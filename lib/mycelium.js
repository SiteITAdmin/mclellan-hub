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

// ── 1. Flights → Tasks ────────────────────────────────────────────────────────
// Creates check-in and prep tasks for upcoming flights automatically.

async function connectFlightsToTasks(user, hub, report) {
  const today = todayIso();
  const in7 = dateInNDays(7);

  const flights = hub.prepare(`
    SELECT * FROM flights
    WHERE user = ? AND status = 'scheduled'
      AND flight_date BETWEEN ? AND ?
    ORDER BY flight_date ASC, scheduled_dep ASC
  `).all(user, today, in7);

  let created = 0;

  for (const f of flights) {
    const route = f.direction || f.flight_number;
    const daysAway = Math.ceil(
      (new Date(f.flight_date) - new Date(today)) / 86400000
    );

    // Pre-flight prep task — 48h before
    if (daysAway <= 2) {
      const prepId = `flight:prep:${f.id}`;
      if (!taskExists(hub, user, prepId)) {
        await createTask(user, {
          title: `Pre-flight: ${f.flight_number} ${route} on ${f.flight_date}`,
          notes: `Check docs, transport, and packing. Dep: ${f.scheduled_dep || 'TBC'}`,
          source: 'mycelium',
          sourceId: prepId,
          projectSlug: null,
        }).catch(() => {});
        created++;
        report.push(`✈ Created prep task: ${f.flight_number} ${route}`);
      }
    }

    // Online check-in task — within 24h window (most airlines open 24h before)
    if (daysAway <= 1) {
      const checkinId = `flight:checkin:${f.id}`;
      if (!taskExists(hub, user, checkinId)) {
        await createTask(user, {
          title: `Check in online: ${f.flight_number} ${route} (${f.flight_date})`,
          notes: f.scheduled_dep ? `Departure ${f.scheduled_dep}` : '',
          source: 'mycelium',
          sourceId: checkinId,
          projectSlug: null,
        }).catch(() => {});
        created++;
        report.push(`✈ Created check-in task: ${f.flight_number} ${route}`);
      }
    }
  }

  return { node: 'flights→tasks', flights: flights.length, created };
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

// ── 3a. Documents → Tasks (auto-extract) ─────────────────────────────────────
// For documents uploaded in the last 24h with no existing tasks, runs LLM
// extraction automatically — same logic as the manual "→ tasks" button.

async function autoExtractDocumentTasks(user, hub, report) {
  const { extractionPrompt, isGeneratedDocument } = require('./document-tasks');
  const { formatLearnedTaskRules } = require('./task-learning');
  // No time window — the per-doc existing-task check prevents re-processing.
  // A time window would silently skip documents uploaded before the window, which is the bug
  // that caused the SharePoint tracker tasks to never be created.
  const docs = hub.prepare(`
    SELECT d.*, p.slug AS project_slug, p.name AS project_name
    FROM documents d
    JOIN projects p ON p.id = d.project_id
    WHERE d.user = ?
      AND d.mimetype NOT LIKE 'image/%'
      AND d.markdown IS NOT NULL AND trim(d.markdown) != ''
      AND NOT EXISTS (
        SELECT 1 FROM google_tasks t
        WHERE t.user = d.user AND t.source = 'document'
          AND t.source_id LIKE 'doc:' || d.id || ':%'
          AND t.deleted_at IS NULL
      )
  `).all(user);

  let totalCreated = 0;

  for (const doc of docs) {
    if (isGeneratedDocument(doc)) {
      report.push(`📄 Skipped generated document for task extraction: ${doc.filename}`);
      continue;
    }
    const markdown = (doc.markdown || '').replace(/^---[\s\S]*?---\n+/, '').replace(/^# .+\n+/, '');
    if (!markdown.trim()) continue;

    const fetch = require('./fetch');
    const { logUsageFromResponse } = require('./openrouter-usage');
    const { createTask } = require('./google-tasks');

    const modelId = 'google/gemini-2.5-pro-preview';
    const started = Date.now();

    const prompt = extractionPrompt(doc, markdown, formatLearnedTaskRules(user, 'document'));

    let extracted;
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://dchat.mclellan.scot',
        },
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
      });
      extracted = JSON.parse(data.choices[0].message.content);
    } catch (err) {
      console.warn(`[mycelium] doc task extract failed for ${doc.filename}:`, err.message);
      continue;
    }

    const tasks = (extracted.tasks || []).filter(t => t?.title?.trim());
    if (!tasks.length) continue;

    let created = 0;
    for (const t of tasks) {
      const sourceRef = t.source_ref ? String(t.source_ref).slice(0, 60) : null;
      const sourceId = `doc:${doc.id}:${sourceRef || t.title.slice(0, 60)}`;
      const result = await createTask(user, {
        title: t.title,
        notes: [t.notes, `Source: ${doc.filename}`].filter(Boolean).join(' · '),
        source: 'document',
        sourceId,
        projectSlug: doc.project_slug || null,
      }).catch(() => null);
      if (result) created++;
    }

    if (created > 0) {
      totalCreated += created;
      report.push(`📄 Auto-extracted ${created} task(s) from ${doc.filename}`);
    }
  }

  return { node: 'documents→tasks', docs: docs.length, created: totalCreated };
}

// ── 3b. Documents → CRM contacts ─────────────────────────────────────────────
// Scans recently uploaded documents for contact name mentions and links them.

function connectDocumentsToContacts(user, hub, report) {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;

  const docs = hub.prepare(`
    SELECT d.*, p.slug AS project_slug
    FROM documents d
    JOIN projects p ON p.id = d.project_id
    WHERE d.user = ? AND d.uploaded_at >= datetime(?, 'unixepoch')
  `).all(user, since);

  const contacts = hub.prepare(
    'SELECT id, name FROM contacts WHERE user = ? ORDER BY length(name) DESC'
  ).all(user);

  let linked = 0;

  for (const doc of docs) {
    const content = (doc.markdown || '').toLowerCase();
    if (!content || !doc.project_slug) continue;

    const project = hub.prepare('SELECT id FROM projects WHERE user = ? AND slug = ?')
                       .get(user, doc.project_slug);
    if (!project) continue;

    for (const contact of contacts) {
      if (contact.name.length < 4) continue; // skip short names — too many false positives
      if (!content.includes(contact.name.toLowerCase())) continue;

      // Link contact to project if not already linked
      const alreadyLinked = hub.prepare(
        'SELECT 1 FROM contact_projects WHERE contact_id = ? AND project_id = ?'
      ).get(contact.id, project.id);

      if (!alreadyLinked) {
        try {
          hub.prepare(
            'INSERT OR IGNORE INTO contact_projects (contact_id, project_id) VALUES (?, ?)'
          ).run(contact.id, project.id);
          linked++;
          report.push(`📎 Linked ${contact.name} → project/${doc.project_slug} (via ${doc.filename})`);
        } catch { /* ignore constraint errors */ }
      }
    }
  }

  return { node: 'documents→crm', docs: docs.length, linked };
}

// ── 4. Regulatory Monitor → Projects ─────────────────────────────────────────
// Matches recent reg items to projects by keyword and stores a CRM note.

function connectRegToProjects(user, hub, report) {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const items = hub.prepare(
    'SELECT * FROM reg_monitor_items WHERE found_at >= ?'
  ).all(since);

  const projects = hub.prepare(
    'SELECT id, slug, name, context_depth FROM projects WHERE user = ? ORDER BY name'
  ).all(user);

  let tagged = 0;

  for (const item of items) {
    const text = `${item.title} ${item.synopsis || ''}`.toLowerCase();

    for (const project of projects) {
      const keywords = project.name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matches = keywords.some(kw => text.includes(kw));
      if (!matches) continue;

      const factText = `[Regulatory/${project.slug}] ${item.title} — ${item.site}: ${item.url}`;

      // Check if already stored
      const existingFact = hub.prepare(`
        SELECT 1 FROM crm_facts WHERE user = ? AND source = 'reg-monitor' AND fact = ?
      `).get(user, factText);

      if (existingFact) continue;

      const selfContact = hub.prepare(
        "SELECT id FROM contacts WHERE user = ? AND lower(name) LIKE '%douglas%' LIMIT 1"
      ).get(user);

      if (!selfContact) continue;

      hub.prepare(`
        INSERT INTO crm_facts (id, user, contact_id, fact, status, source, linked_contacts, fact_type)
        VALUES (?, ?, ?, ?, 'active', 'reg-monitor', '[]', 'note')
      `).run(uuid(), user, selfContact.id, factText);
      tagged++;
      report.push(`📋 Reg: "${item.title.slice(0, 40)}" → ${project.slug}`);
    }
  }

  return { node: 'reg→projects', items: items.length, tagged };
}

// ── 5. Meetings → prep tasks ──────────────────────────────────────────────────
// Creates a prep task for any meeting in the next 48–72h with no existing task.

async function connectMeetingsToPrepTasks(user, hub, report) {
  let events = [];
  try {
    events = await fetchCalendarEvents(user, { daysBack: 0, daysForward: 3 });
  } catch { return { node: 'meetings→tasks', error: 'calendar unavailable' }; }

  const today = todayIso();
  const in48h = dateInNDays(2);

  // Only meetings in the 24–72h window (not today — too late for prep)
  const upcoming = events.filter(e => e.date > today && e.date <= in48h && e.attendees?.length > 0);

  let created = 0;
  for (const ev of upcoming) {
    const sourceId = `meeting:prep:${ev.id}`;
    if (taskExists(hub, user, sourceId)) continue;

    // attendees is already an array of name strings from fetchCalendarEvents
    const attendeeNames = (ev.attendees || []).slice(0, 3).join(', ');

    await createTask(user, {
      title: `Prep: ${ev.summary}${attendeeNames ? ` (with ${attendeeNames})` : ''}`,
      notes: `${ev.date} ${ev.time || ''} ${ev.location ? '@ ' + ev.location : ''}`.trim(),
      source: 'mycelium',
      sourceId,
      projectSlug: null,
    }).catch(() => {});
    created++;
    report.push(`📅 Created prep task for: ${ev.summary} on ${ev.date}`);
  }

  return { node: 'meetings→tasks', meetings: upcoming.length, created };
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

module.exports = { runMycelium, buildConnectivityReport, autoExtractDocumentTasks, connectDocumentsToContacts, connectFlightsToTasks };
