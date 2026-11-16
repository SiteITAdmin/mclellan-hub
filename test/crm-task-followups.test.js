'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-task-followups-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db'), tasks = require('../lib/crm/tasks'), sources = require('../lib/crm/sources');
const followups = require('../lib/crm/task-followups'), review = require('../lib/crm/task-review');
const promises = require('../lib/crm/promises'), jobsLib = require('../lib/crm/task-jobs'), sync = require('../lib/crm/tasks-sync');
const ejs = require('ejs');
const crm = () => db.crm();
const parse = text => JSON.parse(text);
const T = Math.floor(Date.now() / 1000);
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

function queue() {
  const q = { sent: [], job: { status: 'pending' } };
  q.enqueue = j => { q.sent.push(j); return { jobId: `job${q.sent.length}` }; };
  q.getJob = () => q.job;
  q.reply = r => { q.job = { status: 'completed', result: { output: JSON.stringify(r) } }; };
  q.queueStats = () => ({ pending: 0 });
  return q;
}
const at = (date, hh = 12) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh) / 1000;

// Mary asked for a quote by email; it became two tasks in one job.
function quoteJob() {
  const mail = sources.admitSource({ space: 'work', kind: 'email', origin: 'test', externalId: 'q1', title: 'Quote for the SharePoint migration',
    text: 'Hi Douglas, could you send me a quote for the SharePoint migration? I need to take it to the board on 2 December. Thanks, Mary Byrne', occurredAt: T - 86400 }).source;
  const draft = tasks.create('work', { title: 'Draft the SharePoint migration quote', context: { sourceId: mail.id } });
  const send = tasks.create('work', { title: 'Send the quote to Mary Byrne', context: { sourceId: mail.id } });
  const book = tasks.create('work', { title: 'Book the follow-up workshop room', context: { sourceId: mail.id } });
  jobsLib.groupBySource(T);
  return { mail, draft, send, book };
}

test('quick dates: today, tomorrow and next Monday in Dublin, whatever day it is', () => {
  assert.deepEqual(review.quickDates(at('2026-11-13')), { today: '2026-11-13', tomorrow: '2026-11-14', nextWeek: '2026-11-16' }, 'Friday');
  assert.equal(review.quickDates(at('2026-11-15')).nextWeek, '2026-11-16', 'Sunday: tomorrow is next week');
  assert.equal(review.quickDates(at('2026-11-16')).nextWeek, '2026-11-23', 'Monday: a week on, not today');
  assert.equal(review.quickDates(at('2026-11-15', 23) + 3600).today, '2026-11-16', 'past midnight UTC in winter is the next day in Dublin too');
});

test('the review page dates, finishes and drops steps, and lists late and undated first', () => {
  const { draft, send, book } = quoteJob();
  const now = at('2026-11-13');
  tasks.edit(book.id, { due: '2026-11-01' });
  assert.deepEqual(review.list('work', now).map(t => t.id), [book.id, draft.id, send.id]);
  assert.deepEqual(review.counts(review.list('work', now), now), { open: 3, undated: 2, late: 1 });

  assert.match(review.act('work', { task: draft.id, do: 'tomorrow', revision: tasks.get(draft.id).revision }, now), /due Sat, 14 Nov/);
  assert.equal(tasks.get(draft.id).due, '2026-11-14');
  review.act('work', { task: draft.id, do: 'nextweek' }, now); assert.equal(tasks.get(draft.id).due, '2026-11-16');
  review.act('work', { task: draft.id, do: 'date', due: '2026-11-20' }, now); assert.equal(tasks.get(draft.id).due, '2026-11-20');
  review.act('work', { task: draft.id, do: 'clear' }, now); assert.equal(tasks.get(draft.id).due, null);
  assert.throws(() => review.act('work', { task: draft.id, do: 'date', due: '' }, now), /Choose a date/);
  assert.throws(() => review.act('work', { task: draft.id, do: 'date', due: '2026-02-30' }, now), /valid due date/);
  assert.throws(() => review.act('personal', { task: draft.id, do: 'today' }, now), /not found/, 'never across spaces');
  assert.throws(() => review.act('work', { task: draft.id, do: 'today', revision: 1 }, now), /changed/, 'a stale page does not overwrite');

  review.act('work', { task: send.id, do: 'done', said: 'Sent it. Mary said she would come back after the board meets.' }, now);
  assert.equal(tasks.get(send.id).status, 'completed');
  assert.ok(tasks.get(send.id).completed_at >= T);
  assert.equal(crm().prepare('SELECT said FROM task_followups WHERE task_id = ?').get(send.id).said, 'Sent it. Mary said she would come back after the board meets.');
  assert.throws(() => review.act('work', { task: send.id, do: 'today' }, now), /no longer open/);
  review.act('work', { task: book.id, do: 'drop' }, now);
  assert.equal(tasks.get(book.id).status, 'deleted');
  assert.equal(crm().prepare('SELECT COUNT(*) AS n FROM task_followups WHERE task_id = ?').get(book.id).n, 0, 'a dropped step sets nothing in motion');
});

test('completed_at is stamped once, kept, cleared on reopen, and set when Google says it was finished', () => {
  const t = tasks.create('work', { title: 'Renew the domain' });
  assert.equal(tasks.get(t.id).completed_at, null);
  tasks.edit(t.id, { status: 'completed' });
  const first = tasks.get(t.id).completed_at;
  assert.ok(first);
  crm().prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(first - 50, t.id);
  tasks.edit(t.id, { notes: 'Paid by card' });
  assert.equal(tasks.get(t.id).completed_at, first - 50, 'editing a finished task keeps when it was finished');
  tasks.edit(t.id, { status: 'needsAction' });
  assert.equal(tasks.get(t.id).completed_at, null);

  const g = tasks.create('work', { title: 'Ring the bank' });
  crm().prepare("UPDATE tasks SET remote_json = ?, synced_revision = revision, google_id = 'g1', google_list_id = 'work' WHERE id = ?")
    .run(JSON.stringify({ id: 'g1', title: 'Ring the bank', notes: '', status: 'needsAction' }), g.id);
  sync.reconcile(tasks.get(g.id), { id: 'g1', title: 'Ring the bank', notes: '', status: 'completed' });
  assert.equal(tasks.get(g.id).status, 'completed');
  assert.ok(tasks.get(g.id).completed_at >= T, 'ticked in Google counts too');
  crm().prepare('UPDATE tasks SET completed_at = NULL WHERE id = ?').run(t.id);
  crm().prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(t.id);
  followups.notice(T);
  assert.deepEqual(crm().prepare('SELECT task_id FROM task_followups').all().map(r => r.task_id), [g.id], 'tasks finished before the stamp existed are never asked about');
});

test('finished tasks wait to settle, go to the Mac together, and come back as checked suggestions', () => {
  const { draft, send, book } = quoteJob();
  const q = queue();
  tasks.edit(draft.id, { status: 'completed' });
  followups.record(send.id, 'Sent it. Mary said she would come back after the board on 2 December.');
  tasks.edit(send.id, { status: 'completed' });
  const t0 = T + 5;
  assert.equal(followups.enqueueNext(q, t0), false, 'nothing goes while Douglas may still be ticking');
  assert.equal(followups.state('work', t0).thinking, 2);
  assert.equal(followups.enqueueNext(q, t0 + 200), true);
  assert.equal(q.sent.length, 1);
  const prompt = q.sent[0].payload.userPrompt;
  assert.match(prompt, /\[T1\] Finished: Draft the SharePoint migration quote/);
  assert.match(prompt, /\[T2\] Finished: Send the quote to Mary Byrne/);
  assert.match(prompt, /What Douglas said happened: “Sent it\. Mary said she would come back after the board on 2 December\.”/);
  assert.match(prompt, /Steps of that job still open: Book the follow-up workshop room/);
  assert.match(prompt, /could you send me a quote/, 'the email it came from');
  assert.equal(q.sent[0].payload.model, require('../lib/feature-runners').MODELS.opus.model);
  assert.equal(followups.enqueueNext(q, t0 + 300), false, 'one at a time');

  q.reply({ tasks: [
    { id: 'T1', followups: [] },
    { id: 'T2', followups: [
      { direction: 'owed_to_me', who: 'Mary Byrne', action: 'decide on the quote after the board meeting', due: '2026-12-02', why: 'The quote went to Mary for her board.' },
      { direction: 'mine', who: 'Fiona Invented', action: 'send Mary the migration timeline', due: 'next week', why: 'She will need it.' },
      { direction: 'mine', who: null, action: 'a third one is too many', due: null, why: '' },
    ] },
    { id: 'T9', followups: [{ direction: 'mine', action: 'not a task we sent', who: null }] },
  ] });
  const got = followups.collect(q, parse, t0 + 400);
  assert.deepEqual(got, { tasks: 2, suggested: 2 });
  const list = followups.suggested('work');
  assert.equal(list.length, 2);
  const owed = list.find(s => s.direction === 'owed_to_me'), mine = list.find(s => s.direction === 'mine');
  assert.equal(owed.who, 'Mary Byrne'); assert.equal(owed.due, '2026-12-02');
  assert.match(owed.chaseNote, /Chase task on Thu, 3 Dec/);
  assert.equal(mine.who, '', 'a name not in the evidence is dropped, not believed');
  assert.equal(mine.due, null, 'a date that is not a date is dropped');
  assert.equal(followups.state('work', t0 + 400).thinking, 0);
  assert.equal(crm().prepare("SELECT COUNT(*) AS n FROM task_followups WHERE status = 'done'").get().n, 2);
  assert.equal(book.status, 'needsAction');
});

test('accepting puts the follow-up in the ledger: owed to you is chased later, yours becomes a task in the same job', () => {
  const { send, book } = quoteJob();
  const q = queue();
  tasks.edit(send.id, { status: 'completed' });
  followups.enqueueNext(q, T + 500);
  q.reply({ tasks: [{ id: 'T1', followups: [
    { direction: 'owed_to_me', who: 'Mary Byrne', action: 'decide on the quote', due: null, why: 'The quote went to Mary.' },
    { direction: 'mine', who: 'Mary Byrne', action: 'send Mary the migration timeline', due: null, why: 'She asked for it alongside.' },
  ] }] });
  followups.collect(q, parse, T + 600);
  const [owedS, mineS] = ['owed_to_me', 'mine'].map(d => followups.suggested('work').find(s => s.direction === d));

  assert.throws(() => followups.accept(owedS.id, { due: '2026-13-01' }), /valid date/);
  const r1 = followups.accept(owedS.id, { due: '2026-11-28' });
  assert.equal(r1.task, null);
  const p1 = promises.get(r1.atomId);
  assert.deepEqual([p1.direction, p1.who, p1.action, p1.due, p1.certainty, p1.state, p1.task_id], ['owed_to_me', 'Mary Byrne', 'decide on the quote', '2026-11-28', 'clear', 'open', null]);
  assert.equal(p1.looked_back_at, null, 'it may already have arrived, so the look-back still runs');
  const atom = crm().prepare('SELECT * FROM atoms WHERE id = ?').get(r1.atomId);
  assert.equal(atom.statement, 'Mary Byrne will decide on the quote by 2026-11-28 for Douglas.');
  assert.equal(atom.kind, 'promise');
  const src = crm().prepare('SELECT s.* FROM atom_sources x JOIN sources s ON s.id = x.source_id WHERE x.atom_id = ?').get(r1.atomId);
  assert.equal(src.origin, 'task_followup'); assert.equal(src.atomise_status, 'ignored', 'not read a second time');
  assert.match(src.text, /Douglas finished the task “Send the quote to Mary Byrne”/);
  assert.equal(crm().prepare('SELECT quote_verified FROM atom_sources WHERE atom_id = ?').get(r1.atomId).quote_verified, 1);
  assert.equal(promises.ledger('work').owed.length, 1);
  assert.throws(() => followups.accept(owedS.id), /already been dealt with/);

  const r2 = followups.accept(mineS.id, {});
  assert.ok(r2.task);
  assert.equal(r2.task.title, 'Send Mary the migration timeline');
  assert.equal(r2.task.origin, 'promise');
  assert.equal(tasks.get(r2.task.id).job_id, tasks.get(book.id).job_id, 'joins the job that is still going');
  assert.equal(tasks.get(r2.task.id).job_by, 'douglas');
  const p2 = promises.get(r2.atomId);
  assert.equal(p2.task_id, r2.task.id);
  assert.equal(promises.ledger('work').mine.length, 1);
  assert.equal(crm().prepare('SELECT statement FROM atoms WHERE id = ?').get(r2.atomId).statement, 'Douglas will send Mary the migration timeline for Mary Byrne.');
  assert.equal(followups.suggested('work').length, 0);
  // promises.run leaves an accepted one alone: it already has its task, and the chase waits a week.
  return promises.run().then(() => { assert.equal(crm().prepare("SELECT COUNT(*) AS n FROM tasks WHERE origin = 'promise'").get().n, 1); });
});

test('dismissed, failed, stale and reopened finishes behave; failures are visible and can be asked again', () => {
  const { draft, send } = quoteJob();
  const q = queue();
  tasks.edit(send.id, { status: 'completed' });
  followups.enqueueNext(q, T + 500);
  q.job = { status: 'failed', error: 'Mac worker offline' };
  assert.equal(followups.collect(q, parse, T + 600).error, 'Mac worker offline');
  for (let i = 1; i < followups.MAX_TRIES; i++) {
    assert.equal(followups.enqueueNext(q, T + 600 + i * 1900), true, `retry ${i}`);
    followups.collect(q, parse, T + 600 + i * 1900 + 10);
  }
  assert.equal(followups.enqueueNext(q, T + 20000), false, 'gives up after three tries');
  assert.deepEqual(followups.state('work', T + 20000).failed.map(f => f.title), ['Send the quote to Mary Byrne']);
  followups.again(send.id);
  assert.equal(followups.enqueueNext(q, T + 20001), true);
  q.reply({ tasks: [{ id: 'T1', followups: [{ direction: 'owed_to_me', who: 'Mary Byrne', action: 'decide on the quote' }] }] });
  followups.collect(q, parse, T + 20002);
  const [s] = followups.suggested('work');
  assert.equal(followups.dismiss(s.id), 1);
  assert.equal(followups.suggested('work').length, 0);
  assert.equal(followups.dismiss(s.id), 0);

  tasks.edit(draft.id, { status: 'completed' });
  tasks.edit(draft.id, { status: 'needsAction' });
  followups.notice(T + 20003);
  assert.equal(crm().prepare('SELECT COUNT(*) AS n FROM task_followups WHERE task_id = ?').get(draft.id).n, 0, 'reopened before it was looked at');

  tasks.edit(draft.id, { status: 'completed' });
  followups.notice(T);
  assert.equal(followups.enqueueNext(q, T + 4 * 86400), false, 'three days on, it is no longer worth asking');
  assert.equal(crm().prepare('SELECT status FROM task_followups WHERE task_id = ?').get(draft.id).status, 'stale');
});

test('the review page and Today render the steps, the dates and the follow-ups', () => {
  const { draft, send } = quoteJob();
  const q = queue();
  tasks.edit(send.id, { status: 'completed' });
  followups.enqueueNext(q, T + 500);
  q.reply({ tasks: [{ id: 'T1', followups: [{ direction: 'owed_to_me', who: 'Mary Byrne', action: 'decide on the quote', due: '2026-12-02', why: 'The quote went to Mary.' }] }] });
  followups.collect(q, parse, T + 600);
  const views = path.join(__dirname, '../views/crm');
  const render = (file, locals) => ejs.render(fs.readFileSync(path.join(views, file), 'utf8').replace(/<%- include\('_(top|bottom)'\) %>/g, ''), { space: 'work', fmt: String, ago: () => 'now', ...locals }, { filename: path.join(views, file) });
  const list = review.list('work');
  const page = render('tasks-review.ejs', { list, counts: review.counts(list), dates: review.quickDates(), meetingChoices: [], follow: { list: followups.suggested('work'), ...followups.state('work') } });
  assert.match(page, /2 open · 2 with no date/);
  assert.match(page, new RegExp(`id="t-${draft.id}"`));
  assert.match(page, /Mary Byrne will decide on the quote/);
  assert.match(page, /value="2026-12-02"/);
  assert.match(page, /Add to Owed to you/);
  assert.match(page, /After you finished <a href="\/crm\/work\/tasks\/[^"]+">Send the quote to Mary Byrne/);
  // Each form leads with the button Enter should press.
  for (const form of page.match(/<form method="post" action="\/crm\/work\/tasks\/review"[\s\S]*?<\/form>/g)) {
    assert.match(form.match(/<button[^>]*value="(\w+)"/)[1], /^(date|done)$/);
  }
  const today = require('../lib/crm/views').today('work');
  assert.equal(today.followups.list.length, 1);
  assert.deepEqual(today.reviewCounts, { open: 2, undated: 2, late: 0 });
});
