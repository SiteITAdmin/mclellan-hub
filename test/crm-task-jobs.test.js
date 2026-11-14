'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-task-jobs-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db'), tasks = require('../lib/crm/tasks'), help = require('../lib/crm/task-help');
const jobsLib = require('../lib/crm/task-jobs'), sources = require('../lib/crm/sources'), atoms = require('../lib/crm/atoms');
const calendar = require('../lib/crm/calendar'), planner = require('../lib/crm/planner');
const ejs = require('ejs');
const T = Math.floor(Date.now() / 1000);
const MON = '2026-11-09';
const at = (date, hhmm) => planner.epoch(date, planner.minutesOf(hhmm));
const parse = text => JSON.parse(text);
const crm = () => db.crm();
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

// The real case that prompted jobs: one email from Sarah split into four tasks,
// a follow-up a few minutes later, and an unrelated task in the same space.
function roster() {
  const mail = 'Can we please ask who is on these groups: NCHD Roster Access, NCHD Roster Makers, RotaMakers. If there are no members in NCHD visitors can you please delete this. Can you re-title NCHD Members to NCHD Administrative Office? Can you re-title NCHD Owner as IT account? The Ortho Registrars still have access to the draft roster which they shouldn’t.';
  const s = sources.admitSource({ space: 'work', kind: 'email', origin: 'test', externalId: 'm1', title: 'RE: Roster Project > Move to Sharepoint', text: mail, occurredAt: T - 7200 }).source;
  const s2 = sources.admitSource({ space: 'work', kind: 'email', origin: 'test', externalId: 'm2', title: 'RE: Roster Project > Move to Sharepoint', text: 'Would it be possible to arrange a call to go through this this week?', occurredAt: T - 6000 }).source;
  const mk = (title, source) => { const t = tasks.create('work', { title, context: source ? { sourceId: source.id } : {} }); crm().prepare('UPDATE tasks SET minutes = 15 WHERE id = ?').run(t.id); return t; };
  return {
    s, s2,
    list: mk('List the members of NCHD Roster Access, NCHD Roster Makers and RotaMakers', s),
    visitors: mk('Delete the NCHD Visitors group if it has no members', s),
    members: mk('Rename NCHD Members group to NCHD Administrative Office', s),
    owner: mk('Rename NCHD Owner group to IT account', s),
    call: mk('Arrange a call with Sarah Egan about roster access', s2),
    other: mk('Build report dashboards on SharePoint usage'),
  };
}
const jobOf = id => crm().prepare('SELECT job_id, job_by FROM tasks WHERE id = ?').get(id);
const writeHelp = (taskId, gist) => crm().prepare(`INSERT OR REPLACE INTO task_help (task_id, space, task_print, evidence_print, status, help, tried_at, written_at)
  VALUES (?, 'work', ?, 'e', 'done', ?, ?, ?)`).run(taskId, help.taskPrint(tasks.get(taskId)), JSON.stringify({ gist, behind: { text: `Underneath ${gist}`, refs: [] }, recommend: '', should: { verdict: 'do', text: '', refs: [] }, have: [], steps: [], options: [], missing: [] }), T, T);

test('requests from one email start as one job named after it; a task taken out stays out', () => {
  const r = roster();
  assert.equal(jobsLib.groupBySource(T), 4);
  const job = jobsLib.get(jobOf(r.list.id).job_id);
  assert.equal(job.title, 'Roster Project > Move to Sharepoint');
  assert.equal(job.made_by, 'source');
  assert.deepEqual([r.visitors, r.members, r.owner].map(t => jobOf(t.id)), Array(3).fill({ job_id: job.id, job_by: 'source' }));
  assert.equal(jobOf(r.call.id).job_id, null, 'a different email is the reader’s call, not the rule’s');
  assert.equal(jobOf(r.other.id).job_id, null);
  assert.equal(jobsLib.groupBySource(T), 0, 'idempotent');

  assert.equal(jobsLib.takeOut(r.owner.id, 'douglas'), true);
  assert.equal(jobsLib.groupBySource(T), 0, 'not put back');
  assert.equal(jobOf(r.owner.id).job_id, null);
  const later = tasks.create('work', { title: 'Confirm the roster group names with Louise', context: { sourceId: r.s.id } });
  jobsLib.groupBySource(T);
  assert.equal(jobOf(later.id).job_id, job.id, 'a new request from the same email joins the existing job');
  const m = sources.admitSource({ space: 'work', kind: 'meeting', origin: 'test', externalId: 'rec', title: 'Mobile recording - November 10, 2026 3:11 p.m. (part 2 of 4)', text: 'x', occurredAt: Date.UTC(2026, 10, 10, 15) / 1000 }).source;
  for (const title of ['Analyse the drive', 'Train Margaret']) tasks.create('work', { title, context: { sourceId: m.id } });
  jobsLib.groupBySource(T);
  assert.equal(crm().prepare("SELECT j.title FROM tasks t JOIN task_jobs j ON j.id = t.job_id WHERE t.title = 'Train Margaret'").get().title, 'Meeting on 10 Nov 2026');
  jobsLib.addByHand(r.owner.id, job.id);
  assert.deepEqual(jobOf(r.owner.id), { job_id: job.id, job_by: 'douglas' }, 'put back by hand clears the removal');
});

test('the task reader sees the jobs, may add a task to one, and never overrides Douglas', () => {
  const r = roster();
  jobsLib.groupBySource(T);
  const job = jobOf(r.list.id).job_id;
  jobsLib.takeOut(r.owner.id, 'douglas');
  const q = queue();
  crm().prepare("UPDATE tasks SET due = '2026-01-01' WHERE id = ?").run(r.call.id);
  assert.equal(help.enqueueNext(q, { t: T }), true);
  const prompt = q.sent[0].payload.userPrompt;
  assert.match(prompt, /Open jobs in this space \(1\):\n\[J1\] Roster Project > Move to Sharepoint \(tasks: T\d, T\d, T\d\)/);
  assert.match(prompt, /This task is not part of any job yet\./);
  assert.match(prompt, /List the members.*\(in job J1\)/);
  assert.doesNotMatch(prompt, /Rename NCHD Owner group to IT account \(in job/);
  const keyOf = title => prompt.match(new RegExp(`\\[(T\\d+)\\] ${title}`))[1];
  q.reply({ gist: 'Call Sarah.', job: { id: 'J1', with: [keyOf('Rename NCHD Owner'), keyOf('Build report')] } });
  help.collect(q, parse, T + 1);
  assert.deepEqual(jobOf(r.call.id), { job_id: job, job_by: 'model' });
  assert.equal(jobOf(r.owner.id).job_id, null, 'Douglas took it out: the reader cannot put it back');
  assert.deepEqual(jobOf(r.other.id), { job_id: job, job_by: 'model' }, 'a loose task the reader names joins');

  assert.equal(jobsLib.fromHelp(r.owner.id, { id: job, with: [] }), null, 'refused for the removed task itself');
  assert.equal(jobsLib.fromHelp(r.owner.id, { id: 'new', title: 'Alone', with: [] }), null, 'a new job needs a partner');
  assert.equal(crm().prepare('SELECT COUNT(*) n FROM task_jobs').get().n, 1);
  assert.equal(jobsLib.fromHelp(r.list.id, { id: 'new', title: 'Elsewhere', with: [r.owner.id] }), job, 'a task in a job stays in it');
});

test('a job is read once its tasks are, suggests missing steps, and keeps Douglas’s decisions', () => {
  const r = roster();
  jobsLib.groupBySource(T);
  const id = jobOf(r.list.id).job_id;
  const q = queue();
  assert.equal(jobsLib.enqueueNext(q, { t: T }), false, 'waits for each task’s own help');
  for (const t of [r.list, r.visitors, r.members, r.owner]) writeHelp(t.id, t.title);
  assert.equal(jobsLib.enqueueNext(q, { t: T }), true);
  const sent = q.sent[0];
  assert.equal(sent.payload.model, 'opus');
  assert.equal(sent.payload.meta.jobHelp, id);
  const p = sent.payload.userPrompt;
  assert.match(p, /\[T1\] List the members.*\(grouped only because it came from the same source\)\n  Gist: List the members/);
  assert.match(p, /\[S1\] Email, .*"RE: Roster Project > Move to Sharepoint"\nCan we please ask/);
  assert.match(p, /\[O\d\] Arrange a call with Sarah Egan/);
  assert.equal(jobsLib.enqueueNext(q, { t: T + 1 }), false, 'one at a time');
  assert.equal(jobsLib.forJob(id, 'work').state, 'waiting');
  assert.equal(jobsLib.forJob(id, 'personal'), null, 'space-bound');

  q.reply({ title: 'Stop NCHDs editing the draft rosters', goal: 'Only rota makers can open the draft rosters.',
    behind: { text: 'Renaming groups removes nobody’s access.', refs: ['S1', 'S9'] }, recommend: 'Audit the draft folder first, then tidy the names.',
    order: ['T4', 'T1', 'T2'], missing: [{ text: 'Check how the Ortho Registrars reach the draft rosters', why: 'None of the tasks finds the leak.', refs: ['S1'] }, { text: '' }],
    outside: ['T3'], with: [p.match(/\[(O\d+)\] Arrange a call/)[1]] });
  assert.deepEqual(jobsLib.collect(q, parse, T + 2), { written: id });
  let job = jobsLib.forJob(id, 'work');
  assert.equal(job.title, 'Stop NCHDs editing the draft rosters');
  assert.equal(job.goal, 'Only rota makers can open the draft rosters.');
  assert.equal(job.help.behind.sources[0].id, r.s.id);
  assert.deepEqual(job.suggested.map(s => s.text), ['Check how the Ortho Registrars reach the draft rosters']);
  assert.equal(jobOf(r.members.id).job_id, null, 'a source-only grouping the reader says is wrong is undone');
  assert.equal(crm().prepare('SELECT removed_by FROM job_removals WHERE task_id = ?').get(r.members.id).removed_by, 'reader');
  assert.equal(jobOf(r.call.id).job_id, id);
  assert.deepEqual(job.open.slice(0, 2).map(t => t.id), [r.owner.id, r.list.id], 'shown in the reader’s order');
  jobsLib.groupBySource(T + 3);
  assert.equal(jobOf(r.members.id).job_id, null, 'the source rule respects the reader’s removal');

  writeHelp(r.call.id, 'Call');
  assert.equal(jobsLib.enqueueNext(q, { t: T + 4 }), true, 'membership changed, so it is read again straight away');
  jobsLib.rename(id, 'Roster access clean-up');
  const step = job.suggested[0];
  jobsLib.dismiss(step.id);
  q.reply({ title: 'Something else', goal: 'g', recommend: 'r', missing: [{ text: 'Check how the Ortho Registrars reach the draft rosters!' }, { text: 'Send Sarah the findings' }] });
  jobsLib.collect(q, parse, T + 5);
  job = jobsLib.forJob(id, 'work');
  assert.equal(job.title, 'Roster access clean-up', 'Douglas’s name is kept');
  assert.deepEqual(job.suggested.map(s => s.text), ['Send Sarah the findings'], 'a dismissed step is not suggested again');
  assert.match(jobsLib.packet(jobsLib.get(id)).userPrompt, /Steps Douglas already decided on: Check how the Ortho Registrars reach the draft rosters \(dismissed\)/);

  const made = jobsLib.accept(job.suggested[0].id);
  assert.equal(made.origin, 'job');
  assert.match(made.notes, /Suggested by the Hub as part of: Roster access clean-up/);
  assert.deepEqual(jobOf(made.id), { job_id: id, job_by: 'douglas' });
  assert.throws(() => jobsLib.accept(job.suggested[0].id), /already been dealt with/);
  assert.equal(jobsLib.brief(id).suggested, 0);
  assert.equal(jobsLib.enqueueNext(q, { t: T + 6 }), false, 'the new task gets its own help before the job is read again');
});

test('job reading failures are bounded and visible, and keep the last good reading', () => {
  const r = roster();
  jobsLib.groupBySource(T);
  const id = jobOf(r.list.id).job_id;
  for (const t of [r.list, r.visitors, r.members, r.owner]) writeHelp(t.id, t.title);
  const q = queue();
  jobsLib.enqueueNext(q, { t: T }); q.reply({ goal: 'Good goal', recommend: 'Good' }); jobsLib.collect(q, parse, T + 1);
  jobsLib.again(id);
  assert.equal(jobsLib.enqueueNext(q, { t: T + 2 }), true);
  q.job = { status: 'failed', error: 'usage_limit_reached' };
  assert.equal(jobsLib.collect(q, parse, T + 3).retrying, true);
  assert.equal(jobsLib.enqueueNext(q, { t: T + 60 }), false, 'rests before retrying');
  const job = jobsLib.forJob(id, 'work');
  assert.equal(job.state, 'failed');
  assert.match(job.error, /usage_limit/);
  assert.equal(job.help.recommend, 'Good');
  assert.equal(jobsLib.enqueueNext(q, { t: T + 1900 }), true);
  q.reply({}); assert.match(jobsLib.collect(q, parse, T + 1901).error, /nothing usable/);
  assert.equal(jobsLib.enqueueNext(q, { t: T + 3800 }), true, 'third try'); q.reply({}); jobsLib.collect(q, parse, T + 3801);
  assert.equal(jobsLib.failed('work').length, 1);
  assert.match(require('../lib/crm/views').health('work').map(h => h.text).join('\n'), /couldn't be read\. Tries again tomorrow/);
  assert.equal(jobsLib.enqueueNext(q, { t: T + 9000 }), false, 'given up for the day');
});

test('a job is planned as one sitting under its name, and its steps share that block', async () => {
  const r = roster();
  jobsLib.groupBySource(T);
  const id = jobOf(r.list.id).job_id;
  crm().prepare("UPDATE tasks SET minutes = 30 WHERE id = ?").run(r.list.id);
  assert.equal(jobsLib.blockTitle(tasks.get(r.list.id)), `${r.list.title} (+3 more)`, 'an unread source job is named by its first step');
  jobsLib.rename(id, 'Stop NCHDs editing the draft rosters');
  const events = [];
  let n = 0;
  const api = { events: {
    list: async () => ({ data: { items: JSON.parse(JSON.stringify(events)) } }),
    insert: async p => { const e = { id: `g${++n}`, status: 'confirmed', organizer: { self: true }, ...JSON.parse(JSON.stringify(p.requestBody)) }; events.push(e); return { data: e }; },
    patch: async p => { const e = events.find(x => x.id === p.eventId); Object.assign(e, p.requestBody); return { data: e }; },
    delete: async p => { events.splice(events.findIndex(x => x.id === p.eventId), 1); return { data: {} }; },
  } };
  await calendar.run({ api, at: at(MON, '07:00') });
  const blocks = crm().prepare('SELECT * FROM plan_blocks ORDER BY start_at').all();
  const jobBlock = blocks.find(b => b.task_id === r.list.id);
  assert.equal((jobBlock.end_at - jobBlock.start_at) / 60, 75, '30 + 15 + 15 + 15 minutes in one sitting');
  assert.equal(blocks.filter(b => [r.visitors.id, r.members.id, r.owner.id].includes(b.task_id)).length, 0);
  const made = events.find(e => e.extendedProperties.private.hubBlock === jobBlock.id);
  assert.equal(made.summary, 'Stop NCHDs editing the draft rosters');
  assert.match(made.description, /Steps:\n- List the members.*\n- Delete the NCHD Visitors/);
  assert.match(made.description, new RegExp(`/crm/work/jobs/${id}`));
  assert.deepEqual(calendar.blocksFor(r.owner.id).map(b => b.id), [jobBlock.id]);
  const item = calendar.day('work', MON).items.find(i => i.type === 'task' && i.id === r.list.id);
  assert.equal(item.title, 'Stop NCHDs editing the draft rosters');
  assert.equal(item.job, id);

  tasks.edit(r.list.id, { status: 'completed' });
  await calendar.run({ api, at: at(MON, '07:05') });
  const next = crm().prepare('SELECT * FROM plan_blocks WHERE task_id = ?').get(r.visitors.id);
  assert.equal((next.end_at - next.start_at) / 60, 45, 'the next step leads once the first is done');
  assert.equal(events.some(e => e.extendedProperties.private.hubBlock === jobBlock.id), false, 'the old lead\'s block, not yet started, is removed from Google');
  assert.equal(events.filter(e => e.extendedProperties.private.hubBlock).length, 3, 'the job, the call and the dashboards');
  assert.equal(events.find(e => e.extendedProperties.private.hubBlock === next.id).summary, 'Stop NCHDs editing the draft rosters');
});

test('lists show a job once with its steps, and the job and task pages render', () => {
  const r = roster();
  jobsLib.groupBySource(T);
  const id = jobOf(r.list.id).job_id;
  for (const t of [r.list, r.visitors, r.members, r.owner]) writeHelp(t.id, t.title);
  const q = queue();
  jobsLib.enqueueNext(q, { t: T });
  q.reply({ title: 'Stop NCHDs editing the draft rosters', goal: 'Only rota makers can open drafts.', behind: { text: 'Names are not access.', refs: ['S1'] }, recommend: 'Audit the draft folder first.', missing: [{ text: 'Check the Ortho Registrars’ access', why: 'Finds the leak.' }] });
  jobsLib.collect(q, parse, T + 1);
  const views = path.join(__dirname, '../views/crm');
  const locals = { space: 'work', fmt: ts => String(ts), ago: () => 'just now' };
  const list = ejs.render(fs.readFileSync(path.join(views, '_tasks.ejs'), 'utf8'), { ...locals, taskList: tasks.list('work'), taskBack: '/crm/work' }, { filename: path.join(views, '_tasks.ejs') });
  assert.equal(list.match(/class="job-head"/g).length, 1);
  assert.match(list, /Stop NCHDs editing the draft rosters<\/a>\s*<div class="meta">4 open · <a [^>]*>1 missing step to look at/);
  assert.match(list, /Audit the draft folder first\./);
  const inJob = list.slice(list.indexOf('job-group'), list.indexOf('Build report dashboards'));
  for (const t of [r.list, r.visitors, r.members, r.owner]) assert.ok(inJob.includes(t.title), `${t.title} sits under the job`);
  assert.ok(list.indexOf('Arrange a call') > list.indexOf('Rename NCHD Owner'), 'loose tasks stay outside the group');

  const page = ejs.render(fs.readFileSync(path.join(views, 'job.ejs'), 'utf8').replace(/<%- include\('_(top|bottom)'\) %>/g, ''), { ...locals, job: jobsLib.forJob(id, 'work') }, { filename: path.join(views, 'job.ejs') });
  assert.match(page, /<h1>Stop NCHDs editing the draft rosters<\/h1>/);
  assert.match(page, /Names are not access\./);
  assert.match(page, /Check the Ortho Registrars’ access/);
  assert.match(page, /action="\/crm\/work\/jobs\/[^/]+\/accept"/);
  assert.equal(page.match(/Not part of this job/g).length, 4);

  const t = tasks.detail(tasks.get(r.owner.id));
  const taskPage = ejs.render(fs.readFileSync(path.join(views, 'task.ejs'), 'utf8').replace(/<%- include\('_(top|bottom)'\) %>/g, ''),
    { ...locals, t, error: null, choices: tasks.choices('work'), blocks: [], help: help.forTask(t.id), jobs: jobsLib.openJobs('work') }, { filename: path.join(views, 'task.ejs') });
  assert.match(taskPage, new RegExp(`href="/crm/work/jobs/${id}">Stop NCHDs editing the draft rosters</a>`));
});

test('the shared tick groups by source, then reads tasks before the job', async () => {
  const r = roster();
  const q = queue();
  crm().prepare("UPDATE sources SET atomise_status = 'done'").run();
  crm().prepare('UPDATE tasks SET minutes = 30').run();
  await atoms.runAtomiseTick({ jobs: q });
  assert.equal(jobOf(r.visitors.id).job_by, 'source');
  assert.equal(q.sent.at(-1).payload.meta.taskHelp ? 'task' : 'job', 'task');
  for (const t of [r.list, r.visitors, r.members, r.owner, r.call, r.other]) writeHelp(t.id, t.title);
  crm().prepare('DELETE FROM task_help WHERE status = ?').run('waiting');
  q.sent.length = 0;
  await atoms.runAtomiseTick({ jobs: q });
  assert.equal(q.sent.length, 1);
  assert.equal(q.sent[0].payload.meta.jobHelp, jobOf(r.list.id).job_id);
});
