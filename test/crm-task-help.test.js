'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-task-help-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db'), tasks = require('../lib/crm/tasks'), help = require('../lib/crm/task-help');
const sources = require('../lib/crm/sources'), atoms = require('../lib/crm/atoms');
const T = Math.floor(Date.now() / 1000);
const parse = text => JSON.parse(text);
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

function queue() {
  const q = { sent: [], job: { status: 'pending' } };
  q.enqueue = j => { q.sent.push(j); return { jobId: `job${q.sent.length}` }; };
  q.getJob = () => q.job;
  q.reply = r => { q.job = { status: 'completed', result: { output: JSON.stringify(r) } }; };
  return q;
}

function fixture() {
  const mail = 'Ken asked whether the NCHD Visitors group in SharePoint can be deleted. Douglas said he would delete it if it has no members.';
  const s = sources.admitSource({ space: 'work', kind: 'email', origin: 'test', externalId: 'mail', title: 'NCHD SharePoint groups', text: mail, occurredAt: T - 3600 }).source;
  atoms.applyAtoms(s.id, [{ statement: 'The NCHD Visitors group in SharePoint has no members as of November.', kind: 'fact', quote: mail.slice(0, 60), topics: ['SharePoint'], confidence: 'high' }]);
  const other = sources.admitSource({ space: 'personal', kind: 'email', origin: 'test', externalId: 'home', title: 'SharePoint at home', text: 'Personal note about the Visitors group and SharePoint.', occurredAt: T - 3600 }).source;
  const held = sources.admitSource({ space: 'work', kind: 'email', origin: 'test', externalId: 'held', title: 'Unapproved sender on SharePoint Visitors', text: 'SECRET Visitors group SharePoint.', occurredAt: T - 60 }).source;
  db.crm().prepare("UPDATE sources SET atomise_status = 'held' WHERE id = ?").run(held.id);
  const t = tasks.create('work', { title: 'Delete the NCHD Visitors group if it has no members', notes: 'Ken asked about SharePoint groups', context: { sourceId: s.id } });
  return { s, other, held, t, fact: db.crm().prepare("SELECT * FROM atoms WHERE statement LIKE 'The NCHD%'").get() };
}

test('help is written from same-space evidence, keeps only cited lines, and reaches the task page and lists', () => {
  const f = fixture(), q = queue();
  assert.equal(help.forTask(f.t.id).state, 'queued');
  assert.equal(help.enqueueNext(q, { t: T }), true);
  const prompt = q.sent[0].payload.userPrompt;
  assert.match(prompt, /\[S1\] Email.*NCHD SharePoint groups/);
  assert.match(prompt, /\[F1\].*has no members/);
  assert.doesNotMatch(prompt, /Personal note|SECRET/);
  assert.equal(q.sent[0].feature, 'crm_atomise');
  assert.equal(help.enqueueNext(q, { t: T + 1 }), false, 'one job at a time');
  assert.equal(help.forTask(f.t.id).state, 'waiting');
  assert.equal(help.collect(q, parse, T + 2), null);

  q.reply({ gist: 'Ken wants the empty Visitors group removed.',
    should: { verdict: 'check', text: 'Deleting a default group can break sharing links.', refs: ['S1'] },
    have: [{ text: 'The group has no members.', refs: ['F1'] }, { text: 'Invented claim', refs: [] }, { text: 'Wrong id', refs: ['F9'] }],
    steps: [{ text: 'Open Site settings > People and groups.', refs: [] }, { text: 'Confirm it is empty.', refs: ['F1', 'S1'] }],
    draft: { to: 'Ken', subject: 'Visitors group', body: 'Hi Ken,\nDone.\n[date]', refs: ['S1'] },
    missing: ['Whether any sharing links use the group', '', 'b', 'c', 'd'] });
  assert.deepEqual(help.collect(q, parse, T + 3), { written: f.t.id });
  const shown = help.forTask(f.t.id);
  assert.equal(shown.state, 'done');
  assert.deepEqual(shown.help.have.map(l => l.text), ['The group has no members.']);
  assert.equal(shown.help.have[0].sources[0].id, f.s.id);
  assert.equal(shown.help.steps.length, 2);
  assert.equal(shown.help.steps[0].sources.length, 0);
  assert.equal(shown.help.steps[1].sources.length, 1);
  assert.equal(shown.help.draft.to, 'Ken');
  assert.equal(shown.help.missing.length, 4);
  assert.deepEqual(tasks.list('work')[0].help, { verdict: 'check', draft: true, next: 'Open Site settings > People and groups.', why: 'Deleting a default group can break sharing links.' });
  assert.equal(help.enqueueNext(q, { t: T + 4 }), false);
  assert.equal(help.enqueueNext(q, { refresh: true, t: T + 4 }), false);
});

test('rewritten when the task is reworded, when evidence changes (daily at most), or when asked; removed when closed', () => {
  const f = fixture(), q = queue();
  help.enqueueNext(q, { t: T }); q.reply({ gist: 'First', steps: [{ text: 'Step' }] }); help.collect(q, parse, T + 1);
  assert.equal(help.enqueueNext(q, { refresh: true, t: T + 86500 }), false, 'same evidence: nothing to rewrite');

  const s2 = sources.admitSource({ space: 'work', kind: 'email', origin: 'test', externalId: 'm2', title: 'Visitors group update', text: 'The Visitors group now has two members in SharePoint.', occurredAt: T }).source;
  assert.equal(help.enqueueNext(q, { refresh: true, t: T + 86600 }), false, 'checked within the day');
  assert.equal(help.enqueueNext(q, { t: T + 3 * 86400 }), false, 'evidence changes never jump the reading queue');
  assert.equal(help.enqueueNext(q, { refresh: true, t: T + 3 * 86400 }), true);
  assert.match(q.sent.at(-1).payload.userPrompt, /two members/);
  assert.equal(help.forTask(f.t.id).help.gist, 'First', 'old help stays until the new one arrives');
  q.reply({ gist: 'Second', steps: [] }); help.collect(q, parse, T + 3 * 86400 + 1);
  assert.equal(help.forTask(f.t.id).help.gist, 'Second');

  tasks.edit(f.t.id, { notes: 'Ken asked again, urgently' });
  assert.equal(help.forTask(f.t.id).outdated, true);
  assert.equal(help.enqueueNext(q, { t: T + 3 * 86400 + 5 }), true);
  q.reply({ gist: 'Third' }); help.collect(q, parse, T + 3 * 86400 + 6);
  assert.equal(help.again(f.t.id), 1);
  assert.equal(help.enqueueNext(q, { t: T + 3 * 86400 + 7 }), true);
  q.reply({ gist: 'Fourth' }); help.collect(q, parse, T + 3 * 86400 + 8);

  tasks.edit(f.t.id, { status: 'completed' });
  assert.equal(help.forTask(f.t.id), null);
  assert.equal(help.enqueueNext(q, { t: T + 4 * 86400 }), false);
  assert.equal(db.crm().prepare('SELECT COUNT(*) AS n FROM task_help').get().n, 0);
  assert.ok(s2.id);
});

test('failures are bounded, visible, and keep the last good help', () => {
  const f = fixture(), q = queue();
  help.enqueueNext(q, { t: T }); q.reply({ gist: 'Good' }); help.collect(q, parse, T + 1);
  help.again(f.t.id);
  let t = T + 10;
  for (let i = 0; i < help.MAX_TRIES; i++) {
    assert.equal(help.enqueueNext(q, { t }), true, `try ${i + 1}`);
    q.job = i ? { status: 'completed', result: { output: 'not json' } } : { status: 'failed', error: 'usage_limit_reached' };
    const r = help.collect(q, parse, t + 1);
    assert.equal(r.retrying, i === 0);
    assert.equal(help.enqueueNext(q, { t: t + 60 }), false, 'rests before retrying');
    t += 1900;
  }
  assert.equal(help.failedCount('work'), 1);
  assert.equal(help.failedCount('personal'), 0);
  const shown = help.forTask(f.t.id);
  assert.equal(shown.state, 'failed'); assert.equal(shown.givenUp, true); assert.equal(shown.help.gist, 'Good');
  assert.equal(help.enqueueNext(q, { t: t + 3600 }), false, 'given up for the day');
  assert.equal(help.enqueueNext(q, { t: t + 86400 }), true);
  q.reply({}); assert.match(help.collect(q, parse, t + 86401).error, /nothing usable/);
});

test('the shared tick queues help and the task page renders it', async () => {
  const f = fixture(), q = queue();
  q.queueStats = () => ({ pending: 0 });
  db.crm().prepare("UPDATE sources SET atomise_status = 'done' WHERE atomise_status = 'pending'").run();
  db.crm().prepare('UPDATE tasks SET minutes = 30').run();
  await atoms.runAtomiseTick({ jobs: q });
  assert.equal(q.sent.at(-1).payload.meta.taskHelp, f.t.id);
  q.reply({ gist: 'Remove <b>the</b> group', should: { verdict: 'check', text: 'Ask Ken first.' }, steps: [{ text: 'Open settings', refs: ['S1'] }], draft: { to: 'Ken', body: 'Hi Ken' }, missing: ['Owner'] });
  await atoms.runAtomiseTick({ jobs: q });
  const ejs = require('ejs');
  const html = await ejs.renderFile(path.join(__dirname, '../views/crm/_task-help.ejs'),
    { help: help.forTask(f.t.id), t: f.t, space: 'work', fmt: () => '13 Nov' });
  assert.match(html, /Remove &lt;b&gt;the&lt;\/b&gt; group/);
  assert.match(html, /Check first\.<\/strong> Ask Ken first/);
  assert.match(html, new RegExp(`/crm/work/sources/${f.s.id}`));
  assert.match(html, /Draft to Ken/);
  const line = await ejs.renderFile(path.join(__dirname, '../views/crm/_help-line.ejs'), { h: tasks.list('work')[0].help, taskId: f.t.id, space: 'work' });
  assert.match(line, /Check first.*Draft ready.*Ask Ken first/s);
});

test('task screens render with help, and "Write it again" queues a rewrite', async () => {
  const f = fixture(), q = queue();
  help.enqueueNext(q, { t: T });
  q.reply({ gist: 'Remove the group', should: { verdict: 'do', text: 'Still wanted.' }, have: [{ text: 'It is empty.', refs: ['F1'] }], steps: [{ text: 'Open settings' }], draft: { to: 'Ken', body: 'Hi Ken' } });
  help.collect(q, parse, T + 1);
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
    const page = async p => { const res = await fetch(base + p); assert.equal(res.status, 200, p); return res.text(); };
    const task = await page(`/crm/work/tasks/${f.t.id}`);
    assert.match(task, /Help with this/); assert.match(task, /It is empty\./); assert.match(task, /Draft to Ken/); assert.match(task, /Open settings/);
    assert.match(await page('/crm/work/tasks'), /Draft ready<\/span> Start: Open settings/);
    assert.doesNotMatch(await page('/crm/work/tasks/new'), /Help with this/);
    await page('/crm/work');
    const res = await fetch(`${base}/crm/work/tasks/${f.t.id}/help`, { method: 'POST', redirect: 'manual', headers: { Origin: base } });
    assert.equal(res.status, 302);
    assert.equal(help.forTask(f.t.id).outdated, true);
    assert.equal(help.enqueueNext(q, { t: T + 5 }), true);
    assert.match(await page(`/crm/work/tasks/${f.t.id}`), /being rewritten/);
  } finally { server.close(); }
});
