'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-source-evidence-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const {
  deterministicChunks,
  resolveSourceEvidence,
  listSourceEvidence,
  sourceDisplay,
  locateEvidenceSpan,
  stableActionKey,
  STALE_MEETING_PROCESSING_SECONDS,
  canonicalDocumentTaskText,
  isCanonicalEvidenceExcluded,
} = require('../lib/source-evidence');
const { extractionPrompt } = require('../lib/document-tasks');
const { _test: workdayIngestTest } = require('../lib/workday-ingest');

const user = 'source-evidence-test';

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('email evidence uses faithful body text rather than a lossy summary', () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, body_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'source-evidence-gmail', user, 'source-evidence-gmail-msg', 'Forwarded asks', 'Alex', 'alex@example.test', 1770000000,
    'Only the first ask survived the old summary.',
    'Please send the contract.\n\nPlease also confirm the budget.\n\nTAIL ASK: arrange the interview.',
  );

  const evidence = resolveSourceEvidence(user, 'email_summary', 'source-evidence-gmail');
  assert.equal(evidence.complete, true);
  assert.equal(evidence.completeness, 'complete');
  assert.match(evidence.text, /Please also confirm the budget/);
  assert.match(evidence.text, /TAIL ASK: arrange the interview/);
  assert.doesNotMatch(evidence.text, /Only the first ask survived/);

  const span = locateEvidenceSpan(evidence, 'TAIL ASK: arrange the interview.');
  assert.equal(span.exact, true);
  assert.match(stableActionKey(evidence, span), /^[a-f0-9]{64}$/);

  const firstRevision = evidence.revision_hash;
  hub.prepare('UPDATE email_summaries SET body_text = ? WHERE id = ?')
    .run('Please send the contract.\n\nNew tail action: review the revised budget.', 'source-evidence-gmail');
  const revised = resolveSourceEvidence(user, 'email_summary', 'source-evidence-gmail');
  assert.notEqual(revised.revision_hash, firstRevision);
  assert.match(revised.text, /New tail action/);
});

test('AgentMail legacy summaries resolve the raw inbound body when summary body is missing', () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO inbound_email_records
      (id, user, source, external_message_id, subject, received_at, summary, raw_metadata, body_text)
    VALUES (?, ?, 'agentmail', ?, ?, ?, ?, '{}', ?)
  `).run('source-evidence-agentmail-raw', user, 'source-evidence-agentmail', 'Forwarded chain', 1770000001, 'lossy summary', 'Full forwarded body with second request.');
  hub.prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, body_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run('source-evidence-agentmail-summary', user, 'agentmail:source-evidence-agentmail', 'Forwarded chain', 'Alex', 'alex@example.test', 1770000001, 'lossy summary');

  const evidence = resolveSourceEvidence(user, 'email_summary', 'source-evidence-agentmail-summary');
  assert.equal(evidence.body_source, 'inbound_email_records.body_text');
  assert.equal(evidence.complete, true);
  assert.match(evidence.text, /Full forwarded body with second request/);
  assert.doesNotMatch(evidence.text, /lossy summary/);
});

test('mutable mailbox labels cannot revise email evidence or action identity', () => {
  const hub = db.hub();
  const id = 'source-evidence-label-stability';
  const body = 'Please send the final pack.';
  hub.prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at, body_text, raw_metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, user, 'source-evidence-label-stability-msg', 'Final pack', 'Alex', 'alex@example.test', 1770000002, body,
    JSON.stringify({
      provider: 'gmail', thread_id: 'thread-stable', label_ids: ['INBOX', 'UNREAD'],
      headers: [{ name: 'Message-ID', value: '<stable@example.test>' }],
    }),
  );

  const first = resolveSourceEvidence(user, 'email_summary', id);
  const firstSpan = locateEvidenceSpan(first, body);
  const firstActionKey = stableActionKey(first, firstSpan);
  hub.prepare('UPDATE email_summaries SET raw_metadata = ? WHERE id = ?').run(
    JSON.stringify({
      labels: ['hub-processed'], label_ids: ['STARRED', 'Projects/Test'],
      headers: [{ value: '<stable@example.test>', name: 'Message-ID' }],
      thread_id: 'thread-stable', provider: 'gmail',
    }),
    id,
  );

  const relabelled = resolveSourceEvidence(user, 'email_summary', id);
  const relabelledSpan = locateEvidenceSpan(relabelled, body);
  assert.equal(relabelled.revision_hash, first.revision_hash);
  assert.equal(stableActionKey(relabelled, relabelledSpan), firstActionKey);

  hub.prepare('UPDATE email_summaries SET raw_metadata = ? WHERE id = ?').run(
    JSON.stringify({
      provider: 'gmail', thread_id: 'thread-stable', label_ids: ['STARRED'],
      headers: [{ name: 'Message-ID', value: '<changed@example.test>' }],
    }),
    id,
  );
  assert.notEqual(resolveSourceEvidence(user, 'email_summary', id).revision_hash, first.revision_hash);
});

test('messaging identity enrichment cannot revise provider action identity', () => {
  const hub = db.hub();
  const id = 'source-evidence-message-action-stability';
  const body = 'Please bring Dad his phone charger tomorrow.';
  hub.prepare(`
    INSERT INTO messaging_messages
      (id, user, platform, external_message_id, chat_id, chat_name, is_group,
       sender_id, sender_name, body, received_at, raw_json, status, created_at)
    VALUES (?, ?, 'whatsapp', ?, 'dad-chat', 'Dad', 1, 'catriona', 'Catriona', ?, ?, ?, 'received', ?)
  `).run(
    id, user, 'source-evidence-message-action-stability-provider', body, 1770000003,
    JSON.stringify({
      route: {
        project_slug: 'dad',
        project_name: 'Dad',
        contact_name: 'Catriona McLellan',
      },
    }),
    1770000003,
  );

  const first = resolveSourceEvidence(user, 'messaging_message', id);
  const firstSpan = locateEvidenceSpan(first, body);
  const firstActionKey = stableActionKey(first, firstSpan);
  hub.prepare('UPDATE messaging_messages SET raw_json = ? WHERE id = ?').run(
    JSON.stringify({
      contact_id: 'contact-catriona',
      contact_name: 'Catriona McLellan',
      identity_resolution: {
        status: 'matched',
        contact_id: 'contact-catriona',
        contact_name: 'Catriona McLellan',
        matched_by: ['canonical_name'],
      },
      route: {
        project_slug: 'dad',
        project_name: 'Dad',
        contact_name: 'Catriona McLellan',
      },
    }),
    id,
  );

  const enriched = resolveSourceEvidence(user, 'messaging_message', id);
  const enrichedSpan = locateEvidenceSpan(enriched, body);
  assert.notEqual(enriched.revision_hash, first.revision_hash, 'knowledge revision may reflect richer linking context');
  assert.equal(enriched.action_revision_hash, first.action_revision_hash, 'raw action-bearing content did not change');
  assert.equal(stableActionKey(enriched, enrichedSpan), firstActionKey, 'identity enrichment cannot mint another provider action');
});

test('saved debrief transcripts are faithful, revisioned evidence and blank sessions stay ineligible', () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO debrief_sessions (id, user, started_at, ended_at, transcript, note_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'source-evidence-debrief', user, 1770000100, 1770000400,
    'I promised to send the revised outline after the client call.',
    'Debriefs/2026-02-13.md',
  );
  hub.prepare(`
    INSERT INTO debrief_sessions (id, user, started_at, transcript)
    VALUES (?, ?, ?, '   ')
  `).run('source-evidence-empty-debrief', user, 1770000500);
  hub.prepare(`
    INSERT INTO debrief_sessions (id, user, started_at, transcript)
    VALUES (?, ?, ?, ?)
  `).run(
    'source-evidence-in-progress-debrief', user, 1770000600,
    'Partial answer that must not be processed before save.',
  );

  const evidence = resolveSourceEvidence(user, 'debrief_session', 'source-evidence-debrief');
  assert.equal(evidence.complete, true);
  assert.equal(evidence.completeness, 'complete');
  assert.equal(evidence.provenance.note_path, 'Debriefs/2026-02-13.md');
  assert.equal(evidence.provenance.started_at, 1770000100);
  assert.equal(evidence.provenance.ended_at, 1770000400);
  assert.match(evidence.text, /I promised to send the revised outline/);
  assert.deepEqual(
    listSourceEvidence(user, 'debrief_session').map(item => item.source_id),
    ['source-evidence-debrief'],
  );
  const inProgress = resolveSourceEvidence(user, 'debrief_session', 'source-evidence-in-progress-debrief');
  assert.equal(inProgress.complete, false);
  assert.equal(inProgress.completeness, 'in_progress_debrief');
  assert.match(inProgress.text, /must not be processed before save/);
  assert.deepEqual(sourceDisplay(evidence), {
    title: 'Debrief session',
    meta: 'Debriefs/2026-02-13.md',
  });

  const firstRevision = evidence.revision_hash;
  hub.prepare('UPDATE debrief_sessions SET transcript = ? WHERE id = ?')
    .run('I promised to send the revised outline and book the follow-up.', 'source-evidence-debrief');
  const revised = resolveSourceEvidence(user, 'debrief_session', 'source-evidence-debrief');
  assert.notEqual(revised.revision_hash, firstRevision);
  assert.match(revised.text, /book the follow-up/);
});

test('meeting evidence survives extractor errors and stale processing leases', () => {
  const hub = db.hub();
  const current = Math.floor(Date.now() / 1000);
  const insert = hub.prepare(`
    INSERT INTO meeting_intakes
      (id, user, title, transcript, extraction, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('meeting-evidence-processed', user, 'Processed', 'Complete processed transcript', '{}', 'processed', current - 100);
  insert.run('meeting-evidence-error', user, 'Extractor error', 'Complete transcript retained after failure', '{}', 'error', current - 90);
  insert.run(
    'meeting-evidence-stale', user, 'Stale processing', 'Complete transcript retained across crash',
    JSON.stringify({ intake_processing_started_at: current - STALE_MEETING_PROCESSING_SECONDS - 5 }),
    'processing', current - STALE_MEETING_PROCESSING_SECONDS - 10,
  );
  insert.run(
    'meeting-evidence-live', user, 'Live processing', 'Transcript currently being extracted',
    JSON.stringify({ intake_processing_started_at: current }), 'processing', current,
  );
  insert.run('meeting-evidence-draft', user, 'Draft', 'Unsubmitted draft transcript', '{}', 'draft', current);

  const ids = listSourceEvidence(user, 'meeting_intake').map(item => item.source_id);
  assert.deepEqual(ids, [
    'meeting-evidence-stale',
    'meeting-evidence-processed',
    'meeting-evidence-error',
  ]);
  assert.ok(!ids.includes('meeting-evidence-live'));
  assert.ok(!ids.includes('meeting-evidence-draft'));
});

test('derived documents share one canonical evidence exclusion rule', () => {
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'document',
    row: {
      filename: '2026-08-02 client-call [meeting].md',
      markdown: '# Client call\n\n## Action Register\n- Send pack\n\n## Transcript\nPlease send the pack.',
    },
  }), true);
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'document',
    row: { filename: '_Project Memory.md', markdown: '# Compiled memory' },
  }), true);
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'document',
    row: { filename: 'compiled.md', markdown: '---\nauto_generated: true\n---\n# Compiled' },
  }), true);
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'document',
    row: { filename: 'human-notes.md', markdown: '# Notes\n\n## Action Register\nA human-authored checklist.' },
  }), false);
});

test('Nakai daily briefing mail Douglas sends is excluded, not read as his own commitments', () => {
  // Reproduces the bug where Nakai's regulatory Watchlist ("Confirm the
  // deadline...", "Escalate MiCA...") got read by the sent-mail commitment
  // detector as Douglas's own asks and turned into his Google Tasks — the
  // owner is Nakai, not Douglas, even though Douglas's account sent it.
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'email_summary',
    row: { subject: 'Daily Briefing 046 - 3 August 2026', direction: 'sent' },
  }), true);
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'email_summary',
    row: { subject: 'Confirmed — Daily Briefing 046 written and sent to nakai@mclellan.scot', direction: 'sent' },
  }), true);
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'email_summary',
    row: { subject: 'Daily Intelligence Pipeline - 3 August 2026: 0 new in briefing, 0 checked', direction: 'sent' },
  }), true);
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'email_summary',
    row: { subject: 'PANIC — Daily Intelligence Pipeline - 30 July 2026', direction: 'sent' },
  }), true);
  // Same bug, same fix, for M365's own sent-to-self operational brief — it
  // owns its single consolidated "Read briefing" task instead.
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'email_summary',
    row: { subject: 'M365 Operations & Security Brief 003 - 3 August 2026', direction: 'sent' },
  }), true);
  // 18 August production incident: forwarding Brief 018 between Douglas's
  // accounts added Fwd/FW and bypassed the subject-prefix boundary.
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'email_summary',
    row: { subject: 'Fwd: M365 Operations & Security Brief 018 - 18 August 2026', direction: 'sent' },
  }), true);
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'email_summary',
    row: { subject: 'RE: FW: M365 Operations & Security Brief 018 - 18 August 2026', direction: 'received' },
  }), true);
  // A real commitment Douglas sends to a contact must still be evidence.
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'email_summary',
    row: { subject: 'Re: project update', direction: 'sent' },
  }), false);
  assert.equal(isCanonicalEvidenceExcluded({
    source_kind: 'email_summary',
    row: { subject: 'Fwd: Please approve the agency invoice', direction: 'sent' },
  }), false);
});

test('generated chat documents stay visible while workday canonical evidence is transcript-only', () => {
  const hub = db.hub();
  const capturedAt = new Date('2026-08-02T09:30:00.000Z');
  const transcript = 'I promised to send Neil the signed proposal before Friday.';
  const generatedNarrative = 'MODEL NARRATIVE ONLY: Neil is definitely ready to sign immediately.';
  const workdayMarkdown = workdayIngestTest.buildMarkdown({
    user,
    title: 'Morning interview',
    capturedAt,
    source: 'manual',
    narrative: generatedNarrative,
    transcript,
  });
  const chatMarkdown = [
    '---',
    'auto_generated: true',
    'generated_kind: "chat-answer"',
    '---',
    '',
    '# Saved answer',
    '',
    '**Q:** What should I do?',
    '',
    '**A:** MODEL ANSWER ONLY: Call Neil right now.',
  ].join('\n');
  const insert = hub.prepare(`
    INSERT INTO documents (id, user, project_id, filename, mimetype, size_bytes, markdown, uploaded_at)
    VALUES (?, ?, NULL, ?, 'text/markdown', ?, ?, ?)
  `);
  insert.run('source-evidence-workday', user, '2026-08-02 - Morning interview.md', Buffer.byteLength(workdayMarkdown), workdayMarkdown, 1775122200);
  insert.run('source-evidence-chat', user, 'Saved answer [chat].md', Buffer.byteLength(chatMarkdown), chatMarkdown, 1775122300);

  const workday = resolveSourceEvidence(user, 'document', 'source-evidence-workday');
  const chat = resolveSourceEvidence(user, 'document', 'source-evidence-chat');
  assert.equal(isCanonicalEvidenceExcluded(workday), false, 'the raw workday transcript remains a canonical source');
  assert.equal(workday.complete, true);
  assert.equal(workday.completeness, 'complete');
  assert.equal(workday.provenance.canonical_evidence_section, 'transcript');
  assert.equal(workday.provenance.generated_narrative_excluded, true);
  assert.match(workday.text, /send Neil the signed proposal/);
  assert.doesNotMatch(workday.text, /MODEL NARRATIVE ONLY/);
  assert.match(workday.row.markdown, /MODEL NARRATIVE ONLY/, 'the stored user-facing document retains the generated narrative');
  assert.equal(canonicalDocumentTaskText(workday.row, workday.row.markdown), transcript);
  const legacyPrompt = extractionPrompt(workday.row, workday.row.markdown);
  assert.match(legacyPrompt, /send Neil the signed proposal/);
  assert.doesNotMatch(legacyPrompt, /MODEL NARRATIVE ONLY/, 'rollback-only direct extraction shares the transcript boundary');

  const firstRevision = workday.revision_hash;
  const narrativeOnlyEdit = workdayIngestTest.buildMarkdown({
    user,
    title: 'Morning interview',
    capturedAt,
    source: 'manual',
    narrative: 'MODEL NARRATIVE ONLY: revised summary wording with no raw evidence change.',
    transcript,
  });
  hub.prepare('UPDATE documents SET markdown = ? WHERE id = ?').run(narrativeOnlyEdit, 'source-evidence-workday');
  assert.equal(
    resolveSourceEvidence(user, 'document', 'source-evidence-workday').revision_hash,
    firstRevision,
    'generated narrative wording cannot create a new canonical source revision',
  );

  assert.equal(isCanonicalEvidenceExcluded(chat), true, 'structurally marked chat answers cannot enter canonical evidence');
  const documentIds = listSourceEvidence(user, 'document').map(item => item.source_id);
  assert.ok(documentIds.includes(chat.source_id), 'generated documents remain in the normal document listing/search source set');
  assert.deepEqual(sourceDisplay(chat), { title: 'Saved answer [chat].md', meta: '' });
  assert.match(chat.row.markdown, /MODEL ANSWER ONLY/, 'the project document UI can still display the saved answer');
});

test('long evidence is deterministically overlapping and retains the tail', () => {
  const text = `${'alpha '.repeat(90)}TAIL-CANDIDATE: send the final document`;
  const first = deterministicChunks(text, { maxChars: 120, overlap: 20, revisionHash: 'rev-a' });
  const second = deterministicChunks(text, { maxChars: 120, overlap: 20, revisionHash: 'rev-a' });
  assert.deepEqual(first, second);
  assert.ok(first.length > 2);
  assert.ok(first.some(chunk => chunk.text.includes('TAIL-CANDIDATE')));
  assert.ok(first[1].start < first[0].end, 'chunks overlap rather than dropping boundary evidence');
});
