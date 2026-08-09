'use strict';

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-email-curated-promo-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;
delete process.env.CRM_LEGACY_DIRECT_WRITES;
process.env.EMAIL_POLL_DEBUG = '1';

const db = require('../lib/db');
const taxonomy = require('../lib/email-taxonomy');
const { selectKnownPromotionEmails } = require('../lib/email-processor');

// ensureEmailTaxonomy folds config rules only for the taxonomy default user, so
// the test must act as that user.
const user = 'douglas';

// Start from a DB where this user has no seeded classification rules, so the
// config fold path is what actually adds the MasterClass rule.
function resetUserTaxonomy() {
  const hub = db.hub();
  hub.prepare('DELETE FROM email_taxonomy_rules WHERE user = ?').run(user);
  hub.prepare('DELETE FROM email_taxonomy_labels WHERE user = ?').run(user);
  hub.prepare("DELETE FROM crm_context WHERE user = ? AND key = '_email_taxonomy_classification_seed_v1'").run(user);
}

function masterclassRule() {
  const hub = db.hub();
  return hub.prepare(`
    SELECT * FROM email_taxonomy_rules
    WHERE user = ? AND match_type = ? AND match_value = ?
  `).get(user, 'sender_domain', 'email.masterclass.com');
}

const masterClassEmail = () => ({
  id: 'masterclass-promo-1',
  fromEmail: 'support@email.masterclass.com',
  fromName: 'MasterClass',
  subject: 'Take control of your money this month',
  labelIds: ['CATEGORY_PROMOTIONS'],
});

const genericNewsletterEmail = () => ({
  id: 'generic-promo-1',
  fromEmail: 'hello@something.substack.com',
  fromName: 'Something',
  subject: 'Issue of a random newsletter',
  labelIds: ['CATEGORY_PROMOTIONS'],
});

function emptyGmail() {
  return { users: { labels: { list: async () => ({ data: { labels: [] } }) } } };
}

beforeEach(() => resetUserTaxonomy());

test('config classification rule is folded into an existing database once', () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT OR IGNORE INTO email_taxonomy_labels (id, user, name, enabled, display_order)
    VALUES ('x', ?, 'Resources/Learning', 1, 0)
  `).run(user);

  taxonomy.ensureEmailTaxonomy(user);
  const seeded = masterclassRule();
  assert.ok(seeded, 'MasterClass sender_domain rule should be seeded');
  assert.equal(seeded.target_label, 'Resources/Learning');

  // A later call must not duplicate the rule (id stable across calls).
  taxonomy.ensureEmailTaxonomy(user);
  assert.equal(masterclassRule().id, seeded.id, 'seed is idempotent');

  // A rule deleted via the admin page must not come back on restart.
  hub.prepare('DELETE FROM email_taxonomy_rules WHERE id = ?').run(seeded.id);
  taxonomy.ensureEmailTaxonomy(user);
  assert.equal(Boolean(masterclassRule()), false, 'deleted rule is not resurrected');
});

test('matchEmailTaxonomy maps a MasterClass sender to Resources/Learning', () => {
  taxonomy.ensureEmailTaxonomy(user);
  const match = taxonomy.matchEmailTaxonomy(user, masterClassEmail());
  assert.ok(match, 'MasterClass mail should match a rule');
  assert.equal(match.label, 'Resources/Learning');
});

test('selectKnownPromotionEmails admits rule-matched promotions only', async () => {
  taxonomy.ensureEmailTaxonomy(user);
  const emailLabels = ['Resources/Newsletters', 'Resources/Learning', 'Commerce/Offers'];

  const selected = await selectKnownPromotionEmails(
    user,
    emptyGmail(),
    [masterClassEmail(), genericNewsletterEmail()],
    emailLabels,
  );
  const ids = selected.map(e => e.id);
  assert.ok(ids.includes('masterclass-promo-1'), 'MasterClass promo should be admitted');
  assert.ok(!ids.includes('generic-promo-1'), 'generic newsletter promo stays appraisal-only');
});

test('selectKnownPromotionEmails admits already-filed non-archive mail without a rule', async () => {
  taxonomy.ensureEmailTaxonomy(user);
  const filedLabelId = 'learning-label-id';
  const gmail = {
    users: {
      labels: {
        list: async () => ({ data: { labels: [{ id: filedLabelId, name: 'Resources/Learning' }] } }),
      },
    },
  };
  const filed = {
    id: 'filed-learning-1',
    fromEmail: 'someone@elsewhere.com',
    fromName: 'Someone',
    subject: 'A course email',
    labelIds: [filedLabelId, 'CATEGORY_PROMOTIONS'],
  };
  const selected = await selectKnownPromotionEmails(user, gmail, [filed], ['Resources/Newsletters', 'Resources/Learning']);
  assert.equal(selected.length, 1, 'Gmail-filed curated mail is admitted via its label');
  assert.equal(selected[0].id, 'filed-learning-1');
});