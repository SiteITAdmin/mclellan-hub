'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chat-res-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const { captureMessagingMessage } = require('../lib/messaging-capture');
const { resolveSourceEvidence, CRM_KNOWLEDGE_PIPELINE_VERSION } = require('../lib/source-evidence');
const { writeReceipt, _test } = require('../lib/crm-knowledge-engine');

const user = 'chat-resolution-test';
const chatId = '120363239923493562@g.us';

function capture(body, extras = {}) {
  return captureMessagingMessage(user, {
    platform: 'whatsapp',
    chat_id: chatId,
    chat_name: 'Dad Information Group',
    ...extras,
    body,
  });
}

function seedOpenChatTask({ messageId, title, evidence }) {
  const hub = db.hub();
  const taskId = `task-${messageId.slice(0, 8)}`;
  const outcomeId = `outcome-${messageId.slice(0, 8)}`;
  const actionKey = `action-${messageId.slice(0, 8)}`;
  hub.prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, notes, status, source, source_id, created_at)
    VALUES (?, ?, ?, '@default', ?, ?, 'needsAction', 'crm-engine', ?, unixepoch())
  `).run(taskId, user, `google-${taskId}`, title, evidence, `crm-action:${actionKey}`);
  const evidenceRow = resolveSourceEvidence(user, 'messaging_message', messageId);
  hub.prepare(`
    INSERT INTO crm_action_outcomes
      (id, user, source_kind, source_id, source_revision, pipeline_version, action_key,
       candidate_title, evidence_text, actionability, confidence, disposition, reason,
       task_id, payload, created_at, updated_at, resolved_at)
    VALUES (?, ?, 'messaging_message', ?, ?, ?, ?, ?, ?, 'explicit_ask', 0.9,
            'task_created', 'task_created', ?, '{}', unixepoch(), unixepoch(), unixepoch())
  `).run(
    outcomeId, user, messageId, evidenceRow.revision_hash, CRM_KNOWLEDGE_PIPELINE_VERSION,
    actionKey, title, evidence, taskId,
  );
  return { taskId, outcomeId, actionKey, evidence: evidenceRow };
}

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('automatic selection holds a fresh WhatsApp bubble so the reply can land', () => {
  const now = Math.floor(Date.now() / 1000);
  const fresh = capture('Is he walking okay?', {
    external_message_id: 'wa-fresh-q',
    sender_name: 'Catriona Mclellan',
    received_at: now - 30,
    raw: { direction: 'inbound' },
  });
  const settled = capture('Please put Monday lunchtime in the diary.', {
    external_message_id: 'wa-settled-q',
    sender_name: 'Catriona Mclellan',
    received_at: now - _test.MESSAGING_SETTLE_SECONDS - 30,
    raw: { direction: 'inbound' },
  });
  const selected = _test.candidateSources(user, 8, { referenceNow: now });
  const ids = selected.map(item => item.source_id);
  assert.ok(ids.includes(settled.id), 'a settled message is eligible');
  assert.ok(!ids.includes(fresh.id), 'a bubble younger than five minutes is held');
});

test('question processing sees the already-captured answer as neighbour context', () => {
  const now = Math.floor(Date.now() / 1000);
  const question = capture('Is he walking okay? Back to usual shuffle but just with stick?', {
    external_message_id: 'wa-ctx-q',
    sender_name: 'Catriona Mclellan',
    received_at: now - 400,
    raw: { direction: 'inbound' },
  });
  capture('Not sure. Was going to test that tomorrow.', {
    external_message_id: 'wa-ctx-a',
    sender_name: 'Douglas McLellan',
    received_at: now - 318,
    raw: { direction: 'outbound' },
  });
  const evidence = resolveSourceEvidence(user, 'messaging_message', question.id);
  const context = _test.messagingPromptContext(user, evidence);
  assert.match(context, /SAME-CHAT CONTEXT/);
  assert.match(context, /outbound Douglas McLellan: Not sure/);
  assert.doesNotMatch(evidence.text, /Was going to test that tomorrow/);
});

test('a later same-chat answer completes the earlier question task', async () => {
  const now = Math.floor(Date.now() / 1000);
  const question = capture('When are you going back to Dublin?', {
    external_message_id: 'wa-dub-q',
    sender_name: 'Liz',
    received_at: now - 900,
    raw: { direction: 'inbound' },
  });
  const answer = capture('Monday evening so can come see you on Sunday afternoon/evening.', {
    external_message_id: 'wa-dub-a',
    sender_name: 'Douglas McLellan',
    received_at: now - 832,
    raw: { direction: 'outbound' },
  });
  const seeded = seedOpenChatTask({
    messageId: question.id,
    title: 'Respond to Liz about when going back to Dublin',
    evidence: 'When are you going back to Dublin?',
  });
  const evidence = resolveSourceEvidence(user, 'messaging_message', answer.id);
  let completed = [];
  const applied = await _test.applyChatActionResolutions(
    user,
    evidence,
    _test.openChatSourcedActions(user, chatId),
    {
      resolutions: [{
        task_id: seeded.taskId,
        outcome_id: seeded.outcomeId,
        decision: 'resolves',
        confidence: 0.94,
        evidence: 'Monday evening so can come see you on Sunday afternoon/evening.',
        prior_evidence: 'When are you going back to Dublin?',
        reason: 'The current message answers the earlier question.',
      }],
    },
    {
      completeTaskFn: async (_user, googleTaskId, options) => {
        completed.push({ googleTaskId, origin: options.origin });
        db.hub().prepare(`
          UPDATE google_tasks SET status = 'completed', completed_at = unixepoch()
           WHERE google_task_id = ?
        `).run(googleTaskId);
      },
    },
  );

  assert.equal(applied.resolved, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].origin, 'crm-knowledge-engine:action-resolution');
  const task = db.hub().prepare('SELECT status FROM google_tasks WHERE id = ?').get(seeded.taskId);
  assert.equal(task.status, 'completed');
  const outcome = _test.getActionOutcome(user, evidence, _test.chatResolutionActionKey(seeded.taskId));
  assert.equal(outcome.disposition, 'dismissed');
  assert.equal(outcome.reason, 'resolved_by_later_evidence');
});

test('a short ok does not auto-complete an unrelated same-chat task', async () => {
  const now = Math.floor(Date.now() / 1000);
  const question = capture('Could you please pop Monday lunchtime visit in dads diary?', {
    external_message_id: 'wa-diary-q',
    sender_name: 'Catriona Mclellan',
    received_at: now - 1200,
    raw: { direction: 'inbound' },
  });
  const ack = capture('Okay', {
    external_message_id: 'wa-diary-ok',
    sender_name: 'Liz',
    received_at: now - 700,
    raw: { direction: 'inbound' },
  });
  const seeded = seedOpenChatTask({
    messageId: question.id,
    title: 'Schedule Monday lunchtime visit in Dad\'s diary',
    evidence: 'pop Monday lunchtime visit in dads diary',
  });
  const evidence = resolveSourceEvidence(user, 'messaging_message', ack.id);
  let completed = 0;
  const applied = await _test.applyChatActionResolutions(
    user,
    evidence,
    _test.openChatSourcedActions(user, chatId),
    {
      resolutions: [{
        task_id: seeded.taskId,
        decision: 'unrelated',
        confidence: 0.8,
        evidence: 'Okay',
        reason: 'Acknowledgement of a different thread.',
      }],
    },
    {
      completeTaskFn: async () => { completed += 1; },
    },
  );
  assert.equal(applied.resolved, 0);
  assert.equal(completed, 0);
  const task = db.hub().prepare('SELECT status FROM google_tasks WHERE id = ?').get(seeded.taskId);
  assert.equal(task.status, 'needsAction');
});

test('processSource runs chat resolution after projection for a messaging answer', async () => {
  const now = Math.floor(Date.now() / 1000);
  const question = capture('Is he walking okay?', {
    external_message_id: 'wa-proc-q',
    sender_name: 'Catriona Mclellan',
    received_at: now - 1500,
    raw: { direction: 'inbound' },
  });
  const answer = capture('Not sure. Was going to test that tomorrow.', {
    external_message_id: 'wa-proc-a',
    sender_name: 'Douglas McLellan',
    received_at: now - 1400,
    raw: { direction: 'outbound' },
  });
  const seeded = seedOpenChatTask({
    messageId: question.id,
    title: 'Respond to Catriona about whether Dad is walking okay',
    evidence: 'Is he walking okay?',
  });
  const evidence = resolveSourceEvidence(user, 'messaging_message', answer.id);
  writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_source_triage', {
    status: 'done',
    summary: 'Answer already in chat.',
    payload: {
      should_synthesise: false,
      candidate_actions: [],
      source_summary: 'Douglas answers the walking question.',
    },
    sourceRevision: evidence.revision_hash,
  });
  writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_action_projected', {
    status: 'done',
    summary: 'No candidate actions in this source.',
    payload: { candidates: [] },
    sourceRevision: evidence.revision_hash,
  });

  let completed = 0;
  const result = await _test.processSource(user, evidence, {
    entities: [],
    entityFacts: [],
    budget: { n: 0 },
  }, {
    dependencies: {
      requestModelObject: async () => { throw new Error('saved receipts should skip models'); },
      resolveChatActionsFn: async () => ({
        parsed: {
          resolutions: [{
            task_id: seeded.taskId,
            decision: 'resolves',
            confidence: 0.96,
            evidence: 'Not sure. Was going to test that tomorrow.',
            reason: 'This message answers the earlier walking question.',
          }],
        },
        modelId: 'test-resolution',
      }),
      completeTaskFn: async () => {
        completed += 1;
        db.hub().prepare(`
          UPDATE google_tasks SET status = 'completed', completed_at = unixepoch()
           WHERE id = ?
        `).run(seeded.taskId);
      },
    },
  });

  assert.equal(result.resolved, 1);
  assert.equal(completed, 1);
  const task = db.hub().prepare('SELECT status FROM google_tasks WHERE id = ?').get(seeded.taskId);
  assert.equal(task.status, 'completed');
});
