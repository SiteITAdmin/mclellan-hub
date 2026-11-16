'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sent-'));
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
const { crm, now, setting, setSetting } = require('../lib/crm/db');
const outlook = require('../lib/crm/outlook');
const config = require('../lib/crm/config');
const sources = require('../lib/crm/sources');
const atoms = require('../lib/crm/atoms');
const promises = require('../lib/crm/promises');
const tasks = require('../lib/crm/tasks');
let seq = 0;
function source(text, direction = 'out', space = 'work') {
  return sources.admitSource({ space, kind: 'email', origin: 'test', externalId: `email-${++seq}`,
    title: 'Figures', direction, text, occurredAt: now(), participants: [] }).source;
}
function atom(s, statement, spec, extra = {}, refs = []) {
  atoms.applyAtoms(s.id, [{ statement, quote: s.text, kind: 'promise', confidence: 'high', promise: spec, ...extra }], refs);
  return extra.same_as || crm().prepare('SELECT id FROM atoms WHERE statement = ?').get(statement).id;
}
const request = { direction: 'owed_to_me', who: 'Jane Example', action: 'send the figures', is_request: true, certainty: 'clear' };

test('Sent flow format uses recipients and file title, and never reads quoted headers as sender', () => {
  const raw = 'jane@example.com;ben@example.com <html><body><p>Please send the figures.</p><div>From: Someone Else</div><div>Sent: Monday</div><p>I will do it.</p></body></html>';
  assert.equal(outlook.parseOutlookFile(raw), null);
  const p = outlook.parseOutlookFile(raw, { sent: true, title: 'Figures' });
  assert.equal(p.from.email, config.workAddresses()[0]);
  assert.equal(p.subject, 'Figures');
  assert.equal(p.to.length, 2);
  assert.equal(p.receivedAt, null);
  const s = outlook.admitOutlookEmail(p, { fileId: 'bare-sent', fileCreatedAt: now() }).source;
  assert.equal(s.direction, 'out');
  assert.doesNotMatch(s.text_fresh, /I will do it/);
  assert.equal(outlook.parseOutlookFile('<html>No recipients</html>', { sent: true }), null);
});

test('Sent has its own cursor, accepts octet-stream, paginates ties, and imports only once', async () => {
  const stamp = new Date().toISOString();
  setSetting('outlook_cursor', new Date(Date.now() + 86400000).toISOString());
  const queries = [];
  const drive = { files: {
    list: async q => {
      queries.push(q);
      if (q.q.includes(config.outlookFolderId())) return { data: { files: [] } };
      assert.match(q.q, /application\/octet-stream/);
      assert.match(q.q, /createdTime >=/);
      return { data: { files: [{ id: q.pageToken ? 'sent-2' : 'sent-1', name: 'Sent subject', createdTime: stamp }],
        ...(q.pageToken ? {} : { nextPageToken: 'page-two' }) } };
    },
    get: async q => ({ data: `jane@example.com <html><p>Please send the new report ${q.fileId}.</p></html>` }),
  } };
  const first = await outlook.runOutlookCapture({ drive });
  assert.equal(first.admitted, 2);
  assert.equal(setting('outlook_sent_cursor'), stamp);
  assert.equal(queries.length, 3);
  const second = await outlook.runOutlookCapture({ drive });
  assert.equal(second.admitted, 0);
  assert.equal(second.duplicate, 2);
  const bad = { files: { list: async q => ({ data: { files: q.q.includes(config.outlookSentFolderId()) ? [{ id: 'broken', createdTime: stamp }] : [] } }),
    get: async () => ({ data: 'not an email' }) } };
  await assert.rejects(outlook.runOutlookCapture({ drive: bad }), /Cannot read Outlook Sent/);
  assert.match(crm().prepare("SELECT last_error FROM job_runs WHERE name = 'outlook_capture'").get().last_error, /Cannot read/);
  assert.equal(setting('outlook_sent_cursor'), stamp);
});

test('requests stay unconfirmed, persist, and repeated requests do not duplicate or promote them', async () => {
  const id = atom(source('Please send the figures by Friday.'), 'Douglas asked Jane for the figures.', request);
  assert.equal(promises.get(id).certainty, 'unsure');
  assert.equal(promises.get(id).is_request, 1);
  const repeat = source('Please send the figures by Friday.');
  atom(repeat, 'Douglas again asked Jane for the figures.', request, { same_as: id }, [id]);
  assert.equal(promises.get(id).is_request, 1);
  crm().prepare('UPDATE promises SET said_at = ? WHERE atom_id = ?').run(now() - 30 * 86400, id);
  await promises.run();
  assert.equal(promises.get(id).state, 'open');
  assert.equal(promises.get(id).task_id, null);
  const rendered = require('ejs').renderFile;
  const html = await rendered(path.join(__dirname, '../views/crm/_promises.ejs'), { list: promises.ledger('work').owed,
    none: '', space: 'work', back: '/crm/work' });
  assert.match(html, /Awaiting response/);
  assert.doesNotMatch(html, /Jane Example will/);
});

test('acceptance supersedes a request and leaves one confirmed commitment', () => {
  const id = atom(source('Please send the licence quote.'), 'Douglas asked Jane for the licence quote.', { ...request, action: 'send the licence quote' });
  const confirmed = atom(source('I will send the licence quote tomorrow.', 'in'), 'Jane agreed to send the licence quote tomorrow.',
    { ...request, action: 'send the licence quote', is_request: false }, { supersedes: id }, [id]);
  assert.equal(promises.get(id).state, 'untracked');
  assert.equal(promises.get(confirmed).certainty, 'clear');
  assert.equal(promises.get(confirmed).is_request, 0);
  assert.equal(promises.ledger('work').owed.filter(p => [id, confirmed].includes(p.atom_id)).length, 1);
});

test('same-as acceptance can confirm a request, but unverified or outgoing assertions cannot', () => {
  const id = atom(source('Please send the budget.'), 'Douglas asked Jane for the budget.', { ...request, action: 'send the budget' });
  const spec = { ...request, is_request: false, action: 'send the budget' };
  const sent = source('Jane will send the budget.');
  promises.confirmRequest(id, spec, sent, { verified: true, quote: sent.text });
  assert.equal(promises.get(id).is_request, 1);
  const reply = source('I will send the budget.', 'in');
  promises.confirmRequest(id, spec, reply, { verified: false, quote: reply.text });
  assert.equal(promises.get(id).is_request, 1);
  atom(reply, 'Jane will send the budget.', spec, { same_as: id }, [id]);
  assert.equal(promises.get(id).is_request, 0);
});

test('delivery closes requests directly; likely evidence waits; sent evidence closes only the linked task', () => {
  const req = atom(source('Please send the safety report.'), 'Douglas asked Jane for the safety report.', { ...request, action: 'send the safety report' });
  const delivered = source('Here is the safety report.', 'in');
  atoms.applyAtoms(delivered.id, [], [req], [{ id: req, quote: delivered.text, certainty: 'clear' }]);
  assert.equal(promises.get(req).state, 'kept');
  const own = atom(source('I will email Jane the proposal.'), 'Douglas will email Jane the proposal.',
    { direction: 'mine', who: 'Jane Example', action: 'email Jane the proposal', certainty: 'clear' });
  const linked = promises.makeTask(own);
  const other = tasks.create('work', { title: 'Obtain approval for the proposal' });
  const evidence = source('Here is the proposal as promised.');
  const fulfillment = { id: own, quote: evidence.text, certainty: 'likely' };
  atoms.applyAtoms(evidence.id, [], [own], [fulfillment]);
  assert.equal(tasks.get(linked.id).status, 'needsAction');
  assert.equal(promises.get(own).looks_done_source_id, evidence.id);
  atoms.applyAtoms(evidence.id, [], [own], [{ ...fulfillment, quote: 'invented completion', certainty: 'clear' }]);
  assert.equal(tasks.get(linked.id).status, 'needsAction');
  atoms.applyAtoms(source(evidence.text, 'out', 'personal').id, [], [own], [{ ...fulfillment, certainty: 'clear' }]);
  assert.equal(tasks.get(linked.id).status, 'needsAction');
  atoms.applyAtoms(evidence.id, [], [own], [{ ...fulfillment, certainty: 'clear' }]);
  assert.equal(tasks.get(linked.id).status, 'completed');
  assert.ok(tasks.get(linked.id).completed_at);
  assert.equal(tasks.get(other.id).status, 'needsAction');
  assert.equal(promises.closed('work').find(p => p.atom_id === own).closing_source_id, evidence.id);
});

test('corrected standard export wins over a headerless duplicate', async () => {
  const stamp = new Date().toISOString();
  const body = '<html><p>Please send the corrected figures.</p></html>';
  const drive = { files: {
    list: async q => ({ data: { files: q.q.includes(config.outlookSentFolderId()) ? [
      { id: 'legacy-copy', name: 'Corrected figures', createdTime: stamp, mimeType: 'application/octet-stream' },
      { id: 'standard-copy', name: 'export.html', createdTime: stamp, mimeType: 'text/html' },
    ] : [] } }),
    get: async q => ({ data: q.fileId === 'legacy-copy' ? `jane@example.com ${body}`
      : `FROM: ${config.workAddresses()[0]}\nTO: jane@example.com\nSUBJECT: Corrected figures\nRECEIVED: ${stamp}\nMESSAGE:\n${body}` }),
  } };
  const result = await outlook.runOutlookCapture({ drive });
  assert.equal(result.admitted, 1);
  assert.equal(result.duplicate, 1);
  assert.equal(crm().prepare("SELECT raw_ref FROM sources WHERE title = 'Corrected figures'").get().raw_ref, 'standard-copy');
});

test('ordinary tasks use verified email evidence and stale task revisions cannot close', () => {
  const evidence = require('../lib/crm/task-email-evidence');
  const t = tasks.create('work', { title: 'Send the invoice to Jane' });
  const unrelated = tasks.create('work', { title: 'Receive payment from Jane' });
  const s = source('Here is the invoice as promised.');
  const packet = atoms.buildPacket(s);
  assert.ok(packet.relatedIds.includes(evidence.ref(t)));
  atoms.applyAtoms(s.id, [], packet.relatedIds, [{ id: evidence.ref(t), quote: s.text, certainty: 'clear' }]);
  assert.equal(tasks.get(t.id).status, 'completed');
  assert.equal(tasks.get(unrelated.id).status, 'needsAction');
  assert.equal(tasks.detail(tasks.get(t.id)).emailEvidence[0].source_id, s.id);
  tasks.edit(t.id, { status: 'needsAction' });
  atoms.applyAtoms(s.id, [], packet.relatedIds, [{ id: evidence.ref(t), quote: s.text, certainty: 'clear' }]);
  assert.equal(tasks.get(t.id).status, 'needsAction');
  const current = tasks.get(t.id);
  atoms.applyAtoms(s.id, [], [evidence.ref(current)], [{ id: evidence.ref(current), quote: s.text, certainty: 'clear' }]);
  assert.equal(tasks.get(t.id).status, 'needsAction', 'reopened task rejects the same evidence');
  const maybe = source('That invoice should be sent now.');
  atoms.applyAtoms(maybe.id, [], [evidence.ref(current)], [{ id: evidence.ref(current), quote: maybe.text, certainty: 'likely' }]);
  assert.equal(tasks.get(t.id).status, 'needsAction');
  evidence.reject(t.id, maybe.id);
  assert.ok(!evidence.forTask(t.id).some(e => e.source_id === maybe.id));
  const changed = source('I sent the revised invoice.');
  const ref = evidence.ref(tasks.get(t.id));
  tasks.edit(t.id, { title: 'Send a completely different invoice' });
  atoms.applyAtoms(changed.id, [], [ref], [{ id: ref, quote: changed.text, certainty: 'clear' }]);
  assert.equal(tasks.get(t.id).status, 'needsAction');
});
