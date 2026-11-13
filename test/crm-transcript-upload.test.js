'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-upload-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const meetings = require('../lib/crm/meetings');
const documents = require('../lib/crm/documents');
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

const START = Math.floor(Date.now() / 1000) - 2 * 86400;
const TRANSCRIPT = 'Synthetic board call, 11 Nov\n[00:00:03] Ann Example: Morning. Shall we start?\n[00:00:09] Speaker 2: Yes. I will send the minutes by Friday.\nSecond line from speaker two.\n[00:00:20] Ann Example: Thanks.';

test('a transcript uploaded from a calendar entry waits on Meetings, then releases into that entry', async () => {
  db.crm().prepare(`INSERT INTO calendar_events(id,calendar_id,space,title,start_at,end_at,attendees) VALUES('ev1','primary','personal','Synthetic board call',?,?,?)`)
    .run(START, START + 3600, JSON.stringify([{ email: 'ann@example.invalid', name: 'Ann Example' }]));
  db.crm().prepare(`INSERT INTO calendar_events(id,calendar_id,space,title,start_at,end_at,all_day) VALUES('ev2','primary','work','Away',?,?,1)`).run(START, START + 86400);
  // The real failure: the same file added on "Add a note" while .transcript was unreadable.
  db.crm().prepare(`INSERT INTO sources(id,space,kind,origin,external_id,title,occurred_at,text,text_fresh,readable,unreadable_reason,atomise_status)
    VALUES('old','work','report','upload',?,'Recording.transcript',?,'','',0,'The Hub can''t read .transcript files yet','skipped')`)
    .run(`work:${require('crypto').createHash('sha256').update(Buffer.from(TRANSCRIPT)).digest('hex')}`, START);

  const express = require('express'), app = express();
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  const flashes = [];
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = new Proxy({ adminUser: 'douglas' }, { set(t, k, v) { if (k === 'crmFlash' && v) flashes.push({ text: v.text, type: v.level }); t[k] = v; return true; } }); next(); });
  app.use(require('../routes/crm'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = async (event, content, name) => {
    const form = new FormData();
    form.append('event', event);
    form.append('file', new Blob([content]), name);
    return fetch(`${base}/crm/work/calendar/transcript`, { method: 'POST', redirect: 'manual', headers: { Origin: base, Referer: `${base}/crm/work/calendar` }, body: form });
  };
  try {
    let r = await upload('ev1', TRANSCRIPT, 'Recording_2026-11-11_14-04-48.transcript');
    assert.equal(r.status, 302);
    const row = db.crm().prepare('SELECT * FROM krisp_intake').get();
    assert.equal(r.headers.get('location'), `/crm/personal/meetings#intake-${row.id}`);
    assert.equal(row.origin, 'transcript'); assert.equal(row.status, 'pending'); assert.equal(row.occurred_at, START);
    assert.equal(row.title, 'Synthetic board call'); assert.equal(row.readable, 1);
    assert.match(flashes.pop().text, /2 speakers to name\. 1 line before the first speaker/);
    assert.equal(db.crm().prepare("SELECT atomise_status FROM sources WHERE id='old'").get().atomise_status, 'ignored');
    assert.equal(db.crm().prepare("SELECT count(*) n FROM sources WHERE kind='meeting'").get().n, 0);

    r = await upload('ev1', TRANSCRIPT, 'Recording_2026-11-11_14-04-48.transcript');
    assert.equal(r.headers.get('location'), `/crm/personal/meetings#intake-${row.id}`);
    assert.match(flashes.pop().text, /already waiting/);
    assert.equal(db.crm().prepare('SELECT count(*) n FROM krisp_intake').get().n, 1);

    const html = await (await fetch(`${base}/crm/work/meetings`)).text();
    assert.ok(html.includes(`id="intake-${row.id}"`));
    assert.ok(html.includes('Uploaded transcript'));
    assert.ok(html.includes('Invited: Ann Example'));
    assert.ok(html.includes('In your calendar as Synthetic board call (Personal)'));
    assert.match(html, /placeholder="Full name" value="Ann Example"/);
    assert.match(html, /Who is &ldquo;Speaker 2&rdquo;\?<\/label>\s*<input[^>]*placeholder="Full name">/);
    assert.match(html, /value="personal" required checked/);

    const revision = /name="revision" value="([a-f0-9]+)"/.exec(html)[1];
    const body = new URLSearchParams({ choice: 'personal', revision, returnSpace: 'work' });
    body.append('names', 'Ann Example'); body.append('names', 'Bob Example');
    r = await fetch(`${base}/crm/krisp/${row.id}/classify`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body });
    assert.equal(r.status, 302);
    const s = db.crm().prepare("SELECT * FROM sources WHERE kind='meeting'").get();
    assert.equal(s.origin, 'transcript'); assert.equal(s.space, 'personal'); assert.equal(s.occurred_at, START);
    assert.match(s.text, /^Ann Example: Morning\. Shall we start\?\n\nBob Example: Yes\. I will send the minutes by Friday\.\n    Second line from speaker two\./);
    assert.doesNotMatch(s.text, /Synthetic board call, 11 Nov/);
    const ev = db.crm().prepare("SELECT * FROM calendar_events WHERE id='ev1'").get();
    assert.deepEqual(meetings.transcriptsFor(ev).map(t => t.id), [s.id]);
    assert.equal(meetings.recordings('personal')[0].event.id, 'ev1');

    const sourcePage = await (await fetch(`${base}/crm/personal/sources/${s.id}`)).text();
    assert.ok(sourcePage.includes('Original uploaded file'));
    assert.ok(sourcePage.includes('Recording_2026-11-11_14-04-48.transcript'));

    r = await upload('ev1', TRANSCRIPT, 'again.txt');
    assert.equal(r.headers.get('location'), '/crm/personal/meetings');
    assert.match(flashes.pop().text, /already released to Personal/);

    for (const [event, content, name, expected] of [
      ['ev1', 'Just a monologue with nobody named.\nAnother line.', 'm.txt', /has no speaker names/],
      ['ev1', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]), 'r.transcript', /is not a text file/],
      ['ev1', 'Ann: hi', 'r.m4a', /reads transcripts saved as/],
      ['ev2', TRANSCRIPT, 'r.txt', /all-day entry/],
      ['gone', TRANSCRIPT, 'r.txt', /no longer in the Hub/],
    ]) {
      r = await upload(event, content, name);
      assert.equal(r.headers.get('location'), `${base}/crm/work/calendar`);
      const f = flashes.pop(); assert.equal(f.type, 'bad'); assert.match(f.text, expected);
    }
    assert.equal(db.crm().prepare('SELECT count(*) n FROM krisp_intake').get().n, 1);
  } finally { server.close(); }
});

test('a file refused earlier no longer answers "already here" when it becomes readable', async () => {
  const buffer = Buffer.from('Synthetic notes from a call about the Q4 audit plan and its deadlines.');
  const first = await documents.admitFile({ space: 'work', buffer, name: 'notes.unknownext' });
  assert.equal(first.readable, false);
  const second = await documents.admitFile({ space: 'work', buffer, name: 'notes.transcript' });
  assert.equal(second.readable, true); assert.equal(second.created, true);
  assert.notEqual(second.sources[0].id, first.sources[0].id);
  assert.equal(db.crm().prepare('SELECT atomise_status FROM sources WHERE id=?').get(first.sources[0].id).atomise_status, 'ignored');
  const third = await documents.admitFile({ space: 'work', buffer, name: 'notes.txt' });
  assert.equal(third.created, false);
  assert.equal((await documents.admitFile({ space: 'work', buffer: Buffer.from([1, 0, 2, 3]), name: 'bin.transcript' })).reason, 'This is not a text file');
});
