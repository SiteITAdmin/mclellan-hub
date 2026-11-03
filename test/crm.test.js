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
const promises = require('../lib/crm/promises');
const tasks = require('../lib/crm/tasks');
const cleanup = require('../lib/crm/cleanup');
const standings = require('../lib/crm/standings');
const wispr = require('../lib/crm/wispr');

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

// ── Promises ────────────────────────────────────────────────────────────────
function promiseSource(space, { direction = 'out', text, ageDays = 0, isHistory = null, title = `Promise test ${Math.random()}`, participants = [] }) {
  return sources.admitSource({
    space, kind: 'email', origin: 'test', externalId: `p-${Math.random()}`, title, direction, text, participants,
    occurredAt: Math.floor(Date.now() / 1000) - ageDays * 86400, isHistory,
  }).source;
}

function promiseAtom(source, statement, quote, promise, extra = {}) {
  atoms.applyAtoms(source.id, [{ statement, kind: 'promise', quote, people: [], projects: [], topics: [], confidence: 'high', promise, ...extra }], extra.related || []);
  return crm().prepare('SELECT * FROM atoms WHERE statement = ?').get(statement);
}

const MINE = { direction: 'mine', who: 'Jane Whelan', action: 'send the DPIA draft', due: '2026-12-01', certainty: 'clear' };

test('a clear promise of Douglas\'s in fresh sent mail becomes one task, once, linked to its context', async () => {
  const s = promiseSource('work', { text: "I'll send you the DPIA draft by 1 December." });
  const a = promiseAtom(s, 'Douglas will send Jane Whelan the DPIA draft by 1 December 2026.', "I'll send you the DPIA draft", MINE);
  assert.strictEqual(promises.get(a.id).certainty, 'clear');
  assert.strictEqual(promises.ledger('work').mine.some(p => p.atom_id === a.id), true);

  await promises.run();
  assert.strictEqual(promises.get(a.id).task_id, null, "Jane's mail is checked first, in case it's already done");
  crm().prepare('UPDATE promises SET looked_back_at = unixepoch() WHERE atom_id = ?').run(a.id);
  await promises.run();
  await promises.run();
  const p = promises.get(a.id);
  assert.ok(p.task_id, 'a task was created');
  assert.strictEqual(crm().prepare('SELECT COUNT(*) AS n FROM tasks WHERE id IN (SELECT task_id FROM promises WHERE atom_id = ?)').get(a.id).n, 1);
  const t = tasks.detail(tasks.get(p.task_id));
  assert.strictEqual(t.title, 'Send the DPIA draft');
  assert.strictEqual(t.due, '2026-12-01');
  assert.strictEqual(t.origin, 'promise');
  assert.strictEqual(t.context.sourceId, s.id);
  assert.strictEqual(t.people[0].name, 'Jane Whelan', 'the matcher, not the model, linked the person');
  assert.match(t.notes, /“I'll send you the DPIA draft”/);
  assert.strictEqual(crm().prepare('SELECT atomise_status FROM sources WHERE id = ?').get(t.source_id).atomise_status, 'ignored', 'its text is not read back into a second fact');
  assert.ok(crm().prepare("SELECT 1 FROM effects WHERE module = 'crm_promises' AND entity_id = ?").get(p.task_id), 'the task records what caused it');

  assert.ok(!views.today('work').tasks.some(x => x.id === p.task_id), 'Today shows it once, in You owe');
  tasks.edit(p.task_id, { status: 'completed' });
  assert.ok(!promises.ledger('work').mine.some(x => x.atom_id === a.id), 'ticking the task closes the promise');
  assert.strictEqual(promises.closed('work').find(x => x.atom_id === a.id).why, 'Task ticked off');
  tasks.edit(p.task_id, { status: 'needsAction' });
  assert.ok(promises.ledger('work').mine.some(x => x.atom_id === a.id), 'reopening it in Google reopens the promise');
  tasks.edit(p.task_id, { status: 'deleted' });
  await promises.run();
  assert.strictEqual(promises.makeTask(a.id).status, 'deleted', 'a deleted task is never replaced');
});

test('a clear promise needs the source to bear it out', async () => {
  const fromSomeoneElse = promiseAtom(promiseSource('work', { direction: 'in', text: 'Douglas will update the licence list.' }),
    'Douglas will update the licence list according to the minutes.', 'Douglas will update the licence list', { ...MINE, action: 'update the licence list', who: null });
  const quoted = promiseAtom(promiseSource('work', { text: 'Thanks.\n\n________________\nFrom: Me\nSent: Monday\nI will archive the mailbox.' }),
    'Douglas will archive the mailbox, per an earlier email.', 'I will archive the mailbox', { ...MINE, action: 'archive the mailbox', who: null });
  const invented = promiseAtom(promiseSource('work', { text: 'Nothing about that here.' }),
    'Douglas will rebuild the portal.', 'I will rebuild the portal', { ...MINE, action: 'rebuild the portal', who: null });
  const vague = promiseAtom(promiseSource('work', { text: "I'll be in touch about the portal." }),
    'Douglas will be in touch about the portal.', "I'll be in touch about the portal", { ...MINE, action: 'get in touch about the portal', who: null, certainty: 'unsure' });
  for (const a of [fromSomeoneElse, quoted, invented, vague]) assert.strictEqual(promises.get(a.id).certainty, 'unsure', a.statement);
  await promises.run();
  for (const a of [fromSomeoneElse, quoted, invented, vague]) assert.strictEqual(promises.get(a.id).task_id, null, 'waits on Today instead');
  assert.ok(promises.ledger('work').mine.some(p => p.atom_id === vague.id));

  const made = promises.makeTask(vague.id);
  assert.strictEqual(made.title, 'Get in touch about the portal', 'Create task works from Today');
  promises.close(invented.id, 'dismissed', 'douglas');
  assert.ok(!promises.ledger('work').mine.some(p => p.atom_id === invented.id), 'Not a task takes it off');
  promises.reopen(invented.id);
  assert.ok(promises.ledger('work').mine.some(p => p.atom_id === invented.id));
  promises.close(invented.id, 'dismissed', 'douglas');
  promises.close(fromSomeoneElse.id, 'dismissed', 'douglas');
  promises.close(quoted.id, 'dismissed', 'douglas');
});

test('old mail, other people\'s promises and task text never become tasks', async () => {
  const old = promiseAtom(promiseSource('work', { text: 'I will renew the contract.', ageDays: 8 }), 'Douglas will renew the contract.', 'I will renew the contract', { ...MINE, action: 'renew the contract', who: null });
  const hist = promiseAtom(promiseSource('work', { text: 'I will check the backups.', isHistory: true }), 'Douglas will check the backups.', 'I will check the backups', { ...MINE, action: 'check the backups', who: null });
  const others = promiseAtom(promiseSource('work', { text: 'Kealan will keep the tracker.' }), 'Kealan Walters will keep the tracker.', 'Kealan will keep the tracker', { direction: 'other', who: 'Kealan Walters', action: 'keep the tracker', certainty: 'clear' });
  for (const a of [old, hist, others]) assert.strictEqual(promises.get(a.id).state, 'untracked', a.statement);
  await promises.run();
  for (const a of [old, hist, others]) assert.strictEqual(promises.get(a.id).task_id, null);

  const src = sources.admitSource({ space: 'work', kind: 'task', origin: 'test', externalId: 'task-text', title: 'Purview', text: 'Help with the DSAR', occurredAt: Math.floor(Date.now() / 1000) }).source;
  atoms.applyAtoms(src.id, [{ statement: 'Douglas has an open task to help with the DSAR.', kind: 'promise', quote: 'Help with the DSAR', confidence: 'high', promise: MINE }]);
  assert.strictEqual(crm().prepare("SELECT kind FROM atoms WHERE statement = 'Douglas has an open task to help with the DSAR.'").get().kind, 'fact');
});

test('a promise owed to Douglas gets one chase task after seven days, or after its later date', async () => {
  const quoteText = 'I will send the quote for Microsoft Project.';
  const owed = { direction: 'owed_to_me', who: 'Duncan Sackfield', action: 'send the Microsoft Project quote', due: null, certainty: 'clear' };
  const recent = promiseAtom(promiseSource('work', { direction: 'in', text: quoteText }), 'Duncan Sackfield will send a quote today.', 'I will send the quote', owed);
  await promises.run();
  assert.strictEqual(promises.get(recent.id).task_id, null, 'six days of patience first');
  assert.ok(promises.ledger('work').owed.some(p => p.atom_id === recent.id));

  crm().prepare('UPDATE promises SET said_at = said_at - ? WHERE atom_id = ?').run(7 * 86400 + 60, recent.id);
  await promises.run();
  const t = tasks.get(promises.get(recent.id).task_id);
  assert.strictEqual(t.title, 'Chase Duncan Sackfield: send the Microsoft Project quote');
  await promises.run();
  assert.strictEqual(crm().prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE 'Chase Duncan%'").get().n, 1, 'one chase, ever');

  const future = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const later = promiseAtom(promiseSource('work', { direction: 'in', text: 'I will deliver the licences by then.' }), 'Duncan Sackfield will deliver the licences.', 'I will deliver the licences', { ...owed, action: 'deliver the licences', due: future });
  crm().prepare('UPDATE promises SET said_at = said_at - ? WHERE atom_id = ?').run(8 * 86400, later.id);
  await promises.run();
  assert.strictEqual(promises.get(later.id).task_id, null, 'not before the date they gave');

  const expired = promiseAtom(promiseSource('work', { direction: 'in', text: 'I will share the slides soon.' }), 'Duncan Sackfield will share the slides.', 'I will share the slides', { ...owed, action: 'share the slides' });
  crm().prepare('UPDATE promises SET said_at = said_at - ? WHERE atom_id = ?').run(15 * 86400, expired.id);
  await promises.run();
  assert.strictEqual(promises.get(expired.id).state, 'stale', 'an outage retires it rather than chasing weeks late');
  assert.strictEqual(promises.get(expired.id).task_id, null);

  const vague = promiseAtom(promiseSource('work', { direction: 'in', text: 'I will keep you posted.' }), 'Jane Whelan will keep Douglas posted.', 'I will keep you posted', { ...owed, who: 'Jane Whelan', action: 'keep Douglas posted', certainty: 'unsure' });
  crm().prepare('UPDATE promises SET said_at = said_at - ? WHERE atom_id = ?').run(8 * 86400, vague.id);
  await promises.run();
  assert.strictEqual(promises.get(vague.id).task_id, null, 'nothing specific to chase');
});

test('a later email can show a promise was kept, but only with its own words and a known id', async () => {
  const owed = { direction: 'owed_to_me', who: 'Duncan Sackfield', action: 'send the Purview quote', certainty: 'clear' };
  const a = promiseAtom(promiseSource('work', { direction: 'in', text: 'I will send the Purview quote.' }), 'Duncan Sackfield will send the Purview quote.', 'I will send the Purview quote', owed);
  const reply = promiseSource('work', { direction: 'in', text: 'Purview quote attached as promised.' });
  assert.match(atoms.buildPacket(reply).userPrompt, new RegExp(`\\[${a.id}\\]`), 'the model is shown open promises');

  atoms.applyAtoms(reply.id, [], [a.id], [{ id: a.id, quote: 'words not in this email' }]);
  assert.strictEqual(promises.get(a.id).state, 'open');
  atoms.applyAtoms(reply.id, [], [], [{ id: a.id, quote: 'Purview quote attached as promised', certainty: 'clear' }]);
  assert.strictEqual(promises.get(a.id).state, 'open', 'an id the model was not given is refused');
  atoms.applyAtoms(reply.id, [], [a.id], [{ id: a.id, quote: 'Purview quote attached as promised', certainty: 'likely' }]);
  assert.strictEqual(promises.get(a.id).state, 'open', 'a likely match only asks');
  assert.strictEqual(promises.get(a.id).looks_done_source_id, reply.id);
  atoms.applyAtoms(reply.id, [], [a.id], [{ id: a.id, quote: 'Purview quote attached as promised', certainty: 'clear' }]);
  assert.strictEqual(promises.get(a.id).state, 'kept');
  assert.strictEqual(promises.get(a.id).looks_done_source_id, null);
  assert.strictEqual(promises.closed('work').find(x => x.atom_id === a.id).closing_source_id, reply.id);

  const mine = promiseAtom(promiseSource('work', { text: 'I will book the room.' }), 'Douglas will book the room.', 'I will book the room', { ...MINE, action: 'book the room', who: null, due: null });
  await promises.run();
  const taskId = promises.get(mine.id).task_id;
  const sent = promiseSource('work', { text: 'Room is booked.' });
  atoms.applyAtoms(sent.id, [], [mine.id], [{ id: mine.id, quote: 'Room is booked', certainty: 'clear' }]);
  assert.strictEqual(tasks.get(taskId).status, 'completed', 'its open task closes too');
});

const checksDoneSoFar = () => crm().prepare('UPDATE promises SET looked_back_at = unixepoch(), final_checked_at = unixepoch()').run();

test('existing mail is checked when a promise is recorded and again before a chase', async () => {
  checksDoneSoFar();
  const john = [{ role: 'from', email: 'john.check@example.com', name: 'John Check' }, { role: 'to', email: 'douglas@mclellan.scot' }];
  const owed = { direction: 'owed_to_me', who: 'John Check', action: 'confirm the new session date', certainty: 'clear' };
  const earlier = promiseSource('personal', { direction: 'in', participants: john, ageDays: 1, title: 'Rescheduled session', text: "I've moved it to next Tuesday at 5pm." });
  const unrelated = promiseSource('personal', { direction: 'in', participants: [{ role: 'from', email: 'someone.else@example.com' }], ageDays: 1, title: 'Other', text: 'Nothing to do with it.' });
  const old = promiseSource('personal', { direction: 'in', participants: john, ageDays: 6, title: 'Way back', text: 'Too early to matter.' });
  const a = promiseAtom(promiseSource('personal', { direction: 'in', participants: john, text: 'I will contact you to confirm the date.' }), 'John Check will confirm the new session date.', 'I will contact you to confirm the date', owed);

  const shown = promises.checkEmails(promises.get(a.id)).map(s => s.id);
  assert.ok(shown.includes(earlier.id), 'mail from that person just before the promise is shown');
  assert.ok(!shown.includes(unrelated.id), 'mail from others is not');
  assert.ok(!shown.includes(old.id), 'nor is mail from well before it');

  let job = { status: 'pending' };
  const enqueued = [];
  const jobs = { enqueue: e => { enqueued.push(e); return { jobId: 'c1' }; }, getJob: () => job };
  const parse = JSON.parse;
  assert.strictEqual(promises.enqueueCheck(jobs), true);
  assert.match(enqueued[0].payload.userPrompt, /moved it to next Tuesday/);
  assert.strictEqual(promises.checking(), true);
  assert.strictEqual(promises.collectCheck(jobs, parse), null, 'still waiting');

  job = { status: 'completed', result: { output: JSON.stringify({ verdict: 'done', source_id: earlier.id, quote: 'words that are not there' }) } };
  assert.strictEqual(promises.collectCheck(jobs, parse).verdict, 'done');
  assert.strictEqual(promises.get(a.id).state, 'open', 'a claim without its words closes nothing');
  assert.ok(promises.get(a.id).looked_back_at, 'but the look back is finished');
  assert.strictEqual(promises.enqueueCheck(jobs), false, 'and is not repeated');

  crm().prepare('UPDATE promises SET said_at = said_at - ? WHERE atom_id = ?').run(7 * 86400 - 3600, a.id);
  assert.strictEqual(promises.enqueueCheck(jobs), true, 'six hours before the chase the mail is read again');
  job = { status: 'completed', result: { output: JSON.stringify({ verdict: 'done', source_id: earlier.id, quote: "I've moved it to next Tuesday" }) } };
  promises.collectCheck(jobs, parse);
  assert.strictEqual(promises.get(a.id).state, 'kept', 'the real words close it, as with the rescheduled session');
  assert.strictEqual(promises.closed('personal').find(x => x.atom_id === a.id).closing_source_id, earlier.id);
});

test('a final check stops a chase, a likely match asks first, and a failing check still chases', async () => {
  checksDoneSoFar();
  const from = email => [{ role: 'from', email }, { role: 'to', email: 'douglas@mclellan.scot' }];
  const owed = { direction: 'owed_to_me', who: 'Ann Final', action: 'send the slides', certainty: 'clear' };
  const setup = (email, later) => {
    const a = promiseAtom(promiseSource('personal', { direction: 'in', participants: from(email), text: `I will send the slides ${email}.` }), `Ann will send the slides ${email}.`, `I will send the slides ${email}`, owed);
    const reply = promiseSource('personal', { direction: 'in', participants: from(email), text: later });
    crm().prepare('UPDATE promises SET looked_back_at = unixepoch(), said_at = said_at - ? WHERE atom_id = ?').run(7 * 86400 + 60, a.id);
    crm().prepare('UPDATE sources SET occurred_at = ? WHERE id = ?').run(promises.get(a.id).said_at + 3600, reply.id);
    return { a, reply };
  };
  const answer = (verdict, sourceId, quote) => {
    const jobs = { enqueue: () => ({ jobId: 'f' }), getJob: () => ({ status: 'completed', result: { output: JSON.stringify({ verdict, source_id: sourceId, quote }) } }) };
    assert.strictEqual(promises.enqueueCheck(jobs), true);
    promises.collectCheck(jobs, JSON.parse);
  };

  const done = setup('ann1@example.com', 'Slides attached here.');
  await promises.run();
  assert.strictEqual(promises.get(done.a.id).task_id, null, 'no chase before the final check');
  answer('done', done.reply.id, 'Slides attached here');
  assert.strictEqual(promises.get(done.a.id).state, 'kept');
  await promises.run();
  assert.strictEqual(promises.get(done.a.id).task_id, null, 'and none after it closed');
  promises.reopen(done.a.id);
  assert.ok(!promises.checkEmails(promises.get(done.a.id)).some(s => s.id === done.reply.id), 'putting it back rules that email out');
  promises.close(done.a.id, 'dismissed', 'douglas');

  const likely = setup('ann2@example.com', 'That should be sorted now.');
  answer('looks_done', likely.reply.id, 'should be sorted now');
  assert.strictEqual(promises.get(likely.a.id).looks_done_source_id, likely.reply.id);
  await promises.run();
  assert.strictEqual(promises.get(likely.a.id).task_id, null, 'no chase while it waits for Douglas');
  assert.ok(promises.ledger('personal').owed.some(p => p.atom_id === likely.a.id), 'it stays on Today');
  promises.notDone(likely.a.id);
  assert.strictEqual(promises.get(likely.a.id).looks_done_source_id, null);
  await promises.run();
  assert.ok(promises.get(likely.a.id).task_id, 'told not done, the chase goes out');
  assert.ok(!promises.checkEmails(promises.get(likely.a.id)).some(s => s.id === likely.reply.id));
  promises.close(likely.a.id, 'dismissed', 'douglas');

  const broken = setup('ann3@example.com', 'Something about slides.');
  const jobs = { enqueue: () => ({ jobId: 'b' }), getJob: () => ({ status: 'failed', error: 'worker crashed' }) };
  for (let i = 0; i < 3; i++) { assert.strictEqual(promises.enqueueCheck(jobs), true); promises.collectCheck(jobs, JSON.parse); }
  assert.strictEqual(promises.checkFailed('personal'), 1);
  assert.ok(views.health('personal').some(h => /couldn't be checked/.test(h.text)), 'the failure shows on Today');
  await promises.run();
  assert.ok(promises.get(broken.a.id).task_id, 'and the chase still goes out');
  promises.close(broken.a.id, 'dismissed', 'douglas');
});

test('the same promise twice is one task; a changed promise keeps its task on the new date', async () => {
  const text = 'I will call the vendor on Friday.';
  const statement = 'Douglas will call the vendor on Friday.';
  const a = promiseAtom(promiseSource('work', { text }), statement, 'I will call the vendor', { ...MINE, action: 'call the vendor', who: null, due: '2026-12-04' });
  atoms.applyAtoms(promiseSource('work', { text }).id, [{ statement, kind: 'promise', quote: 'I will call the vendor', confidence: 'high', promise: { ...MINE, action: 'call the vendor', who: null } }]);
  assert.strictEqual(crm().prepare('SELECT COUNT(*) AS n FROM atoms WHERE statement = ?').get(statement).n, 1);
  await promises.run();
  const taskId = promises.get(a.id).task_id;
  const next = promiseSource('work', { text: 'I will call the vendor on Monday instead.' });
  const b = promiseAtom(next, 'Douglas will call the vendor on Monday.', 'I will call the vendor on Monday', { ...MINE, action: 'call the vendor', who: null, due: '2026-12-07' }, { supersedes: a.id, related: [a.id] });
  await promises.run();
  assert.strictEqual(promises.get(b.id).task_id, taskId);
  assert.strictEqual(tasks.get(taskId).due, '2026-12-07');
  assert.strictEqual(crm().prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Call the vendor'").get().n, 1);
  assert.ok(!promises.ledger('work').mine.some(p => p.atom_id === a.id));
  tasks.edit(taskId, { status: 'completed' });
});

test('promises read before the ledger are sorted in batches, and a failing lane is reported', async () => {
  const old = sources.admitSource({ space: 'personal', kind: 'email', origin: 'test', externalId: 'sort-1', title: 'Sort', direction: 'in', text: 'I will send the agreement. Please review the policy.', occurredAt: Math.floor(Date.now() / 1000) }).source;
  atoms.applyAtoms(old.id, [
    { statement: 'John Reilly will send the agreement.', kind: 'promise', quote: 'I will send the agreement', confidence: 'high' },
    { statement: 'Nakai is asked to review the policy.', kind: 'promise', quote: 'Please review the policy', confidence: 'high' },
  ]);
  assert.strictEqual(promises.unsorted().length, 2);
  let job = { status: 'pending' };
  const enqueued = [];
  const jobs = { enqueue: e => { enqueued.push(e); return { jobId: 'j1' }; }, getJob: () => job };
  assert.strictEqual(promises.enqueueClassify(jobs), true);
  assert.strictEqual(promises.classifying(), true);
  assert.strictEqual(promises.enqueueClassify(jobs), false, 'one batch at a time');
  assert.strictEqual(promises.collectClassified(jobs, JSON.parse), null);

  const ids = promises.unsorted().map(a => a.id);
  const john = ids.find(id => crm().prepare('SELECT statement FROM atoms WHERE id = ?').get(id).statement.startsWith('John'));
  const nakai = ids.find(id => id !== john);
  job = { status: 'completed', result: { output: JSON.stringify({ promises: [
    { id: john, direction: 'owed_to_me', who: 'John Reilly', action: 'send the agreement', certainty: 'clear' },
    { id: nakai, not_a_promise: true },
    { id: 'made-up', direction: 'mine', action: 'nothing' },
  ] }) } };
  assert.strictEqual(promises.collectClassified(jobs, JSON.parse).sorted, 2);
  assert.strictEqual(promises.get(john).certainty, 'clear');
  assert.ok(promises.ledger('personal').owed.some(p => p.atom_id === john));
  assert.strictEqual(crm().prepare('SELECT kind FROM atoms WHERE id = ?').get(nakai).kind, 'fact');
  assert.strictEqual(promises.get('made-up'), null);

  const retry = sources.admitSource({ space: 'personal', kind: 'email', origin: 'test', externalId: 'sort-2', title: 'Sort', direction: 'in', text: 'I will phone.', occurredAt: Math.floor(Date.now() / 1000) }).source;
  atoms.applyAtoms(retry.id, [{ statement: 'Someone will phone Douglas.', kind: 'promise', quote: 'I will phone', confidence: 'high' }]);
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(promises.enqueueClassify(jobs), true, 'try ' + i);
    job = { status: 'completed', result: { output: 'not json' } };
    promises.collectClassified(jobs, s => JSON.parse(s));
  }
  assert.strictEqual(promises.enqueueClassify(jobs), false, 'stops asking');
  assert.strictEqual(promises.classifyStuck('personal'), 1);
  assert.ok(views.health('personal').some(h => /couldn't be sorted/.test(h.text)), 'and says so on Today');
  crm().prepare("DELETE FROM atoms WHERE statement = 'Someone will phone Douglas.'").run();
  crm().prepare("DELETE FROM settings WHERE key = 'promise_classify_fails'").run();
});

test('Nakai\'s automated reports are removed once and never captured again', () => {
  const report = (title, to = 'nakai@mclellan.scot') => sources.admitSource({
    space: 'personal', kind: 'email', origin: 'gmail', externalId: `report-${title}-${to}`, title, direction: 'out', text: 'Nakai is asked to read the speech.',
    occurredAt: Math.floor(Date.now() / 1000) - 86400, participants: [{ role: 'from', email: 'douglas@mclellan.scot' }, { role: 'to', email: to }],
  }).source;
  const briefing = report('Daily Briefing 059 - 16 August 2026');
  const special = report('US Block Special Edition - 3 August 2026');
  const real = report('Lunch on Friday');
  const toJohn = report('Daily Briefing 001', 'reillyjb@gmail.com');
  const older = promiseSource('personal', { text: 'The audit is in May.' });
  atoms.applyAtoms(older.id, [{ statement: 'The audit is in May.', kind: 'fact', quote: 'The audit is in May', topics: ['audit timing'], confidence: 'high' }]);
  const olderId = crm().prepare("SELECT id FROM atoms WHERE statement = 'The audit is in May.'").get().id;
  atoms.applyAtoms(briefing.id, [
    { statement: 'The audit is in June.', kind: 'fact', quote: 'Nakai is asked', topics: ['briefing only topic'], confidence: 'high', supersedes: olderId },
    { statement: 'Nakai is asked to read the speech.', kind: 'promise', quote: 'Nakai is asked to read the speech', confidence: 'high' },
  ], [olderId]);
  assert.strictEqual(crm().prepare('SELECT status FROM atoms WHERE id = ?').get(olderId).status, 'superseded');
  atoms.applyAtoms(real.id, [{ statement: 'Lunch is on Friday.', kind: 'fact', quote: 'Nakai is asked to read', confidence: 'high' }]);
  atoms.applyAtoms(special.id, [{ statement: 'Lunch is on Friday.', kind: 'fact', quote: 'Nakai is asked to read', confidence: 'high' }]);

  const r = cleanup.removeNakaiReports();
  assert.strictEqual(r.sources, 2, 'both report types, and nothing else');
  for (const s of [briefing, special]) assert.strictEqual(crm().prepare('SELECT 1 FROM sources WHERE id = ?').get(s.id), undefined);
  for (const s of [real, toJohn]) assert.ok(crm().prepare('SELECT 1 FROM sources WHERE id = ?').get(s.id), s.title);
  assert.strictEqual(crm().prepare("SELECT 1 FROM atoms WHERE statement = 'Nakai is asked to read the speech.'").get(), undefined);
  assert.strictEqual(crm().prepare("SELECT 1 FROM topics WHERE name = 'briefing only topic'").get(), undefined);
  assert.strictEqual(crm().prepare("SELECT 1 FROM atoms_fts WHERE statement MATCH 'speech'").get(), undefined);
  assert.strictEqual(crm().prepare('SELECT status FROM atoms WHERE id = ?').get(olderId).status, 'active', 'what a report replaced comes back');
  assert.ok(crm().prepare("SELECT 1 FROM atoms WHERE statement = 'Lunch is on Friday.'").get(), 'a fact another email supports stays');
  assert.strictEqual(cleanup.removeNakaiReports(), null, 'runs once');

  const meta = { labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'douglas@mclellan.scot' }, { name: 'To', value: 'nakai@mclellan.scot' }, { name: 'Subject', value: 'Daily Briefing 098 - 24 September 2026' }] } };
  assert.strictEqual(gmail.classify(meta).why, 'nakai_report');
  meta.payload.headers[1].value = 'nakai@mclellan.scot, reillyjb@gmail.com';
  assert.strictEqual(gmail.classify(meta).keep, true, 'mail with a real recipient is kept');
});

test('where things stand: written from cited facts, only when they change, and failures show', () => {
  const clear = () => {
    crm().prepare("UPDATE standings SET tried_at = unixepoch()").run();
    for (let due = standings.nextDue(); due; due = standings.nextDue()) {
      crm().prepare(`INSERT INTO standings (entity_type, entity_id, space, fingerprint, tried_at) VALUES (?, ?, 'work', '', unixepoch())
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET tried_at = unixepoch()`).run(due.type, due.id);
    }
  };
  clear();
  const project = review.createProject('work', 'Standing Test');
  const source = promiseSource('work', { direction: 'in', text: 'Budget is 10k. Launch is in May. Vendor is Acme. Launch moved to June.' });
  const fact = (statement, quote) => ({ statement, kind: 'fact', quote, projects: ['Standing Test'], confidence: 'high' });
  assert.strictEqual(standings.forEntity('project', project.id).tooFew, true);
  atoms.applyAtoms(source.id, [fact('Standing Test budget is 10k.', 'Budget is 10k'), fact('Standing Test launch is in May.', 'Launch is in May')]);
  assert.strictEqual(standings.nextDue(), null, 'two facts are not worth a summary');
  atoms.applyAtoms(source.id, [fact('Standing Test vendor is Acme.', 'Vendor is Acme')]);
  const facts = standings.factsFor('project', project.id);
  assert.strictEqual(standings.nextDue().id, project.id);
  assert.strictEqual(standings.forEntity('project', project.id).waiting, true);

  let job = { status: 'pending' };
  const enqueued = [];
  const jobs = { enqueue: e => { enqueued.push(e); return { jobId: 's1' }; }, getJob: () => job };
  const write = reply => {
    assert.strictEqual(standings.enqueueNext(jobs), true);
    job = { status: 'completed', result: { output: JSON.stringify(reply) } };
    return standings.collect(jobs, JSON.parse);
  };
  assert.strictEqual(standings.enqueueNext(jobs), true);
  assert.match(enqueued[0].payload.userPrompt, /Project: Standing Test/);
  assert.match(enqueued[0].payload.userPrompt, /vendor is Acme/);
  assert.strictEqual(standings.enqueueNext(jobs), false, 'one at a time');
  assert.strictEqual(standings.collect(jobs, JSON.parse), null, 'still waiting');
  crm().prepare("DELETE FROM settings WHERE key = 'standing_job'").run();

  assert.match(write({ lines: [{ text: 'Invented.', facts: ['not-a-fact'] }] }).error, /cited a fact/, 'a line with no real fact is refused');
  assert.strictEqual(standings.forEntity('project', project.id).lines.length, 0);
  const saved = write({ lines: [
    { text: 'Launch is in May and the vendor is Acme.', facts: [facts[0].id, facts[1].id] },
    { text: 'This one has no support.', facts: [] },
    { text: 'Budget is 10k.', facts: [facts[2].id, 'also-not-a-fact'] },
  ] });
  assert.strictEqual(saved.lines, 2);
  const view = standings.forEntity('project', project.id);
  assert.strictEqual(view.lines.length, 2);
  assert.strictEqual(view.lines[0].sources[0].id, source.id);
  assert.strictEqual(views.project(project.id).standing.lines.length, 2);
  assert.strictEqual(standings.nextDue(), null, 'nothing changed, nothing to write');

  atoms.applyAtoms(source.id, [{ ...fact('Standing Test launch moved to June.', 'Launch moved to June') }]);
  assert.strictEqual(standings.nextDue(), null, 'at most once a day');
  assert.strictEqual(standings.forEntity('project', project.id).behind, 1, 'the page says a fact has arrived since');
  const may = facts.find(f => /May/.test(f.statement));
  crm().prepare("UPDATE atoms SET status = 'superseded' WHERE id = ?").run(may.id);
  assert.strictEqual(standings.forEntity('project', project.id).lines.find(l => /May/.test(l.text)).changed, true, 'a line on a changed fact is flagged');
  crm().prepare("UPDATE standings SET tried_at = 0 WHERE entity_id = ?").run(project.id);
  assert.strictEqual(standings.nextDue().id, project.id, 'the next day it rewrites');

  for (let i = 0; i < 3; i++) {
    assert.strictEqual(standings.enqueueNext(jobs), true);
    job = { status: 'failed', error: 'worker crashed' };
    standings.collect(jobs, JSON.parse);
  }
  assert.strictEqual(standings.nextDue(), null, 'failures rest for a day instead of looping');
  assert.strictEqual(standings.forEntity('project', project.id).lines.length, 2, 'the old version stays');
  assert.ok(views.health('work').some(h => /Where things stand/.test(h.text)));
  assert.strictEqual(standings.enqueueNext({ ...jobs }), false);
  crm().prepare("UPDATE standings SET error = ''").run();
});

test('wispr: the device sign-in connects one space, records the tools, and refreshes its token', async () => {
  const calls = [];
  let tokenReplies = [{ error: 'authorization_pending' }, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }];
  const reply = (status, body, headers = {}) => ({
    status, ok: status < 400,
    headers: { get: h => ({ 'content-type': 'application/json', ...headers })[h.toLowerCase()] || null },
    json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  wispr._setHttp(async (url, opts) => {
    const body = opts.headers['Content-Type'] === 'application/json' ? JSON.parse(opts.body) : Object.fromEntries(new URLSearchParams(opts.body));
    calls.push({ url, body, auth: opts.headers.Authorization, session: opts.headers['Mcp-Session-Id'] });
    if (url.endsWith('/register')) return reply(201, { client_id: 'client_test' });
    if (url.endsWith('/device_authorization')) return reply(200, { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri_complete: 'https://mcp-auth.wisprflow.com/device?user_code=ABCD-EFGH', expires_in: 300, interval: 5 });
    if (url.endsWith('/token')) {
      if (body.grant_type === 'refresh_token') return reply(200, { access_token: 'at-2', expires_in: 3600 });
      return reply(tokenReplies[0].error ? 400 : 200, tokenReplies.shift());
    }
    if (body.method === 'initialize') return reply(200, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'sess-1' });
    if (body.method === 'notifications/initialized') return reply(202, '');
    if (body.method === 'tools/list') return reply(200, `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'search_meetings', inputSchema: { type: 'object' } }, { name: 'get_account_info', inputSchema: {} }] } })}\n\n`, { 'content-type': 'text/event-stream' });
    if (body.method === 'tools/call') return reply(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ email: 'douglas.mclellan@beaconhospital.ie', name: 'Douglas McLellan' }) }] } });
    throw new Error(`unexpected ${url} ${body.method}`);
  });
  try {
    assert.strictEqual(wispr.status('work').connected, false);
    await wispr.startConnect('work');
    const st = wispr.status('work');
    assert.strictEqual(st.device.user_code, 'ABCD-EFGH');
    assert.strictEqual(calls.find(c => c.url.endsWith('/device_authorization')).body.resource, wispr.MCP_URL, 'the token is asked for the MCP server');
    assert.strictEqual(await wispr.pollConnect('work'), 'waiting', 'does not poll before the interval');
    const dev = JSON.parse(setting('wispr_work_device'));
    const { setSetting } = require('../lib/crm/db');
    setSetting('wispr_work_device', JSON.stringify({ ...dev, next_poll_at: 0 }));
    assert.strictEqual(await wispr.pollConnect('work'), 'waiting', 'pending sign-in keeps waiting');
    setSetting('wispr_work_device', JSON.stringify({ ...JSON.parse(setting('wispr_work_device')), next_poll_at: 0 }));
    assert.strictEqual(await wispr.pollConnect('work'), 'connected');
    const after = wispr.status('work');
    assert.ok(after.connected && !after.device);
    assert.deepStrictEqual(after.tools.map(t => t.name), ['search_meetings', 'get_account_info']);
    assert.strictEqual(after.account.email, 'douglas.mclellan@beaconhospital.ie');
    assert.ok(calls.filter(c => c.body.method === 'tools/list').every(c => c.session === 'sess-1' && c.auth === 'Bearer at-1'), 'session and token are sent');
    assert.strictEqual(wispr.status('personal').connected, false, 'personal stays unconnected');
    await assert.rejects(wispr.open('personal'), /not connected in personal/);

    const auth = JSON.parse(setting('wispr_work_auth'));
    setSetting('wispr_work_auth', JSON.stringify({ ...auth, expires_at: 0 }));
    assert.strictEqual(await wispr.accessToken('work'), 'at-2');
    assert.strictEqual(JSON.parse(setting('wispr_work_auth')).refresh_token, 'rt-1', 'an unrotated refresh token is kept');

    wispr._setHttp(async () => reply(400, { error: 'invalid_grant' }));
    setSetting('wispr_work_auth', JSON.stringify({ ...JSON.parse(setting('wispr_work_auth')), expires_at: 0 }));
    await assert.rejects(wispr.accessToken('work'), /expired/);
    assert.ok(views.health('work').some(h => /Wispr Flow meetings/.test(h.text)), 'a lost sign-in shows on Today');
    setSetting('wispr_work_error', '');
  } finally {
    wispr._setHttp((url, opts) => fetch(url, opts));
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
      `/crm/work/projects/${project}`, `/crm/work/promises`, '/crm/personal/promises', `/crm/work/topics/${topic}`, '/crm/work/search?q=purview', '/crm/personal/note', '/crm/work/meetings', '/crm/personal/meetings'];
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
