'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-improvements-'));
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DISABLE_JOBS = '1';

const hubDb = require('../lib/db');
const crmDb = require('../lib/crm/db');
const subJobs = require('../lib/subscription-agent-jobs');
const review = require('../lib/crm/review');
const sources = require('../lib/crm/sources');
const imports = require('../lib/crm/imports');
const tasks = require('../lib/crm/tasks');
const inbox = require('../lib/crm/inbox');
const topics = require('../lib/crm/topics');
const orders = require('../lib/crm/money/orders');
const selfChat = require('../lib/crm/self-chat');
const config = require('../lib/crm/config');

function resetDbs() {
  crmDb._reset();
  fs.rmSync(process.env.CRM_DB_PATH, { force: true });
  hubDb.hub().prepare('DELETE FROM subscription_agent_jobs').run();
}

function makeApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.portfolioUser = 'douglas';
    req.session = { adminUser: 'douglas' };
    next();
  });
  app.use(require('../routes/home'));
  app.use(require('../routes/crm'));
  app.use(require('../routes/money'));
  app.use(require('../routes/house'));
  app.use(require('../routes/flights'));
  return app;
}

async function startServer(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('standalone Money & House tools render with tool shell, redirect old Personal URLs, and 404 Work URLs', async () => {
  resetDbs();
  const { server, base } = await startServer(makeApp());
  try {
    // Old Personal URLs redirect cleanly to standalone tools, preserving path & query
    for (const [oldPath, want] of [
      ['/crm/personal/money', '/money'],
      ['/crm/personal/money/transactions?month=2026-11', '/money/transactions?month=2026-11'],
      ['/crm/personal/house', '/house'],
      ['/crm/personal/house/properties?compare=a', '/house/properties?compare=a'],
    ]) {
      const r = await fetch(base + oldPath, { redirect: 'manual' });
      assert.equal(r.status, 302, oldPath);
      assert.equal(r.headers.get('location'), want);
    }

    // Work URLs still 404
    for (const p of ['/crm/work/money', '/crm/work/house', '/crm/work/house/properties']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }

    // Standalone Money & House pages render with tool-shell (no CRM sidebar)
    const moneyRes = await fetch(`${base}/money`);
    assert.equal(moneyRes.status, 200);
    const moneyHtml = await moneyRes.text();
    assert.match(moneyHtml, /class="tool-shell"/);
    assert.doesNotMatch(moneyHtml, /class="sidebar"/);
    assert.match(moneyHtml, /class="money-nav"/);

    const houseRes = await fetch(`${base}/house`);
    assert.equal(houseRes.status, 200);
    const houseHtml = await houseRes.text();
    assert.match(houseHtml, /class="tool-shell"/);
    assert.doesNotMatch(houseHtml, /class="sidebar"/);

    // Personal CRM sidebar no longer contains Money or House hunting items
    const personalHtml = await (await fetch(`${base}/crm/personal`)).text();
    assert.doesNotMatch(personalHtml, /href="\/crm\/personal\/money"/);
    assert.doesNotMatch(personalHtml, /href="\/crm\/personal\/house"/);
    assert.match(personalHtml, /href="\/crm\/inbox"/);
    assert.match(personalHtml, /href="\/crm\/settings"/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('Mac worker queue prioritizes interactive ask/reports above background enrichment', () => {
  resetDbs();
  const bg = subJobs.enqueue({ feature: 'crm_atomise', dedupeKey: 'bg-1', payload: { userPrompt: 'bg', meta: { taskHelp: 't1' } } });
  const src = subJobs.enqueue({ feature: 'crm_atomise', dedupeKey: 'src-1', payload: { userPrompt: 'src', meta: { sourceId: 's1', isHistory: false } } });
  const hist = subJobs.enqueue({ feature: 'crm_atomise', dedupeKey: 'hist-1', payload: { userPrompt: 'hist', meta: { sourceId: 's2', isHistory: true } } });
  const ask = subJobs.enqueue({ feature: 'crm_atomise', dedupeKey: 'ask-1', payload: { userPrompt: 'ask', meta: { ask: 'q1' } } });
  const prep = subJobs.enqueue({ feature: 'crm_atomise', dedupeKey: 'prep-1', payload: { userPrompt: 'prep', meta: { meeting: 'm1' } } });

  assert.equal(subJobs.hasHighPriorityPending(29), true);

  const claimed = [];
  for (let i = 0; i < 5; i++) {
    const j = subJobs.claim({ workerId: 'mac-test' }).jobs[0];
    if (j) claimed.push(j.id);
  }
  assert.deepEqual(claimed, [ask.jobId, prep.jobId, src.jobId, bg.jobId, hist.jobId]);

  // Split-lane worker filtering: fast worker claims <= 30 only, leaves priority 50 for background worker
  resetDbs();
  const bg2 = subJobs.enqueue({ feature: 'crm_atomise', dedupeKey: 'bg-2', payload: { userPrompt: 'bg', meta: { taskHelp: 't2' } } });
  const src2 = subJobs.enqueue({ feature: 'crm_atomise', dedupeKey: 'src-2', payload: { userPrompt: 'src', meta: { sourceId: 's2', isHistory: false } } });
  const ask2 = subJobs.enqueue({ feature: 'crm_atomise', dedupeKey: 'ask-2', payload: { userPrompt: 'ask', meta: { ask: 'q2' } } });
  assert.equal(subJobs.claim({ workerId: 'dev-server-fast', maxPriority: 30 }).jobs[0].id, ask2.jobId);
  assert.equal(subJobs.claim({ workerId: 'dev-server-fast', maxPriority: 30 }).jobs[0].id, src2.jobId);
  assert.equal(subJobs.claim({ workerId: 'dev-server-fast', maxPriority: 30 }).jobs.length, 0);
  assert.equal(subJobs.claim({ workerId: 'mac-bg' }).jobs[0].id, bg2.jobId);
});

test('unified inbox aggregates cross-space queues, bulk ignore automated works, and imports paginate/search/bulk-ignore', async () => {
  resetDbs();
  // Create automated and non-automated review proposals
  sources.proposePerson({ kind: 'email', value: 'noreply@notifications.example.com', name: 'No Reply', space: 'work', reason: 'Emailed you' });
  sources.proposePerson({ kind: 'email', value: 'notifications@service.example.com', name: 'Alerts', space: 'personal', reason: 'Emailed you' });
  sources.proposePerson({ kind: 'email', value: 'alice@example.org', name: 'Alice', space: 'work', reason: 'Emailed you' });

  // Create imported contacts
  for (let i = 1; i <= 6; i++) {
    imports.admit('linkedin', `li-${i}`, { name: `Contact ${i}`, company: i <= 2 ? 'Beacon' : 'OtherCo', emails: [`c${i}@example.com`], phones: [] });
  }

  const s = inbox.summary();
  assert.equal(s.triage.reviewItems.length, 3);
  assert.equal(s.triage.automatedCount, 2);
  assert.equal(s.optional.importCount, 6);
  assert.ok(inbox.badgeCount() >= 3);

  // Bulk ignore automated
  const ignoredAuto = review.ignoreAutomated();
  assert.equal(ignoredAuto, 2);
  assert.equal(review.openItems().length, 1);
  assert.equal(review.openItems()[0].payload.value, 'alice@example.org');

  // Imports search, pagination, and bulk-ignore
  assert.equal(imports.count({ q: 'beacon' }), 2);
  assert.equal(imports.list({ q: 'beacon', limit: 1, offset: 0 }).length, 1);
  const firstTwo = imports.list({ q: 'beacon', limit: 10, offset: 0 }).map(r => r.id);
  assert.equal(imports.ignoreMany(firstTwo), 2);
  assert.equal(imports.count(), 4);
  assert.equal(imports.ignoreAllPending('linkedin'), 4);
  assert.equal(imports.count(), 0);
});

test('unified task filters, topic tidy, order-to-bank-line matching, WhatsApp Task prefix, and CRM_WORK_CALENDAR_ID work', async () => {
  resetDbs();
  // Tasks search & filters
  const yesterday = '2020-01-01';
  const t1 = tasks.create('work', { title: 'Prepare Purview audit', due: yesterday });
  const t2 = tasks.create('work', { title: 'Buy whiteboard markers' });
  assert.deepEqual(tasks.list('work', { filter: 'overdue' }).map(t => t.id), [t1.id]);
  assert.deepEqual(tasks.list('work', { filter: 'undated' }).map(t => t.id), [t2.id]);
  assert.deepEqual(tasks.list('work', { q: 'purview' }).map(t => t.id), [t1.id]);

  // Topic deduplication and merging
  const db = crmDb.crm();
  db.prepare("INSERT INTO topics (id, space, name, name_norm) VALUES ('tp1','work','Microsoft 365 Licenses','microsoft 365 licenses'), ('tp2','work','M365 Licence','m365 licence')").run();
  db.prepare("INSERT INTO atoms (id, space, kind, statement, status, said_at) VALUES ('a1','work','fact','Renewed M365','active',1000)").run();
  db.prepare("INSERT INTO atom_topics (atom_id, topic_id) VALUES ('a1','tp2')").run();
  const dupes = topics.duplicates('work');
  assert.equal(dupes.length, 1);
  const tidy = topics.tidyAll('work');
  assert.equal(tidy.merged, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topics WHERE space = ?').get('work').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM atom_topics WHERE atom_id = ?').get('a1').n, 1);

  // Order-to-bank-line matching
  orders.matchesForTransactions([]);
  db.prepare(`INSERT INTO money_transactions (id, posted_on, description, merchant, merchant_norm, amount_cents, category, kind, status, dup_key)
    VALUES ('mtx1', '2026-11-18', 'AMZN MKTP IE', 'Amazon', 'amazon', -4999, 'Shopping', 'spend', 'confirmed', 'dk1')`).run();
  db.prepare(`INSERT INTO money_orders (id, dedupe_key, kind, merchant, merchant_norm, order_ref, ordered_on, total_cents, currency, items, status, found_at)
    VALUES ('mord1', 'odk1', 'order', 'Amazon', 'amazon', '204-1234', '2026-11-16', 4999, 'EUR', '[{"name":"USB-C Dock","quantity":1}]', 'open', 1000)`).run();
  const matched = orders.matchesForTransactions(['mtx1']);
  assert.ok(matched.mtx1);
  assert.equal(matched.mtx1.id, 'mord1');
  assert.equal(matched.mtx1.items[0].name, 'USB-C Dock');

  // WhatsApp self-chat Task: prefix
  db.prepare(`INSERT INTO whatsapp_chats (chat_id, name, is_self, status, space, decided_at) VALUES ('self@s.whatsapp.net', 'You', 1, 'approved', 'personal', 1000)`).run();
  const chat = db.prepare("SELECT * FROM whatsapp_chats WHERE chat_id = 'self@s.whatsapp.net'").get();
  const waSrc = sources.admitSource({ space: 'personal', kind: 'whatsapp', origin: 'whatsapp', externalId: 'wa-task-1', title: 'You', text: 'Work task: Send Q4 cyber report', occurredAt: crmDb.now() }).source;
  selfChat.capture(chat, [{ body: 'Work task: Send Q4 cyber report' }], waSrc);
  const waTasks = tasks.list('work');
  assert.ok(waTasks.some(t => t.title === 'Send Q4 cyber report' && t.origin === 'whatsapp'));
  const outbox = db.prepare("SELECT * FROM whatsapp_outbox WHERE chat_id = 'self@s.whatsapp.net'").all();
  assert.ok(outbox.some(o => o.body.includes('Task added in Work: Send Q4 cyber report')));

  // CRM_WORK_CALENDAR_ID config support
  const prev = process.env.CRM_WORK_CALENDAR_ID;
  process.env.CRM_WORK_CALENDAR_ID = 'work-ics@group.calendar.google.com';
  try {
    assert.ok(config.calendars.some(c => c.space === 'work' && c.id === 'work-ics@group.calendar.google.com'));
  } finally {
    if (prev === undefined) delete process.env.CRM_WORK_CALENDAR_ID;
    else process.env.CRM_WORK_CALENDAR_ID = prev;
  }

  // HTTP: Inbox, Settings, Tasks filters, Space switch preserves sub-page, and JSON micro-actions
  const { server, base } = await startServer(makeApp());
  try {
    assert.equal((await fetch(`${base}/crm/inbox`)).status, 200);
    assert.equal((await fetch(`${base}/crm/settings`)).status, 200);
    const tasksHtml = await (await fetch(`${base}/crm/work/tasks?filter=overdue&q=purview`)).text();
    assert.match(tasksHtml, /Prepare Purview audit/);
    assert.doesNotMatch(tasksHtml, /Buy whiteboard markers/);
    // Space switcher preserves /tasks sub-page
    assert.match(tasksHtml, /href="\/crm\/personal\/tasks"/);

    // JSON async micro-action completes a task without HTML redirect
    const completeRes = await fetch(`${base}/crm/work/tasks/${t1.id}/complete`, {
      method: 'POST',
      headers: {
        Origin: base,
        Accept: 'application/json',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `revision=${t1.revision}`,
    });
    assert.equal(completeRes.status, 200);
    const json = await completeRes.json();
    assert.equal(json.ok, true);
    assert.equal(tasks.get(t1.id).status, 'completed');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('CRM neumorphism-lite shell, mobile dock, and collapsible task filters stay scoped to CRM only', async () => {
  resetDbs();
  const db = crmDb.crm();
  db.prepare("INSERT INTO projects (id, space, name, name_norm) VALUES ('p1', 'work', 'Migration', 'migration')").run();
  tasks.create('work', { title: 'Confirm cutover window', due: '2020-01-01' });

  const { server, base } = await startServer(makeApp());
  try {
    const workToday = await (await fetch(`${base}/crm/work`)).text();
    assert.match(workToday, /<body class="crm-app" data-space="work">/);
    assert.match(workToday, /class="hub-menu"/);
    assert.match(workToday, /class="mobile-dock"/);
    assert.match(workToday, /class="dock-fab" href="\/crm\/work\/note"/);

    const personalToday = await (await fetch(`${base}/crm/personal`)).text();
    assert.match(personalToday, /<body class="crm-app" data-space="personal">/);
    assert.match(personalToday, /name="theme-color" content="#e7eee5"/);

    const workTasks = await (await fetch(`${base}/crm/work/tasks`)).text();
    assert.match(workTasks, /class="dock-fab" href="\/crm\/work\/tasks\/new"/);
    assert.match(workTasks, /class="tasks-filter-extra" id="tasks-filter-extra"/);
    assert.match(workTasks, /data-filter-toggle/);

    const filteredTasks = await (await fetch(`${base}/crm/work/tasks?projectId=p1`)).text();
    assert.match(filteredTasks, /class="tasks-filter-extra is-open" id="tasks-filter-extra"/);

    // Non-CRM tools and Home stay untouched (no crm-app body class, no mobile dock)
    for (const p of ['/home', '/money', '/house', '/flights']) {
      const html = await (await fetch(base + p)).text();
      assert.doesNotMatch(html, /class="crm-app"/, p);
      assert.doesNotMatch(html, /class="mobile-dock"/, p);
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
