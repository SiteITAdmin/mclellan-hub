'use strict';

const taxonomyDefaults = require('../config/email-taxonomy.json');
const db = require('./db');
const { uuid } = require('./id');

const RULE_TYPES = new Set([
  'legacy_label',
  'sender_email',
  'sender_domain',
  'sender_name',
  'subject_contains',
]);

function ensureEmailTaxonomy(user) {
  const hub = db.hub();
  if (taxonomyDefaults.default_user && taxonomyDefaults.default_user !== user) return;

  const syncEntities = hub.transaction(() => {
    for (const person of taxonomyDefaults.people || []) {
      const existingContact = hub.prepare(
        'SELECT id, aliases FROM contacts WHERE user = ? AND lower(name) = lower(?)'
      ).get(user, person.canonical_name);
      if (!existingContact) {
        hub.prepare(
          'INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)'
        ).run(uuid(), user, person.canonical_name, JSON.stringify(person.aliases || []));
      } else {
        let aliases = [];
        try { aliases = JSON.parse(existingContact.aliases || '[]'); } catch (_) {}
        const merged = [...new Set([...aliases, ...(person.aliases || [])])];
        hub.prepare('UPDATE contacts SET aliases = ? WHERE id = ?')
          .run(JSON.stringify(merged), existingContact.id);
      }
    }

    if (!hub.prepare(
      'SELECT 1 FROM projects WHERE user = ? AND slug = ?'
    ).get(user, 'vipbackups')) {
      hub.prepare(`
        INSERT INTO projects (id, user, name, slug, context_depth)
        VALUES (?, ?, 'VIPBackups', 'vipbackups', 20)
      `).run(uuid(), user);
    }
  });
  syncEntities();

  const existing = hub.prepare(
    'SELECT 1 FROM email_taxonomy_labels WHERE user = ? LIMIT 1'
  ).get(user);
  if (existing) return;

  const insertLabel = hub.prepare(`
    INSERT OR IGNORE INTO email_taxonomy_labels
      (id, user, name, enabled, display_order)
    VALUES (?, ?, ?, 1, ?)
  `);
  const insertRule = hub.prepare(`
    INSERT OR IGNORE INTO email_taxonomy_rules
      (id, user, match_type, match_value, target_label, notes, priority, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const seed = hub.transaction(() => {
    (taxonomyDefaults.canonical_labels || []).forEach((name, index) => {
      insertLabel.run(uuid(), user, name, index);
    });
    Object.entries(taxonomyDefaults.legacy_mappings || {}).forEach(([legacy, target], index) => {
      insertRule.run(
        uuid(), user, 'legacy_label', legacy, target,
        'Seeded from config/email-taxonomy.json', 500 - index
      );
    });
    (taxonomyDefaults.classification_rules || []).forEach(rule => {
      insertRule.run(
        uuid(), user, rule.match_type, rule.match_value, rule.target_label,
        rule.notes || 'Seeded from config/email-taxonomy.json',
        Number.isFinite(rule.priority) ? rule.priority : 100
      );
    });

  });
  seed();
}

function listEmailTaxonomy(user) {
  ensureEmailTaxonomy(user);
  const hub = db.hub();
  return {
    labels: hub.prepare(`
      SELECT * FROM email_taxonomy_labels
      WHERE user = ?
      ORDER BY display_order, name
    `).all(user),
    rules: hub.prepare(`
      SELECT * FROM email_taxonomy_rules
      WHERE user = ?
      ORDER BY priority DESC, match_type, match_value
    `).all(user),
  };
}

function normalizeRuleType(value) {
  return RULE_TYPES.has(value) ? value : null;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function ruleMatchesEmail(rule, email) {
  const expected = normalize(rule.match_value);
  if (!expected) return false;

  if (rule.match_type === 'sender_email') {
    return normalize(email.fromEmail) === expected;
  }
  if (rule.match_type === 'sender_domain') {
    const domain = normalize(email.fromEmail).split('@')[1] || '';
    return domain === expected || domain.endsWith(`.${expected}`);
  }
  if (rule.match_type === 'sender_name') {
    return normalize(email.fromName).includes(expected);
  }
  if (rule.match_type === 'subject_contains') {
    return normalize(email.subject).includes(expected);
  }
  return false;
}

function matchEmailTaxonomy(user, email) {
  const { labels, rules } = listEmailTaxonomy(user);
  const enabledLabels = new Set(labels.filter(label => label.enabled).map(label => label.name));
  const rule = rules.find(candidate =>
    candidate.enabled
    && candidate.match_type !== 'legacy_label'
    && enabledLabels.has(candidate.target_label)
    && ruleMatchesEmail(candidate, email)
  );
  return rule ? { label: rule.target_label, rule } : null;
}

function getEnabledEmailLabels(user) {
  return listEmailTaxonomy(user).labels.filter(label => label.enabled).map(label => label.name);
}

function recordPendingEmail(user, email) {
  db.hub().prepare(`
    INSERT OR IGNORE INTO email_classification_pending
      (id, user, gmail_message_id, from_email, from_name, subject)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), user, email.id,
    normalize(email.fromEmail), String(email.fromName || '').trim(),
    String(email.subject || '').trim()
  );
}

async function learnFromPendingEmailLabels(user, gmail) {
  const hub = db.hub();
  const pending = hub.prepare(`
    SELECT * FROM email_classification_pending
    WHERE user = ? AND status = 'pending'
    ORDER BY created_at
    LIMIT 100
  `).all(user);
  if (!pending.length) return [];

  const { labels, rules } = listEmailTaxonomy(user);
  const enabledLabels = new Set(labels.filter(label => label.enabled).map(label => label.name));
  const labelsResponse = await gmail.users.labels.list({ userId: 'me' });
  const labelNameById = new Map(
    (labelsResponse.data.labels || []).map(label => [label.id, label.name])
  );
  const existingAutomatic = new Set(
    rules
      .filter(rule => rule.enabled && rule.match_type === 'sender_email')
      .map(rule => normalize(rule.match_value))
  );
  const learned = [];

  for (const item of pending) {
    try {
      const response = await gmail.users.messages.get({
        userId: 'me',
        id: item.gmail_message_id,
        format: 'minimal',
      });
      const canonical = (response.data.labelIds || [])
        .map(labelId => labelNameById.get(labelId))
        .filter(labelName => enabledLabels.has(labelName));

      // One canonical label is an unambiguous user correction. Zero means the
      // user has not trained it yet; multiple labels need manual cleanup first.
      if (canonical.length !== 1) continue;

      const senderEmail = normalize(item.from_email);
      if (senderEmail && !existingAutomatic.has(senderEmail)) {
        hub.prepare(`
          INSERT INTO email_taxonomy_rules
            (id, user, match_type, match_value, target_label, notes, priority, enabled)
          VALUES (?, ?, 'sender_email', ?, ?, ?, 900, 1)
          ON CONFLICT(user, match_type, match_value) DO UPDATE SET
            target_label = excluded.target_label,
            notes = excluded.notes,
            priority = excluded.priority,
            enabled = 1
        `).run(
          uuid(), user, senderEmail, canonical[0],
          `Learned from manual label on "${item.subject}"`
        );
        existingAutomatic.add(senderEmail);
      }

      hub.prepare(`
        UPDATE email_classification_pending
        SET status = 'learned', learned_label = ?, learned_at = unixepoch()
        WHERE id = ?
      `).run(canonical[0], item.id);
      learned.push({
        gmailMessageId: item.gmail_message_id,
        fromEmail: senderEmail,
        label: canonical[0],
      });
    } catch (err) {
      if (err.code === 404 || err.response?.status === 404) {
        hub.prepare(`
          UPDATE email_classification_pending SET status = 'missing'
          WHERE id = ?
        `).run(item.id);
        continue;
      }
      console.warn(`[email-taxonomy] training check failed for ${item.gmail_message_id}:`, err.message);
    }
  }
  return learned;
}

module.exports = {
  RULE_TYPES: [...RULE_TYPES],
  ensureEmailTaxonomy,
  getEnabledEmailLabels,
  learnFromPendingEmailLabels,
  listEmailTaxonomy,
  matchEmailTaxonomy,
  normalizeRuleType,
  recordPendingEmail,
};
