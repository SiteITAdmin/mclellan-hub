'use strict';

/**
 * Mycelium — cross-node connector.
 * Runs on a schedule and grows paths between isolated data nodes.
 * Every check is idempotent: safe to run repeatedly, no duplicates.
 */

const db = require('./db');
const { uuid } = require('./id');
const { createTask } = require('./google-tasks');
const { fetchCalendarEvents } = require('./crm');
const { discoverCalendarFlights } = require('./flight-calendar-import');
const { legacyDirectCrmWritesEnabled } = require('./crm-pipeline-mode');
const { queueCrmKnowledgeEngine } = require('./crm-knowledge-queue');

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function dateInNDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function taskExists(hub, user, sourceId) {
  return !!hub.prepare(
    'SELECT 1 FROM google_tasks WHERE user = ? AND source_id = ? AND source = ? AND deleted_at IS NULL'
  ).get(user, sourceId, 'mycelium');
}

// Document task extraction is source evidence for the canonical CRM
// knowledge/action pipeline.  Keep the extractor's decision auditable without
// treating it as permission to project a Google Task in the normal path.
function writeDocumentTaskReceipt(user, doc, {
  status,
  summary,
  payload = {},
} = {}) {
  try {
    const receiptId = uuid();
    db.hub().prepare(`
      INSERT INTO knowledge_receipts
        (id, user, source_kind, source_id, stage, status, summary, payload, created_at)
      VALUES (?, ?, 'document', ?, 'mycelium_document_tasks', ?, ?, ?, unixepoch())
    `).run(
      receiptId,
      user,
      String(doc?.id || 'unknown-document'),
      String(status || 'review'),
      summary || null,
      JSON.stringify(payload || {}),
    );
    return receiptId;
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/**
 * Attempt one projection task and keep the outcome visible to the caller.
 *
 * Google Tasks uses a null result for an idempotent duplicate.  That is not a
 * newly-created task, so callers must only increment their created counter for
 * a real result.  API/auth failures are retained in errorDetails rather than
 * being swallowed by a fire-and-forget catch.
 */
async function projectTask(user, options, {
  createTaskFn = createTask,
  errorDetails,
  report,
  label,
} = {}) {
  const sourceId = options?.sourceId || null;
  try {
    const result = await createTaskFn(user, options);
    if (result) {
      if (label && report) report.push(label);
      return { created: true, result };
    }
    return { created: false, duplicate: true };
  } catch (err) {
    const detail = {
      sourceId,
      title: options?.title || null,
      error: err?.message || String(err),
    };
    if (Array.isArray(errorDetails)) errorDetails.push(detail);
    if (report) report.push(`⚠️ Failed to create task${sourceId ? ` ${sourceId}` : ''}: ${detail.error}`);
    return { created: false, error: detail };
  }
}

// ── 1. Flights → Tasks ────────────────────────────────────────────────────────
// Creates check-in and prep tasks for upcoming flights automatically.

async function connectFlightsToTasks(user, hub, report, { createTaskFn = createTask } = {}) {
  const today = todayIso();
  const in7 = dateInNDays(7);

  const flights = hub.prepare(`
    SELECT * FROM flights
    WHERE user = ? AND status = 'scheduled'
      AND flight_date BETWEEN ? AND ?
    ORDER BY flight_date ASC, scheduled_dep ASC
  `).all(user, today, in7);

  let created = 0;
  const errorDetails = [];
  let skipped = 0;

  for (const f of flights) {
    const route = f.direction || f.flight_number;
    const daysAway = Math.ceil(
      (new Date(f.flight_date) - new Date(today)) / 86400000
    );

    // Pre-flight prep task — 48h before
    if (daysAway <= 2) {
      const prepId = `flight:prep:${f.id}`;
      if (!taskExists(hub, user, prepId)) {
        const outcome = await projectTask(user, {
          title: `Pre-flight: ${f.flight_number} ${route} on ${f.flight_date}`,
          notes: `Check docs, transport, and packing. Dep: ${f.scheduled_dep || 'TBC'}`,
          source: 'mycelium',
          sourceId: prepId,
          projectSlug: null,
        }, {
          createTaskFn,
          errorDetails,
          report,
          label: `✈ Created prep task: ${f.flight_number} ${route}`,
        });
        if (outcome.created) created++;
        else if (outcome.duplicate) skipped++;
      } else {
        skipped++;
      }
    }

    // Online check-in task — within 24h window (most airlines open 24h before)
    if (daysAway <= 1) {
      const checkinId = `flight:checkin:${f.id}`;
      if (!taskExists(hub, user, checkinId)) {
        const outcome = await projectTask(user, {
          title: `Check in online: ${f.flight_number} ${route} (${f.flight_date})`,
          notes: f.scheduled_dep ? `Departure ${f.scheduled_dep}` : '',
          source: 'mycelium',
          sourceId: checkinId,
          projectSlug: null,
        }, {
          createTaskFn,
          errorDetails,
          report,
          label: `✈ Created check-in task: ${f.flight_number} ${route}`,
        });
        if (outcome.created) created++;
        else if (outcome.duplicate) skipped++;
      } else {
        skipped++;
      }
    }
  }

  return {
    node: 'flights→tasks',
    flights: flights.length,
    created,
    skipped,
    errors: errorDetails.length,
    errorDetails,
  };
}

// ── 2. Flights × Calendar — conflict awareness ────────────────────────────────
// Checks for calendar events on flight days and adds a note to the flight record.

async function checkFlightCalendarConflicts(user, hub, report) {
  const today = todayIso();
  const in7 = dateInNDays(7);

  const flights = hub.prepare(`
    SELECT * FROM flights
    WHERE user = ? AND status = 'scheduled'
      AND flight_date BETWEEN ? AND ?
  `).all(user, today, in7);

  if (!flights.length) return { node: 'flights×calendar', flights: 0, conflicts: 0 };

  let events = [];
  try {
    events = await fetchCalendarEvents(user, { daysBack: 0, daysForward: 7 });
  } catch { return { node: 'flights×calendar', error: 'calendar unavailable' }; }

  let conflicts = 0;
  for (const f of flights) {
    const dayEvents = events.filter(e => e.date === f.flight_date);
    if (!dayEvents.length) continue;

    const note = `Calendar on ${f.flight_date}: ${dayEvents.map(e => `${e.time} ${e.summary}`).join('; ')}`;
    // Only update if note has changed to avoid churning
    if (!(f.notes || '').includes('Calendar on')) {
      hub.prepare('UPDATE flights SET notes = ? WHERE id = ?')
         .run([f.notes, note].filter(Boolean).join('\n'), f.id);
      conflicts++;
      report.push(`📅 Flight ${f.flight_number}: noted ${dayEvents.length} calendar event(s) on that day`);
    }
  }

  return { node: 'flights×calendar', flights: flights.length, conflicts };
}

// ── 3a. Documents → Tasks (canonical review request) ─────────────────────────
// Normal operation queues the canonical CRM knowledge engine.  The historical
// extractor/direct projection remains only behind CRM_LEGACY_DIRECT_WRITES=1.

async function autoExtractDocumentTasks(user, hub, report, {
  createTaskFn = createTask,
  fetchFn = require('./fetch'),
} = {}) {
  const { extractionPrompt, isGeneratedDocument } = require('./document-tasks');
  const docs = hub.prepare(`
    SELECT d.*, p.slug AS project_slug, p.name AS project_name
    FROM documents d
    JOIN projects p ON p.id = d.project_id
    WHERE d.user = ?
      AND d.mimetype NOT LIKE 'image/%'
      AND d.markdown IS NOT NULL AND trim(d.markdown) != ''
      AND d.task_extracted_at IS NULL
  `).all(user);

  let totalCreated = 0;
  let totalDeferred = 0;
  let deferredDocs = 0;
  let totalSkipped = 0;
  const errorDetails = [];
  const receiptErrors = [];
  const legacyDirectWrites = legacyDirectCrmWritesEnabled();

  // Normal Mycelium must not run a second task-extraction model.  Documents
  // are already canonical source evidence; queue the one versioned CRM engine
  // pass and leave task_extracted_at untouched until that engine's semantic
  // action outcome is authoritative.  The queue helper reuses a pending/running
  // job, so repeated scheduler ticks create no receipts or provider calls.
  if (!legacyDirectWrites) {
    let queued = null;
    for (const doc of docs) {
      if (isGeneratedDocument(doc)) {
        report.push(`📄 Skipped generated document for task extraction: ${doc.filename}`);
        continue;
      }
      const markdown = (doc.markdown || '').replace(/^---[\s\S]*?---\n+/, '').replace(/^# .+\n+/, '');
      if (!markdown.trim()) continue;
      if (!queued) {
        queued = queueCrmKnowledgeEngine({
          user,
          sourceKind: 'document',
          sourceId: doc.id,
          requestedBy: 'mycelium-document-tasks',
        }, hub);
      }
      totalDeferred += 1;
      deferredDocs += 1;
      const queueLabel = queued.existing ? `reused CRM knowledge job ${queued.jobId}` : `queued CRM knowledge job ${queued.jobId}`;
      report.push(`📄 Deferred document task review for ${doc.filename} to canonical CRM knowledge (${queueLabel})`);
    }
    return {
      node: 'documents→tasks',
      docs: docs.length,
      created: 0,
      deferred: totalDeferred,
      deferredDocs,
      skipped: 0,
      errors: 0,
      errorDetails,
      receiptErrors,
      queue: queued,
      status: deferredDocs ? 'deferred_to_crm_knowledge' : 'done',
      directWrites: false,
    };
  }

  for (const doc of docs) {
    if (isGeneratedDocument(doc)) {
      report.push(`📄 Skipped generated document for task extraction: ${doc.filename}`);
      continue;
    }
    const markdown = (doc.markdown || '').replace(/^---[\s\S]*?---\n+/, '').replace(/^# .+\n+/, '');
    if (!markdown.trim()) continue;
    // Legacy rollback path intentionally retains the historical extractor and
    // direct task projection.  It is unreachable in normal operation.

    const { formatLearnedTaskRules } = require('./task-learning');
    const { logUsageFromResponse } = require('./openrouter-usage');
    const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
    const { getSystemModelId } = require('./settings');

    const modelId = getSystemModelId('task_extractor', 'system', 'google/gemini-2.5-pro-preview');
    const started = Date.now();

    const prompt = extractionPrompt(doc, markdown, formatLearnedTaskRules(user, 'document'));

    let extracted;
    try {
      const resp = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: openRouterHeaders(TASK_CODES.MYCELIUM),
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });
      if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
      const data = await resp.json();
      logUsageFromResponse({
        user, feature: 'mycelium-doc-tasks', modelKey: 'task_extractor',
        fallbackModelId: modelId, data, durationMs: Date.now() - started,
        taskCode: TASK_CODES.MYCELIUM,
      });
      extracted = JSON.parse(data.choices[0].message.content);
    } catch (err) {
      console.warn(`[mycelium] doc task extract failed for ${doc.filename}:`, err.message);
      errorDetails.push({
        documentId: doc.id,
        filename: doc.filename,
        stage: 'extraction',
        error: err?.message || String(err),
      });
      const receipt = writeDocumentTaskReceipt(user, doc, {
        status: 'error',
        summary: `Document task extraction failed: ${err?.message || String(err)}`,
        payload: {
          filename: doc.filename,
          stage: 'extraction',
          error: err?.message || String(err),
        },
      });
      if (receipt?.error) receiptErrors.push({ documentId: doc.id, error: receipt.error });
      report.push(`⚠️ Document task extraction failed for ${doc.filename}: ${err.message}`);
      continue;
    }

    const tasks = (Array.isArray(extracted.tasks) ? extracted.tasks : [])
      .filter(t => t?.title?.trim());
    if (!tasks.length) {
      // The extractor has not compiled canonical evidence/action outcomes, so
      // the operational completion marker must remain unset in the normal
      // path.  The canonical document engine owns that semantic transition.
      const receipt = writeDocumentTaskReceipt(user, doc, {
        status: legacyDirectWrites ? 'done' : 'deferred_to_crm_knowledge',
        summary: legacyDirectWrites
          ? `Extracted 0 genuine tasks from ${doc.filename}`
          : `Deferred document task review for ${doc.filename}; no task candidates extracted`,
        payload: {
          filename: doc.filename,
          candidateCount: 0,
          directWrites: legacyDirectWrites,
        },
      });
      if (receipt?.error) receiptErrors.push({ documentId: doc.id, error: receipt.error });
      if (legacyDirectWrites) {
        hub.prepare('UPDATE documents SET task_extracted_at = unixepoch() WHERE id = ?').run(doc.id);
        report.push(`📄 Extracted 0 genuine tasks from ${doc.filename}`);
      } else {
        totalDeferred += 0;
        report.push(`📄 Deferred document task review for ${doc.filename}; no task candidates extracted`);
      }
      continue;
    }

    if (!legacyDirectWrites) {
      // Model wording is a candidate only.  Leave Google Tasks untouched and
      // leave task_extracted_at NULL so the canonical CRM knowledge engine can
      // consume the complete document evidence and compile action outcomes.
      totalDeferred += tasks.length;
      const receipt = writeDocumentTaskReceipt(user, doc, {
        status: 'deferred_to_crm_knowledge',
        summary: `Deferred ${tasks.length} document task candidate(s) from ${doc.filename}`,
        payload: {
          filename: doc.filename,
          candidateCount: tasks.length,
          candidates: tasks.map(task => ({
            title: String(task.title || '').trim().slice(0, 500),
            notes: task.notes ? String(task.notes).slice(0, 1000) : null,
            source_ref: task.source_ref ? String(task.source_ref).slice(0, 120) : null,
          })),
          directWrites: false,
        },
      });
      if (receipt?.error) receiptErrors.push({ documentId: doc.id, error: receipt.error });
      report.push(`📄 Deferred ${tasks.length} task candidate(s) from ${doc.filename} to CRM knowledge`);
      continue;
    }

    let created = 0;
    let projectionFailed = false;
    for (const t of tasks) {
      const sourceRef = t.source_ref ? String(t.source_ref).slice(0, 60) : null;
      const sourceId = `doc:${doc.id}:${sourceRef || t.title.slice(0, 60)}`;
      try {
        const result = await createTaskFn(user, {
          title: t.title,
          notes: [t.notes, `Source: ${doc.filename}`].filter(Boolean).join(' · '),
          source: 'document',
          sourceId,
          projectSlug: doc.project_slug || null,
        });
        if (result) created++;
        else totalSkipped++;
      } catch (err) {
        projectionFailed = true;
        const detail = {
          documentId: doc.id,
          filename: doc.filename,
          sourceId,
          stage: 'task_projection',
          error: err?.message || String(err),
        };
        errorDetails.push(detail);
        report.push(`⚠️ Document task projection failed for ${doc.filename}: ${detail.error}`);
      }
    }

    // Never mark a document extracted when a task projection failed.  Keeping
    // it NULL allows the next Mycelium run to retry the failed projection.
    if (!projectionFailed) {
      hub.prepare('UPDATE documents SET task_extracted_at = unixepoch() WHERE id = ?').run(doc.id);
    }

    const receipt = writeDocumentTaskReceipt(user, doc, {
      status: projectionFailed ? 'error' : 'done',
      summary: projectionFailed
        ? `Document task projection failed for ${doc.filename}`
        : `Projected ${created} document task(s) from ${doc.filename}`,
      payload: {
        filename: doc.filename,
        candidateCount: tasks.length,
        created,
        skipped: tasks.length - created,
        directWrites: true,
        projectionFailed,
      },
    });
    if (receipt?.error) receiptErrors.push({ documentId: doc.id, error: receipt.error });

    if (created > 0) {
      totalCreated += created;
      report.push(`📄 Auto-extracted ${created} task(s) from ${doc.filename}`);
    } else if (!projectionFailed) {
      report.push(`📄 Extracted ${tasks.length} task candidate(s) from ${doc.filename}; no new tasks created`);
    }
  }

  return {
    node: 'documents→tasks',
    docs: docs.length,
    created: totalCreated,
    deferred: totalDeferred,
    deferredDocs,
    skipped: totalSkipped,
    errors: errorDetails.length,
    errorDetails,
    receiptErrors,
    status: errorDetails.length
      ? (totalCreated || deferredDocs > errorDetails.length ? 'partial' : 'error')
      : (deferredDocs ? 'deferred_to_crm_knowledge' : 'done'),
    directWrites: legacyDirectWrites,
  };
}

// ── 3b. Documents → CRM contacts ─────────────────────────────────────────────
// Relationship derivation belongs to knowledge synthesis.  This compatibility
// function intentionally performs no contact_projects mutation: a name mention
// in a document is raw evidence, not proof that the person belongs to its
// project.

function connectDocumentsToContacts(user, hub, report) {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const docs = hub.prepare(`
    SELECT d.id, d.filename
    FROM documents d
    WHERE d.user = ?
      AND (d.uploaded_at >= datetime(?, 'unixepoch') OR CAST(d.uploaded_at AS INTEGER) >= ?)
  `).all(user, since, since);
  if (docs.length) {
    report.push('📎 Document/contact relationship derivation deferred to knowledge synthesis');
  }
  return {
    node: 'documents→crm',
    docs: docs.length,
    linked: 0,
    deferred: docs.length,
    reason: 'relationship derivation belongs to knowledge synthesis',
  };
}

// ── 4. Regulatory Monitor → Projects ─────────────────────────────────────────
// Regulatory items are already the authoritative raw evidence.  Keyword
// matching against a project and writing a Douglas crm_fact is a convenience
// projection that bypasses synthesis, so retain the source rows and report the
// deferred derivation without creating CRM facts.

function connectRegToProjects(user, hub, report) {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const items = hub.prepare(
    'SELECT * FROM reg_monitor_items WHERE found_at >= ?'
  ).all(since);

  if (items.length) {
    report.push(`📋 Retained ${items.length} regulatory item(s) in reg_monitor_items; project derivation deferred to knowledge synthesis`);
  }
  return {
    node: 'reg→projects',
    items: items.length,
    tagged: 0,
    deferred: items.length,
    reason: 'regulatory evidence remains in reg_monitor_items; CRM projection belongs to knowledge synthesis',
  };
}

// ── 5. Meetings → prep tasks ──────────────────────────────────────────────────
// Creates a prep task for any meeting in the next 48–72h with no existing task.

async function connectMeetingsToPrepTasks(user, hub, report, {
  createTaskFn = createTask,
  fetchCalendarEventsFn = fetchCalendarEvents,
} = {}) {
  let events = [];
  try {
    events = await fetchCalendarEventsFn(user, { daysBack: 0, daysForward: 3 });
  } catch (err) {
    return { node: 'meetings→tasks', error: 'calendar unavailable', errorDetails: [{ stage: 'calendar', error: err.message }] };
  }

  const today = todayIso();
  const in48h = dateInNDays(2);

  // Only meetings in the 24–72h window (not today — too late for prep)
  const upcoming = events.filter(e => e.date > today && e.date <= in48h && e.attendees?.length > 0);

  let created = 0;
  let skipped = 0;
  const errorDetails = [];
  for (const ev of upcoming) {
    const sourceId = `meeting:prep:${ev.id}`;
    if (taskExists(hub, user, sourceId)) continue;

    // attendees is already an array of name strings from fetchCalendarEvents
    const attendeeNames = (ev.attendees || []).slice(0, 3).join(', ');

    const outcome = await projectTask(user, {
      title: `Prep: ${ev.summary}${attendeeNames ? ` (with ${attendeeNames})` : ''}`,
      notes: `${ev.date} ${ev.time || ''} ${ev.location ? '@ ' + ev.location : ''}`.trim(),
      source: 'mycelium',
      sourceId,
      projectSlug: null,
    }, {
      createTaskFn,
      errorDetails,
      report,
      label: `📅 Created prep task for: ${ev.summary} on ${ev.date}`,
    });
    if (outcome.created) created++;
    else if (outcome.duplicate) skipped++;
  }

  return {
    node: 'meetings→tasks',
    meetings: upcoming.length,
    created,
    skipped,
    errors: errorDetails.length,
    errorDetails,
  };
}

// ── 6. Connectivity report ────────────────────────────────────────────────────
// Returns a snapshot of orphaned / underconnected nodes for the admin view.

function buildConnectivityReport(user, hub) {
  const items = [];

  // Contacts with no CRM facts
  const emptyContacts = hub.prepare(`
    SELECT c.name FROM contacts c
    LEFT JOIN crm_facts f ON f.contact_id = c.id AND f.status = 'active'
    WHERE c.user = ? AND f.id IS NULL
    ORDER BY c.name
  `).all(user);
  if (emptyContacts.length) {
    items.push({
      type: 'warning',
      label: 'Contacts with no active facts',
      count: emptyContacts.length,
      examples: emptyContacts.slice(0, 5).map(c => c.name),
    });
  }

  // Projects with no contacts
  const emptyProjects = hub.prepare(`
    SELECT p.name, p.slug FROM projects p
    LEFT JOIN contact_projects cp ON cp.project_id = p.id
    WHERE p.user = ? AND cp.contact_id IS NULL
    ORDER BY p.name
  `).all(user);
  if (emptyProjects.length) {
    items.push({
      type: 'warning',
      label: 'Projects with no contacts',
      count: emptyProjects.length,
      examples: emptyProjects.slice(0, 5).map(p => p.name),
    });
  }

  // Projects with no documents
  const undocumentedProjects = hub.prepare(`
    SELECT p.name, p.slug FROM projects p
    LEFT JOIN documents d ON d.project_id = p.id
    WHERE p.user = ? AND d.id IS NULL
    ORDER BY p.name
  `).all(user);
  if (undocumentedProjects.length) {
    items.push({
      type: 'info',
      label: 'Projects with no documents',
      count: undocumentedProjects.length,
      examples: undocumentedProjects.slice(0, 5).map(p => p.name),
    });
  }

  // Upcoming flights with no tasks
  const today = todayIso();
  const in7 = dateInNDays(7);
  const flightsWithNoTasks = hub.prepare(`
    SELECT f.flight_number, f.direction, f.flight_date FROM flights f
    WHERE f.user = ? AND f.status = 'scheduled'
      AND f.flight_date BETWEEN ? AND ?
      AND NOT EXISTS (
        SELECT 1 FROM google_tasks t
        WHERE t.user = ? AND t.source = 'mycelium'
          AND t.source_id LIKE 'flight:%' || f.id || '%'
          AND t.deleted_at IS NULL
      )
    ORDER BY f.flight_date ASC
  `).all(user, today, in7, user);
  if (flightsWithNoTasks.length) {
    items.push({
      type: 'warning',
      label: 'Upcoming flights with no tasks',
      count: flightsWithNoTasks.length,
      examples: flightsWithNoTasks.map(f => `${f.flight_number} ${f.direction} ${f.flight_date}`),
    });
  }

  // Open tasks with no project or contact
  const orphanTasks = hub.prepare(`
    SELECT COUNT(*) AS n FROM google_tasks
    WHERE user = ? AND status = 'needsAction'
      AND deleted_at IS NULL
      AND project_slug IS NULL AND contact_id IS NULL
  `).get(user);
  if (orphanTasks.n > 0) {
    items.push({
      type: 'info',
      label: 'Open tasks with no project or contact',
      count: orphanTasks.n,
      examples: [],
    });
  }

  // Documents never sent to wiki
  const unwikiDocCount = hub.prepare(`
    SELECT COUNT(*) AS n FROM documents d
    WHERE d.user = ? AND d.mimetype NOT LIKE 'image/%'
  `).get(user);
  // (we can't easily tell which went to wiki without a flag — report total for awareness)
  if (unwikiDocCount.n > 0) {
    items.push({
      type: 'info',
      label: 'Total project documents (wiki status unknown)',
      count: unwikiDocCount.n,
      examples: [],
    });
  }

  // CRM facts marked wrong — model is making systematic errors
  const wrongFacts = hub.prepare(`
    SELECT COUNT(*) AS n FROM crm_facts WHERE user = ? AND status = 'wrong'
  `).get(user);
  if (wrongFacts.n >= 3) {
    items.push({
      type: 'warning',
      label: 'CRM facts marked wrong (model errors to review)',
      count: wrongFacts.n,
      examples: [],
    });
  }

  return items;
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function runMycelium(user = 'douglas') {
  const hub = db.hub();
  const report = [];
  const results = [];

  console.log('[mycelium] starting cross-node connectivity run');

  // Calendar events can contain a flight number and route even when the
  // booking email predates Gmail intake. Import those explicit details before
  // creating tasks or checking calendar conflicts.
  try {
    results.push(await discoverCalendarFlights(user, hub, report));
  } catch (err) { results.push({ node: 'calendar→flights', error: err.message }); }

  try {
    results.push(await connectFlightsToTasks(user, hub, report));
  } catch (err) { results.push({ node: 'flights→tasks', error: err.message }); }

  try {
    results.push(await checkFlightCalendarConflicts(user, hub, report));
  } catch (err) { results.push({ node: 'flights×calendar', error: err.message }); }

  try {
    results.push(await autoExtractDocumentTasks(user, hub, report));
  } catch (err) { results.push({ node: 'documents→tasks', error: err.message }); }

  try {
    results.push(connectDocumentsToContacts(user, hub, report));
  } catch (err) { results.push({ node: 'documents→crm', error: err.message }); }

  try {
    results.push(connectRegToProjects(user, hub, report));
  } catch (err) { results.push({ node: 'reg→projects', error: err.message }); }

  try {
    results.push(await connectMeetingsToPrepTasks(user, hub, report));
  } catch (err) { results.push({ node: 'meetings→tasks', error: err.message }); }

  const connectivity = buildConnectivityReport(user, hub);

  if (report.length) {
    console.log('[mycelium] connections made:');
    report.forEach(line => console.log(' ', line));
  } else {
    console.log('[mycelium] no new connections needed');
  }

  return { results, report, connectivity };
}

module.exports = {
  runMycelium,
  buildConnectivityReport,
  autoExtractDocumentTasks,
  connectDocumentsToContacts,
  connectRegToProjects,
  connectFlightsToTasks,
  connectMeetingsToPrepTasks,
  projectTask,
};
