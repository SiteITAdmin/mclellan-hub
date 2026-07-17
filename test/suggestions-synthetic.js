'use strict';

// Synthetic build-time test for the suggestion engine (CLAUDE.md Rule 3).
// Makes REAL OpenRouter calls (extraction + travel suggester) — costs a few
// cents. Run: node test/suggestions-synthetic.js

require('dotenv').config();
const assert = require('assert');
const db = require('./../lib/db');
const hub = db.hub();
const engine = require('./../lib/suggestion-engine');
const { uuid } = require('./../lib/id');

const USER = 'douglas';
let failures = 0;
const factIds = [];

function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}: ${err.message}`); }
}

function cleanup() {
  hub.prepare("DELETE FROM travel_price_points WHERE gmail_message_id LIKE 'synthtest%'").run();
  hub.prepare("DELETE FROM suggestions WHERE user = ? AND (dedup_key LIKE 'travel:%' OR dedup_key LIKE 'content:%' OR dedup_key LIKE 'opportunity:synthtest-%') AND created_at > unixepoch() - 600").run(USER);
  for (const id of factIds) hub.prepare('DELETE FROM crm_facts WHERE id = ?').run(id);
  hub.prepare("DELETE FROM google_tasks WHERE source = 'suggestion' AND created_at > unixepoch() - 600").run();
}

(async () => {
  console.log('1. Skyscanner extraction (REAL LLM call, fake email)');
  const fakeEmail = {
    id: 'synthtest-skyscanner-' + Date.now(),
    fromEmail: 'alerts@mail.skyscanner.net',
    fromName: 'Skyscanner',
    subject: 'Price Alert: Dublin to Edinburgh fares have dropped',
    receivedAt: Math.floor(Date.now() / 1000),
    bodyText: `Hi Douglas,

Good news! Prices for your saved trip have changed.

Dublin (DUB) to Edinburgh (EDI)
Departing: 20 July 2026 — Returning: 24 July 2026
Now from €58 return (was €74)

Track this price or book now on Skyscanner.

You're receiving this because you set up a Price Alert for this route.`,
  };
  const inserted = await engine.extractTravelPrices(USER, fakeEmail);
  const rows = hub.prepare("SELECT * FROM travel_price_points WHERE gmail_message_id = ?").all(fakeEmail.id);
  console.log('  raw extracted rows:', JSON.stringify(rows.map(r => ({ route: r.route, start: r.travel_window_start, end: r.travel_window_end, price: r.price, currency: r.currency }))));
  check('at least one price point extracted', () => assert(inserted >= 1 && rows.length >= 1));
  check('route contains DUB and EDI', () => assert(rows.some(r => /DUB/.test(r.route) && /EDI/.test(r.route)), rows.map(r => r.route).join(',')));
  check('price ≈ 58 EUR with travel window', () =>
    assert(rows.some(r => Math.abs(r.price - 58) < 1 && r.currency === 'EUR' && r.travel_window_start === '2026-07-20')));

  const again = await engine.extractTravelPrices(USER, fakeEmail);
  check('re-processing the same email is a no-op (no second LLM cost)', () => assert.strictEqual(again, 0));

  console.log('2. Travel suggester (REAL LLM call, seeded price history + travel fact, no booking)');
  // Older, higher price for the same route so there is a trend
  hub.prepare(`INSERT OR IGNORE INTO travel_price_points
    (id, user, route, travel_window_start, travel_window_end, price, currency, source, gmail_message_id, observed_at)
    VALUES (?, ?, 'DUB-EDI', '2026-07-20', '2026-07-24', 74, 'EUR', 'skyscanner', ?, ?)`)
    .run(uuid(), USER, 'synthtest-older-' + Date.now(), Math.floor(Date.now() / 1000) - 14 * 86400);
  const contact = hub.prepare('SELECT id FROM contacts WHERE user = ? LIMIT 1').get(USER);
  if (contact) {
    const fid = uuid();
    hub.prepare(`INSERT INTO crm_facts (id, user, contact_id, fact, status, source)
      VALUES (?, ?, ?, 'Planning a trip to Edinburgh 20-24 July 2026 to visit family — flights not booked yet', 'active', 'synthtest')`)
      .run(fid, USER, contact.id);
    factIds.push(fid);
  }
  const created = await engine.SUGGESTERS.travel(USER);
  console.log('  suggestions:', JSON.stringify(created.map(s => ({ code: s.short_code, title: s.title, dedup: s.dedup_key }))));
  check('travel suggester produced a suggestion', () => assert(created.length >= 1));
  check('suggestion stores evidence with price points', () => {
    const ev = JSON.parse(created[0].evidence);
    assert(Array.isArray(ev.pricePoints) && ev.pricePoints.length >= 1);
  });

  const rerun = await engine.SUGGESTERS.travel(USER);
  check('second run dedups (no duplicate suggestions)', () => {
    const dupes = hub.prepare('SELECT dedup_key, COUNT(*) AS n FROM suggestions GROUP BY dedup_key HAVING n > 1').all();
    assert.strictEqual(dupes.length, 0, JSON.stringify(dupes));
    assert.strictEqual(rerun.length, 0, `rerun created ${rerun.length}`);
  });

  console.log('3. Accept / dismiss / why');
  const s = created[0];
  const why = engine.whySuggestion(USER, s.short_code);
  check('why returns evidence', () => assert(why.ok && why.message.includes('Evidence')));
  const dismissed = engine.dismissSuggestion(USER, s.short_code);
  check('dismiss closes suggestion', () => {
    assert(dismissed.ok);
    assert.strictEqual(hub.prepare('SELECT status FROM suggestions WHERE id = ?').get(s.id).status, 'dismissed');
  });

  console.log('4. Standalone email formatting');
  const fresh = engine.createSuggestion(USER, {
    domain: 'opportunity', title: 'synthtest list item', body: 'test body',
    dedupKey: 'opportunity:synthtest-' + Date.now(),
  });
  check('standalone email includes the opportunity and fixed subject', () => {
    const email = engine.buildOpportunitySuggestionEmail([fresh]);
    assert.strictEqual(email.subject, 'Suggestion from CRM');
    assert(email.text.includes(`Suggestion #${fresh.short_code}`));
  });

  cleanup();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll suggestion engine tests passed.');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); cleanup(); process.exit(1); });
