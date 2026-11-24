'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-briefing-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const briefing = require('../lib/crm/briefing');
const ejs = require('ejs');

// Tuesday 17 Nov 2026, 06:30 in Dublin (GMT).
const T = Date.parse('2026-11-17T06:30:00Z') / 1000;
const DAY = '2026-11-17';
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

function work() {
  const c = db.crm();
  c.prepare("INSERT INTO organisations (id, space, name, name_norm) VALUES ('o1','work','Northside Clinic','northside clinic')").run();
  c.prepare("INSERT INTO people (id, space, name, org_id) VALUES ('p1','work','Aoife Brennan','o1'), ('p2','personal','Tom Hale',NULL)").run();
  c.prepare("INSERT INTO projects (id, space, name, name_norm, about) VALUES ('pr1','work','SharePoint to Departments','sharepoint to departments','Moving department file shares into SharePoint'), ('pr2','personal','Garden','garden','')").run();
  const task = c.prepare("INSERT INTO tasks (id, space, title, due, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'hub', ?, ?)");
  task.run('t1', 'work', 'Speak to Aoife Brennan about SharePoint data transfer', '2026-11-20', T - 3600, T - 3600);
  task.run('t2', 'work', 'Work through the SQL ESU registration', null, T - 7200, T - 7200);
  task.run('t3', 'personal', 'Book the dentist', null, T - 7200, T - 7200);
  const src = c.prepare('INSERT INTO sources (id, space, kind, origin, external_id, title, occurred_at, readable, atomise_status) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)');
  src.run('s1', 'work', 'email', 'outlook', 'e1', 'RE: Entra conditional access for the clinic', T - 86400, 'done');
  src.run('s2', 'work', 'email', 'outlook', 'e2', 'FW: Entra conditional access for the clinic', T - 80000, 'done');
  src.run('s3', 'work', 'email', 'outlook', 'e3', 'Held supplier mail', T - 80000, 'held');
  src.run('s4', 'personal', 'email', 'gmail', 'e4', 'Dinner on Friday', T - 80000, 'done');
  src.run('s5', 'work', 'email', 'outlook', 'e5', 'Old thread about printers', T - 20 * 86400, 'done');
  c.prepare("INSERT INTO calendar_events (id, calendar_id, space, title, start_at, end_at) VALUES ('ev1','c','work','Infrastructure Projects meeting',?,?)").run(T + 86400, T + 90000);
}

function fakeJobs() {
  let k = 0;
  const jobs = new Map(), enqueued = [];
  return {
    enqueued, jobs,
    enqueue({ feature, dedupeKey, payload }) { const id = `job${++k}`; jobs.set(id, { id, feature, status: 'pending', dedupeKey, payload }); enqueued.push(jobs.get(id)); return { jobId: id }; },
    getJob(id) { return jobs.get(id) || null; },
    finish(id, output, meta = { runner: 'claude', model: 'sonnet' }) { Object.assign(jobs.get(id), { status: 'completed', result: { output: typeof output === 'string' ? output : JSON.stringify(output), meta } }); },
    fail(id, error) { Object.assign(jobs.get(id), { status: 'failed', error }); },
    last() { return enqueued[enqueued.length - 1]; },
  };
}
const theme = (o = {}) => ({ name: 'SharePoint Online', query: 'SharePoint Online migration and sharing changes', why: 'You are moving department file shares into SharePoint with Aoife Brennan.', refs: ['P1', 'T1'], weight: 3, ...o });
const item = (o = {}) => ({ theme: 'SharePoint Online', headline: 'SharePoint Migration Tool adds incremental sync', summary: 'Microsoft has updated the migration tool. It rolls out from December.',
  action: 'Check whether planned migrations should wait for it.', published: '2026-11-15', source: 'Microsoft 365 Blog', source_url: 'https://techcommunity.microsoft.com/blog/spmt-incremental',
  quote: 'Starting in December, the SharePoint Migration Tool supports incremental sync for file shares.', kind: 'feature', confidence: 'high', ...o });
const row = () => briefing.get(DAY);

test('packet: Work only, read mail only, last week only, one line per thread', () => {
  work();
  const p = briefing.packet(T), labels = p.map(r => r.label);
  assert.deepEqual(p.filter(r => r.type === 'project').map(r => r.label), ['SharePoint to Departments']);
  assert.ok(labels.includes('Work through the SQL ESU registration'));
  assert.equal(labels.filter(l => /Entra conditional access/.test(l)).length, 1, 'RE: and FW: of one subject count once');
  for (const no of ['Held supplier mail', 'Dinner on Friday', 'Old thread about printers', 'Book the dentist', 'Garden']) assert.ok(!labels.includes(no), `${no} must not be shown`);
  assert.ok(p.some(r => r.type === 'meeting' && r.label === 'Infrastructure Projects meeting'));
  const prompt = JSON.parse(briefing.themesUserPrompt(p, T));
  assert.equal(prompt.today, DAY);
  assert.ok(!JSON.stringify(prompt).includes('"id"'), 'Hub ids are not sent to the reader');
});

test('themes: names of people and organisations never reach the search; uncited and muted themes are dropped', () => {
  work();
  briefing.mute('Printers');
  briefing.follow('Microsoft Entra ID');
  const { kept, dropped } = briefing.cleanThemes({ themes: [
    theme(),
    theme({ name: 'Northside Clinic SharePoint', query: 'sharepoint' }),
    theme({ name: 'Power Automate', query: 'Power Automate approvals for Aoife Brennan' }),
    theme({ name: 'Exchange Online', query: 'bounce backs service.desk@example.ie' }),
    theme({ name: 'Ticket 136797 follow up', query: 'ticket' }),
    theme({ name: 'Printers' }),
    theme({ name: 'Intune', refs: ['Z9'] }),
    theme({ name: 'sharepoint online', query: 'duplicate' }),
    theme({ name: 'microsoft entra id', query: 'Entra changes for Northside Clinic', refs: [] }),
  ] }, briefing.packet(T));
  assert.deepEqual(kept.map(k => k.name), ['SharePoint Online', 'Microsoft Entra ID']);
  const entra = kept.find(k => k.name === 'Microsoft Entra ID');
  assert.equal(entra.query, 'Microsoft Entra ID', 'a leaking query on his own theme falls back to the theme name');
  assert.equal(entra.followed, true);
  const why = Object.fromEntries(dropped.map(d => [d.theme, d.reason]));
  assert.match(why['Northside Clinic SharePoint'], /organisation/);
  assert.match(why['Power Automate'], /person/);
  assert.match(why['Exchange Online'], /email address/);
  assert.match(why['Ticket 136797 follow up'], /reference number/);
  assert.match(why.Printers, /turned this theme off/);
  assert.match(why.Intune, /nothing in your work/);
});

test('themes: a followed theme is searched even when the reader leaves it out', () => {
  work();
  briefing.follow('Microsoft Purview');
  const { kept } = briefing.cleanThemes({ themes: [theme()] }, briefing.packet(T));
  assert.deepEqual(kept.map(k => k.name).sort(), ['Microsoft Purview', 'SharePoint Online']);
});

test('items: need a real page, a quote, a date inside 30 days, and must be new', () => {
  const batch = [{ norm: 'sharepoint online', name: 'SharePoint Online' }];
  const { kept, dropped } = briefing.validate({ items: [
    item(),
    item({ headline: 'Same page again' }),
    item({ headline: 'Old news', source_url: 'https://example.com/old', published: '2026-10-10' }),
    item({ headline: 'Tomorrowland', source_url: 'https://example.com/future', published: '2026-12-25' }),
    item({ headline: 'No date', source_url: 'https://example.com/nodate', published: '' }),
    item({ headline: 'No quote', source_url: 'https://example.com/noquote', quote: 'short' }),
    item({ headline: 'Plain http', source_url: 'http://example.com/a' }),
    item({ headline: 'Shortened', source_url: 'https://bit.ly/abc' }),
    item({ headline: 'Other theme', theme: 'Kubernetes', source_url: 'https://example.com/k8s' }),
    item({ headline: 'Seen last week', source_url: 'https://www.example.com/seen/' }),
  ] }, batch, DAY, new Set(['example.com/seen']));
  assert.deepEqual(kept.map(k => k.headline), ['SharePoint Migration Tool adds incremental sync']);
  const why = Object.fromEntries(dropped.map(d => [d.headline, d.reason]));
  assert.equal(why['Same page again'], 'already reported');
  assert.match(why['Old news'], /older than 30 days/);
  assert.match(why.Tomorrowland, /future/);
  assert.match(why['No date'], /publication date/);
  assert.match(why['No quote'], /quote/);
  assert.match(why['Plain http'], /https/);
  assert.match(why.Shortened, /shortener/);
  assert.match(why['Other theme'], /not one of those searched/);
  assert.equal(why['Seen last week'], 'already reported');
});

test('a morning end to end: themes, two themes to a search job, nothing private in the search, links back to his work', async () => {
  work();
  const jobs = fakeJobs();
  assert.equal((await briefing.tick({ jobs, t: T })).started, true);
  assert.equal(jobs.last().feature, 'crm_briefing_themes');
  assert.match(jobs.last().payload.userPrompt, /Aoife Brennan/, 'the theme reader sees his real work');
  assert.equal((await briefing.tick({ jobs, t: T + 60 })).started, false, 'one run at a time');
  assert.equal(jobs.enqueued.length, 1);

  const names = ['SharePoint Online', 'SQL Server Extended Security Updates', 'Microsoft Entra ID', 'Power Automate', 'Microsoft Teams'];
  jobs.finish('job1', { themes: names.map((name, i) => theme({ name, query: `${name} news`, refs: i === 1 ? ['T2'] : ['P1', 'T1'], weight: i === 0 ? 3 : 2 })) });
  await briefing.tick({ jobs, t: T + 120 });
  assert.equal(row().status, 'search');
  const search1 = jobs.last();
  assert.equal(search1.feature, 'crm_briefing_search');
  const sent = search1.payload.systemPrompt + search1.payload.userPrompt;
  for (const secret of ['Aoife', 'Brennan', 'Northside', 'Departments', 'data transfer', 'pr1', 't1']) assert.ok(!sent.includes(secret), `${secret} must not reach the web step`);
  const asked = JSON.parse(search1.payload.userPrompt);
  assert.equal(asked.themes.length, 2, 'two themes to a job, so every theme gets its searches');
  assert.equal(asked.since, '2026-10-18');
  const four = ['a', 'b', 'c', 'd'];

  jobs.finish('job2', { items: [item(), item({ headline: 'Sharing links default changes', source_url: 'https://learn.microsoft.com/sharing-default', published: '2026-11-16', kind: 'change' }),
    item({ theme: 'SQL Server Extended Security Updates', headline: 'ESU year two pricing published', source_url: 'https://learn.microsoft.com/esu', kind: 'licensing' })],
    searched: [{ theme: 'SharePoint Online', found: 2, queries: four }, { theme: 'SQL Server Extended Security Updates', found: 1, queries: four }] });
  await briefing.tick({ jobs, t: T + 300 });
  assert.deepEqual(JSON.parse(jobs.last().payload.userPrompt).themes.map(x => x.theme), ['Microsoft Entra ID', 'Power Automate']);
  jobs.finish('job3', { items: [], searched: [{ theme: 'Microsoft Entra ID', found: 0, note: 'Checked the Entra blog and release notes; nothing since 10 November.', queries: four },
    { theme: 'Power Automate', found: 0, note: 'Nothing.', queries: ['power automate news'] }] });
  await briefing.tick({ jobs, t: T + 400 });
  assert.equal(row().status, 'search', 'the fifth theme still needs its own job');
  assert.equal(JSON.parse(jobs.last().payload.userPrompt).themes.length, 1);
  jobs.finish('job4', { items: [], searched: [{ theme: 'Microsoft Teams', found: 0, queries: four }] }, { runner: 'grok', model: 'grok-4.7', fallbackFrom: 'claude' });
  await briefing.tick({ jobs, t: T + 500 });

  const b = briefing.today(T + 600);
  assert.equal(b.status, 'done');
  assert.equal(b.items.length, 3);
  assert.match(b.model, /standing in for claude/);
  const sp = b.themes.find(th => th.name === 'SharePoint Online');
  assert.equal(sp.items.length, 2);
  assert.deepEqual(sp.links.map(l => l.href), ['/crm/work/projects/pr1', '/crm/work/tasks/t1']);
  assert.match(b.themes.find(th => th.name === 'Microsoft Entra ID').note, /nothing since/);
  const pa = b.themes.find(th => th.name === 'Power Automate');
  assert.equal(pa.shallow, true, 'one search out of four is not "nothing new"');
  assert.match(pa.note, /Not searched properly: 1 of 4 searches/);
  assert.deepEqual(briefing.headlines(T + 600, 5).map(h => h.themeName), ['SharePoint Online', 'SQL Server Extended Security Updates', 'SharePoint Online']);
  assert.equal((await briefing.tick({ jobs, t: T + 3600 })).started, false, 'once a day');
  assert.deepEqual(briefing.health('work', T + 3600), []);

  // Tomorrow the same page is not news again, and the model is told so.
  const T2 = T + 86400;
  await briefing.tick({ jobs, t: T2 });
  jobs.finish(jobs.last().id, { themes: [theme()] });
  await briefing.tick({ jobs, t: T2 + 60 });
  assert.ok(JSON.parse(jobs.last().payload.userPrompt).already_reported.includes('https://techcommunity.microsoft.com/blog/spmt-incremental'));
  jobs.finish(jobs.last().id, { items: [item()], searched: [] });
  await briefing.tick({ jobs, t: T2 + 120 });
  const second = briefing.today(T2 + 200);
  assert.equal(second.status, 'done');
  assert.equal(second.items.length, 0);
  assert.equal(second.dropped[0].reason, 'already reported');
});

test('stale: no weekend briefing, none started before 06:00 or after 14:00, and a run left overnight is dropped', async () => {
  work();
  const jobs = fakeJobs();
  const at = iso => Date.parse(iso) / 1000;
  assert.equal((await briefing.tick({ jobs, t: at('2026-11-15T09:00:00Z') })).started, false, 'Sunday');
  assert.equal((await briefing.tick({ jobs, t: at('2026-11-17T05:30:00Z') })).started, false, 'too early');
  assert.equal((await briefing.tick({ jobs, t: at('2026-11-17T14:05:00Z') })).started, false, 'too late');
  assert.equal(jobs.enqueued.length, 0);
  assert.equal((await briefing.tick({ jobs, t: at('2026-11-17T13:50:00Z') })).started, true);
  await briefing.tick({ jobs, t: at('2026-11-18T06:10:00Z') });
  assert.equal(row().status, 'failed');
  assert.match(row().error, /not finished on the day/);
  assert.equal(jobs.enqueued.length, 2, "yesterday's is dropped and today's starts on the next tick or the same one");
});

test('failures: three tries, then visible on Today; "Write it again" recovers', async () => {
  work();
  const jobs = fakeJobs();
  await briefing.tick({ jobs, t: T });
  jobs.fail('job1', 'Claude usage limit');
  await briefing.tick({ jobs, t: T + 120 });
  assert.match(row().error, /trying again/);
  jobs.finish('job2', 'I could not do that');
  await briefing.tick({ jobs, t: T + 240 });
  assert.equal(jobs.enqueued.length, 3);
  await briefing.tick({ jobs, t: T + 240 + 21 * 60 });
  assert.equal(row().status, 'failed');
  assert.match(row().error, /did not answer within 20 minutes.*gave up after 3 tries/);
  const health = briefing.health('work', T + 3600);
  assert.equal(health[0].level, 'bad');
  assert.deepEqual(briefing.health('personal', T + 3600), []);
  assert.equal((await briefing.tick({ jobs, t: T + 3700 })).started, false, 'a failed day is not retried by itself forever');

  briefing.writeNow({ jobs, t: T + 4000 });
  assert.throws(() => briefing.writeNow({ jobs, t: T + 4100 }), /already being written/);
  jobs.finish(jobs.last().id, { themes: [] });
  await briefing.tick({ jobs, t: T + 4200 });
  assert.equal(row().status, 'done');
  assert.equal(row().error, '');
  assert.throws(() => briefing.writeNow({ jobs, t: T + 4300 }), /less than 20 minutes/);
});

test('a search that returns nothing at all is flagged, and a half-finished search keeps what it found', async () => {
  work();
  const jobs = fakeJobs();
  await briefing.tick({ jobs, t: T });
  jobs.finish('job1', { themes: [theme()] });
  await briefing.tick({ jobs, t: T + 60 });
  jobs.finish('job2', { items: [], searched: [] });
  await briefing.tick({ jobs, t: T + 120 });
  assert.match(briefing.health('work', T + 200).map(h => h.text).join(' '), /returned nothing at all/);

  db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true });
  work();
  const j = fakeJobs();
  await briefing.tick({ jobs: j, t: T });
  j.finish('job1', { themes: ['A', 'B', 'C', 'D', 'E'].map(x => theme({ name: `Product ${x}` })) });
  await briefing.tick({ jobs: j, t: T + 60 });
  j.finish('job2', { items: [item({ theme: 'Product A' })], searched: [] });
  await briefing.tick({ jobs: j, t: T + 120 });
  for (let i = 0; i < 3; i++) { j.fail(j.last().id, 'web tools unavailable'); await briefing.tick({ jobs: j, t: T + 200 + i * 60 }); }
  assert.equal(row().status, 'done');
  assert.match(row().error, /Searching the web: web tools unavailable/);
  assert.equal(briefing.today(T + 600).items.length, 1);
  assert.match(briefing.health('work', T + 600)[0].text, /couldn't be rewritten|web tools unavailable/);
});

test('screens render: full briefing, Today card, morning email section', async () => {
  work();
  const jobs = fakeJobs();
  const views = path.join(__dirname, '..', 'views', 'crm');
  const locals = b => ({ page: 'briefing', title: 'Work briefing', space: 'work', flash: null, reviewAll: 0, whatsappWaiting: 0, krispWaiting: 0, icon: require('../lib/crm/icons'),
    b, day: DAY, isToday: true, recent: briefing.recent(), prefs: briefing.prefs() });
  assert.match(await ejs.renderFile(path.join(views, 'briefing.ejs'), locals(null)), /has not been written yet/);
  await briefing.tick({ jobs, t: T });
  assert.match(await ejs.renderFile(path.join(views, 'briefing.ejs'), locals(briefing.today(T))), /Choosing today&#39;s themes/);
  jobs.finish('job1', { themes: [theme(), theme({ name: 'Northside Clinic rollout' })] });
  await briefing.tick({ jobs, t: T + 60 });
  jobs.finish('job2', { items: [item({ headline: '<script>alert(1)</script> SPMT update' })], searched: [] });
  await briefing.tick({ jobs, t: T + 120 });
  const html = await ejs.renderFile(path.join(views, 'briefing.ejs'), locals(briefing.today(T + 200)));
  assert.match(html, /SharePoint Online/);
  assert.match(html, /Why you:/);
  assert.match(html, /href="\/crm\/work\/projects\/pr1"/);
  assert.match(html, /https:\/\/techcommunity\.microsoft\.com\/blog\/spmt-incremental/);
  assert.ok(!html.includes('<script>alert(1)'), 'web text is escaped');
  assert.match(html, /Left out \(1\)/);
  const card = await ejs.renderFile(path.join(views, '_briefing-card.ejs'), { briefing: { today: briefing.today(T + 200), headlines: briefing.headlines(T + 200) } });
  assert.match(card, /News for your work/);
  assert.match(card, /1 new on 1 theme/);
  assert.equal((await ejs.renderFile(path.join(views, '_briefing-card.ejs'), { briefing: null })).trim(), '');
  assert.equal(briefing.forEmail(T + 3600).length, 1, 'the morning email can use it');
});

test('worth finding: one official Microsoft page may be undated; anything else is turned away', () => {
  const batch = [{ norm: 'sharepoint migration tool', name: 'SharePoint Migration Tool', find: true }, { norm: 'sharepoint online', name: 'SharePoint Online' }];
  const tool = o => item({ theme: 'SharePoint Migration Tool', headline: 'SPMT scans file shares before moving', published: '', kind: 'guidance', ...o });
  const { kept, dropped } = briefing.validate({ items: [
    tool({ source_url: 'https://learn.microsoft.com/sharepointmigration/spmt-scan' }),
    tool({ headline: 'A second tool', source_url: 'https://learn.microsoft.com/other' }),
    tool({ headline: 'Blog copy', source_url: 'https://someblog.example.com/spmt' }),
    item({ headline: 'Project Online retires', source_url: 'https://learn.microsoft.com/project-online-retire', published: '2026-09-30', kind: 'retirement' }),
    item({ headline: 'Old feature news', source_url: 'https://learn.microsoft.com/old-feature', published: '2026-09-30', kind: 'feature' }),
    item({ headline: 'Undated news', source_url: 'https://learn.microsoft.com/undated', published: '' }),
  ] }, batch, DAY);
  assert.deepEqual(kept.map(k => [k.headline, k.kind]), [['SPMT scans file shares before moving', 'tool'], ['Project Online retires', 'retirement']]);
  const why = Object.fromEntries(dropped.map(d => [d.headline, d.reason]));
  assert.match(why['A second tool'], /more than 1/);
  assert.match(why['Blog copy'], /official Microsoft page/);
  assert.match(why['Old feature news'], /older than 30 days/);
  assert.match(why['Undated news'], /publication date/);
  assert.ok(briefing.officialUrl('https://github.com/microsoft/spmt'));
  assert.ok(!briefing.officialUrl('https://github.com/someone/microsoft'));
  assert.ok(!briefing.officialUrl('https://microsoft.com.evil.example/x'));
});

test('the theme reader may ask for one tool to find for an open task; it must cite the task and keep names off the web', () => {
  work();
  const records = briefing.packet(T);
  const ok = briefing.cleanThemes({ themes: [theme()], find: { name: 'SharePoint Migration Tool', query: 'scan file shares before migration', why: 'For the file-share move.', refs: ['T1'] } }, records);
  assert.deepEqual(ok.kept.map(th => [th.name, !!th.find]), [['SharePoint Online', false], ['SharePoint Migration Tool', true]]);
  const leaky = briefing.cleanThemes({ themes: [], find: { name: 'Tool for Aoife Brennan', query: 'x', refs: ['T1'] } }, records);
  assert.equal(leaky.kept.length, 0);
  assert.match(leaky.dropped[0].reason, /named a person/);
  const uncited = briefing.cleanThemes({ themes: [], find: { name: 'Some Tool', query: 'x', refs: [] } }, records);
  assert.match(uncited.dropped[0].reason, /nothing in your work/);
});

test('email eligibility: an item stays offered until it is sent, then never again; low confidence and stale news are left out', () => {
  const c = db.crm();
  const put = (day, items) => c.prepare("INSERT INTO briefings (id, day, trigger, status, themes, items, created_at) VALUES (?, ?, 'auto', 'done', ?, ?, ?)")
    .run(`b-${day}`, day, JSON.stringify([{ norm: 'sharepoint online', name: 'SharePoint Online', why: 'File-share move', weight: 3 }]), JSON.stringify(items), T);
  const it = o => ({ theme: 'sharepoint online', headline: 'h', summary: 's', action: 'a', published: '2026-11-15', source: 'MS', url: 'https://learn.microsoft.com/a', quote: 'q', kind: 'feature', confidence: 'high', ...o });
  put('2026-11-16', [it(), it({ url: 'https://learn.microsoft.com/low', confidence: 'low' }), it({ url: 'https://learn.microsoft.com/stale', published: '2026-10-01' })]);
  put('2026-11-17', [it({ url: 'https://learn.microsoft.com/b', published: '2026-11-16' })]);
  const first = briefing.forEmail(T + 3600);
  assert.deepEqual(first.map(i => i.url).sort(), ['https://learn.microsoft.com/a', 'https://learn.microsoft.com/b']);
  assert.equal(first[0].why, 'File-share move');
  briefing.markDelivered(first.filter(i => i.url.endsWith('/a')), T + 3600);
  assert.deepEqual(briefing.forEmail(T + 86400).map(i => i.url), ['https://learn.microsoft.com/b'], 'yesterday\'s unsent item carries over; the sent one does not');
  assert.ok(JSON.parse(briefing.searchUserPrompt([{ name: 'SharePoint Online', query: 'q' }], '2026-11-18')).already_reported.includes('https://learn.microsoft.com/a'));
});

test('two briefings running with shallow searches are flagged as not to be trusted', () => {
  const c = db.crm();
  for (const day of ['2026-11-16', '2026-11-17']) c.prepare("INSERT INTO briefings (id, day, trigger, status, themes, raw_count, created_at) VALUES (?, ?, 'auto', 'done', ?, 1, ?)")
    .run(`b-${day}`, day, JSON.stringify([{ norm: 'x', name: 'X', searched: true, shallow: true }]), T);
  assert.match(briefing.health('work', T + 3600).map(h => h.text).join(' '), /fewer searches than it must on two briefings running/);
});
