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
const { SUGGESTERS } = require('../lib/suggestion-engine');
const { uuid } = require('../lib/id');

const USER = '__test_opportunity';

function cleanup() {
  const hub = db.hub();
  hub.prepare('DELETE FROM opportunity_signals WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM knowledge_atoms WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM suggestions WHERE user = ?').run(USER);
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

test('storing an opportunity signal compiles a source-backed atom', () => {
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
    WHERE user = ? AND subject_kind = 'opportunity' AND predicate = 'retail_offer'
    LIMIT 1
  `).get(USER);
  assert.ok(atom);
  assert.match(atom.value, /GBP|sterling/i);
  const refs = JSON.parse(atom.source_refs);
  assert.ok(refs.some(r => r.kind === 'opportunity_signal' && r.id === signal.id));
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
