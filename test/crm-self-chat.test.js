'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-self-chat-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db'), selfChat = require('../lib/crm/self-chat'), whatsapp = require('../lib/crm/whatsapp');
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });
function chat({ status = 'approved', space = 'personal', is_self = 1 } = {}) {
  db.crm().prepare(`INSERT INTO whatsapp_chats(chat_id,name,is_group,is_self,status,space,decided_at)
    VALUES('353861111111@s.whatsapp.net','You',0,?,?,?,?)`).run(is_self, status, space, db.now());
  return db.crm().prepare('SELECT * FROM whatsapp_chats').get();
}
test('only an approved, unpaused self chat can be queued for; notes confirm their space', () => {
  const c = chat();
  assert.equal(selfChat.queue({ ...c, status: 'waiting' }, 'k', 'body'), false);
  assert.equal(selfChat.queue(c, 'k', 'body'), true);
  assert.equal(selfChat.queue(c, 'k', 'body'), false, 'one item key is queued once');
  whatsapp.setPaused(true);
  assert.equal(selfChat.queue(c, 'another', 'body'), false);
  whatsapp.setPaused(false);
  const source = { id: 's1', space: 'work', is_history: 0 };
  selfChat.capture(c, [{ body: 'Work: Met Aoife, she is moving to Stripe' }], source);
  const row = db.crm().prepare("SELECT * FROM whatsapp_outbox WHERE item_key='note:s1'").get();
  assert.match(row.body, /Saved in Work/);
  assert.match(row.body, /\/crm\/work\/sources\/s1/);
});
test('a claimed reminder is sent once and its outcome is recorded', () => {
  const c = chat();
  selfChat.queue(c, 'reminder:one', 'Meeting in 30 minutes');
  const claimed = selfChat.claim([c.chat_id], db.now());
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].body, '[Hub] Meeting in 30 minutes');
  assert.equal(selfChat.claim([c.chat_id], db.now()).length, 0, 'claiming removes it from the queue');
  assert.equal(db.crm().prepare("SELECT status FROM whatsapp_outbox WHERE id=?").get(claimed[0].id).status, 'claimed');
  selfChat.complete(claimed[0].id, { ok: true, messageId: 'wamid' });
  assert.equal(db.crm().prepare('SELECT status FROM whatsapp_outbox WHERE id=?').get(claimed[0].id).status, 'sent');
  assert.equal(db.crm().prepare("SELECT status FROM effects WHERE module='crm_whatsapp_self'").get().status, 'done');
  selfChat.queue(c, 'reminder:two', 'Another');
  const second = selfChat.claim([c.chat_id], db.now())[0];
  const effect = db.crm().prepare('SELECT effect_id FROM whatsapp_outbox WHERE id=?').get(second.id).effect_id;
  selfChat.complete(second.id, { ok: false, error: 'send timed out' });
  assert.equal(db.crm().prepare('SELECT status FROM whatsapp_outbox WHERE id=?').get(second.id).status, 'failed');
  assert.equal(db.crm().prepare('SELECT status FROM effects WHERE id=?').get(effect).status, 'uncertain');
});
test('claim is refused for a chat that is not an approved self chat, and expired reminders are dropped', () => {
  const c = chat({ status: 'waiting' });
  selfChat.queue({ ...c, status: 'approved' }, 'reminder:one', 'Never sent');
  assert.equal(selfChat.claim([c.chat_id], db.now()).length, 0);
  db.crm().prepare("UPDATE whatsapp_chats SET status='approved' WHERE chat_id=?").run(c.chat_id);
  db.crm().prepare("UPDATE whatsapp_outbox SET expires_at=?").run(db.now() - 1);
  selfChat.tick(db.now());
  assert.equal(db.crm().prepare("SELECT status FROM whatsapp_outbox WHERE item_key='reminder:one'").get().status, 'expired');
  assert.equal(selfChat.claim([c.chat_id], db.now()).length, 0);
});
test("the Hub's own reply, echoed back by WhatsApp, is not stored and is never answered again", () => {
  const c = chat();
  const incoming = (id, body) => whatsapp.receive({ chat_id: c.chat_id, is_self: true, is_group: false, from_me: true, message_id: id, body, sent_at: db.now() });
  assert.equal(incoming('m1', 'Met Aoife Brennan, she is moving to Stripe').stored, true);
  db.crm().prepare('UPDATE whatsapp_messages SET received_at = received_at - 400').run();
  whatsapp.settle(db.now());
  const [reply] = selfChat.claim([c.chat_id], db.now());
  assert.match(reply.body, /^\[Hub\] Saved in Personal/);
  selfChat.complete(reply.id, { ok: true });
  assert.deepEqual(incoming('m2', reply.body), { stored: false, reason: 'hub_reply' });
  db.crm().prepare('UPDATE whatsapp_messages SET received_at = received_at - 400').run();
  whatsapp.settle(db.now());
  assert.equal(selfChat.claim([c.chat_id], db.now()).length, 0);
  assert.equal(db.crm().prepare("SELECT COUNT(*) n FROM sources WHERE origin='whatsapp'").get().n, 1);
});
