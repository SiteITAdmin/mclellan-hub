'use strict';

/**
 * Canonical source evidence for the CRM knowledge pipeline.
 *
 * This module is deliberately boring: it turns one raw source row into the
 * exact text that downstream model work may read, along with enough immutable
 * provenance to tell whether that source changed.  It is the boundary between
 * raw ingestion and compiled knowledge.  Summaries are never promoted to the
 * canonical body when a faithful body is available; a legacy summary-only row
 * is explicitly marked incomplete so it cannot quietly look processed.
 */

const crypto = require('crypto');
const db = require('./db');
const { buildEvidenceText, routingMetadata } = require('./messaging-capture');

const CRM_KNOWLEDGE_PIPELINE_VERSION = 'crm-evidence-actions-v2';
// Automatic OpenRouter CRM work only considers evidence at or after this epoch.
// Older sources stay frozen: a pipeline-version bump must not re-queue the
// historical corpus. Manual source-scoped replay remains available.
// 2026-08-03T00:00:00Z — day the accidental full-corpus reprocess was stopped.
const CRM_KNOWLEDGE_AUTO_PROCESS_AFTER = Math.floor(Date.UTC(2026, 7, 3) / 1000);
const SOURCE_EVIDENCE_KINDS = [
  'email_summary',
  'meeting_intake',
  'document',
  'open_task',
  'completed_task',
  'crm_fact',
  'messaging_message',
  'debrief_session',
];

const DEFAULT_CHUNK_CHARS = 7000;
const DEFAULT_CHUNK_OVERLAP = 700;
const STALE_MEETING_PROCESSING_SECONDS = 15 * 60;
const HUB_REPORT_SUBJECT_PREFIXES = [
  'daily consigliere report',
  'hub daily report',
  'hub report',
  'daily system report',
  // Nakai's regulatory intelligence briefing and its Douglas-facing audit/
  // confirmation mail. These are Hub-generated deliverables addressed to a
  // third party (Nakai) or status reports about that delivery — their
  // Watchlist/Executive-Readout language reads like explicit asks, but the
  // owner is Nakai, not Douglas, and none of it is a personal commitment he
  // made. See MODULES.md Regulatory Monitor: "Does not own ... Douglas-facing
  // regulatory surfaces."
  'daily briefing',
  'daily intelligence pipeline',
  'panic — daily intelligence pipeline',
  'confirmed — daily briefing',
  // M365 Operations & Security Brief owns its own single consolidated
  // "Read briefing" task with subtasks (see scripts/build-m365-daily-briefing.js
  // createM365BriefingReadTask) — it must not also flood the generic sent-mail
  // commitment detector into creating one task per Rolling Watchlist row.
  'm365 operations & security brief',
  // The Work Brief is a Hub-generated digest too (delivery now retired). Its
  // sender is Douglas's own address, not the AgentMail inbox, so the sender
  // check never caught it — a re-forwarded Work Brief would otherwise re-project
  // its listed items. This is a provenance boundary; the open-corpus dedup in
  // crm-knowledge-engine is what stops duplicates from any other source.
  'work brief',
];

// Gmail/Outlook preserve the original subject when a Hub-generated report is
// forwarded between Douglas's accounts, but add one or more Re/Fw/Fwd prefixes.
// Those transport prefixes do not turn derived Hub output into fresh source
// evidence. Strip only the standard prefixes at the start; ordinary sent mail
// remains eligible unless the remaining subject names a known Hub report.
function subjectWithoutTransportPrefixes(value) {
  return string(value).trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim();
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function now() { return Math.floor(Date.now() / 1000); }

function string(value) { return value == null ? '' : String(value); }

function dateText(ts) {
  const n = Number(ts || 0);
  return n ? new Date(n * 1000).toISOString() : '';
}

function textWithHeader(lines, body) {
  const header = lines.filter(Boolean).join('\n');
  if (!header) return string(body);
  return body ? `${header}\n\n${body}` : header;
}

function completedTaskText(row) {
  return [
    `Completed task: ${string(row.title)}`,
    `Notes: ${string(row.notes)}`,
    `Source: ${string(row.source || 'manual')}`,
    `Completed at: ${dateText(row.completed_at || row.synced_at || row.created_at)}`,
    row.contact_name ? `Linked person: ${row.contact_name}` : '',
    row.company_name ? `Linked company: ${row.company_name}` : '',
    row.project_name || row.project_slug ? `Linked project: ${row.project_name || row.project_slug}` : '',
  ].filter(Boolean).join('\n');
}

function openTaskText(row) {
  return [
    `Open task: ${string(row.title)}`,
    `Notes: ${string(row.notes)}`,
    `Source: ${string(row.source || 'manual')}`,
    row.due ? `Due: ${row.due}` : '',
    row.contact_name ? `Linked person: ${row.contact_name}` : '',
    row.company_name ? `Linked company: ${row.company_name}` : '',
    row.project_name || row.project_slug ? `Linked project: ${row.project_name || row.project_slug}` : '',
  ].filter(Boolean).join('\n');
}

function crmFactText(row) {
  return `CRM fact about ${row.contact_name || 'unknown'}: ${string(row.fact)}`;
}

function emailBody(row) {
  // AgentMail used to write its faithful body only to inbound_email_records.
  // Prefer the canonical email_summaries body when present, otherwise use that
  // raw record as a compatibility backfill source.  Never choose `summary`
  // while a body exists.
  const direct = string(row.body_text);
  const inbound = string(row.inbound_body_text);
  const body = direct.trim() ? direct : inbound.trim() ? inbound : '';
  return {
    body,
    bodySource: direct.trim() ? 'email_summaries.body_text'
      : inbound.trim() ? 'inbound_email_records.body_text'
        : 'none',
  };
}

function emailRawMetadata(row) {
  const direct = string(row.raw_metadata).trim();
  const inbound = string(row.inbound_raw_metadata).trim();
  return direct && direct !== '{}' ? direct : inbound && inbound !== '{}' ? inbound : '';
}

// Mailbox labels and processing/routing fields are mutable navigation state,
// not source identity.  If they enter the revision hash, filing or retrying an
// otherwise unchanged message can produce a second action key.  Preserve only
// stable provider material, with object keys canonicalised for deterministic
// hashing; array order is retained because header/recipient order is evidence.
const MUTABLE_EMAIL_METADATA_KEYS = new Set([
  'label_ids', 'labels', 'ingestion_status', 'status',
  'summary', 'classification', 'project_slug', 'contact_id',
]);

function canonicalEmailRawMetadata(value) {
  let parsed;
  try { parsed = JSON.parse(string(value)); } catch (_) { return ''; }
  function canonicalise(item) {
    if (Array.isArray(item)) return item.map(canonicalise);
    if (!item || typeof item !== 'object') return item;
    const result = {};
    for (const key of Object.keys(item).sort()) {
      if (MUTABLE_EMAIL_METADATA_KEYS.has(key.toLowerCase())) continue;
      result[key] = canonicalise(item[key]);
    }
    return result;
  }
  return JSON.stringify(canonicalise(parsed));
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(string(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// A meeting transcript is raw evidence even if the intake's local extraction
// failed.  We deliberately do not expose an actively-running extraction to a
// second worker, but an old `processing` receipt is a crash-window artifact and
// must re-enter the canonical source enumeration.  New rows record the start
// timestamp in extraction metadata; old rows safely fall back to created_at.
function meetingProcessingStartedAt(row) {
  const extraction = parseObject(row?.extraction);
  const started = Number(extraction.intake_processing_started_at || extraction.processing_started_at || 0);
  return Number.isFinite(started) && started > 0 ? started : Number(row?.created_at || 0);
}

function isCanonicalMeetingEvidenceRow(row, referenceNow = now()) {
  if (!string(row?.transcript).trim()) return false;
  const status = String(row?.status || '').toLowerCase();
  if (['processed', 'error'].includes(status)) return true;
  if (status !== 'processing') return false;
  return meetingProcessingStartedAt(row) <= Number(referenceNow) - STALE_MEETING_PROCESSING_SECONDS;
}

function markdownFrontmatter(markdown) {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*(?:\r?\n|$))/.exec(string(markdown));
  return match ? match[1] : '';
}

function frontmatterValue(markdown, key) {
  const frontmatter = markdownFrontmatter(markdown);
  if (!frontmatter) return '';
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escaped}\\s*:\\s*(.*?)\\s*$`, 'im').exec(frontmatter);
  if (!match) return '';
  const value = String(match[1] || '').trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try { return String(JSON.parse(value)); } catch (_) { /* retain scalar below */ }
  }
  return value.replace(/^'(.*)'$/, '$1');
}

function frontmatterBoolean(markdown, key) {
  return /^true$/i.test(frontmatterValue(markdown, key));
}

function isWorkdayInterviewDocument(row) {
  return frontmatterValue(row?.markdown, 'type').trim().toLowerCase() === 'workday-interview';
}

function headingMatches(markdown, pattern) {
  return [...string(markdown).matchAll(pattern)];
}

// Workday notes intentionally contain two different classes of content: a
// model-written convenience narrative and the speaker's raw transcript.  The
// latter is the only canonical evidence.  New notes carry an explicit heading
// and marker; legacy notes used a trailing "## Transcript" section, which we
// continue to read so existing raw evidence is not lost.  The transcript is
// terminal by construction: workday-ingest never appends generated prose after
// it, so everything following the selected heading remains faithful source
// material (including any headings the speaker dictated).
function workdayTranscriptMaterial(row) {
  if (!isWorkdayInterviewDocument(row)) return null;
  const markdown = string(row?.markdown);
  const canonicalHeadings = headingMatches(markdown, /^##\s+Transcript\s+\(Canonical Raw Evidence\)\s*$/gim);
  const markedCanonicalHeadings = canonicalHeadings.filter(heading =>
    /^\s*\r?\n<!--\s*hub:canonical-transcript:start\s*-->/i.test(
      markdown.slice(heading.index + heading[0].length),
    )
  );
  const legacyHeadings = headingMatches(markdown, /^##\s+Transcript\s*$/gim);
  // The writer's marker prevents a model narrative which merely happens to
  // use a "Transcript" heading from becoming canonical.  The real section is
  // appended after the narrative, hence the final marked heading is selected.
  const heading = markedCanonicalHeadings.at(-1) || legacyHeadings.at(-1) || null;
  if (!heading) {
    return {
      body: '',
      format: frontmatterValue(markdown, 'canonical_evidence_section') ? 'declared_missing_section' : 'legacy_missing_section',
      sectionFound: false,
    };
  }
  const bodyStart = heading.index + heading[0].length;
  const afterHeading = markdown.slice(bodyStart).replace(/^\s*\r?\n/, '');
  // The marker is metadata, not speaker evidence.  It is present only in new
  // notes and sits immediately below the fixed canonical heading.  Removing
  // exactly that first line leaves every byte of the transcript after it.
  const body = afterHeading.replace(/^<!--\s*hub:canonical-transcript:start\s*-->\s*\r?\n?/i, '');
  return {
    body: body.trim(),
    format: markedCanonicalHeadings.length ? 'canonical_transcript_v1' : 'legacy_transcript_section',
    sectionFound: true,
  };
}

function canonicalDocumentMaterial(row) {
  const markdown = string(row?.markdown);
  const workday = workdayTranscriptMaterial(row);
  if (!workday) {
    return {
      body: markdown,
      complete: Boolean(markdown.trim()),
      completeness: markdown.trim() ? 'complete' : 'empty_document',
      provenance: {},
      adapter: 'stored_markdown',
    };
  }
  const body = workday.body;
  return {
    body,
    complete: Boolean(body.trim()),
    completeness: body.trim() ? 'complete' : 'missing_canonical_transcript',
    provenance: {
      canonical_evidence_section: 'transcript',
      document_adapter: workday.format,
      generated_narrative_excluded: true,
    },
    adapter: 'workday_transcript',
  };
}

// Direct document extraction is rollback-only, but it must obey the same
// evidence boundary as the canonical engine.  Ordinary documents retain the
// caller's presentation-stripped body; workday notes use only their raw
// transcript, never the model-written narrative stored beside it.
function canonicalDocumentTaskText(row, fallbackMarkdown = '') {
  const material = canonicalDocumentMaterial(row);
  return material.adapter === 'workday_transcript' ? material.body : string(fallbackMarkdown);
}

// Documents are faithful source material only when they were actually supplied
// as source material.  Meeting intake renders an action register as a derived
// convenience document; it must not compete with its canonical transcript or
// manufacture a second task path.  The structural check keeps a genuinely raw
// document with an incidental "Action Register" heading eligible.
function isGeneratedCanonicalDocument(row) {
  const filename = string(row?.filename).trim().toLowerCase();
  const markdown = string(row?.markdown);
  const autoGenerated = frontmatterBoolean(markdown, 'auto_generated');
  const projectMemory = filename === '_project memory.md';
  const generatedMeetingRegister = /\[meeting\]\.md$/i.test(filename)
    && /(^|\n)##\s+Action Register\s*$/im.test(markdown)
    && /(^|\n)##\s+Transcript\s*$/im.test(markdown);
  // Saved chat answers pre-date the frontmatter marker.  Treat the exact
  // legacy Q&A shape as generated too, while letting ordinary human notes
  // named "chat" remain eligible.
  const generatedChatAnswer = /\[chat\]\.md$/i.test(filename)
    && /^\s*\*\*Q:\*\*/im.test(markdown)
    && /^\s*\*\*A:\*\*/im.test(markdown);
  return autoGenerated || projectMemory || generatedMeetingRegister || generatedChatAnswer;
}

// List-Unsubscribe is the provider-agnostic technical marker for bulk mail
// (RFC 2369/8058) — every newsletter/marketing sender sets it and ordinary
// correspondence never does. This is a hard fact already captured in
// raw_metadata at ingest, not a re-derived judgment about the email's
// content, so it belongs beside the other technical exclusions here rather
// than in the classifier's project/action inference.
function hasListUnsubscribeHeader(row) {
  const rawMetadata = parseObject(emailRawMetadata(row));
  const headers = Array.isArray(rawMetadata.headers) ? rawMetadata.headers : [];
  return headers.some(header => string(header?.name).toLowerCase() === 'list-unsubscribe');
}

// This exclusion is intentionally shared by engine selection, health, replay,
// and outcome visibility.  It is a canonical-evidence policy, not a UI filter:
// generated outputs can remain stored and searchable without becoming a new
// task-bearing source.
function canonicalEvidenceExclusionReason(evidence) {
  if (evidence?.source_kind === 'document') {
    return isGeneratedCanonicalDocument(evidence.row) ? 'generated_document' : null;
  }
  if (evidence?.source_kind !== 'email_summary') return null;
  const row = evidence.row || {};
  if (['__skip', '__system'].includes(row.project_slug)) return 'system_project';
  const subject = subjectWithoutTransportPrefixes(row.subject).toLowerCase();
  const reportSubject = HUB_REPORT_SUBJECT_PREFIXES.some(prefix => subject.startsWith(prefix));
  const address = string(process.env.AGENTMAIL_INBOX_ID).toLowerCase();
  if (reportSubject) return 'hub_generated_report';
  if (address && string(row.from_email).toLowerCase() === address) return 'hub_agentmail_sender';
  // Bulk mail the classifier already found no project/contact for is noise,
  // not unrecognised correspondence: a real sender who matched nothing known
  // still isn't bulk-flagged, so this never touches a genuine one-off email.
  if (row.project_slug == null && hasListUnsubscribeHeader(row)) return 'unclassified_bulk_mail';
  return null;
}

function isCanonicalEvidenceExcluded(evidence) {
  return Boolean(canonicalEvidenceExclusionReason(evidence));
}

function sourceMaterial(sourceKind, row) {
  if (sourceKind === 'email_summary') {
    const { body, bodySource } = emailBody(row);
    const rawMetadataValue = emailRawMetadata(row);
    const rawMetadata = canonicalEmailRawMetadata(rawMetadataValue);
    const metadata = parseObject(rawMetadataValue);
    const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
    const incompleteAttachment = attachments.some(attachment => {
      const status = String(attachment?.extraction_status || '').toLowerCase();
      return !['extracted', 'inline_resource'].includes(status);
    });
    const fallback = body || string(row.summary);
    const complete = Boolean(body.trim()) && !incompleteAttachment;
    const material = {
      text: textWithHeader([
        row.direction === 'sent' ? 'Direction: sent email' : 'Direction: received email',
        `Subject: ${string(row.subject)}`,
        `From: ${string(row.from_name)}${row.from_email ? ` <${row.from_email}>` : ''}`.trim(),
        row.received_at ? `Received: ${dateText(row.received_at)}` : '',
      ], fallback),
      complete,
      completeness: incompleteAttachment
        ? 'attachment_unextracted'
        : complete ? 'complete' : fallback.trim() ? 'summary_only_missing_raw_body' : 'missing_body',
      bodySource,
      provenance: {
        gmail_message_id: row.gmail_message_id || null,
        direction: row.direction || 'received',
        from_email: row.from_email || null,
        received_at: row.received_at || null,
        body_source: bodySource,
        // Header/provider material is raw evidence; project/contact/summary
        // routing is deliberately absent so later model compatibility writes
        // never revise the source identity or action keys.
        raw_metadata_hash: rawMetadata ? hash(rawMetadata) : null,
      },
    };
    if (attachments.length) material.provenance.attachment_manifest = attachments;
    return material;
  }

  if (sourceKind === 'document') {
    const material = canonicalDocumentMaterial(row);
    const body = material.body;
    return {
      text: textWithHeader([
        `Document: ${string(row.filename)}`,
        row.mimetype ? `MIME type: ${row.mimetype}` : '',
      ], body),
      complete: material.complete,
      completeness: material.completeness,
      provenance: {
        filename: row.filename || null,
        mimetype: row.mimetype || null,
        project_id: row.project_id || null,
        uploaded_at: row.uploaded_at || null,
        ...material.provenance,
      },
    };
  }

  if (sourceKind === 'meeting_intake') {
    const transcript = string(row.transcript);
    const summary = string(row.summary);
    const body = transcript || summary;
    return {
      text: textWithHeader([
        `Meeting: ${string(row.title)}`,
        summary && transcript ? `Recorded summary: ${summary}` : '',
      ], body),
      complete: Boolean(transcript.trim()),
      completeness: transcript.trim() ? 'complete' : summary.trim() ? 'summary_only_missing_transcript' : 'missing_transcript',
      provenance: {
        meeting_id: row.meeting_id || null,
        project_slug: row.project_slug || null,
        source_filename: row.source_filename || null,
        created_at: row.created_at || null,
      },
    };
  }

  if (sourceKind === 'debrief_session') {
    const transcript = string(row.transcript);
    const saved = Boolean(row.ended_at) && Boolean(string(row.note_path).trim());
    return {
      text: textWithHeader([
        'Debrief session',
        row.note_path ? `Saved note: ${string(row.note_path)}` : '',
        row.started_at ? `Started: ${dateText(row.started_at)}` : '',
        row.ended_at ? `Ended: ${dateText(row.ended_at)}` : '',
      ], transcript),
      complete: Boolean(transcript.trim()) && saved,
      completeness: !transcript.trim() ? 'missing_transcript'
        : !row.ended_at ? 'in_progress_debrief'
          : !string(row.note_path).trim() ? 'missing_debrief_note_path'
            : 'complete',
      provenance: {
        session_id: row.id,
        note_path: row.note_path || null,
        started_at: row.started_at || null,
        ended_at: row.ended_at || null,
      },
    };
  }

  if (sourceKind === 'completed_task') {
    const text = completedTaskText(row);
    return {
      text,
      complete: Boolean(string(row.title).trim()),
      completeness: string(row.title).trim() ? 'complete' : 'missing_task_title',
      provenance: {
        task_id: row.id,
        source: row.source || null,
        source_id: row.source_id || null,
        completed_at: row.completed_at || null,
        project_slug: row.project_slug || null,
      },
    };
  }

  if (sourceKind === 'open_task') {
    const text = openTaskText(row);
    return {
      text,
      complete: Boolean(string(row.title).trim()),
      completeness: string(row.title).trim() ? 'complete' : 'missing_task_title',
      provenance: {
        task_id: row.id,
        source: row.source || null,
        source_id: row.source_id || null,
        project_slug: row.project_slug || null,
      },
    };
  }

  if (sourceKind === 'crm_fact') {
    const text = crmFactText(row);
    return {
      text,
      complete: Boolean(string(row.fact).trim()),
      completeness: string(row.fact).trim() ? 'complete' : 'missing_fact',
      provenance: {
        contact_id: row.contact_id || null,
        company_id: row.company_id || null,
        project_slug: row.project_slug || null,
        created_at: row.created_at || null,
      },
    };
  }

  if (sourceKind === 'messaging_message') {
    const text = buildEvidenceText(row);
    const routing = routingMetadata(row);
    return {
      text,
      complete: Boolean(string(row.body).trim()),
      completeness: string(row.body).trim() ? 'complete' : 'missing_message_body',
      provenance: {
        platform: row.platform || null,
        external_message_id: row.external_message_id || null,
        chat_id: row.chat_id || null,
        received_at: row.received_at || null,
        routing,
      },
    };
  }

  throw new Error(`Unknown source evidence kind: ${sourceKind}`);
}

function rowForSource(user, sourceKind, sourceId) {
  const hub = db.hub();
  if (sourceKind === 'email_summary') {
    return hub.prepare(`
      SELECT es.*, ier.body_text AS inbound_body_text, ier.thread_id AS inbound_thread_id,
             ier.raw_metadata AS inbound_raw_metadata
      FROM email_summaries es
      LEFT JOIN inbound_email_records ier
        ON ier.user = es.user
       AND ier.source = 'agentmail'
       AND ('agentmail:' || ier.external_message_id) = es.gmail_message_id
      WHERE es.user = ? AND es.id = ?
      LIMIT 1
    `).get(user, sourceId);
  }
  if (sourceKind === 'document') {
    return hub.prepare('SELECT d.*, d.uploaded_at AS ts FROM documents d WHERE d.user = ? AND d.id = ?').get(user, sourceId);
  }
  if (sourceKind === 'meeting_intake') {
    return hub.prepare('SELECT mi.*, mi.created_at AS ts FROM meeting_intakes mi WHERE mi.user = ? AND mi.id = ?').get(user, sourceId);
  }
  if (sourceKind === 'debrief_session') {
    return hub.prepare(`
      SELECT ds.*, COALESCE(ds.ended_at, ds.started_at) AS ts
      FROM debrief_sessions ds WHERE ds.user = ? AND ds.id = ? LIMIT 1
    `).get(user, sourceId);
  }
  if (sourceKind === 'completed_task' || sourceKind === 'open_task') {
    return hub.prepare(`
      SELECT t.*, c.name AS contact_name, co.name AS company_name, p.name AS project_name,
             COALESCE(t.completed_at, t.synced_at, t.created_at) AS ts
      FROM google_tasks t
      LEFT JOIN contacts c ON c.id = t.contact_id
      LEFT JOIN companies co ON co.id = t.company_id
      LEFT JOIN projects p ON p.user = t.user AND p.slug = t.project_slug
      WHERE t.user = ? AND t.id = ?
      LIMIT 1
    `).get(user, sourceId);
  }
  if (sourceKind === 'crm_fact') {
    return hub.prepare(`
      SELECT f.*, c.name AS contact_name, f.created_at AS ts
      FROM crm_facts f LEFT JOIN contacts c ON c.id = f.contact_id
      WHERE f.user = ? AND f.id = ? LIMIT 1
    `).get(user, sourceId);
  }
  if (sourceKind === 'messaging_message') {
    return hub.prepare('SELECT m.*, m.received_at AS ts FROM messaging_messages m WHERE m.user = ? AND m.id = ?').get(user, sourceId);
  }
  return null;
}

function rowsForSourceKind(user, sourceKind, database = null) {
  // `database` keeps the evidence contract usable by read-only audit tools.
  // Normal application callers retain the existing db.hub() behaviour.
  const hub = database || db.hub();
  if (sourceKind === 'email_summary') {
    return hub.prepare(`
      SELECT es.*, ier.body_text AS inbound_body_text, ier.thread_id AS inbound_thread_id,
             ier.raw_metadata AS inbound_raw_metadata,
             COALESCE(es.received_at, es.processed_at) AS ts
      FROM email_summaries es
      LEFT JOIN inbound_email_records ier
        ON ier.user = es.user
       AND ier.source = 'agentmail'
       AND ('agentmail:' || ier.external_message_id) = es.gmail_message_id
      WHERE es.user = ?
      ORDER BY COALESCE(es.received_at, es.processed_at) ASC, es.id ASC
    `).all(user);
  }
  if (sourceKind === 'document') {
    return hub.prepare('SELECT d.*, d.uploaded_at AS ts FROM documents d WHERE d.user = ? ORDER BY d.uploaded_at ASC, d.id ASC').all(user);
  }
  if (sourceKind === 'meeting_intake') {
    const rows = hub.prepare(`
      SELECT mi.*, mi.created_at AS ts
      FROM meeting_intakes mi
      WHERE mi.user = ?
        AND mi.status IN ('processed', 'error', 'processing')
        AND TRIM(COALESCE(mi.transcript, '')) != ''
      ORDER BY mi.created_at ASC, mi.id ASC
    `).all(user);
    return rows.filter(row => isCanonicalMeetingEvidenceRow(row));
  }
  if (sourceKind === 'debrief_session') {
    return hub.prepare(`
      SELECT ds.*, COALESCE(ds.ended_at, ds.started_at) AS ts
      FROM debrief_sessions ds
      WHERE ds.user = ?
        AND ds.ended_at IS NOT NULL
        AND TRIM(COALESCE(ds.note_path, '')) != ''
        AND TRIM(COALESCE(ds.transcript, '')) != ''
      ORDER BY ts ASC, ds.id ASC
    `).all(user);
  }
  if (sourceKind === 'completed_task') {
    return hub.prepare(`
      SELECT t.*, c.name AS contact_name, co.name AS company_name, p.name AS project_name,
             COALESCE(t.completed_at, t.synced_at, t.created_at) AS ts
      FROM google_tasks t
      LEFT JOIN contacts c ON c.id = t.contact_id
      LEFT JOIN companies co ON co.id = t.company_id
      LEFT JOIN projects p ON p.user = t.user AND p.slug = t.project_slug
      WHERE t.user = ? AND t.status = 'completed' AND t.deleted_at IS NULL
        AND COALESCE(t.title, '') != ''
      ORDER BY ts ASC, t.id ASC
    `).all(user);
  }
  if (sourceKind === 'open_task') {
    return hub.prepare(`
      SELECT t.*, c.name AS contact_name, co.name AS company_name, p.name AS project_name,
             COALESCE(t.created_at, t.synced_at) AS ts
      FROM google_tasks t
      LEFT JOIN contacts c ON c.id = t.contact_id
      LEFT JOIN companies co ON co.id = t.company_id
      LEFT JOIN projects p ON p.user = t.user AND p.slug = t.project_slug
      WHERE t.user = ? AND t.status = 'needsAction' AND t.deleted_at IS NULL
        AND COALESCE(t.title, '') != ''
      ORDER BY ts ASC, t.id ASC
    `).all(user);
  }
  if (sourceKind === 'crm_fact') {
    return hub.prepare(`
      SELECT f.*, c.name AS contact_name, f.created_at AS ts
      FROM crm_facts f LEFT JOIN contacts c ON c.id = f.contact_id
      WHERE f.user = ? AND f.status NOT IN ('wrong', 'archived')
      ORDER BY f.created_at ASC, f.id ASC
    `).all(user);
  }
  if (sourceKind === 'messaging_message') {
    return hub.prepare(`
      SELECT m.*, m.received_at AS ts FROM messaging_messages m
      WHERE m.user = ? AND COALESCE(m.body, '') != ''
      ORDER BY m.received_at ASC, m.id ASC
    `).all(user);
  }
  return [];
}

// Stable, overlapping chunks.  We preserve original character offsets instead
// of normalising whitespace, because action identity must point back to the
// exact source span rather than a model's paraphrase of it.
function deterministicChunks(text, {
  maxChars = DEFAULT_CHUNK_CHARS,
  overlap = DEFAULT_CHUNK_OVERLAP,
  revisionHash = '',
} = {}) {
  const source = string(text);
  if (!source) return [];
  const safeMax = Math.max(256, Number(maxChars) || DEFAULT_CHUNK_CHARS);
  const safeOverlap = Math.max(0, Math.min(safeMax - 1, Number(overlap) || 0));
  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < source.length) {
    let end = Math.min(start + safeMax, source.length);
    if (end < source.length) {
      const window = source.slice(start, end);
      const threshold = Math.floor(window.length * 0.58);
      const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' ')];
      const breakAt = Math.max(...candidates);
      if (breakAt >= threshold) end = start + breakAt + 1;
    }
    // A pathological long token can otherwise leave end equal to start.
    if (end <= start) end = Math.min(start + safeMax, source.length);
    const chunkText = source.slice(start, end);
    if (chunkText.trim()) {
      chunks.push({
        index,
        start,
        end,
        text: chunkText,
        chunk_id: hash(`${revisionHash}:${start}:${end}:${hash(chunkText)}`).slice(0, 40),
      });
      index += 1;
    }
    if (end >= source.length) break;
    start = Math.max(start + 1, end - safeOverlap);
  }
  return chunks;
}

function evidenceRevision(sourceKind, sourceId, material) {
  return hash(JSON.stringify({
    source_kind: sourceKind,
    source_id: String(sourceId),
    text: material.text,
    complete: material.complete,
    completeness: material.completeness,
    provenance: material.provenance,
  }));
}

// Task identity is deliberately narrower than knowledge revision identity.
// Filing, routing, identity enrichment and generated prompt headers may all
// justify re-synthesising how evidence connects to the graph, but none of them
// turn an action already present in the raw source into a new action.  Only the
// faithful action-bearing content belongs in this fingerprint.
function actionBearingText(sourceKind, row, material) {
  if (sourceKind === 'email_summary') {
    const { body } = emailBody(row);
    return [string(row.subject), body || string(row.summary)].join('\n');
  }
  if (sourceKind === 'document') {
    return [string(row.filename), canonicalDocumentMaterial(row).body].join('\n');
  }
  if (sourceKind === 'meeting_intake') {
    return [string(row.title), string(row.transcript) || string(row.summary)].join('\n');
  }
  if (sourceKind === 'debrief_session') return string(row.transcript);
  if (sourceKind === 'completed_task' || sourceKind === 'open_task') {
    return [string(row.title), string(row.notes), string(row.due)].join('\n');
  }
  if (sourceKind === 'crm_fact') return string(row.fact);
  if (sourceKind === 'messaging_message') return string(row.body);
  return string(material?.text);
}

function actionRevision(sourceKind, sourceId, row, material) {
  return hash(JSON.stringify({
    source_kind: sourceKind,
    source_id: String(sourceId),
    action_text: actionBearingText(sourceKind, row, material),
  }));
}

// Pure revision calculation for a row already read by a caller.  In
// particular, replay/audit tooling can use it against a read-only SQLite
// handle without invoking the application's writable db singleton.
function sourceRevisionFromRow(sourceKind, row) {
  if (!row) return null;
  const material = sourceMaterial(sourceKind, row);
  return evidenceRevision(sourceKind, String(row.id), material);
}

function evidenceFromRow(user, sourceKind, row) {
  if (!row) return null;
  const material = sourceMaterial(sourceKind, row);
  const sourceId = String(row.id);
  const revisionHash = evidenceRevision(sourceKind, sourceId, material);
  const actionRevisionHash = actionRevision(sourceKind, sourceId, row, material);
  return {
    user,
    source_kind: sourceKind,
    source_id: sourceId,
    row,
    text: material.text,
    provenance: material.provenance,
    complete: Boolean(material.complete),
    completeness: material.completeness,
    body_source: material.bodySource || null,
    revision_hash: revisionHash,
    action_revision_hash: actionRevisionHash,
    chunks: deterministicChunks(material.text, { revisionHash }),
    ts: Number(row.ts || row.received_at || row.uploaded_at || row.created_at || now()),
  };
}

function resolveSourceEvidence(user, sourceKind, sourceIdOrRow) {
  const row = sourceIdOrRow && typeof sourceIdOrRow === 'object'
    ? sourceIdOrRow
    : rowForSource(user, sourceKind, sourceIdOrRow);
  return evidenceFromRow(user, sourceKind, row);
}

function listSourceEvidence(user, sourceKind = null) {
  const kinds = sourceKind ? [sourceKind] : SOURCE_EVIDENCE_KINDS;
  const evidence = [];
  for (const kind of kinds) {
    for (const row of rowsForSourceKind(user, kind)) {
      const item = evidenceFromRow(user, kind, row);
      if (item) evidence.push(item);
    }
  }
  return evidence.sort((a, b) => Number(a.ts) - Number(b.ts)
    || a.source_kind.localeCompare(b.source_kind)
    || a.source_id.localeCompare(b.source_id));
}

function sourceDisplay(evidence) {
  const row = evidence?.row || {};
  const kind = evidence?.source_kind;
  if (kind === 'email_summary') {
    return {
      title: row.subject || '(no subject)',
      meta: `From ${row.from_name || ''}${row.from_email ? ` <${row.from_email}>` : ''}`.trim(),
    };
  }
  if (kind === 'document') return { title: row.filename || 'Document', meta: '' };
  if (kind === 'meeting_intake') return { title: row.title || 'Meeting', meta: '' };
  if (kind === 'debrief_session') {
    return {
      title: 'Debrief session',
      meta: row.note_path || (row.started_at ? dateText(row.started_at) : ''),
    };
  }
  if (kind === 'completed_task') return { title: row.title || 'Completed task', meta: 'Completed task evidence' };
  if (kind === 'open_task') return { title: row.title || 'Open task', meta: 'Open task evidence' };
  if (kind === 'crm_fact') return { title: 'CRM fact', meta: row.contact_name || '' };
  if (kind === 'messaging_message') return { title: row.chat_name || row.sender_name || 'Message', meta: row.sender_name || row.platform || '' };
  return { title: 'Source', meta: '' };
}

function locateEvidenceSpan(evidence, snippet, preferredChunk = null) {
  const text = string(evidence?.text);
  const quoted = string(snippet).trim();
  const fallback = preferredChunk || evidence?.chunks?.[0] || null;
  if (!text || !quoted) {
    return fallback ? {
      start: fallback.start,
      end: fallback.end,
      chunk_index: fallback.index,
      chunk_id: fallback.chunk_id,
      text: fallback.text,
      exact: false,
    } : null;
  }
  const lowerText = text.toLowerCase();
  const lowerQuote = quoted.toLowerCase();
  const positions = [];
  let at = lowerText.indexOf(lowerQuote);
  while (at >= 0) {
    positions.push(at);
    at = lowerText.indexOf(lowerQuote, at + 1);
  }
  if (!positions.length) {
    return fallback ? {
      start: fallback.start,
      end: fallback.end,
      chunk_index: fallback.index,
      chunk_id: fallback.chunk_id,
      text: fallback.text,
      exact: false,
    } : null;
  }
  const preferred = preferredChunk
    ? positions.find(pos => pos >= preferredChunk.start && pos + quoted.length <= preferredChunk.end)
    : null;
  const start = preferred == null ? positions[0] : preferred;
  const end = start + quoted.length;
  const chunk = evidence.chunks.find(c => start >= c.start && end <= c.end)
    || evidence.chunks.find(c => start >= c.start && start < c.end)
    || fallback;
  return {
    start,
    end,
    chunk_index: chunk?.index ?? null,
    chunk_id: chunk?.chunk_id ?? null,
    text: text.slice(start, end),
    exact: true,
  };
}

function stableActionKey(evidence, span) {
  // An approximate chunk fallback is useful for human review, but it is never
  // an action identity: otherwise every unmatched model candidate in one
  // chunk collapses into a single externally creatable side effect.
  const actionRevisionHash = evidence?.action_revision_hash || evidence?.revision_hash;
  if (!actionRevisionHash || span?.exact !== true || !Number.isInteger(span.start) || !Number.isInteger(span.end)) {
    return null;
  }
  // Do not use chunk_id or absolute offsets here: both include the broader
  // knowledge revision and generated header length.  The same exact quotation
  // from the same raw source must retain one provider identity when linking or
  // identity metadata changes.  Candidate semantics are layered on top by
  // stableCandidateActionKey so two asks sharing one quotation remain distinct.
  const exactEvidence = string(span.text).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!exactEvidence) return null;
  return hash(JSON.stringify({
    type: 'source_action_span_v2',
    source_kind: evidence.source_kind,
    source_id: evidence.source_id,
    action_revision: actionRevisionHash,
    exact_evidence: exactEvidence,
  }));
}

module.exports = {
  CRM_KNOWLEDGE_PIPELINE_VERSION,
  CRM_KNOWLEDGE_AUTO_PROCESS_AFTER,
  SOURCE_EVIDENCE_KINDS,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CHUNK_OVERLAP,
  STALE_MEETING_PROCESSING_SECONDS,
  deterministicChunks,
  resolveSourceEvidence,
  listSourceEvidence,
  rowForSource,
  rowsForSourceKind,
  evidenceFromRow,
  sourceRevisionFromRow,
  sourceDisplay,
  locateEvidenceSpan,
  stableActionKey,
  isCanonicalMeetingEvidenceRow,
  canonicalDocumentMaterial,
  canonicalDocumentTaskText,
  workdayTranscriptMaterial,
  isGeneratedCanonicalDocument,
  subjectWithoutTransportPrefixes,
  canonicalEvidenceExclusionReason,
  isCanonicalEvidenceExcluded,
  hash,
};
