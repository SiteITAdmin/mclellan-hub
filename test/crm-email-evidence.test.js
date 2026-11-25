'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-evidence-'));
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
const { crm, now } = require('../lib/crm/db');
const sources = require('../lib/crm/sources');
const atoms = require('../lib/crm/atoms');
const tasks = require('../lib/crm/tasks');
const review = require('../lib/crm/review');

const DAY = 86400;
let seq = 0;
function email(text, { title = `Mail ${++seq}`, space = 'work', direction = 'in', ago = 0 } = {}) {
  return sources.admitSource({ space, kind: 'email', origin: 'test', externalId: `e-${++seq}`, title, direction, text, occurredAt: now() - ago * DAY, participants: [] }).source;
}
const row = id => crm().prepare('SELECT * FROM sources WHERE id = ?').get(id);
const active = statement => crm().prepare("SELECT * FROM atoms WHERE statement = ? AND status = 'active'").all(statement);
const cites = id => crm().prepare('SELECT COUNT(*) AS n FROM atom_sources WHERE atom_id = ?').get(id).n;

// Holds `statement` from one email, then reads `claim` from another and returns [first atom, second email's atoms].
function twice(first, claim, { title = 'Fees', gap = 0, firstTitle = title } = {}) {
  const a = email(`${first.statement}\n`, { title: firstTitle, ago: gap + 1 });
  atoms.applyAtoms(a.id, [{ kind: 'fact', confidence: 'high', quote: first.statement, ...first }], []);
  const old = crm().prepare('SELECT * FROM atoms WHERE statement = ?').get(first.statement);
  const b = email(`${claim.statement}\n`, { title, ago: 0 });
  atoms.applyAtoms(b.id, [{ kind: 'fact', confidence: 'high', quote: claim.statement, ...claim }], [old.id]);
  return { old: crm().prepare('SELECT * FROM atoms WHERE id = ?').get(old.id), second: b };
}
const mergedInto = (old, second) => crm().prepare('SELECT 1 FROM atom_sources WHERE atom_id = ? AND source_id = ?').get(old.id, second.id) !== undefined;

test('quotes: apostrophes, partial and fake quotes, and short replies', () => {
  const text = 'Hi Douglas,\nI’ll send the report on Friday.\nPaid.\nThe unpaid invoice stays open.';
  for (const q of ["I'll send the report", 'Ill send the report', 'send the report on Friday', 'I’ll  send the REPORT']) assert.ok(atoms.quoteVerified(q, text), q);
  for (const q of ['I will send the budget', "I'll send ... on Friday", 'send the report on Monday', 'Paid in full']) assert.ok(!atoms.quoteVerified(q, text), q);
  assert.ok(atoms.quoteVerified('Paid.', text), 'a short reply on a line of its own is a quote');
  assert.ok(!atoms.quoteVerified('paid', 'The invoice is unpaid.'), 'a few letters inside other words are not');
});

test('a claim whose quote is not in the email is never stored or cited; good claims stay; reading again is bounded and visible', () => {
  const held = email('Beacon routes DSAR requests through the Linnane desk.', { title: 'Routing' });
  atoms.applyAtoms(held.id, [{ statement: 'Beacon routes DSAR requests through the Linnane desk.', kind: 'fact', quote: 'routes DSAR requests', confidence: 'high' }], []);
  const routing = crm().prepare("SELECT id FROM atoms WHERE statement LIKE 'Beacon routes%'").get().id;

  const src = email('Thanks, the invoice will be paid on 5 December.', { title: 'Invoice' });
  const claims = [
    { statement: 'Beacon will pay the invoice on 5 December 2026.', kind: 'fact', quote: 'the invoice will be paid on 5 December', confidence: 'high' },
    { statement: 'Beacon routes DSAR requests through the Linnane desk.', kind: 'fact', quote: 'Linnane routing table in the task notes', confidence: 'high', same_as: routing },
    { statement: 'A made-up fact.', kind: 'fact', quote: 'words that are nowhere', confidence: 'high' },
  ];
  assert.equal(atoms.applyAtoms(src.id, claims, [routing]), 1);
  assert.equal(cites(routing), 1, 'the bad quote is not added as a citation to an existing fact');
  assert.equal(active('A made-up fact.').length, 0);
  let s = row(src.id);
  assert.deepEqual([s.atomise_status, s.atom_count, s.atomise_attempts], ['pending', 1, 1]);
  assert.match(s.atomise_error, /2 claims quoted words that are not in this email/);

  atoms.applyAtoms(src.id, claims, [routing]);
  s = row(src.id);
  assert.deepEqual([s.atomise_status, s.atom_count, s.atomise_attempts], ['pending', 1, 2], 'read again; the good claim is not counted twice');
  assert.equal(active('Beacon will pay the invoice on 5 December 2026.').length, 1);

  atoms.applyAtoms(src.id, claims, [routing]);
  s = row(src.id);
  assert.equal(s.atomise_status, 'failed', 'after two re-reads it stops and says so');
  assert.match(s.atomise_error, /Kept 1 fact, but 2 claims quoted words that are not in this email/);
  assert.equal(s.atom_count, 1);
  assert.equal(atoms.retrySource(src.id), 1, 'Retry puts it back');
  assert.equal(row(src.id).atomise_attempts, 0);

  atoms.applyAtoms(src.id, [claims[0]], []);
  s = row(src.id);
  assert.deepEqual([s.atomise_status, s.atom_count, s.atomise_error], ['done', 1, ''], 'a clean read finishes');
});

test('other kinds of source keep their old contract: an unverified quote is stored at low confidence', () => {
  const note = sources.addNote({ space: 'personal', text: 'Lunch with Gemma on Friday.' });
  atoms.applyAtoms(note.id, [{ statement: 'Gemma is having lunch on Friday.', kind: 'fact', quote: 'words that are not in the note', confidence: 'high' }], []);
  const a = crm().prepare("SELECT a.confidence, x.quote_verified FROM atoms a JOIN atom_sources x ON x.atom_id = a.id WHERE a.statement LIKE 'Gemma is having%'").get();
  assert.deepEqual({ ...a }, { confidence: 'low', quote_verified: 0 });
  assert.equal(row(note.id).atomise_status, 'done');
});

test('a short forward keeps its content, a mixed forward keeps its new material, and a subject alone is still data', () => {
  const forward = email('From: Mary Byrne\nSent: Monday, 2 November 2026 10:00\nTo: Douglas\nSubject: Fees\n\nThe monthly fee is €400 from January.', { title: 'Fwd: Fees' });
  assert.match(atoms.buildPacket(forward).userPrompt, /SOURCE TEXT \(new content\) ---\nThe monthly fee is €400/, 'a forward with no words of its own is read in full');
  atoms.applyAtoms(forward.id, [{ statement: 'The monthly fee is €400 from January 2027.', kind: 'fact', quote: 'The monthly fee is €400 from January', confidence: 'high' }], []);
  assert.equal(active('The monthly fee is €400 from January 2027.').length, 1);

  const earlier = email('The audit starts on 4 January 2027.', { title: 'Audit plan', ago: 0.5 });
  atoms.applyAtoms(earlier.id, [{ statement: 'The audit starts on 4 January 2027.', kind: 'date', quote: 'The audit starts on 4 January 2027', confidence: 'high' }], []);
  const audit = crm().prepare("SELECT id FROM atoms WHERE statement LIKE 'The audit starts%'").get().id;
  const mixed = email('FYI\n\nFrom: Mary Byrne\nSent: Tuesday\nSubject: Audit plan\n\nThe audit starts on 4 January 2027.\nThe auditor will visit on site for 3 days.', { title: 'Fwd: Audit plan' });
  assert.equal(atoms.buildPacket(mixed).relatedIds.includes(audit), true, 'the held fact is offered to the model for same_as');
  atoms.applyAtoms(mixed.id, [
    { statement: 'The audit starts on 4 January 2027.', kind: 'date', quote: 'The audit starts on 4 January 2027', confidence: 'high', same_as: audit },
    { statement: 'The auditor will visit on site for 3 days.', kind: 'fact', quote: 'The auditor will visit on site for 3 days', confidence: 'high' },
  ], [audit]);
  assert.equal(cites(audit), 1);
  assert.equal(active('The auditor will visit on site for 3 days.').length, 1, 'the new material in a mixed forward is kept');
  assert.equal(row(mixed.id).atom_count, 1);

  const subject = email('', { title: 'Board approved the 2027 budget of €15k' });
  atoms.applyAtoms(subject.id, [{ statement: 'The board approved the 2027 budget of €15k.', kind: 'decision', quote: 'Board approved the 2027 budget of €15k', confidence: 'high' }], []);
  assert.equal(active('The board approved the 2027 budget of €15k.').length, 1, 'a subject-only email can carry a fact');
});

test('short replies, answers that rely on the quoted conversation and answers written inside it are kept', () => {
  const approval = email('Approved.\n\n________________________________\nFrom: Mary Byrne\nSent: Monday, 2 November 2026\nSubject: Invoice INV1234\n\nPlease approve invoice INV1234 for €15,000.', { title: 'Re: Invoice INV1234' });
  atoms.applyAtoms(approval.id, [{ statement: 'Douglas approved invoice INV1234 for €15,000.', kind: 'decision', quote: 'Approved.', confidence: 'high' }], []);
  assert.equal(active('Douglas approved invoice INV1234 for €15,000.').length, 1, 'a one-word answer is evidence; the figures come from the conversation it answers');

  const done = email('Done.', { title: 'Re: Reset the shared mailbox password' });
  atoms.applyAtoms(done.id, [{ statement: 'The shared mailbox password was reset.', kind: 'fact', quote: 'Done.', confidence: 'high' }], []);
  assert.equal(active('The shared mailbox password was reset.').length, 1);

  const inline = email('Hi Douglas, answers inline.\n\n________________________________\nFrom: Mary Byrne\nSent: Monday\nSubject: Questions\n\n> When can you start?\nI can start on 1 February 2027.\n> Who pays?\nBeacon pays the setup fee.', { title: 'Re: Questions' });
  atoms.applyAtoms(inline.id, [
    { statement: 'Mary Byrne can start on 1 February 2027.', kind: 'fact', quote: 'I can start on 1 February 2027', confidence: 'high' },
    { statement: 'Beacon pays the setup fee.', kind: 'fact', quote: 'Beacon pays the setup fee', confidence: 'high' },
  ], []);
  assert.equal(row(inline.id).atom_count, 2, 'inline answers below a divider are not dropped');
  assert.equal(row(inline.id).atomise_status, 'done');
});

test('open tasks are context only: none for an empty or unrelated email, only titles for a relevant one', () => {
  const unrelatedSource = email('Linnane routing table: tickets go to the service desk. Passwords expire in 90 days.', { title: 'Routing notes' });
  const unrelated = tasks.create('work', { title: 'Check Linnane routing', notes: 'Linnane routing table: tickets go to the service desk.' });
  crm().prepare('UPDATE tasks SET source_id = ? WHERE id = ?').run(unrelatedSource.id, unrelated.id);
  const stripeSource = email('Please pay the Stripe invoice INV-1234 by Friday.', { title: 'Stripe invoice INV-1234' });
  const stripe = tasks.create('work', { title: 'Pay the Stripe invoice', notes: 'SECRET-NOTES about Stripe' });
  crm().prepare('UPDATE tasks SET source_id = ? WHERE id = ?').run(stripeSource.id, stripe.id);

  for (const body of ['', 'Thanks, received.']) {
    const packet = atoms.buildPacket(email(body, { title: body ? 'Re: Rota' : 'Accepted: Weekly rota' }));
    assert.doesNotMatch(packet.userPrompt, /Open tasks/);
    assert.doesNotMatch(packet.userPrompt, /Linnane|Stripe|SECRET-NOTES/);
    assert.equal(packet.relatedIds.some(id => id.startsWith('task:')), false);
  }
  const reply = email('Paid.', { title: 'Re: Stripe invoice INV-1234' });
  const packet = atoms.buildPacket(reply);
  assert.match(packet.userPrompt, /Open tasks \(context only/);
  assert.match(packet.userPrompt, /Pay the Stripe invoice/);
  assert.doesNotMatch(packet.userPrompt, /SECRET-NOTES|Check Linnane/, 'only the title, and only of a task the email is about');

  const empty = email('', { title: 'Re: Linnane routing' });
  atoms.applyAtoms(empty.id, [{ statement: 'Linnane routing sends tickets to the service desk.', kind: 'fact', quote: 'Linnane routing table: tickets go to the service desk', confidence: 'high' }], []);
  assert.equal(active('Linnane routing sends tickets to the service desk.').length, 0, 'an email cannot cite words that belong to a task');
  assert.equal(row(empty.id).atomise_status, 'pending');
});

test('a task is closed only by the email\'s own words, for a task it was shown', () => {
  const evidence = require('../lib/crm/task-email-evidence');
  const mk = (title, text) => {
    const src = email(text, { title });
    const t = tasks.create('work', { title: `Do: ${title}` });
    crm().prepare('UPDATE tasks SET source_id = ?, created_at = ? WHERE id = ?').run(src.id, now() - 5 * DAY, t.id);
    return tasks.get(t.id);
  };
  const shown = mk('Quarterly widget settlement', 'Please settle the quarterly widget settlement.');
  const other = mk('Annual gadget licence', 'Please renew the annual gadget licence.');
  const reply = email('Paid.', { title: 'Re: Quarterly widget settlement' });
  const refs = [shown, other].map(evidence.ref);
  assert.deepEqual(evidence.candidates(reply).map(evidence.ref), [refs[0]]);

  // A result queued under an older packet that listed every recent task.
  atoms.applyAtoms(reply.id, [], refs, refs.map(id => ({ id, quote: 'Paid.', certainty: 'clear' })));
  assert.equal(tasks.get(shown.id).status, 'completed');
  assert.equal(tasks.get(other.id).status, 'needsAction', 'a task the email was not shown stays open');

  const acceptance = email('', { title: 'Accepted: Annual gadget licence' });
  atoms.applyAtoms(acceptance.id, [], refs, [{ id: refs[1], quote: 'Accepted: Annual gadget licence', certainty: 'clear' }]);
  assert.equal(tasks.get(other.id).status, 'needsAction', 'a subject-only acceptance is not evidence that work was done');
});

test('a model merge is vetoed when amount, people order, outcome, period, occurrence or supersession differ', () => {
  const cases = [
    ['400 against 80, even for a named id', { statement: 'Beacon owes Douglas €80.' }, { statement: 'Beacon owes Douglas €400.' }, false],
    ['payer and payee flipped', { statement: 'Beacon owes Douglas €400.' }, { statement: 'Douglas owes Beacon €400.' }, false],
    ['asked against confirmed', { statement: 'Douglas asked Karol to review the contract.' }, { statement: 'Karol confirmed the contract review.' }, false],
    ['the same date for a different event', { statement: 'The review meeting is on 15 March 2027.' }, { statement: 'The payment is due on 15 March 2027.' }, false],
    ['unrelated products', { statement: 'Purview licences now cover 500 users.' }, { statement: 'Teams Premium licences now cover 500 users.' }, false],
    ['a different period', { statement: 'The maintenance window is open.', valid_from: '2026-11-01', valid_until: '2026-11-07' }, { statement: 'The maintenance window is open.', valid_from: '2026-12-01', valid_until: '2026-12-07' }, false],
    ['a different kind', { statement: 'The vendor will visit on site.' }, { statement: 'The vendor will visit on site.', kind: 'risk' }, false],
    ['the same thing written differently (€15k, 15,000, INV-1234)', { statement: 'Invoice INV-1234 for €15k was approved.' }, { statement: 'Invoice INV1234 for €15,000 was approved.' }, true],
    ['the same thing in other words', { statement: 'Karol Podziewski is away until 9 November 2026.' }, { statement: 'Karol Podziewski is away until 9 November.' }, true],
  ];
  for (const [name, first, claim, merges] of cases) {
    const held = email(`${first.statement}\n`, { title: `Case ${name}`, ago: 1 });
    atoms.applyAtoms(held.id, [{ kind: 'fact', confidence: 'high', quote: first.statement, ...first }], []);
    const old = crm().prepare('SELECT id FROM atoms WHERE statement = ? AND valid_from IS ?').get(first.statement, first.valid_from || null);
    const next = email(`${claim.statement}\n`, { title: `Case ${name}` });
    atoms.applyAtoms(next.id, [{ kind: 'fact', confidence: 'high', quote: claim.statement, ...claim, same_as: old.id }], [old.id]);
    assert.equal(mergedInto(old, next), merges, name);
    assert.equal(row(next.id).atom_count, 1, `${name}: the claim is never lost`);
  }
});

test('exact repeats merge within a conversation or a few days, not weeks apart; supersession always wins', () => {
  const sameThread = twice({ statement: 'The VPN was down for the whole morning.' }, { statement: 'The VPN was down for the whole morning.' }, { title: 'Re: VPN outage', firstTitle: 'VPN outage', gap: 20 });
  assert.equal(mergedInto(sameThread.old, sameThread.second), false, 'a subject can recur weeks later');

  const soon = twice({ statement: 'The weekly payroll file was sent.' }, { statement: 'The weekly payroll file was sent.' }, { title: 'Payroll B', firstTitle: 'Payroll A', gap: 1 });
  assert.equal(mergedInto(soon.old, soon.second), true, 'within three days');

  const weeks = twice({ statement: 'The monthly backup job failed overnight.' }, { statement: 'The monthly backup job failed overnight.' }, { title: 'Backups B', firstTitle: 'Backups A', gap: 30 });
  assert.equal(mergedInto(weeks.old, weeks.second), false, 'the same words weeks apart in other conversations are another occurrence');
  assert.equal(active('The monthly backup job failed overnight.').length, 2);

  const first = email('The audit date is 14 November 2026.', { title: 'Audit', ago: 1 });
  atoms.applyAtoms(first.id, [{ statement: 'The audit date is 14 November 2026.', kind: 'date', quote: 'The audit date is 14 November 2026', confidence: 'high' }], []);
  const old = crm().prepare("SELECT id FROM atoms WHERE statement = 'The audit date is 14 November 2026.'").get().id;
  const next = email('The audit date is now 28 November 2026.', { title: 'Audit' });
  atoms.applyAtoms(next.id, [{ statement: 'The audit date is now 28 November 2026.', kind: 'date', quote: 'The audit date is now 28 November 2026', confidence: 'high', same_as: old, supersedes: old }], [old]);
  assert.equal(crm().prepare('SELECT status FROM atoms WHERE id = ?').get(old).status, 'superseded');
  assert.equal(cites(old), 1, 'the newer claim is its own atom, not a citation of the old one');

  const ghost = email('The audit date is now 5 December 2026.', { title: 'Audit' });
  atoms.applyAtoms(ghost.id, [{ statement: 'The audit date is now 5 December 2026.', kind: 'date', quote: 'The audit date is now 5 December 2026', confidence: 'high', same_as: old }], [old]);
  assert.equal(cites(old), 1, 'a superseded atom is not a merge target');
  assert.equal(active('The audit date is now 5 December 2026.').length, 1);
});

test('ids the packet never showed are ignored, and promises keep direction, person, due date and request state apart', () => {
  const held = email('The deposit is €2,000.', { title: 'Deposit' });
  atoms.applyAtoms(held.id, [{ statement: 'The deposit is €2,000.', kind: 'fact', quote: 'The deposit is €2,000', confidence: 'high' }], []);
  const deposit = crm().prepare("SELECT id FROM atoms WHERE statement = 'The deposit is €2,000.'").get().id;
  const again = email('The deposit is €2,000.', { title: 'Deposit' });
  atoms.applyAtoms(again.id, [{ statement: 'The deposit is €2,000.', kind: 'fact', quote: 'The deposit is €2,000', confidence: 'high', same_as: 'invented', supersedes: deposit }], []);
  assert.equal(crm().prepare('SELECT status FROM atoms WHERE id = ?').get(deposit).status, 'active', 'a supersedes id that was not offered does nothing');

  const promise = (statement, spec) => ({ statement, kind: 'promise', quote: statement, confidence: 'high', promise: { direction: 'mine', who: 'Jane Whelan', action: 'send the budget', due: '2026-12-05', certainty: 'clear', ...spec } });
  const p1 = email('Douglas will send Jane Whelan the budget by 5 December.', { title: 'Budget', direction: 'out' });
  atoms.applyAtoms(p1.id, [promise('Douglas will send Jane Whelan the budget by 5 December.', {})], []);
  const id = crm().prepare("SELECT id FROM atoms WHERE kind = 'promise' AND statement LIKE 'Douglas will send Jane Whelan the budget%'").get().id;
  const tries = [
    ['another person', 'Douglas will send Ben Ryan the budget by 5 December.', { who: 'Ben Ryan' }],
    ['another date', 'Douglas will send Jane Whelan the budget by 12 December.', { due: '2026-12-12' }],
    ['the other direction', 'Jane Whelan will send Douglas the budget by 5 December.', { direction: 'owed_to_me' }],
  ];
  for (const [name, statement, spec] of tries) {
    const s = email(statement, { title: 'Budget', direction: 'out' });
    atoms.applyAtoms(s.id, [{ ...promise(statement, spec), same_as: id }], [id]);
    assert.equal(mergedInto({ id }, s), false, name);
    assert.equal(crm().prepare('SELECT COUNT(*) AS n FROM atoms WHERE statement = ?').get(statement).n, 1, `${name} is kept as its own promise`);
  }
});

test('a claim filed under a project the held fact is not in is kept apart', () => {
  review.createProject('work', 'Evidence Project');
  const held = email('Karol manages the vendor contract.', { title: 'Vendors' });
  atoms.applyAtoms(held.id, [{ statement: 'Karol manages the vendor contract.', kind: 'fact', quote: 'Karol manages the vendor contract', confidence: 'high' }], []);
  const old = crm().prepare("SELECT id FROM atoms WHERE statement LIKE 'Karol manages%'").get().id;
  const next = email('Karol manages the vendor contract.', { title: 'Vendors' });
  atoms.applyAtoms(next.id, [{ statement: 'Karol manages the vendor contract.', kind: 'fact', quote: 'Karol manages the vendor contract', confidence: 'high', same_as: old, projects: ['Evidence Project'] }], [old]);
  assert.equal(crm().prepare('SELECT COUNT(*) AS n FROM atoms WHERE statement LIKE ?').get('Karol manages%').n, 2);
});

test('a copy in quoted history or an unrelated acceptance cannot back a new fact', () => {
  const old = 'Exchange returned no on-premises recipient for the shared mailbox.';
  for (const source of [
    email('I will send the rota tomorrow.\n\nFrom: Douglas\nSent: Monday\n\n' + old),
    email('Accepted.', {title:'Re: Travel'}),
    email('', {title:'Accepted: SAR Portal'}),
  ]) {
    const q = source.text.startsWith('I will') ? old : source.text || source.title;
    atoms.applyAtoms(source.id, [{statement:old, kind:'fact', quote:q}]);
    assert.equal(row(source.id).atom_count, 0);
  }
});

test('nested history and calendar courtesies cannot supply task or promise evidence', () => {
  const { emailParts, actionText } = require('../lib/crm/text');
  const nested = email('Answers inline.\n___________\nFrom: Jane\nSent: Monday\nSubject: Visit\n\n> Ready?\nReady tomorrow.\nFrom: Tom\nSent: Friday\nThe payroll transfer was completed.');
  assert.match(emailParts(nested).fresh, /Ready tomorrow/);
  assert.doesNotMatch(actionText(nested), /payroll/);
  for (const title of ['Accepted: Send the transfer', 'Re: Transfer']) {
    const stub = email('Accepted.', { title });
    assert.equal(actionText(stub), '');
    assert.deepEqual(require('../lib/crm/task-email-evidence').candidates(stub), []);
  }
});

test('a role change and a later forwarded occurrence are new facts', () => {
  const first = email('The weekly report was sent to the team.', { title:'Weekly report', ago:35 });
  const firstClaim = {statement:first.text, quote:first.text, kind:'fact'};
  atoms.applyAtoms(first.id, [firstClaim]);
  const keeper = active(first.text)[0];
  const forward = email('From: Clare\nSent: today\n\n' + first.text, {title:'Fwd: Weekly report'});
  atoms.applyAtoms(forward.id, [firstClaim]);
  assert.equal(active(first.text).length, 2);
  const different = email('The weekly report was sent by the team.');
  atoms.applyAtoms(different.id, [{statement:different.text, quote:different.text, kind:'fact',same_as:keeper.id}], [keeper.id]);
  assert.equal(active(different.text).length, 1);
  assert.equal(require('../lib/crm/claims').sameStatement(different.text, first.text), false);
});

test('a calendar subject cannot substantiate completed work when the body only accepts the invitation', () => {
  const s = email('Accepted.', { title: 'Accepted: Payroll transfer' });
  atoms.applyAtoms(s.id, [{kind:'fact', statement:'The payroll transfer was completed.', quote:'Payroll transfer'}]);
  assert.equal(row(s.id).atom_count, 0);
});

test('HTML blockquotes and nested quoted headers stay out of facts and actionable words', () => {
  const { htmlToText, actionText } = require('../lib/crm/text');
  const old = 'The payroll transfer was completed.';
  for (const text of [
    htmlToText('<div>Thanks, Jane.</div><blockquote><p>' + old + '</p></blockquote><div>Call tomorrow.</div>'),
    'Answers inline.\nFrom: Mary\nSent: Monday\n\n> Ready?\nCall tomorrow.\n> On Friday Jane wrote:\n' + old,
  ]) {
    const s = email(text);
    assert.match(actionText(s), /Call tomorrow/);
    assert.ok(!actionText(s).includes(old));
    atoms.applyAtoms(s.id, [{kind:'fact', statement:old, quote:old}]);
    assert.equal(row(s.id).atom_count, 0);
  }
});

test('a repeated forward keeps a new effective date even within one day', () => {
  const text = 'The daily settlement completed.';
  const original = email(text, {title:'Settlement report', ago:0.5});
  const claim = {kind:'fact', statement:text, quote:text, valid_from:'2026-11-24'};
  atoms.applyAtoms(original.id, [claim]);
  const old = active(text)[0];
  const s = email('From: Jane\nSent: today\n\n' + text, {title:'Fwd: Settlement report'});
  atoms.applyAtoms(s.id, [{...claim, valid_from:'2026-11-25',same_as:old.id}], [old.id]);
  assert.equal(row(s.id).atom_count, 1);
  assert.equal(active(text).length, 2);
});

test('ordinary promises retain the recipient and the sender as distinct roles', () => {
  const {sameStatement} = require('../lib/crm/claims');
  assert.equal(sameStatement('The report will be sent to the team.', 'The report will be sent by the team.', {promise:true}), false);
});

test('a source header can identify its mailbox but an unrelated mailbox cannot be imported from model context', () => {
  const address = "office.o'brien@example.com";
  const s = email('Please send requests to this mailbox.');
  crm().prepare("INSERT INTO source_addresses(source_id,kind,value,role) VALUES (?,'email',?,'from')").run(s.id,address);
  const proposal = mailbox => ({statement:'Please send requests to ' + mailbox, quote:s.text, kind:'fact'});
  atoms.applyAtoms(s.id,[proposal(address),proposal('office.unrelated@example.com')]);
  assert.equal(row(s.id).atom_count,1);
  assert.equal(active(proposal(address).statement).length,1);
});
