'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  activeOpportunitySignals,
  expireOpportunitySignals,
  looksLikeOpportunityEmail,
  storeOpportunitySignal,
} = require('../lib/opportunity-engine');
const {
  SUGGESTERS,
  buildOpportunitySuggestionEmail,
  compileOpportunitySuggestionAtom,
  isActionableOpportunitySignal,
  isAdmissibleOpportunitySuggestion,
  relevanceWindowEnd,
  retireExpiredOpportunityKnowledge,
} = require('../lib/suggestion-engine');
const { appraisePromotionEmails } = require('../lib/email-processor');
const { fetchNewPromotionEmails } = require('../lib/gmail');
const { uuid } = require('../lib/id');

const USER = '__test_opportunity';

function cleanup() {
  const hub = db.hub();
  hub.prepare('DELETE FROM opportunity_signals WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM knowledge_atoms WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM suggestions WHERE user = ?').run(USER);
  hub.prepare("DELETE FROM crm_context WHERE user = ? AND key = '_gmail_promotions_last_check_ts'").run(USER);
  hub.prepare("DELETE FROM processing_failures WHERE source = 'gmail_promotion' AND external_id LIKE 'promo-test-%'").run();
}

test.before(cleanup);
test.after(cleanup);

test('offer detection accepts canonical offer labels and offer-looking retail mail', () => {
  assert.equal(looksLikeOpportunityEmail({
    fromName: 'A sender',
    fromEmail: 'sender@example.com',
    subject: 'Hello',
    bodyText: 'Plain update',
  }, 'Commerce/Offers'), true);

  assert.equal(looksLikeOpportunityEmail({
    fromName: 'Co-op Membership',
    fromEmail: 'membership@email.coop.co.uk',
    subject: 'Your weekly member offers',
    bodyText: 'Save £4 this week with your Co-op membership.',
  }), true);

  assert.equal(looksLikeOpportunityEmail({
    fromName: 'Newsletter',
    fromEmail: 'news@example.com',
    subject: 'Weekly notes',
    bodyText: 'No discounts here.',
  }), false);
});

test('storing an opportunity signal creates a candidate without prematurely atomising it', () => {
  const email = {
    id: `opp-email-${Date.now()}`,
    fromName: 'Co-op Membership',
    fromEmail: 'membership@email.coop.co.uk',
    subject: 'Your weekly member offers',
    receivedAt: Math.floor(Date.now() / 1000),
  };
  const signal = storeOpportunitySignal(USER, email, {
    title: 'Co-op weekly member offers',
    summary: 'Co-op has weekly member offers priced in sterling.',
    actor: 'Co-op',
    geography: 'UK',
    currency: 'GBP',
    valid_until: '2099-01-31',
    items: ['milk', 'fruit'],
  }, { sourceLabel: 'Commerce/Offers' });

  assert.ok(signal);
  assert.equal(signal.actor, 'Co-op');
  assert.equal(signal.geography, 'UK');
  assert.equal(signal.currency, 'GBP');

  const atom = db.hub().prepare(`
    SELECT * FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'opportunity'
    LIMIT 1
  `).get(USER);
  assert.equal(atom, undefined);
});

test('activeOpportunitySignals expires old opportunities', () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO opportunity_signals
      (id, user, signal_type, source_kind, source_id, title, summary, valid_until, observed_at)
    VALUES (?, ?, 'retail_offer', 'test', 'expired-source', 'Expired offer', 'No longer valid', '2000-01-01', unixepoch())
  `).run(uuid(), USER);

  const expired = expireOpportunitySignals(USER);
  assert.ok(expired >= 1);
  const active = activeOpportunitySignals(USER);
  assert.equal(active.some(s => s.title === 'Expired offer'), false);
  assert.equal(active.some(s => s.title === 'Co-op weekly member offers'), true);
});

test('suggestion engine registers the opportunity suggester', () => {
  assert.equal(typeof SUGGESTERS.opportunity, 'function');
});

test('opportunity admission requires an action and a direct causal join', () => {
  assert.equal(isAdmissibleOpportunitySuggestion({
    action_required: true,
    relevance_basis: 'travel_utility',
    causal_connection: 'The travel privacy benefit directly applies on public networks.',
  }), true);
  assert.equal(isAdmissibleOpportunitySuggestion({
    action_required: true,
    relevance_basis: 'generic_timing',
    causal_connection: 'Douglas will be away before the promotion ends.',
  }), false);
  assert.equal(isAdmissibleOpportunitySuggestion({
    action_required: false,
    relevance_basis: 'known_need',
    causal_connection: 'The account limits were increased automatically.',
  }), false);
});

test('legacy and automatic-benefit signals cannot enter salience synthesis', () => {
  assert.equal(isActionableOpportunitySignal({ details: {} }), false);
  assert.equal(isActionableOpportunitySignal({
    details: { action_required: false, required_action: '' },
  }), false);
  assert.equal(isActionableOpportunitySignal({
    details: { action_required: true, required_action: 'Redeem the member voucher' },
  }), true);
});

test('standalone CRM email contains only opportunity suggestions', () => {
  const email = buildOpportunitySuggestionEmail([
    { domain: 'content', short_code: 1, title: 'Content idea', body: 'Skip this.' },
    { domain: 'opportunity', short_code: 2, title: 'Scottish shop offer', body: 'This is usable during the trip.' },
  ]);
  assert.equal(email.subject, 'Suggestion from CRM');
  assert.match(email.text, /Scottish shop offer/);
  assert.doesNotMatch(email.text, /Content idea/);
});

test('suggestion evidence remains valid JSON when context exceeds 4,000 characters', () => {
  const { createSuggestion } = require('../lib/suggestion-engine');
  const row = createSuggestion(USER, {
    domain: 'opportunity',
    title: 'Large evidence test',
    body: 'Evidence must remain parseable.',
    evidence: { context: 'x'.repeat(6000), relevanceWindow: '2099-01-01' },
    dedupKey: `large-evidence-${uuid()}`,
  });
  const parsed = JSON.parse(row.evidence);
  assert.equal(parsed.context.length, 6000);
  assert.equal(parsed.relevanceWindow, '2099-01-01');
});

test('an admitted suggestion compiles the candidate into a source-backed atom', async () => {
  const suggestion = {
    id: uuid(),
    domain: 'opportunity',
    title: 'Opportunity radar: Asda match-night meal deal',
    body: 'The meal deal is usable while Douglas is visiting Dad in Kelty.',
  };
  const signalId = uuid();
  const atomId = await compileOpportunitySuggestionAtom(USER, suggestion, [signalId], {
    causal_connection: 'The UK shop offer is usable at the destination during the visit.',
    relevance_window: '2099-01-31',
    confidence: 0.9,
  }, { index: async () => 1 });
  const atom = db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ?').get(atomId);
  assert.equal(atom.predicate, 'relevant_offer');
  assert.equal(atom.derived_by, 'suggestion_opportunity');
  const refs = JSON.parse(atom.source_refs);
  assert.ok(refs.some(ref => ref.kind === 'suggestion' && ref.id === suggestion.id));
  assert.ok(refs.some(ref => ref.kind === 'opportunity_signal' && ref.id === signalId));
});

test('relevance windows expose their final date for short-lived knowledge retirement', () => {
  assert.equal(relevanceWindowEnd('2099-01-01'), '2099-01-01');
  assert.equal(relevanceWindowEnd('2099-01-01..2099-01-03'), '2099-01-03');
  assert.equal(relevanceWindowEnd(null), null);
});

test('expired relevance windows retire compiled offer atoms', async () => {
  const suggestion = db.hub().prepare(`
    INSERT INTO suggestions (id, user, domain, title, body, evidence, status)
    VALUES (?, ?, 'opportunity', 'Past offer', 'Past body', ?, 'open')
    RETURNING *
  `).get(uuid(), USER, JSON.stringify({ relevanceWindow: '2000-01-01' }));
  const atomId = await compileOpportunitySuggestionAtom(USER, suggestion, [uuid()], {
    causal_connection: 'This was relevant only during the past event window.',
    relevance_window: '2000-01-01',
    confidence: 0.8,
  }, { index: async () => 1 });
  assert.equal(retireExpiredOpportunityKnowledge(USER), 1);
  assert.equal(db.hub().prepare('SELECT status FROM knowledge_atoms WHERE id = ?').get(atomId).status, 'retired');
});

test('promotion fetch uses an independent cursor and the Gmail promotions category', async () => {
  let query = '';
  const fakeGmail = { users: { messages: {
    list: async options => {
      query = options.q;
      return { data: { messages: [{ id: 'promo-test-fetch' }] } };
    },
    get: async () => ({ data: {
      internalDate: String(Date.now()),
      payload: {
        headers: [
          { name: 'From', value: 'Asda <asda@example.test>' },
          { name: 'Subject', value: 'Match-night meal deal' },
        ],
        body: { data: Buffer.from('Buy a pizza meal deal for Sunday.').toString('base64url') },
      },
    } }),
  } } };
  const result = await fetchNewPromotionEmails(USER, fakeGmail);
  assert.match(query, /category:promotions/);
  assert.equal(result.emails.length, 1);
  assert.equal(result.emails[0].fromName, 'Asda');
  assert.ok(db.hub().prepare("SELECT 1 FROM crm_context WHERE user = ? AND key = '_gmail_promotions_last_check_ts'").get(USER));
});

test('generic promotions stop after appraisal', async () => {
  let synthesised = false;
  let delivered = false;
  const result = await appraisePromotionEmails(USER, [{ id: 'promo-test-generic', subject: 'Brand news' }], {
    extract: async () => 0,
    synthesise: async () => { synthesised = true; return []; },
    deliver: async () => { delivered = true; },
  });
  assert.deepEqual(result, { appraised: 1, candidates: 0, suggestions: 0 });
  assert.equal(synthesised, false);
  assert.equal(delivered, false);
});

test('an actionable promotion triggers immediate synthesis and delivery', async () => {
  let deliveredRows = null;
  const suggestion = { id: 'suggestion-1', domain: 'opportunity' };
  const result = await appraisePromotionEmails(USER, [{ id: 'promo-test-asda', subject: 'Match-night meal deal' }], {
    extract: async () => 1,
    synthesise: async () => [suggestion],
    deliver: async (_user, rows) => { deliveredRows = rows; },
  });
  assert.deepEqual(result, { appraised: 1, candidates: 1, suggestions: 1 });
  assert.deepEqual(deliveredRows, [suggestion]);
});
