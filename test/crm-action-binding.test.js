'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-binding-'));
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
const { crm, now } = require('../lib/crm/db');
const sources = require('../lib/crm/sources');
const atoms = require('../lib/crm/atoms');
const promises = require('../lib/crm/promises');
const tasks = require('../lib/crm/tasks');
const evidence = require('../lib/crm/task-email-evidence');
const { bind } = require('../lib/crm/action-binding');

const DAY = 86400;
let seq = 0;
function mail(text, { title = `Mail ${++seq}`, direction = 'out', ago = 0, space = 'work' } = {}) {
  return sources.admitSource({ space, kind: 'email', origin: 'test', externalId: `b-${++seq}`, title, direction, text, occurredAt: now() - ago * DAY, participants: [] }).source;
}
function promise(text, quote, spec, { title, direction = 'out', ago = 0 } = {}) {
  const s = mail(text, { title, direction, ago });
  const statement = `Statement ${++seq}: ${spec.action}`;
  atoms.applyAtoms(s.id, [{ statement, kind: 'promise', quote, people: [], projects: [], topics: [], confidence: 'high', promise: spec }], []);
  return crm().prepare('SELECT * FROM atoms WHERE statement = ?').get(statement);
}
const mine = (action, extra = {}) => ({ direction: 'mine', who: null, action, due: null, certainty: 'clear', ...extra });
const owed = (action, extra = {}) => ({ direction: 'owed_to_me', who: 'Pat Payne', action, due: null, certainty: 'clear', ...extra });

test('bind: the quote must bear on the action; marks and subjects decide the rest', () => {
  assert.equal(bind('I will review the rota on Friday', 'reset the payroll server', 'Rota'), 'unrelated');
  assert.equal(bind('I will review the rota on Friday', 'reset the payroll server', 'Payroll server'), 'uncertain', 'a shared subject only asks');
  assert.equal(bind("I'll send you the DPIA draft", 'send the DPIA draft'), 'supported');
  assert.equal(bind('Quote attached', 'send the pricing quote to Sarah', '', 'Sarah'), 'supported', 'the other party need not be named');
  assert.equal(bind('Done.', 'prepare the payroll bank file for December', 'Re: Payroll bank file December'), 'supported');
  assert.equal(bind('Done.', 'prepare the payroll bank file for December', 'Payroll'), 'uncertain', 'one shared word in the subject is not enough');
  assert.equal(bind('Done.', 'prepare the payroll bank file for December', 'Unrelated'), 'uncertain');
  assert.equal(bind('Audit results attached', 'prepare the payroll bank file for December', 'Payroll - November audit results'), 'unrelated', 'November is not December');
  assert.equal(bind('Invoice 1042 paid', 'chase invoice 1043', ''), 'unrelated', 'a different number');
  assert.equal(bind('Q3 figures attached', 'send the Q3 figures'), 'supported');
  assert.equal(bind('Q2 figures attached', 'send the Q3 figures'), 'unrelated');
});

test('a genuine quote about another matter never makes a clear promise or a task', async () => {
  const wrong = promise('I will review the rota on Friday.', 'I will review the rota on Friday', mine('reset the payroll server'));
  assert.equal(promises.get(wrong.id).certainty, 'unsure');
  const right = promise('I will reset the payroll server tonight.', 'I will reset the payroll server', mine('reset the payroll server'));
  assert.equal(promises.get(right.id).certainty, 'clear');
  const shortYes = promise('Will do.', 'Will do', mine('send the DPIA draft'), { title: 'Re: DPIA draft for Jane' });
  assert.equal(promises.get(shortYes.id).certainty, 'clear', 'a short reply resolved by its subject stays clear');
  const shortOnly = promise('Will do.', 'Will do', mine('send the DPIA draft'), { title: 'Hello' });
  assert.equal(promises.get(shortOnly.id).certainty, 'unsure');

  // Old rows recorded before binding existed are checked again before they make a task.
  crm().prepare("UPDATE promises SET certainty = 'clear' WHERE atom_id = ?").run(wrong.id);
  crm().prepare('UPDATE promises SET looked_back_at = ? WHERE atom_id IN (?, ?, ?)').run(now(), wrong.id, right.id, shortYes.id);
  await promises.run();
  assert.equal(promises.get(wrong.id).task_id, null);
  assert.equal(promises.get(wrong.id).certainty, 'unsure', 'demoted for Douglas to review');
  assert.ok(promises.ledger('work').mine.some(p => p.atom_id === wrong.id), 'still listed');
  assert.ok(promises.get(right.id).task_id, 'the supported promise still becomes a task');
  assert.ok(promises.get(shortYes.id).task_id);
  assert.equal(promises.get(shortOnly.id).task_id, null);
});

test('a chased promise: an unrelated quote cannot confirm a request', () => {
  const s = mail('Please send the audit pack.', { direction: 'out' });
  atoms.applyAtoms(s.id, [{ statement: 'Douglas asked Pat for the audit pack.', kind: 'promise', quote: 'Please send the audit pack', confidence: 'high', promise: owed('send the audit pack', { is_request: true }) }], []);
  const req = crm().prepare("SELECT id FROM atoms WHERE statement = 'Douglas asked Pat for the audit pack.'").get().id;
  assert.equal(promises.get(req).is_request, 1);
  const off = mail('I will review the rota on Friday.', { direction: 'in', title: 'Rota' });
  atoms.applyAtoms(off.id, [{ statement: 'Pat will review the rota.', kind: 'promise', quote: 'I will review the rota on Friday', confidence: 'high', same_as: req, promise: owed('send the audit pack', { is_request: false }) }], [req]);
  assert.equal(promises.get(req).is_request, 1, 'still only a request');
  const yes = mail('I will send the audit pack tomorrow.', { direction: 'in' });
  atoms.applyAtoms(yes.id, [{ statement: 'Pat will send the audit pack.', kind: 'promise', quote: 'I will send the audit pack', confidence: 'high', same_as: req, promise: owed('send the audit pack', { is_request: false }) }], [req]);
  assert.equal(promises.get(req).is_request, 0, 'an accepting quote about the action confirms it');
});

test('fulfilment: November audit results cannot close the December bank file; real completions still do', () => {
  const p = promise('I will prepare the payroll bank file for December.', 'I will prepare the payroll bank file for December', mine('prepare the payroll bank file for December'));
  const open = () => promises.get(p.id);
  const resolve = (text, quote, title, certainty = 'clear') => {
    const s = mail(text, { title, direction: 'in' });
    atoms.applyAtoms(s.id, [], [p.id], [{ id: p.id, quote, certainty }]);
    return s;
  };

  resolve('November audit results attached.', 'November audit results attached', 'Payroll - November audit results');
  assert.equal(open().state, 'open');
  assert.equal(open().looks_done_source_id, null, 'a different month is not even asked about');

  resolve('I will review the rota on Friday.', 'I will review the rota on Friday', 'Rota');
  assert.equal(open().state, 'open');
  assert.equal(open().looks_done_source_id, null, 'a quote about something else is ignored');

  const loose = resolve('Done.', 'Done.', 'Payroll');
  assert.equal(open().state, 'open', 'a bare "Done." under a one-word subject does not close it');
  assert.equal(open().looks_done_source_id, loose.id, 'but Douglas is asked');
  promises.notDone(p.id);

  resolve('Done.', 'Done.', 'Re: Payroll bank file for December');
  assert.equal(open().state, 'kept', 'the subject names the work, so the short reply closes it');
});

test('fulfilment: partial overlap from a "clear" claim asks instead of closing', () => {
  const p = promise('I will send the signed supplier contract and the insurance certificate.', 'I will send the signed supplier contract', mine('send the signed supplier contract and insurance certificate'));
  const s = mail('The supplier is ready to proceed.', { title: 'Next steps', direction: 'in' });
  atoms.applyAtoms(s.id, [], [p.id], [{ id: p.id, quote: 'The supplier is ready to proceed', certainty: 'clear' }]);
  assert.equal(promises.get(p.id).state, 'open');
  assert.equal(promises.get(p.id).looks_done_source_id, s.id);
});

test('look-back: unrelated quotes are ignored, loose ones ask, bound ones close', () => {
  const p = promise('I will prepare the payroll bank file for December.', 'I will prepare the payroll bank file for December', mine('prepare the payroll bank file for December'), { ago: 1 });
  crm().prepare('UPDATE promises SET looked_back_at = NULL WHERE atom_id = ?').run(p.id);
  const run = (s, verdict, quote) => {
    const job = { status: 'completed', result: { output: JSON.stringify({ verdict, source_id: s.id, quote }) } };
    const jobs = { enqueue: () => ({ jobId: `j${++seq}` }), getJob: () => job };
    crm().prepare('UPDATE promises SET looked_back_at = NULL WHERE atom_id = ?').run(p.id);
    assert.equal(promises.enqueueCheck({ enqueue: jobs.enqueue, getJob: jobs.getJob }), true);
    return promises.collectCheck(jobs, JSON.parse);
  };
  // The checker only shows mail from the promise's own thread (or sender).
  const threadTitle = crm().prepare('SELECT s.title FROM atom_sources x JOIN sources s ON s.id = x.source_id WHERE x.atom_id = ?').get(p.id).title;
  const related = (text, title = threadTitle) => mail(text, { title, direction: 'in' });

  const november = related('November audit results attached.');
  run(november, 'done', 'November audit results attached');
  assert.equal(promises.get(p.id).state, 'open');
  assert.equal(promises.get(p.id).looks_done_source_id, null);

  const elsewhere = related('I will review the rota on Friday.');
  run(elsewhere, 'done', 'I will review the rota on Friday');
  assert.equal(promises.get(p.id).state, 'open');
  assert.equal(promises.get(p.id).looks_done_source_id, null);

  const loose = related('Done.');
  run(loose, 'done', 'Done.');
  assert.equal(promises.get(p.id).state, 'open', 'a bare "Done." says nothing about which work it was');
  assert.equal(promises.get(p.id).looks_done_source_id, loose.id, 'so Douglas is asked rather than it closing');
  promises.notDone(p.id);

  const bound = related('The December payroll bank file is prepared and attached.');
  run(bound, 'done', 'The December payroll bank file is prepared and attached');
  assert.equal(promises.get(p.id).state, 'kept');
});

test('standalone tasks: wrong-month or unrelated mail cannot close them; supported mail still does; loose mail asks', () => {
  const mk = (title, subject, text) => {
    const src = mail(text, { title: subject });
    const t = tasks.create('work', { title });
    crm().prepare('UPDATE tasks SET source_id = ?, created_at = ? WHERE id = ?').run(src.id, now() - 5 * DAY, t.id);
    return tasks.get(t.id);
  };
  const task = mk('Prepare payroll bank file for December', 'Payroll bank file for December', 'Please prepare the payroll bank file for December.');
  const reply = (text, quote, subject, certainty = 'clear') => {
    const s = mail(text, { title: subject, direction: 'in' });
    const ref = evidence.ref(task);
    assert.ok(evidence.candidates(s).map(evidence.ref).includes(ref), 'shown to the reader');
    atoms.applyAtoms(s.id, [], [ref], [{ id: ref, quote, certainty }]);
    return s;
  };
  const rows = () => crm().prepare('SELECT * FROM task_email_evidence WHERE task_id = ?').all(task.id);

  reply('The payroll audit results for November are attached.', 'payroll audit results for November are attached', 'Payroll bank file - November audit results');
  assert.equal(tasks.get(task.id).status, 'needsAction');
  assert.equal(rows().length, 0, 'a different month leaves no evidence at all');

  reply('I will review the rota on Friday. The payroll bank file is separate.', 'I will review the rota on Friday', 'Rota');
  assert.equal(tasks.get(task.id).status, 'needsAction');
  assert.equal(rows().length, 0, 'a quote about something else leaves none either');

  const loose = reply('The payroll bank file is attached.', 'The payroll bank file is attached', 'Payroll bank file for December', 'clear');
  // Two of its words and no conflict: this one is supported and closes.
  assert.equal(tasks.get(task.id).status, 'completed');
  assert.equal(rows()[0].source_id, loose.id);
  assert.equal(rows()[0].verdict, 'done');

  const other = mk('Renew the annual gadget licence for the Dublin office', 'Gadget licence renewal', 'Please renew the annual gadget licence for the Dublin office.');
  const s = mail('All sorted, thanks.', { title: 'Gadget query', direction: 'in' });
  const ref = evidence.ref(other);
  assert.ok(evidence.candidates(s).map(evidence.ref).includes(ref));
  atoms.applyAtoms(s.id, [], [ref], [{ id: ref, quote: 'All sorted, thanks.', certainty: 'clear' }]);
  const e = crm().prepare('SELECT verdict FROM task_email_evidence WHERE task_id = ?').get(other.id);
  assert.equal(tasks.get(other.id).status, 'needsAction', 'a "clear" claim resting on one shared subject word is demoted');
  assert.equal(e?.verdict, 'likely', 'and shown to Douglas as likely');
});

test('a negated completion stays open for review even with a matching subject', () => {
  const {bind} = require('../lib/crm/action-binding');
  assert.equal(bind("I haven't sent the payroll file", 'send the payroll file', 'Payroll file'), 'uncertain');
});
