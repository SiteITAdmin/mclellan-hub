'use strict';

/**
 * Knowledge layer — L4 synthesis (the self-improving loop).
 *
 * Re-reads raw sources AFTER ingestion and derives atoms with provenance, then
 * resolves each atom's subject to a known entity. This is what connects, say, a
 * care-plan address to the right contact even though the email classifier that
 * first saw the document had no idea who it was about. Connections are made from
 * the whole corpus, not from the thin context available at capture time.
 *
 * Resolution order: exact/alias name match (deterministic, free) → LLM linker
 * (budgeted) for ambiguous subjects. High-confidence links auto-apply; uncertain
 * ones are stored as 'proposed' for review (Stage 4). All model calls go through
 * OpenRouter; both models are admin-controllable slots.
 */

const db = require('./db');
const { PROMPTS } = require('./prompts');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { parseModelObject } = require('./model-response');
const { upsertAtom } = require('./atoms');

const EXTRACT_FALLBACK = 'anthropic/claude-haiku-4-5';
const LINK_FALLBACK = 'anthropic/claude-haiku-4-5';
const INTELLIGENCE_LABELS = new Set(['resources/newsletters', 'resources/research']);
const NEWSLETTER_SENDER_RE = /substack|tldr|newsletter|digest|rundown|briefing|weekly|daily|futurepedia|implicator|forwardfuture|artificialcorner/i;
const NEWSLETTER_SUBJECT_RE = /newsletter|digest|weekly|daily|edition|issue\s*#|briefing|\bvol\b|\bno\.\s*\d/i;
const SERVICE_SENDER_RE = /\b(no-?reply|noreply|notifications?|accounts?|billing|receipts?|support|automated|mailer)\b/i;
const SERVICE_SUBJECT_RE = /\b(invoice|receipt|payment|subscription|trial|account|welcome|password|verification|security|login|sign-?in|deleted|cancelled|canceled|renewal|charged|statement)\b/i;

async function llmJson(feature, fallbackModel, prompt, defaults) {
  const modelId = getSystemModelId(feature, 'system', fallbackModel);
  const started = Date.now();
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.SYNTHESIS),
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user: 'system', feature, modelKey: feature, fallbackModelId: modelId,
    data, durationMs: Date.now() - started, taskCode: TASK_CODES.SYNTHESIS,
  });
  // Extract the JSON object: some OpenRouter models wrap output in ```json fences
  // despite response_format, so don't depend on a bare JSON.parse of the content.
  const raw = String(data.choices?.[0]?.message?.content || '');
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  const content = (s >= 0 && e > s) ? raw.slice(s, e + 1) : raw;
  return parseModelObject(content, defaults, feature);
}

function parseAliases(j) {
  try { const a = JSON.parse(j || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

function loadEntities(user) {
  const hub = db.hub();
  const contacts = hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(user)
    .map(c => ({ kind: 'contact', id: c.id, label: c.name, aliases: parseAliases(c.aliases) }));
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ?').all(user)
    .map(c => ({ kind: 'company', id: c.id, label: c.name, aliases: [] }));
  const projects = hub.prepare('SELECT id, name, slug FROM projects WHERE user = ?').all(user)
    .map(p => ({ kind: 'project', id: p.id, label: p.name, aliases: p.slug ? [p.slug] : [] }));
  return [...contacts, ...companies, ...projects];
}

function entityNames(entity) {
  return [entity.label, ...(entity.aliases || [])]
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);
}

function entityScoreForSource(entity, context = {}) {
  let score = 0;
  if (context.projectId && entity.kind === 'project' && entity.id === context.projectId) score += 100;
  if (context.contactId && entity.kind === 'contact' && entity.id === context.contactId) score += 100;
  if (context.companyId && entity.kind === 'company' && entity.id === context.companyId) score += 100;
  if (context.preferKind && entity.kind === context.preferKind) score += 10;
  return score;
}

// Deterministic subject resolution by name/alias. Returns an entity or null.
function resolveByName(label, entities, context = {}) {
  const n = String(label || '').trim().toLowerCase();
  if (!n) return null;
  const best = matches => matches
    .sort((a, b) => entityScoreForSource(b, context) - entityScoreForSource(a, context))[0] || null;
  const exact = entities.filter(e => entityNames(e).some(name => name === n));
  if (exact.length) return best(exact);
  const partial = entities.filter(e => entityNames(e).some(name =>
    n.length >= 4 && name.length >= 4 && (name.includes(n) || n.includes(name))
  ));
  if (partial.length) return best(partial);
  return null;
}

function sourceContext(user, sourceKind, row) {
  const hub = db.hub();
  if (sourceKind === 'document' && row.project_id) return { projectId: row.project_id, preferKind: 'project' };
  if (sourceKind === 'email_summary') {
    const context = {};
    if (row.contact_id) {
      context.contactId = row.contact_id;
      context.preferKind = 'contact';
    }
    if (row.project_slug) {
      const project = hub.prepare('SELECT id FROM projects WHERE user = ? AND slug = ?').get(user, row.project_slug);
      if (project) {
        context.projectId = project.id;
        if (!context.preferKind) context.preferKind = 'project';
      }
    }
    return context;
  }
  if (sourceKind === 'meeting_intake') {
    const context = {};
    try {
      const extraction = JSON.parse(row.extraction || '{}');
      const slugs = extraction?.meeting?.projects || [];
      if (slugs.length) {
        const project = hub.prepare('SELECT id FROM projects WHERE user = ? AND slug = ?').get(user, slugs[0]);
        if (project) {
          context.projectId = project.id;
          context.preferKind = 'project';
        }
      }
    } catch (_) {}
    return context;
  }
  return {};
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function emailSummaryExternalIds(row = {}) {
  const id = String(row.gmail_message_id || '').trim();
  if (!id) return [];
  const ids = [id];
  if (id.startsWith('agentmail:')) ids.push(id.slice('agentmail:'.length));
  return [...new Set(ids.filter(Boolean))];
}

function emailSummaryHasIntelDocument(user, row) {
  const ids = emailSummaryExternalIds(row);
  if (!ids.length) return false;
  const placeholders = ids.map(() => '?').join(',');
  return !!db.hub().prepare(`
    SELECT 1 FROM intel_documents
    WHERE user = ? AND source_kind = 'email' AND external_id IN (${placeholders})
    LIMIT 1
  `).get(user, ...ids);
}

function emailSummaryMatchesIntelSource(user, row) {
  const emailAddress = normalize(row.from_email);
  if (!emailAddress) return false;
  const domain = emailAddress.split('@')[1] || '';
  return !!db.hub().prepare(`
    SELECT 1 FROM intel_sources
    WHERE user = ? AND source_kind = 'email' AND enabled = 1
      AND (
        (match_type = 'sender_email' AND lower(match_value) = ?)
        OR (match_type = 'sender_domain' AND (? = lower(match_value) OR ? LIKE '%.' || lower(match_value)))
      )
    LIMIT 1
  `).get(user, emailAddress, domain, domain);
}

function emailSummaryMatchesIntelligenceTaxonomy(user, row) {
  const hub = db.hub();
  const labels = new Set(hub.prepare(`
    SELECT name FROM email_taxonomy_labels
    WHERE user = ? AND enabled = 1
  `).all(user).map(label => normalize(label.name)));
  if (!labels.size) return false;

  const rules = hub.prepare(`
    SELECT match_type, match_value, target_label
    FROM email_taxonomy_rules
    WHERE user = ? AND enabled = 1
    ORDER BY priority DESC
  `).all(user);
  const sender = normalize(row.from_email);
  const domain = sender.split('@')[1] || '';
  const name = normalize(row.from_name);
  const subject = normalize(row.subject);

  for (const rule of rules) {
    const target = normalize(rule.target_label);
    if (!labels.has(target) || !INTELLIGENCE_LABELS.has(target)) continue;
    const expected = normalize(rule.match_value);
    if (!expected) continue;
    if (rule.match_type === 'sender_email' && sender === expected) return true;
    if (rule.match_type === 'sender_domain' && (domain === expected || domain.endsWith(`.${expected}`))) return true;
    if (rule.match_type === 'sender_name' && name.includes(expected)) return true;
    if (rule.match_type === 'subject_contains' && subject.includes(expected)) return true;
  }
  return false;
}

function emailSummaryLooksLikeNewsletter(row) {
  if (row.contact_id || row.project_slug) return false;
  const from = `${row.from_name || ''} ${row.from_email || ''}`;
  const subject = String(row.subject || '').replace(/^(fwd?|fw):\s*/i, '');
  return NEWSLETTER_SENDER_RE.test(from) || NEWSLETTER_SUBJECT_RE.test(subject);
}

function emailSummaryLooksLikeServiceNoise(row) {
  if (row.contact_id || row.project_slug) return false;
  const from = `${row.from_name || ''} ${row.from_email || ''}`;
  const subject = String(row.subject || '');
  const text = `${subject}\n${row.text || ''}`;
  return SERVICE_SENDER_RE.test(from) && SERVICE_SUBJECT_RE.test(text);
}

function shouldExcludeEmailSummaryFromKnowledge(user, row) {
  if (!row || row.project_slug === '__skip' || row.project_slug === '__system') return true;
  return emailSummaryHasIntelDocument(user, row)
    || emailSummaryMatchesIntelSource(user, row)
    || emailSummaryMatchesIntelligenceTaxonomy(user, row)
    || emailSummaryLooksLikeNewsletter(row)
    || emailSummaryLooksLikeServiceNoise(row);
}

function pruneExcludedEmailSummaryAtomRefs(user, excludedIds) {
  if (!excludedIds?.size) return { retired: 0, pruned: 0 };
  const hub = db.hub();
  const rows = hub.prepare(`
    SELECT id, source_refs FROM knowledge_atoms
    WHERE user = ? AND source_refs LIKE '%"kind":"email_summary"%'
  `).all(user);
  let retired = 0, pruned = 0;
  for (const row of rows) {
    let refs = [];
    try { refs = JSON.parse(row.source_refs || '[]'); } catch (_) { refs = []; }
    if (!Array.isArray(refs) || !refs.some(ref => ref?.kind === 'email_summary' && excludedIds.has(ref.id))) continue;
    const remaining = refs.filter(ref => !(ref?.kind === 'email_summary' && excludedIds.has(ref.id)));
    if (remaining.length) {
      hub.prepare('UPDATE knowledge_atoms SET source_refs = ?, updated_at = unixepoch() WHERE id = ?')
        .run(JSON.stringify(remaining), row.id);
      pruned++;
    } else {
      hub.prepare('UPDATE knowledge_atoms SET status = ?, updated_at = unixepoch() WHERE id = ?')
        .run('retired', row.id);
      retired++;
    }
  }
  return { retired, pruned };
}

function cleanupExcludedEmailSummaryKnowledge(user) {
  const hub = db.hub();
  const rows = hub.prepare(`
    SELECT id, gmail_message_id, subject, from_name, from_email, project_slug, contact_id
    FROM email_summaries
    WHERE user = ?
  `).all(user);
  const excludedIds = new Set();
  for (const row of rows) {
    if (shouldExcludeEmailSummaryFromKnowledge(user, row)) {
      excludedIds.add(row.id);
      markProcessed('email_summary', row.id, user, 0);
    }
  }
  const pruned = pruneExcludedEmailSummaryAtomRefs(user, excludedIds);
  return { excludedEmailSummaries: excludedIds.size, ...pruned };
}

function sourceContextEntities(entities, context = {}) {
  return entities.filter(e =>
    (context.projectId && e.kind === 'project' && e.id === context.projectId)
    || (context.contactId && e.kind === 'contact' && e.id === context.contactId)
    || (context.companyId && e.kind === 'company' && e.id === context.companyId)
  );
}

function textMentionsEntity(text, entity) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return false;
  return entityNames(entity).some(name => name.length >= 4 && haystack.includes(name));
}

function linkableCandidates(draft, entities, context = {}, sourceText = '') {
  const seeded = new Map();
  for (const e of sourceContextEntities(entities, context)) seeded.set(e.id, e);
  for (const e of entities) {
    if (textMentionsEntity(sourceText, e)) seeded.set(e.id, e);
  }
  return [...seeded.values()];
}

function canResolveByName(draft, entity, context = {}, sourceText = '') {
  if (!entity) return false;
  if (sourceContextEntities([entity], context).length) return true;
  return textMentionsEntity(sourceText, entity);
}

function sourceTextMentionsEntity(text, entity) {
  return textMentionsEntity(text, entity);
}

function legacyLinkableCandidates(draft, entities, context = {}) {
  const claimText = `${draft.subject || ''} ${draft.predicate || ''} ${draft.value || ''}`;
  const seeded = new Map();
  for (const e of sourceContextEntities(entities, context)) seeded.set(e.id, e);
  for (const e of entities) {
    if (textMentionsEntity(claimText, e)) seeded.set(e.id, e);
  }
  return [...seeded.values()];
}

async function extractAtoms(user, text, entities) {
  const entityList = entities
    .map(e => `- ${e.label}${e.aliases.length ? ` (aka ${e.aliases.join(', ')})` : ''}`)
    .join('\n') || '(none)';
  const prompt = getSystemPrompt('atom_extractor', 'system', PROMPTS.atom_extractor)
    .replaceAll('[ENTITIES]', entityList) + `\n\nSOURCE TEXT:\n${String(text).slice(0, 6000)}`;
  const obj = await llmJson('atom_extractor', EXTRACT_FALLBACK, prompt, { atoms: [] });
  return Array.isArray(obj.atoms) ? obj.atoms : [];
}

// Top active atoms per entity, so the linker can disambiguate on real knowledge
// (an address, an employer, a relationship) — not just names. Built once per run.
function buildEntityFacts(user, perEntity = 4) {
  const rows = db.hub().prepare(`
    SELECT subject_id, predicate, value, confidence FROM knowledge_atoms
     WHERE user = ? AND status = 'active' AND subject_id IS NOT NULL
     ORDER BY confidence DESC
  `).all(user);
  const map = new Map();
  for (const r of rows) {
    const arr = map.get(r.subject_id) || [];
    if (arr.length < perEntity) {
      arr.push(`${r.predicate}: ${String(r.value).slice(0, 80)}`);
      map.set(r.subject_id, arr);
    }
  }
  return map;
}

async function linkSubject(draft, entities, entityFacts, context = {}, sourceText = '') {
  const candidatesForDraft = linkableCandidates(draft, entities, context, sourceText);
  if (!candidatesForDraft.length) return { entity_id: null, confidence: 0, reason: 'No source or text evidence names a known entity' };
  const candidates = candidatesForDraft
    .map(e => {
      const aka = e.aliases.length ? ` (aka ${e.aliases.join(', ')})` : '';
      const facts = (entityFacts && entityFacts.get(e.id)) || [];
      const known = facts.length ? ` — known: ${facts.join('; ')}` : '';
      return `${e.id} — ${e.label}${aka}${known}`;
    })
    .join('\n') || '(none)';
  const prompt = getSystemPrompt('entity_linker', 'system', PROMPTS.entity_linker)
    .replaceAll('[SUBJECT]', draft.subject || '')
    .replaceAll('[PREDICATE]', draft.predicate || '')
    .replaceAll('[VALUE]', String(draft.value || ''))
    .replaceAll('[CANDIDATES]', candidates);
  return llmJson('entity_linker', LINK_FALLBACK, prompt, { entity_id: null, confidence: 0, reason: '' });
}

function markProcessed(sourceKind, sourceId, user, atomCount) {
  db.hub().prepare(`
    INSERT INTO synthesis_state (source_kind, source_id, user, processed_at, atom_count)
    VALUES (?, ?, ?, unixepoch(), ?)
    ON CONFLICT(source_kind, source_id) DO UPDATE SET processed_at = unixepoch(), atom_count = excluded.atom_count
  `).run(sourceKind, sourceId, user, atomCount);
}

async function synthesiseSource(user, sourceKind, sourceId, text, entities, budget, entityFacts, context = {}) {
  const drafts = await extractAtoms(user, text, entities);
  let stored = 0, proposed = 0;
  for (const d of drafts) {
    if (!d || !d.subject || !d.predicate || d.value == null || d.value === '') continue;
    const conf = typeof d.confidence === 'number' ? d.confidence : 0.6;

    let subjectId = null, subjectKind = 'contact', subjectLabel = d.subject, status = 'active';
    const ent = resolveByName(d.subject, entities, context);
    if (canResolveByName(d, ent, context, text)) {
      ({ id: subjectId, kind: subjectKind, label: subjectLabel } = ent);
    } else if (budget.n > 0) {
      budget.n--;
      try {
        const link = await linkSubject(d, entities, entityFacts, context, text);
        const matched = link.entity_id ? entities.find(e => e.id === link.entity_id) : null;
        if (matched) {
          subjectId = matched.id; subjectKind = matched.kind; subjectLabel = matched.label;
          status = link.confidence >= 0.8 ? 'active' : 'proposed';
          d.confidence = Math.min(conf, typeof link.confidence === 'number' ? link.confidence : conf);
        } else {
          status = 'proposed';
        }
      } catch { status = 'proposed'; }
    } else {
      status = 'proposed';
    }

    upsertAtom(user, {
      subjectKind, subjectId, subjectLabel,
      predicate: d.predicate, value: String(d.value),
      sourceRef: { kind: sourceKind, id: sourceId },
      confidence: typeof d.confidence === 'number' ? d.confidence : conf, status, derivedBy: 'synthesis',
    });
    stored++;
    if (status === 'proposed') proposed++;
  }
  markProcessed(sourceKind, sourceId, user, stored);
  return { stored, proposed };
}

const SYNTH_SOURCES = [
  { kind: 'document',       sql: "SELECT id, project_id, markdown AS text FROM documents WHERE user = ?" },
  { kind: 'email_summary',  sql: "SELECT id, gmail_message_id, subject, from_name, from_email, project_slug, contact_id, (COALESCE(subject,'') || '. ' || COALESCE(summary,'')) AS text FROM email_summaries WHERE user = ?" },
  { kind: 'meeting_intake', sql: "SELECT id, extraction, (COALESCE(title,'') || '. ' || COALESCE(summary,'') || ' ' || COALESCE(transcript,'')) AS text FROM meeting_intakes WHERE user = ? AND status = 'processed'" },
];

function isProcessed(sourceKind, sourceId) {
  return !!db.hub().prepare(
    'SELECT 1 FROM synthesis_state WHERE source_kind = ? AND source_id = ? LIMIT 1'
  ).get(sourceKind, sourceId);
}

// Process up to `limit` unprocessed sources. linkBudget caps LLM linker calls
// per run to bound cost. Returns counts; remaining>0 means call again soon.
async function runSynthesis(user, { limit = 15, linkBudget = 20 } = {}) {
  const entities = loadEntities(user);
  const entityFacts = buildEntityFacts(user);
  const budget = { n: linkBudget };
  const hub = db.hub();
  let processed = 0, atomsStored = 0, proposed = 0, remaining = 0;
  const excludedEmailSummaryIds = new Set();

  for (const src of SYNTH_SOURCES) {
    const rows = hub.prepare(src.sql).all(user);
    for (const row of rows) {
      if (src.kind === 'email_summary' && shouldExcludeEmailSummaryFromKnowledge(user, row)) {
        excludedEmailSummaryIds.add(row.id);
        if (!isProcessed(src.kind, row.id)) markProcessed(src.kind, row.id, user, 0);
        continue;
      }
      if (isProcessed(src.kind, row.id)) continue;
      const text = (row.text || '').trim();
      if (text.length < 20) { markProcessed(src.kind, row.id, user, 0); continue; }
      if (processed >= limit) { remaining++; continue; }
      try {
        const r = await synthesiseSource(user, src.kind, row.id, text, entities, budget, entityFacts, sourceContext(user, src.kind, row));
        atomsStored += r.stored; proposed += r.proposed; processed++;
      } catch (err) {
        console.warn(`[synthesis] ${src.kind} ${row.id}:`, err.message);
      }
    }
  }
  const excluded = pruneExcludedEmailSummaryAtomRefs(user, excludedEmailSummaryIds);
  return { processed, atomsStored, proposed, remaining, excludedEmailSummaries: excludedEmailSummaryIds.size, retiredNewsletterAtoms: excluded.retired, prunedNewsletterRefs: excluded.pruned };
}

// Test/maintenance helper: forget that sources were synthesised so they re-run.
function resetSynthesis(user) {
  db.hub().prepare('DELETE FROM synthesis_state WHERE user = ?').run(user);
}

module.exports = {
  runSynthesis, synthesiseSource, extractAtoms, linkSubject,
  resolveByName, loadEntities, resetSynthesis,
  linkableCandidates, legacyLinkableCandidates, sourceContext, canResolveByName, sourceTextMentionsEntity,
  shouldExcludeEmailSummaryFromKnowledge, pruneExcludedEmailSummaryAtomRefs, cleanupExcludedEmailSummaryKnowledge,
};
