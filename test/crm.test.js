'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-crm-'));
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');

const { crm, setting } = require('../lib/crm/db');
const text = require('../lib/crm/text');
const identity = require('../lib/crm/identity');
const sources = require('../lib/crm/sources');
const outlook = require('../lib/crm/outlook');
const atoms = require('../lib/crm/atoms');
const review = require('../lib/crm/review');
const gmail = require('../lib/crm/gmail');
const views = require('../lib/crm/views');
const orgs = require('../lib/crm/orgs');

const ME = 'douglas.mclellan@beaconhospital.ie';
const hours = h => Math.floor(Date.now() / 1000) - h * 3600;

function outlookFile({ from, to, cc = '', subject, received, body, messageId = '' }) {
  return [
    `FROM: ${from}`, `TO: ${to}`, cc ? `CC: ${cc}` : null, `SUBJECT: ${subject}`, `RECEIVED: ${received}`,
    messageId ? `MESSAGE-ID: ${messageId}` : null, '', 'MESSAGE:', body,
  ].filter(l => l !== null).join('\n');
}

function reviewItem(key) {
  return crm().prepare("SELECT * FROM review_items WHERE item_key = ? AND status = 'open'").get(key);
}

// ── text ────────────────────────────────────────────────────────────────────
test('htmlToText drops Outlook styles and keeps paragraphs', () => {
  const html = '<html><head><style>p.MsoNormal{margin:0}</style></head><body><p>Hi Douglas,</p><p>Licences &amp; seats: 300&nbsp;users.</p></body></html>';
  assert.strictEqual(text.htmlToText(html), 'Hi Douglas,\n\nLicences & seats: 300 users.');
});

test('splitFresh cuts the quoted Outlook thread and the gateway banner', () => {
  const t = 'EXTERNAL UNTRUSTED EMAIL: Do not click links.\nGreat, thanks.\n\n________________\nFrom: Jane Whelan <jane@x.ie>\nSent: Monday 19 October 2026 11:09\nTo: Douglas';
  const { fresh, quoted } = text.splitFresh(t);
  assert.strictEqual(fresh, 'Great, thanks.');
  assert.match(quoted, /^_{8,}/);
});

test('names lose accents and case only; phones become E.164', () => {
  assert.strictEqual(text.normName('Ciarán  DOYLE'), 'ciaran doyle');
  assert.notStrictEqual(text.normName('Alec'), text.normName('Alan'));
  assert.strictEqual(text.normPhone('087 412 6603'), '+353874126603');
  assert.strictEqual(text.normPhone('00353 87 412 6603'), '+353874126603');
});

// ── Outlook files ───────────────────────────────────────────────────────────
test('parses the Outlook flow format, with and without line breaks', () => {
  const lines = outlook.parseOutlookFile(outlookFile({
    from: 'Laura.Ellard@beaconhospital.ie', to: `Jane.Whelan@beaconhospital.ie;${ME}`, cc: 'Kealan.Walters@beaconhospital.ie',
    subject: 'RE: Purview Premium', received: '2026-10-23T09:03:18+00:00', body: '<p>We have 300 Purview Premium licences.</p>', messageId: '<abc@x>',
  }));
  assert.strictEqual(lines.from.email, 'laura.ellard@beaconhospital.ie');
  assert.deepStrictEqual(lines.to.map(t => t.email), ['jane.whelan@beaconhospital.ie', ME]);
  assert.strictEqual(lines.cc[0].email, 'kealan.walters@beaconhospital.ie');
  assert.strictEqual(lines.messageId, '<abc@x>');
  assert.strictEqual(lines.receivedAt, Date.parse('2026-10-23T09:03:18Z') / 1000);
  assert.strictEqual(lines.text, 'We have 300 Purview Premium licences.');

  // The first test file the flow wrote had every field on one line.
  const inline = outlook.parseOutlookFile(`﻿FROM: Nicola.Wolfe@beaconhospital.ie TO: ${ME} SUBJECT: Re: M365 Meeting Recording RECEIVED: 2026-10-20T12:54:54+00:00 MESSAGE:\r\nIt was Alan's meeting.`);
  assert.strictEqual(inline.from.email, 'nicola.wolfe@beaconhospital.ie');
  assert.strictEqual(inline.subject, 'Re: M365 Meeting Recording');
  assert.match(inline.text, /Alan's meeting/);
});

test('mail not addressed to Douglas is skipped; unknown senders are held and proposed', () => {
  const notMine = outlook.parseOutlookFile(outlookFile({ from: 'jbuice@gocloudwave.com', to: 'Serhiy.Pylypaka@beaconhospital.ie', subject: 'Re: Palo Update', received: '2026-10-24T19:01:16+00:00', body: 'Great, thanks.' }));
  assert.deepStrictEqual(outlook.admitOutlookEmail(notMine, { fileId: 'f-not-mine' }), { skipped: 'not_addressed' });

  const mine = outlook.parseOutlookFile(outlookFile({ from: 'Jane Whelan <Jane.Whelan@beaconhospital.ie>', to: ME, subject: 'RE: Purview Premium', received: new Date(hours(2) * 1000).toISOString(), body: 'The DPIA for Purview is due on 14 November.' }));
  const r = outlook.admitOutlookEmail(mine, { fileId: 'f-jane-1' });
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.source.space, 'work');
  assert.strictEqual(r.source.atomise_status, 'held');
  const item = reviewItem('addr:email:jane.whelan@beaconhospital.ie');
  assert.ok(item, 'Jane is proposed for review');
  assert.strictEqual(item.space, 'work');
  assert.strictEqual(JSON.parse(item.payload).name, 'Jane Whelan');

  assert.strictEqual(outlook.admitOutlookEmail(mine, { fileId: 'f-jane-1' }).created, false, 'same file twice is one source');
});

// ── identity ────────────────────────────────────────────────────────────────
test('Alec and Alan never match each other; a name shared by two people is ambiguous', () => {
  const alec = identity.createPerson({ space: 'work', name: 'Alec Byrne', orgId: orgs.createOrg('work', 'Northwall Group').id });
  const alan = identity.createPerson({ space: 'work', name: 'Alan Garland' });
  identity.linkIdentifier(alec.id, 'email', 'alec.byrne@northwall.ie');
  assert.deepStrictEqual(identity.resolveName('work', 'Alec'), { status: 'resolved', personId: alec.id, how: 'name' });
  assert.deepStrictEqual(identity.resolveName('work', 'Alan'), { status: 'resolved', personId: alan.id, how: 'name' });
  assert.deepStrictEqual(identity.resolveName('work', 'Alex'), { status: 'unresolved' });
  assert.deepStrictEqual(identity.resolveName('personal', 'Alec'), { status: 'unresolved' }, 'spaces never cross');

  const alec2 = identity.createPerson({ space: 'work', name: 'Alec Hughes' });
  const amb = identity.resolveName('work', 'Alec');
  assert.strictEqual(amb.status, 'ambiguous');
  assert.deepStrictEqual(amb.candidateIds.sort(), [alec.id, alec2.id].sort());
  assert.deepStrictEqual(identity.resolveName('work', 'Alec', { participantIds: [alec2.id] }), { status: 'resolved', personId: alec2.id, how: 'participant' });
  assert.deepStrictEqual(identity.resolveName('work', 'Alec Byrne'), { status: 'resolved', personId: alec.id, how: 'name' });
  assert.strictEqual(identity.resolveName('work', 'Douglas').status, 'self');

  assert.throws(() => identity.addAlias(alan.id, 'Alec Byrne'), /already Alec Byrne's name/);
  assert.throws(() => identity.linkIdentifier(alan.id, 'email', 'alec.byrne@northwall.ie'), /already belongs to Alec Byrne/);
  assert.strictEqual(identity.lookalikes('Alex Byrne', 'alexbyrne.photo@gmail.com')[0].id, alec.id, 'shown side by side for Douglas to decide');
});

// ── review ──────────────────────────────────────────────────────────────────
test('adding Jane releases her held mail and records who she is not', () => {
  const item = reviewItem('addr:email:jane.whelan@beaconhospital.ie');
  const alan = crm().prepare("SELECT id FROM people WHERE name = 'Alan Garland'").get();
  const r = review.decide(item.id, { action: 'new', name: 'Jane Whelan', space: 'work', shownIds: [alan.id] });
  const jane = crm().prepare('SELECT * FROM people WHERE id = ?').get(r.personId);
  assert.strictEqual(jane.space, 'work');
  assert.strictEqual(crm().prepare("SELECT atomise_status FROM sources WHERE raw_ref = 'f-jane-1'").get().atomise_status, 'pending');
  assert.ok(crm().prepare('SELECT 1 FROM distinct_pairs WHERE person_id = ? AND other_id = ?').get(jane.id, alan.id));
  assert.strictEqual(views.person(jane.id).sourceCount, 1, 'her past mail links by address, not by a stored row');
});

test('"Not a person" sets held mail aside for good', () => {
  const f = outlook.parseOutlookFile(outlookFile({ from: 'phishalert@beaconhospital.ie', to: ME, subject: 'Your phishing report', received: new Date(hours(1) * 1000).toISOString(), body: 'Judged safe.' }));
  const { source } = outlook.admitOutlookEmail(f, { fileId: 'f-phish' });
  const item = reviewItem('addr:email:phishalert@beaconhospital.ie');
  assert.strictEqual(JSON.parse(item.payload).automated, true);
  review.decide(item.id, { action: 'ignore' });
  assert.strictEqual(crm().prepare('SELECT atomise_status FROM sources WHERE id = ?').get(source.id).atomise_status, 'ignored');
  const again = outlook.parseOutlookFile(outlookFile({ from: 'phishalert@beaconhospital.ie', to: ME, subject: 'Another', received: new Date(hours(1) * 1000).toISOString(), body: 'x', messageId: 'p2' }));
  assert.strictEqual(outlook.admitOutlookEmail(again, { fileId: 'f-phish-2' }).source.atomise_status, 'ignored');
  assert.strictEqual(reviewItem('addr:email:phishalert@beaconhospital.ie'), undefined);
});

// ── atoms ───────────────────────────────────────────────────────────────────
test('atoms are checked against the source and names go through the matcher', () => {
  review.createProject('work', 'M365 Rollout');
  const src = crm().prepare("SELECT * FROM sources WHERE raw_ref = 'f-jane-1'").get();
  const packet = atoms.buildPacket(src);
  assert.match(packet.userPrompt, /Projects in this space: M365 Rollout/);
  assert.match(packet.userPrompt, /DPIA for Purview/);

  const n = atoms.applyAtoms(src.id, [
    { statement: 'The DPIA for Purview at Beacon is due on 14 November 2026.', kind: 'date', quote: 'The DPIA for Purview is due on 14 November', people: ['Jane Whelan', 'Alec'], projects: ['M365 Rollout'], topics: ['data protection', 'Purview'], valid_until: '2026-11-14', confidence: 'high' },
    { statement: 'Beacon plans a records retention review.', kind: 'fact', quote: 'words that are not in the email', people: [], projects: ['Records Programme'], topics: ['data protection'], confidence: 'high' },
    { statement: 'x', kind: 'fact' },
  ], packet.relatedIds);
  assert.strictEqual(n, 2, 'the too-short atom is dropped');

  const dpia = crm().prepare("SELECT * FROM atoms WHERE statement LIKE 'The DPIA%'").get();
  assert.strictEqual(dpia.confidence, 'high');
  assert.strictEqual(dpia.valid_until, '2026-11-14');
  const mentions = crm().prepare('SELECT m.*, p.name AS pname FROM atom_mentions m LEFT JOIN people p ON p.id = m.person_id WHERE atom_id = ? ORDER BY m.name').all(dpia.id);
  assert.deepStrictEqual(mentions.map(m => [m.name, m.status, m.pname]), [['Alec', 'ambiguous', null], ['Jane Whelan', 'resolved', 'Jane Whelan']]);
  assert.ok(reviewItem(`mention:${mentions[0].id}`), 'two Alecs: Douglas is asked which');

  const unverified = crm().prepare("SELECT a.confidence, s.quote_verified FROM atoms a JOIN atom_sources s ON s.atom_id = a.id WHERE a.statement LIKE 'Beacon plans%'").get();
  assert.deepStrictEqual(unverified, { confidence: 'low', quote_verified: 0 }, 'a quote not found in the source lowers confidence');
  assert.ok(reviewItem('project:work:records programme'), 'unknown projects are proposed, not created');
  assert.strictEqual(crm().prepare("SELECT COUNT(*) AS n FROM projects WHERE space = 'work'").get().n, 1);
  assert.strictEqual(crm().prepare("SELECT atomise_status, atom_count FROM sources WHERE id = ?").get(src.id).atom_count, 2);

  const hits = views.search('work', 'data protection');
  assert.ok(hits.atoms.some(a => a.id === dpia.id), 'full-text search finds facts by topic');
  assert.strictEqual(views.search('personal', 'data protection').atoms.length, 0, 'search never crosses spaces');
});

test('a repeated fact joins the existing atom; a newer one supersedes it', () => {
  const f = outlook.parseOutlookFile(outlookFile({ from: 'Jane.Whelan@beaconhospital.ie', to: ME, subject: 'RE: Purview Premium', received: new Date(hours(1) * 1000).toISOString(), body: 'Reminder: the DPIA for Purview is due on 14 November. Purview licences now cover 500 users.', messageId: 'jane-2' }));
  const { source } = outlook.admitOutlookEmail(f, { fileId: 'f-jane-2' });
  assert.strictEqual(source.atomise_status, 'pending', 'Jane is known now, so nothing is held');
  const dpia = crm().prepare("SELECT id FROM atoms WHERE statement LIKE 'The DPIA%'").get();
  const old = atoms.applyAtoms(source.id, [], []);
  assert.strictEqual(old, 0, 'zero atoms is a valid result');

  const f3 = outlook.parseOutlookFile(outlookFile({ from: 'Jane.Whelan@beaconhospital.ie', to: ME, subject: 'Purview', received: new Date(hours(1) * 1000).toISOString(), body: 'The DPIA for Purview is now due on 28 November.', messageId: 'jane-3' }));
  const s3 = outlook.admitOutlookEmail(f3, { fileId: 'f-jane-3' }).source;
  const packet = atoms.buildPacket(s3);
  assert.ok(packet.relatedIds.includes(dpia.id), 'related atoms are offered to the model');
  atoms.applyAtoms(s3.id, [
    { statement: 'The DPIA for Purview is due on 14 November 2026.', quote: 'The DPIA for Purview', same_as: dpia.id, kind: 'date' },
    { statement: 'The DPIA for Purview at Beacon is now due on 28 November 2026.', quote: 'The DPIA for Purview is now due on 28 November', supersedes: dpia.id, kind: 'date', topics: ['data protection'] },
    { statement: 'An invented reference is ignored.', quote: 'The DPIA', same_as: 'not-a-real-atom', kind: 'fact' },
  ], packet.relatedIds);
  assert.strictEqual(crm().prepare('SELECT COUNT(*) AS n FROM atom_sources WHERE atom_id = ?').get(dpia.id).n, 2);
  assert.strictEqual(crm().prepare('SELECT status FROM atoms WHERE id = ?').get(dpia.id).status, 'superseded');
  assert.ok(crm().prepare("SELECT 1 FROM atoms WHERE statement = 'An invented reference is ignored.'").get(), 'an unknown same_as id creates a new atom instead');
});

test('approving a person re-resolves names that were unknown', () => {
  const note = sources.addNote({ space: 'personal', text: 'Lunch with Gemma Quinn on Friday, she is moving to Lisbon.' });
  atoms.applyAtoms(note.id, [{ statement: 'Gemma Quinn is moving to Lisbon.', quote: 'she is moving to Lisbon', people: ['Gemma Quinn'], kind: 'fact' }], []);
  const m = crm().prepare("SELECT * FROM atom_mentions WHERE name = 'Gemma Quinn'").get();
  assert.strictEqual(m.status, 'unresolved');
  identity.createPerson({ space: 'personal', name: 'Gemma Quinn' });
  atoms.reresolveMentions('personal');
  assert.strictEqual(crm().prepare('SELECT status FROM atom_mentions WHERE id = ?').get(m.id).status, 'resolved');
});

test('the queue keeps one CRM job in flight and steps aside for other work', async () => {
  const queue = [];
  const fakeJobs = {
    pendingOthers: 1,
    queueStats() { return { pending: this.pendingOthers + queue.filter(j => j.status === 'pending').length }; },
    enqueue({ feature, dedupeKey, payload }) { const j = { id: `job-${queue.length}`, feature, dedupeKey, payload, status: 'pending' }; queue.push(j); return { jobId: j.id }; },
    getJob(id) { return queue.find(j => j.id === id) || null; },
  };
  const older = sources.addNote({ space: 'work', text: 'Older note about the Purview rollout plan.' });
  crm().prepare('UPDATE sources SET occurred_at = occurred_at - 3600 WHERE id = ?').run(older.id);
  const newer = sources.addNote({ space: 'work', text: 'Newest note: Intune pilot starts Monday.' });
  let r = await atoms.runAtomiseTick({ jobs: fakeJobs });
  assert.strictEqual(r.queued, false, 'site chat is waiting, so nothing is added');
  fakeJobs.pendingOthers = 0;
  r = await atoms.runAtomiseTick({ jobs: fakeJobs });
  assert.strictEqual(r.queued, true);
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].feature, 'crm_atomise');
  assert.strictEqual(queue[0].payload.model, 'sonnet');
  const queuedId = crm().prepare("SELECT id FROM sources WHERE atomise_status = 'queued'").get().id;
  assert.strictEqual(queuedId, newer.id, 'newest first');

  queue[0].status = 'claimed';
  r = await atoms.runAtomiseTick({ jobs: fakeJobs });
  assert.strictEqual(queue.length, 1, 'still one in flight');

  queue[0].status = 'completed';
  queue[0].result = { output: '```json\n{"atoms":[]}\n```' };
  r = await atoms.runAtomiseTick({ jobs: fakeJobs });
  assert.strictEqual(r.applied, 1);
  assert.strictEqual(crm().prepare('SELECT atomise_status FROM sources WHERE id = ?').get(queuedId).atomise_status, 'done');

  const next = queue[queue.length - 1];
  next.status = 'failed'; next.error = "Couldn't use the model's reply: no JSON";
  await atoms.runAtomiseTick({ jobs: fakeJobs });
  const failed = crm().prepare("SELECT * FROM sources WHERE atomise_status = 'failed'").get();
  assert.strictEqual(failed.id, older.id);
  assert.strictEqual(failed.atomise_error, "Couldn't use the model's reply: no JSON", 'failures are recorded, not dropped');
  assert.ok(views.health('work').some(h => /couldn't be read/.test(h.text)), 'and shown on Today');
  assert.strictEqual(atoms.retrySource(failed.id), 1);
});

test('a busy model lane puts the source back in the queue instead of failing it', async () => {
  const queue = [];
  const fakeJobs = {
    queueStats() { return { pending: queue.filter(j => j.status === 'pending').length }; },
    enqueue({ feature, dedupeKey, payload }) { const j = { id: `job-${queue.length}`, feature, dedupeKey, payload, status: 'pending' }; queue.push(j); return { jobId: j.id }; },
    getJob(id) { return queue.find(j => j.id === id) || null; },
  };
  const src = sources.addNote({ space: 'personal', text: 'The boiler was serviced on Tuesday.' });
  await atoms.runAtomiseTick({ jobs: fakeJobs });
  const job = queue[queue.length - 1];
  assert.strictEqual(job.payload.meta.sourceId, src.id);
  job.status = 'failed';
  job.error = 'local subscription runner exited 1: "api_error_status":429,"api_error":"usage_limit_reached"';
  await atoms.runAtomiseTick({ jobs: fakeJobs });
  const row = crm().prepare('SELECT * FROM sources WHERE id = ?').get(src.id);
  assert.strictEqual(row.atomise_status, 'pending', 'left queued, not needing a click');
  assert.strictEqual(row.atomise_attempts, 1);
  assert.match(row.atomise_error, /Waiting to try again/);
  assert.ok(views.health('personal').some(h => /waiting for the model lane/.test(h.text)), 'and said plainly on Today');

  const fresh = sources.addNote({ space: 'personal', text: 'The car needs its NCT in November.' });
  await atoms.runAtomiseTick({ jobs: fakeJobs });
  assert.strictEqual(queue[queue.length - 1].payload.meta.sourceId, fresh.id, 'a fresh source goes ahead of one the lane refused');
});

// ── Gmail ───────────────────────────────────────────────────────────────────
function fakeGmail(messages) {
  const b64 = s => Buffer.from(s).toString('base64url');
  return {
    users: { messages: {
      list: async () => ({ data: { messages: messages.map(m => ({ id: m.id })) } }),
      get: async ({ id }) => {
        const m = messages.find(x => x.id === id);
        const headers = [['From', m.from], ['To', m.to], ['Subject', m.subject]].map(([name, value]) => ({ name, value }));
        return { data: { id, threadId: `t-${id}`, internalDate: String(m.at * 1000), labelIds: m.sent ? ['SENT'] : ['INBOX'],
          payload: { headers, mimeType: 'text/plain', body: { data: b64(m.body) } } } };
      },
    } },
  };
}

test('Gmail keeps sent mail and known senders, and skips strangers', async () => {
  const work = crm().prepare("SELECT * FROM people WHERE name = 'Jane Whelan'").get();
  identity.linkIdentifier(work.id, 'email', 'jane.whelan@gmail.com');
  const g = fakeGmail([
    { id: 'm1', sent: true, from: 'Douglas <douglas@mclellan.scot>', to: 'Ruairí Kelly <ruairi.kelly@gmail.com>', subject: 'Saturday', body: 'See you at the match at 3.', at: hours(3) },
    { id: 'm2', from: 'Deals <offers@shop.example>', to: 'douglas@mclellan.scot', subject: '50% off', body: 'Buy now', at: hours(2) },
    { id: 'm3', from: 'Ruairí Kelly <ruairi.kelly@gmail.com>', to: 'douglas@mclellan.scot', subject: 'Re: Saturday', body: 'Grand, I will bring the tickets.', at: hours(1) },
    { id: 'm4', from: 'Jane Whelan <jane.whelan@gmail.com>', to: 'douglas@mclellan.scot', subject: 'Purview', body: 'Work thing', at: hours(1) },
    { id: 'm5', sent: true, from: 'douglas@mclellan.scot', to: 'douglas@mclellan.scot', subject: '✓ Hub Backup', body: 'Backup ok', at: hours(1) },
  ]);
  const counts = await gmail.runGmailCapture({ gmail: g });
  assert.deepStrictEqual(counts, { seen: 5, admitted: 2, duplicate: 0, skipped: 3 });
  assert.strictEqual(crm().prepare("SELECT 1 FROM sources WHERE external_id = 'm5'").get(), undefined, 'mail to himself only (the Hub reports) is skipped');
  assert.ok(reviewItem('addr:email:ruairi.kelly@gmail.com'), 'a new recipient is proposed');
  const reply = crm().prepare("SELECT * FROM sources WHERE origin = 'gmail' AND external_id = 'm3'").get();
  assert.strictEqual(reply.space, 'personal');
  assert.strictEqual(reply.atomise_status, 'held', 'held until Douglas says who Ruairí is');
  assert.strictEqual(crm().prepare("SELECT 1 FROM sources WHERE external_id = 'm4'").get(), undefined, 'a Work contact writing to Gmail stays out of Personal');
  assert.strictEqual(crm().prepare("SELECT 1 FROM sources WHERE external_id = 'm2'").get(), undefined);
});

test('the bootstrap proposes people emailed twice or more and stores their mail as history', async () => {
  const at = hours(24 * 20);
  const g = fakeGmail([
    { id: 'b1', sent: true, from: 'douglas@mclellan.scot', to: 'Sinéad Moran <sinead@example.ie>', subject: 'Bread', body: 'Recipe please', at },
    { id: 'b2', sent: true, from: 'douglas@mclellan.scot', to: 'Sinéad Moran <sinead@example.ie>, help@utility.example', subject: 'Bread again', body: 'Still waiting!', at },
  ]);
  const r = await gmail.runGmailBootstrap({ gmail: g });
  assert.deepStrictEqual(r, { sent: 2, proposed: 1, stored: 2 });
  assert.ok(reviewItem('addr:email:sinead@example.ie'));
  assert.strictEqual(reviewItem('addr:email:help@utility.example'), undefined, 'one email is not enough');
  assert.strictEqual(crm().prepare("SELECT is_history FROM sources WHERE external_id = 'b1'").get().is_history, 1);
  assert.ok(setting('gmail_bootstrap_done'));
  assert.deepStrictEqual(await gmail.runGmailBootstrap({ gmail: g }), { skipped: 'already done' });
});

// ── screens ─────────────────────────────────────────────────────────────────
// ── organisations ───────────────────────────────────────────────────────────
test('organisations: one space each, domains suggest, people link', () => {
  const beacon = orgs.createOrg('work', 'Beacon Hospital');
  assert.strictEqual(orgs.createOrg('work', 'beacon hospital').id, beacon.id, 'same name is the same organisation');
  assert.strictEqual(orgs.addDomain(beacon.id, 'Jane.Whelan@BeaconHospital.ie'), 'beaconhospital.ie');
  assert.throws(() => orgs.addDomain(beacon.id, 'gmail.com'), /public email service/);
  const other = orgs.createOrg('work', 'Northwall Group');
  assert.throws(() => orgs.addDomain(other.id, 'beaconhospital.ie'), /already belongs to Beacon Hospital/);
  assert.strictEqual(orgs.orgForEmail('work', 'kealan.walters@beaconhospital.ie').id, beacon.id);
  assert.strictEqual(orgs.orgForEmail('personal', 'kealan.walters@beaconhospital.ie'), null, 'spaces never cross');

  const jane = crm().prepare("SELECT id FROM people WHERE name = 'Jane Whelan'").get().id;
  orgs.setPersonOrg(jane, beacon);
  assert.strictEqual(crm().prepare('SELECT org FROM people_v WHERE id = ?').get(jane).org, 'Beacon Hospital');
  const club = orgs.createOrg('personal', 'Munster Cricket');
  assert.throws(() => orgs.setPersonOrg(jane, club), /same space/);
  assert.throws(() => orgs.resolveChoice('work', { orgId: club.id }), /other space/);

  const n = sources.addNote({ space: 'work', text: 'Jane Whelan is leading the records retention review at Beacon Hospital.' });
  atoms.applyAtoms(n.id, [{ statement: 'Jane Whelan is leading the records retention review.', quote: 'Jane Whelan is leading the records retention review', people: ['Jane Whelan'], kind: 'fact' }], []);
  const o = views.organisation(beacon.id);
  assert.deepStrictEqual(o.members.map(m => m.name), ['Jane Whelan']);
  assert.deepStrictEqual(o.domains, ['beaconhospital.ie']);
  assert.ok(o.timeline.length >= 1, 'mail from the domain and its people appears on the timeline');
  assert.ok(o.atoms.some(a => /records retention/.test(a.statement)), "its people's facts are the organisation's facts");

  const f = outlook.parseOutlookFile(outlookFile({ from: 'Kealan Walters <Kealan.Walters@beaconhospital.ie>', to: ME, subject: 'Accounts', received: new Date(hours(1) * 1000).toISOString(), body: 'Second account is ready.', messageId: 'kw1' }));
  outlook.admitOutlookEmail(f, { fileId: 'f-kw1' });
  const item = reviewItem('addr:email:kealan.walters@beaconhospital.ie');
  const r = review.decide(item.id, { action: 'new', name: 'Kealan Walters', space: 'work', orgId: beacon.id });
  assert.strictEqual(crm().prepare('SELECT org_id FROM people WHERE id = ?').get(r.personId).org_id, beacon.id);
});

test('departments hold teams; people sit in either; moving up keeps them', () => {
  const beacon = crm().prepare("SELECT * FROM organisations WHERE name = 'Beacon Hospital'").get();
  const it = orgs.addUnit(beacon.id, { name: 'IT' });
  assert.strictEqual(it.kind, 'department');
  const help = orgs.addUnit(beacon.id, { name: 'Help Desk', parentId: it.id });
  assert.strictEqual(help.kind, 'team');
  assert.throws(() => orgs.addUnit(beacon.id, { name: 'Tier 2', parentId: help.id }), /team goes under a department/);
  assert.throws(() => orgs.addUnit(beacon.id, { name: 'it' }), /already exists/);
  const northwall = crm().prepare("SELECT * FROM organisations WHERE name = 'Northwall Group'").get();
  assert.throws(() => orgs.addUnit(northwall.id, { name: 'Ops', parentId: it.id }), /another organisation/);
  assert.ok(orgs.addUnit(northwall.id, { name: 'IT' }), 'two organisations can each have IT');

  const jane = crm().prepare("SELECT id FROM people WHERE name = 'Jane Whelan'").get().id;
  const kealan = crm().prepare("SELECT id FROM people WHERE name = 'Kealan Walters'").get().id;
  orgs.setPersonUnit(kealan, help.id);
  orgs.setPersonUnit(jane, it.id);
  const k = crm().prepare('SELECT dept, team FROM people_v WHERE id = ?').get(kealan);
  assert.deepStrictEqual({ ...k }, { dept: 'IT', team: 'Help Desk' });
  assert.deepStrictEqual(orgs.unitChoices(beacon.id).map(c => c.label), ['IT', 'IT › Help Desk']);
  assert.strictEqual(orgs.units(beacon.id)[0].people, 2, 'a department counts its teams');

  const deptView = views.organisation(beacon.id, it.id);
  assert.deepStrictEqual(deptView.members.map(m => m.name).sort(), ['Jane Whelan', 'Kealan Walters']);
  const teamView = views.organisation(beacon.id, help.id);
  assert.deepStrictEqual(teamView.members.map(m => m.name), ['Kealan Walters']);
  assert.strictEqual(teamView.parent.id, it.id);
  assert.strictEqual(views.organisation(northwall.id, help.id), null, "a team opened under the wrong organisation isn't found");

  const alec = crm().prepare("SELECT id FROM people WHERE name = 'Alec Byrne'").get().id;
  assert.throws(() => orgs.setPersonUnit(alec, help.id), /isn't in this person's organisation/);

  orgs.renameUnit(help.id, 'Service Desk');
  assert.strictEqual(crm().prepare('SELECT team FROM people_v WHERE id = ?').get(kealan).team, 'Service Desk');
  assert.strictEqual(orgs.removeUnit(help.id), 1);
  assert.strictEqual(crm().prepare('SELECT dept, team FROM people_v WHERE id = ?').get(kealan).dept, 'IT', 'a removed team moves its people up to the department');

  const ops = orgs.addUnit(beacon.id, { name: 'Ops', parentId: it.id });
  orgs.setPersonUnit(kealan, ops.id);
  orgs.removeUnit(it.id);
  assert.strictEqual(crm().prepare('SELECT COUNT(*) AS n FROM people WHERE unit_id IS NOT NULL AND org_id = ?').get(beacon.id).n, 0, 'a removed department moves everyone up to the organisation');
  assert.strictEqual(crm().prepare('SELECT COUNT(*) AS n FROM org_units WHERE org_id = ?').get(beacon.id).n, 0, 'and its teams go with it');

  const fin = orgs.addUnit(beacon.id, { name: 'Finance' });
  orgs.setPersonUnit(jane, fin.id);
  orgs.setPersonOrg(jane, northwall);
  assert.strictEqual(crm().prepare('SELECT unit_id FROM people WHERE id = ?').get(jane).unit_id, null, 'changing organisation clears the department');
  orgs.setPersonOrg(jane, beacon);
  orgs.setPersonUnit(jane, fin.id);
});

test('old free-text organisations become linked organisations', () => {
  const Database = require('better-sqlite3');
  const file = path.join(tmp, 'legacy.db');
  const old = new Database(file);
  old.exec(`CREATE TABLE people (id TEXT PRIMARY KEY, space TEXT NOT NULL, name TEXT NOT NULL, org TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', hue INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
    INSERT INTO people (id, space, name, org) VALUES ('p1', 'work', 'Ann', 'Beacon Hospital'), ('p2', 'work', 'Bo', 'beacon hospital '), ('p3', 'personal', 'Cy', 'Beacon Hospital'), ('p4', 'work', 'Di', '');`);
  old.close();
  const db = require('../lib/crm/db');
  const keep = process.env.CRM_DB_PATH;
  db._reset(); process.env.CRM_DB_PATH = file;
  try {
    const rows = db.crm().prepare('SELECT id, space, org_id, org FROM people_v ORDER BY id').all();
    assert.strictEqual(rows[0].org_id, rows[1].org_id, 'the same name in one space is one organisation');
    assert.notStrictEqual(rows[2].org_id, rows[0].org_id, 'each space gets its own');
    assert.deepStrictEqual(rows.map(r => r.org), ['Beacon Hospital', 'Beacon Hospital', 'Beacon Hospital', '']);
    assert.ok(db.crm().prepare('PRAGMA table_info(people)').all().some(c => c.name === 'org_legacy'));
    db._reset();
    assert.strictEqual(db.crm().prepare('SELECT COUNT(*) AS n FROM organisations').get().n, 2, 'running again changes nothing');
  } finally {
    db._reset(); process.env.CRM_DB_PATH = keep;
  }
});

test('every CRM screen renders for the signed-in owner', async () => {
  const express = require('express');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = { adminUser: 'douglas' }; next(); });
  app.use(require('../routes/crm'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const jane = crm().prepare("SELECT id FROM people WHERE name = 'Jane Whelan'").get().id;
    const project = crm().prepare("SELECT id FROM projects WHERE name = 'M365 Rollout'").get().id;
    const topic = crm().prepare("SELECT id FROM topics WHERE space = 'work' LIMIT 1").get().id;
    const src = crm().prepare("SELECT id FROM sources WHERE raw_ref = 'f-jane-1'").get().id;
    const beacon = crm().prepare("SELECT id FROM organisations WHERE name = 'Beacon Hospital'").get().id;
    const pages = ['/crm/work', '/crm/personal', '/crm/work/people', `/crm/work/people/${jane}`, '/crm/review',
      '/crm/work/organisations', `/crm/work/organisations/${beacon}`, '/crm/work/search?q=beacon',
      `/crm/work/organisations/${beacon}/units/${crm().prepare("SELECT id FROM org_units WHERE name = 'Finance'").get().id}`,
      '/crm/work/captured', '/crm/work/captured?filter=attention', `/crm/work/sources/${src}`, '/crm/work/projects',
      `/crm/work/projects/${project}`, `/crm/work/topics/${topic}`, '/crm/work/search?q=purview', '/crm/personal/note'];
    for (const kind of ['person', 'mention', 'project']) {
      const it = crm().prepare("SELECT id FROM review_items WHERE kind = ? AND status = 'open' LIMIT 1").get(kind);
      if (it) pages.push(`/crm/review?item=${it.id}`);
    }
    for (const p of pages) {
      const res = await fetch(base + p);
      const body = await res.text();
      assert.strictEqual(res.status, 200, `${p} → ${res.status}: ${body.slice(0, 300)}`);
      assert.match(body, /<h1/, `${p} has a title`);
    }
    assert.strictEqual((await fetch(`${base}/crm/elsewhere`)).status, 404);
    const personal = await (await fetch(`${base}/crm/personal/people/${jane}`, { redirect: 'manual' }));
    assert.strictEqual(personal.status, 302, 'a Work person opened under Personal is sent to their own space');
  } finally {
    server.close();
  }
});
