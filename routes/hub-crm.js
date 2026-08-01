const express = require('express');
const router = express.Router();
const fetch = require('../lib/fetch');
const db = require('../lib/db');
const {
  processCrmCommand,
  listContacts,
  buildBriefingText,
  fetchTodayCalendarEvents,
  syncCalendarMeetings,
  parseJsonArray,
  syncContactVaultFact,
  syncContactVaultProfile,
} = require('../lib/crm');
const { readNote, searchNotes, writeNote } = require('../lib/obsidian-vault');
const { uuid } = require('../lib/id');
const {
  upload, uploadLimiter, writeLimiter, requireAuth, requireSameOrigin,
} = require('./hub-shared');
const {
  createTask, createSubtask, updateTask,
  syncTasks, completeTask, deleteTask, deleteTaskEverywhere, restoreTask,
  getTask, getCachedTasks,
} = require('../lib/google-tasks');
const { TASK_CODES, openRouterHeaders } = require('../lib/openrouter-attribution');
const { logUsageFromResponse } = require('../lib/openrouter-usage');
const { PROMPTS } = require('../lib/prompts');
const { getSystemModelId, getSystemPrompt } = require('../lib/settings');
const { sendEmail: amSendEmail } = require('../lib/agentmail');
const { getCrmKnowledgeHealth } = require('../lib/crm-knowledge-health');
const { closedProjectIds, isProjectClosed, renameProject } = require('../lib/project-lifecycle');

const knowledgeRetryUsers = new Set();


function todayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function rootEmailSubject(subject) {
  let cleaned = String(subject || '').trim();
  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').trim();
  } while (cleaned && cleaned !== previous);
  return cleaned || '(no subject)';
}

function subjectFromFactProjection(projection) {
  const match = String(projection || '').match(/\[[^\]]+\]\s+(.+?)\s+—/);
  return match ? rootEmailSubject(match[1]) : null;
}

function dedupeProjectFacts(facts) {
  const seen = new Set();
  const result = [];
  for (const fact of facts) {
    const subject = subjectFromFactProjection(fact.vault_projection);
    const key = subject && ['agentmail', 'email', 'email_sent'].includes(fact.source)
      ? `${fact.source}:${fact.contact_id}:${subject.toLowerCase()}`
      : null;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    result.push(fact);
    if (result.length >= 50) break;
  }
  return result;
}


// ── CRM endpoints ─────────────────────────────────────────────────────────────
router.get('/api/crm/contacts', requireAuth, (req, res) => {
  const contacts = listContacts(req.hubUser, req.query.q);
  res.json(contacts);
});

router.post('/api/crm/contacts', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const hub = db.hub();
  const existing = hub.prepare('SELECT id FROM contacts WHERE user = ? AND name = ?').get(req.hubUser, name);
  if (existing) return res.status(409).json({ error: 'Contact already exists', id: existing.id });
  const id = uuid();
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const phone = String(req.body.phone || '').trim() || null;
  const notes = String(req.body.notes || '').trim() || null;
  hub.prepare('INSERT INTO contacts (id, user, name, email, phone, notes) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, req.hubUser, name, email, phone, notes
  );
  applyContactCreationExtras(hub, req.hubUser, id, req.body);
  syncContactVaultProfile(req.hubUser, id);
  res.json({ ok: true, id, name });
});

router.post('/api/crm/contacts/:id/merge', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const source = hub.prepare('SELECT * FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!source) return res.status(404).json({ error: 'Source contact not found' });
  const targetId = String(req.body.targetId || '').trim();
  if (!targetId) return res.status(400).json({ error: 'targetId required' });
  if (targetId === source.id) return res.status(400).json({ error: 'Cannot merge a contact into itself' });
  const target = hub.prepare('SELECT * FROM contacts WHERE id = ? AND user = ?').get(targetId, req.hubUser);
  if (!target) return res.status(404).json({ error: 'Target contact not found' });

  hub.transaction(() => {
    // Move facts owned by source → target (skip exact-duplicate facts)
    const sourceFacts = hub.prepare('SELECT id, fact FROM crm_facts WHERE contact_id = ? AND user = ?').all(source.id, req.hubUser);
    const targetFactTexts = new Set(
      hub.prepare('SELECT fact FROM crm_facts WHERE contact_id = ? AND user = ?').all(targetId, req.hubUser).map(f => f.fact)
    );
    const moveFact = hub.prepare('UPDATE crm_facts SET contact_id = ? WHERE id = ?');
    const deleteFact = hub.prepare('DELETE FROM crm_facts WHERE id = ?');
    for (const f of sourceFacts) {
      if (targetFactTexts.has(f.fact)) deleteFact.run(f.id);
      else moveFact.run(targetId, f.id);
    }

    // Rewrite linked_contacts in any fact that references source
    const linkedFacts = hub.prepare(
      "SELECT id, linked_contacts FROM crm_facts WHERE user = ? AND linked_contacts LIKE ?"
    ).all(req.hubUser, `%"${source.id}"%`);
    const updateLinks = hub.prepare('UPDATE crm_facts SET linked_contacts = ? WHERE id = ?');
    for (const fact of linkedFacts) {
      const ids = parseJsonArray(fact.linked_contacts).map(id => id === source.id ? targetId : id);
      const deduped = [...new Set(ids)];
      updateLinks.run(JSON.stringify(deduped), fact.id);
    }

    // Move meeting attendances (skip duplicates)
    const sourceMeetings = hub.prepare('SELECT meeting_id FROM meeting_attendees WHERE contact_id = ?').all(source.id);
    const targetMeetingIds = new Set(
      hub.prepare('SELECT meeting_id FROM meeting_attendees WHERE contact_id = ?').all(targetId).map(r => r.meeting_id)
    );
    const moveAttendee = hub.prepare('UPDATE meeting_attendees SET contact_id = ? WHERE contact_id = ? AND meeting_id = ?');
    const deleteAttendee = hub.prepare('DELETE FROM meeting_attendees WHERE contact_id = ? AND meeting_id = ?');
    for (const { meeting_id } of sourceMeetings) {
      if (targetMeetingIds.has(meeting_id)) deleteAttendee.run(source.id, meeting_id);
      else moveAttendee.run(targetId, source.id, meeting_id);
    }

    // Move project links (skip duplicates)
    const sourceProjects = hub.prepare('SELECT project_id FROM contact_projects WHERE contact_id = ?').all(source.id);
    const targetProjectIds = new Set(
      hub.prepare('SELECT project_id FROM contact_projects WHERE contact_id = ?').all(targetId).map(r => r.project_id)
    );
    const deleteProj = hub.prepare('DELETE FROM contact_projects WHERE contact_id = ? AND project_id = ?');
    const moveProj = hub.prepare('UPDATE contact_projects SET contact_id = ? WHERE contact_id = ? AND project_id = ?');
    for (const { project_id } of sourceProjects) {
      if (targetProjectIds.has(project_id)) deleteProj.run(source.id, project_id);
      else moveProj.run(targetId, source.id, project_id);
    }

    // Move company links (skip duplicates)
    const sourceCompanies = hub.prepare('SELECT company_id FROM contact_companies WHERE contact_id = ?').all(source.id);
    const targetCompanyIds = new Set(
      hub.prepare('SELECT company_id FROM contact_companies WHERE contact_id = ?').all(targetId).map(r => r.company_id)
    );
    const deleteCo = hub.prepare('DELETE FROM contact_companies WHERE contact_id = ? AND company_id = ?');
    const moveCo = hub.prepare('UPDATE contact_companies SET contact_id = ? WHERE contact_id = ? AND company_id = ?');
    for (const { company_id } of sourceCompanies) {
      if (targetCompanyIds.has(company_id)) deleteCo.run(source.id, company_id);
      else moveCo.run(targetId, source.id, company_id);
    }

    // Delete source contact
    hub.prepare('DELETE FROM contacts WHERE id = ?').run(source.id);
  })();

  res.json({ ok: true, merged: source.name, into: target.name, targetId });
});

router.get('/api/crm/briefing', requireAuth, async (req, res) => {
  try {
    const events = await fetchTodayCalendarEvents(req.hubUser);
    const text = buildBriefingText(req.hubUser, events);
    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Hermes (or any external agent) posts a /crm note here
// Secured by a shared secret: Authorization: Bearer <HERMES_WEBHOOK_SECRET>
router.post('/api/crm/webhook', writeLimiter, async (req, res) => {
  const secret = process.env.HERMES_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook not configured' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const { text, source = 'hermes', dedup_key } = req.body;
  const user = req.hubUser || req.body.user;
  if (!text || !user) return res.status(400).json({ error: 'text and user required' });

  // Dedup: reject retries from the same message ID within 5 minutes
  if (dedup_key) {
    const hub = db.hub();
    const dedupCtxKey = `_dedup_${dedup_key.replace(/[^a-z0-9_/-]/gi, '_')}`;
    const existing = hub.prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?').get(user, dedupCtxKey);
    if (existing && (Date.now() - parseInt(existing.value)) < 5 * 60 * 1000) {
      return res.json({ ok: true, message: 'Duplicate ignored' });
    }
    hub.prepare(`INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value`)
      .run(uuid(), user, dedupCtxKey, Date.now().toString());
  }

  try {
    const result = await processCrmCommand(user, text, source);
    res.json(result);
  } catch (err) {
    console.error('[crm webhook]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CRM view page ─────────────────────────────────────────────────────────────
router.get('/crm', requireAuth, (req, res) => {
  res.redirect('/crm/contacts');
});

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function crmPageData(user) {
  return {
    user,
    nav: [
      { href: '/crm/contacts', label: 'People' },
      { href: '/crm/companies', label: 'Companies' },
      { href: '/crm/meetings', label: 'Meetings' },
      { href: '/crm/meeting-intake', label: 'Intake' },
      { href: '/crm/questions', label: 'Questions' },
      { href: '/crm/tasks', label: 'Tasks' },
      { href: '/crm/suggestions', label: 'Suggestions' },
      { href: '/crm/reminders', label: 'Reminders' },
      { href: '/crm/projects', label: 'Projects' },
      { href: '/crm/project-report', label: 'Project Report' },
      { href: '/crm/knowledge', label: 'Ask the Hub' },
    ],
  };
}

function crmProjectsForUser(user, { includeClosed = false } = {}) {
  const hub = db.hub();
  const projects = hub.prepare(`
    SELECT p.*
      FROM projects p
     WHERE p.user = ?
       AND (
         p.project_kind = 'crm'
         OR
         EXISTS (SELECT 1 FROM contact_projects cp WHERE cp.project_id = p.id)
         OR EXISTS (SELECT 1 FROM company_projects cop WHERE cop.project_id = p.id)
         OR EXISTS (SELECT 1 FROM google_tasks t WHERE t.user = p.user AND t.project_slug = p.slug)
         OR EXISTS (SELECT 1 FROM email_summaries e WHERE e.user = p.user AND e.project_slug = p.slug)
         OR EXISTS (SELECT 1 FROM meeting_intakes mi WHERE mi.user = p.user AND mi.project_slug = p.slug)
         OR EXISTS (
           SELECT 1 FROM knowledge_atoms a
            WHERE a.user = p.user AND a.subject_kind = 'project' AND a.subject_id = p.id
         )
       )
     ORDER BY p.name
  `).all(user);
  if (includeClosed) return projects;
  const closed = closedProjectIds(hub, user);
  return projects.filter(project => !closed.has(project.id));
}

function reportableWorkspacesForUser(user, crmProjects = crmProjectsForUser(user), { includeClosed = false } = {}) {
  const crmIds = new Set(crmProjects.map(p => p.id));
  const hub = db.hub();
  const projects = hub.prepare(`
    SELECT p.*
      FROM projects p
     WHERE p.user = ?
       AND COALESCE(p.project_kind, 'workspace') != 'crm'
     ORDER BY p.name
  `).all(user).filter(p => !crmIds.has(p.id));
  if (includeClosed) return projects;
  const closed = closedProjectIds(hub, user);
  return projects.filter(project => !closed.has(project.id));
}

function safeBack(req, fallback) {
  try {
    const url = new URL(String(req.headers.referer || ''), 'http://local');
    return url.pathname.startsWith('/crm/') ? `${url.pathname}${url.search}` : fallback;
  } catch {
    return fallback;
  }
}

function setPrimaryCompany(hub, contactId, companyId) {
  return hub.transaction(() => {
    hub.prepare('UPDATE contact_companies SET is_primary = 0 WHERE contact_id = ?').run(contactId);
    return hub.prepare(`
      UPDATE contact_companies SET is_primary = 1
      WHERE contact_id = ? AND company_id = ?
    `).run(contactId, companyId);
  })();
}

function promoteFirstLinkedCompany(hub, contactId) {
  const next = hub.prepare(`
    SELECT cc.company_id
    FROM contact_companies cc
    JOIN companies co ON co.id = cc.company_id
    WHERE cc.contact_id = ?
    ORDER BY co.name
    LIMIT 1
  `).get(contactId);
  if (next) setPrimaryCompany(hub, contactId, next.company_id);
}

router.get('/crm/contacts', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const contacts = listContacts(req.hubUser, q);
  const companies = db.hub().prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  res.render('hub/crm', { ...crmPageData(req.hubUser), contacts, q, companies });
});

// Shared by the form and API create paths: link a company (existing or created
// inline) and record the how-we-met fact so the relationship origin is captured
// at add-time instead of being lost. The fact's created_at is backdated to
// first_contacted so the nightly last_contacted_at recompute agrees with it.
function applyContactCreationExtras(hub, user, contactId, body) {
  let companyId = String(body.company_id || '').trim();
  const newCompanyName = String(body.new_company_name || '').trim();
  if (companyId === '__new__' && newCompanyName) {
    const existing = hub.prepare('SELECT id FROM companies WHERE user = ? AND name = ?').get(user, newCompanyName);
    if (existing) companyId = existing.id;
    else {
      companyId = uuid();
      hub.prepare('INSERT INTO companies (id, user, name) VALUES (?, ?, ?)').run(companyId, user, newCompanyName);
    }
  }
  if (companyId && companyId !== '__new__') {
    const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(companyId, user);
    if (company) {
      hub.prepare(`
        INSERT INTO contact_companies (contact_id, company_id, role, is_primary)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(contact_id, company_id) DO UPDATE SET role = excluded.role, is_primary = 1
      `).run(contactId, company.id, String(body.role || '').trim() || null);
    }
  }
  const firstContacted = /^\d{4}-\d{2}-\d{2}$/.test(String(body.first_contacted || '')) ? body.first_contacted : null;
  const howWeMet = String(body.how_we_met || '').trim();
  if (howWeMet || firstContacted) {
    const ts = firstContacted ? Math.floor(Date.parse(firstContacted + 'T12:00:00Z') / 1000) : Math.floor(Date.now() / 1000);
    const factText = howWeMet
      ? `How we met: ${howWeMet}${firstContacted ? ` (${firstContacted})` : ''}`
      : `First contact recorded: ${firstContacted}`;
    hub.prepare(`
      INSERT INTO crm_facts (id, user, contact_id, fact, status, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 'manual', ?, ?)
    `).run(uuid(), user, contactId, factText, ts, ts);
    hub.prepare('UPDATE contacts SET last_contacted_at = MAX(COALESCE(last_contacted_at, 0), ?) WHERE id = ?').run(ts, contactId);
  }
}

router.post('/crm/contacts', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).send('Name required');
  const hub = db.hub();
  const id = uuid();
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const phone = String(req.body.phone || '').trim() || null;
  hub.prepare('INSERT INTO contacts (id, user, name, email, phone, notes) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, req.hubUser, name, email, phone, String(req.body.notes || '').trim()
  );
  applyContactCreationExtras(hub, req.hubUser, id, req.body);
  syncContactVaultProfile(req.hubUser, id);
  res.redirect('/crm/contact/' + id);
});

// Provenance resolver — turns an atom's source_ref {kind,id} into a viewable
// source so every claim on a contact/project page is traceable in one click.
router.get('/crm/source/:kind/:id', requireAuth, (req, res) => {
  const hub = db.hub();
  const { kind, id } = req.params;
  let title = 'Source', meta = '', body = '';
  if (kind === 'crm_fact') {
    const f = hub.prepare('SELECT contact_id FROM crm_facts WHERE id = ? AND user = ?').get(id, req.hubUser);
    if (!f) return res.status(404).send('Source not found');
    return res.redirect('/crm/contact/' + f.contact_id);
  } else if (kind === 'document') {
    const d = hub.prepare('SELECT filename, markdown FROM documents WHERE id = ? AND user = ?').get(id, req.hubUser);
    if (!d) return res.status(404).send('Source not found');
    title = d.filename || 'Document'; body = d.markdown || '';
  } else if (kind === 'email_summary') {
    const e = hub.prepare('SELECT subject, from_name, from_email, summary, received_at FROM email_summaries WHERE id = ? AND user = ?').get(id, req.hubUser);
    if (!e) return res.status(404).send('Source not found');
    title = e.subject || '(no subject)';
    meta = `From ${e.from_name || ''} ${e.from_email ? '<' + e.from_email + '>' : ''}`.trim();
    body = e.summary || '';
  } else if (kind === 'meeting_intake') {
    const m = hub.prepare('SELECT title, summary, transcript FROM meeting_intakes WHERE id = ? AND user = ?').get(id, req.hubUser);
    if (!m) return res.status(404).send('Source not found');
    title = m.title || 'Meeting';
    body = (m.summary ? m.summary + '\n\n' : '') + (m.transcript || '');
  } else if (kind === 'completed_task') {
    const t = hub.prepare(`
      SELECT t.*, c.name AS contact_name, co.name AS company_name, p.name AS project_name
        FROM google_tasks t
        LEFT JOIN contacts c ON c.id = t.contact_id
        LEFT JOIN companies co ON co.id = t.company_id
        LEFT JOIN projects p ON p.user = t.user AND p.slug = t.project_slug
       WHERE t.id = ? AND t.user = ?
    `).get(id, req.hubUser);
    if (!t) return res.status(404).send('Source not found');
    title = t.title || 'Completed task';
    meta = [
      t.completed_at ? `Completed ${new Date(t.completed_at * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Dublin' })}` : null,
      t.source ? `source: ${t.source}` : null,
      t.contact_name ? `person: ${t.contact_name}` : null,
      t.company_name ? `company: ${t.company_name}` : null,
      t.project_name ? `project: ${t.project_name}` : null,
    ].filter(Boolean).join(' · ');
    body = t.notes || '';
  } else {
    return res.status(404).send('Unknown source kind');
  }
  res.render('hub/crm-source', { ...crmPageData(req.hubUser), kind, title, meta, body });
});

router.get('/crm/contact/:id', requireAuth, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT * FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).send('Contact not found');

  const companies = hub.prepare(`
    SELECT co.*, cc.role, cc.is_primary
    FROM contact_companies cc
    JOIN companies co ON co.id = cc.company_id
    WHERE cc.contact_id = ?
    ORDER BY cc.is_primary DESC, co.name
  `).all(contact.id);
  const allMeetings = hub.prepare(`
    SELECT m.*, co.name AS company_name
    FROM meeting_attendees ma
    JOIN meetings m ON m.id = ma.meeting_id
    LEFT JOIN companies co ON co.id = m.company_id
    WHERE ma.contact_id = ? AND m.user = ?
    ORDER BY m.meeting_date ASC, m.meeting_time ASC
  `).all(contact.id, req.hubUser);
  const todayIsoStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const upcomingMeetings = allMeetings.filter(m => m.meeting_date >= todayIsoStr);
  const pastMeetings = allMeetings.filter(m => m.meeting_date < todayIsoStr).reverse();
  const meetings = allMeetings; // kept for coworker logic below
  const showHistory = req.query.show_history === '1';
  const allFacts = hub.prepare(`
    SELECT f.*, c.name AS subject_name, m.title AS meeting_title, co.name AS company_name
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    LEFT JOIN meetings m ON m.id = f.meeting_id
    LEFT JOIN companies co ON co.id = f.company_id
    WHERE f.user = ? AND f.status != 'wrong' ${showHistory ? '' : "AND f.status != 'archived'"}
    ORDER BY f.created_at DESC
  `).all(req.hubUser);
  const facts = allFacts.filter(f => f.contact_id === contact.id || parseJsonArray(f.linked_contacts).includes(contact.id));
  const contactMap = new Map(hub.prepare('SELECT id, name FROM contacts WHERE user = ?').all(req.hubUser).map(c => [c.id, c]));
  const coworkerIds = new Set();
  for (const meeting of meetings) {
    for (const row of hub.prepare('SELECT contact_id FROM meeting_attendees WHERE meeting_id = ?').all(meeting.id)) {
      if (row.contact_id !== contact.id) coworkerIds.add(row.contact_id);
    }
  }
  for (const fact of facts) {
    if (fact.contact_id !== contact.id) coworkerIds.add(fact.contact_id);
    for (const id of parseJsonArray(fact.linked_contacts)) if (id !== contact.id) coworkerIds.add(id);
  }
  const workedWith = [...coworkerIds].map(id => contactMap.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const tasks = getCachedTasks(req.hubUser, { contactId: contact.id }, showHistory);

  const linkedProjects = hub.prepare(`
    SELECT p.*, cp.role FROM contact_projects cp
    JOIN projects p ON p.id = cp.project_id
    WHERE cp.contact_id = ? ORDER BY p.name
  `).all(contact.id);
  const allProjects = hub.prepare('SELECT id, slug, name FROM projects WHERE user = ? ORDER BY name').all(req.hubUser);
  const linkedProjectIds = new Set(linkedProjects.map(p => p.id));
  const availableProjects = allProjects.filter(p => !linkedProjectIds.has(p.id));

  const linkedCompanyIds = new Set(companies.map(c => c.id));
  const allCompanies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  const availableCompanies = allCompanies.filter(c => !linkedCompanyIds.has(c.id));

  // Knowledge layer (compiled): claims the synthesis loop derived about this
  // contact. Legacy facts still render in the timeline during the migration.
  const { knowledgeByPredicate } = knowledgeGroupsForEntity(req.hubUser, 'contact', contact.id, { includeStale: showHistory });

  // Reminders chasing this contact's tasks — joins the relationship layer
  // to the escalation layer without new columns.
  const contactReminders = hub.prepare(`
    SELECT r.id, r.short_code, r.title, r.status, r.next_fire_at, r.escalation_level, t.id AS task_id
    FROM reminders r
    JOIN google_tasks t ON t.id = r.target_id AND t.user = r.user
    WHERE r.user = ? AND r.kind = 'task' AND t.contact_id = ?
      AND r.status IN ('scheduled', 'snoozed', 'stale', 'acked')
    ORDER BY r.next_fire_at
  `).all(req.hubUser, contact.id);

  res.render('hub/crm-contact', {
    ...crmPageData(req.hubUser), contact, companies,
    meetings, upcomingMeetings, pastMeetings,
    facts, workedWith, tasks, showHistory,
    linkedProjects, availableProjects, availableCompanies,
    knowledgeByPredicate, contactReminders,
  });
});

router.get('/crm/companies', requireAuth, (req, res) => {
  const hub = db.hub();
  const companies = hub.prepare(`
    SELECT co.*,
      COUNT(DISTINCT cc.contact_id) AS contact_count,
      COUNT(DISTINCT m.id) AS meeting_count
    FROM companies co
    LEFT JOIN contact_companies cc ON cc.company_id = co.id
    LEFT JOIN meetings m ON m.company_id = co.id
    WHERE co.user = ?
    GROUP BY co.id
    ORDER BY co.name
  `).all(req.hubUser);
  const keyContactRows = hub.prepare(`
    SELECT cc.company_id, c.name, cc.role, cc.is_primary
    FROM contact_companies cc
    JOIN contacts c ON c.id = cc.contact_id
    JOIN companies co ON co.id = cc.company_id
    WHERE co.user = ?
    ORDER BY cc.is_primary DESC, c.name
  `).all(req.hubUser);
  const keyContactsByCompany = new Map();
  for (const row of keyContactRows) {
    if (!keyContactsByCompany.has(row.company_id)) keyContactsByCompany.set(row.company_id, []);
    const list = keyContactsByCompany.get(row.company_id);
    if (list.length < 2) list.push(row);
  }
  for (const co of companies) co.keyContacts = keyContactsByCompany.get(co.id) || [];
  res.render('hub/crm-companies', { ...crmPageData(req.hubUser), companies });
});

router.post('/crm/companies', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).send('Company name required');
  const id = uuid();
  db.hub().prepare(`
    INSERT INTO companies (id, user, name, type, website, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id, req.hubUser, name, String(req.body.type || '').trim() || null,
    String(req.body.website || '').trim() || null, String(req.body.notes || '').trim() || null
  );
  res.redirect(`/crm/company/${id}`);
});

router.get('/crm/company/:id', requireAuth, (req, res) => {
  const hub = db.hub();
  const company = hub.prepare('SELECT * FROM companies WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!company) return res.status(404).send('Company not found');
  const contacts = hub.prepare(`
    SELECT c.*, cc.role, cc.is_primary
    FROM contact_companies cc JOIN contacts c ON c.id = cc.contact_id
    WHERE cc.company_id = ? ORDER BY c.name
  `).all(company.id);
  const allCompanyMeetings = hub.prepare(`
    SELECT * FROM meetings WHERE user = ? AND company_id = ?
    ORDER BY meeting_date ASC, meeting_time ASC
  `).all(req.hubUser, company.id);
  const todayIsoStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const upcomingMeetings = allCompanyMeetings.filter(m => m.meeting_date >= todayIsoStr);
  const pastMeetings = allCompanyMeetings.filter(m => m.meeting_date < todayIsoStr).reverse();
  const meetings = allCompanyMeetings;
  const contactIds = new Set(contacts.map(c => c.id));
  const facts = hub.prepare(`
    SELECT f.*, c.name AS subject_name, m.title AS meeting_title
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    LEFT JOIN meetings m ON m.id = f.meeting_id
    WHERE f.user = ?
    ORDER BY f.created_at DESC
  `).all(req.hubUser).filter(f =>
    f.company_id === company.id
    || contactIds.has(f.contact_id)
    || parseJsonArray(f.linked_contacts).some(id => contactIds.has(id))
  );
  const availableContacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const showHistory = req.query.show_history === '1';
  const tasks = getCachedTasks(req.hubUser, { companyId: company.id }, showHistory);
  const { knowledgeByPredicate } = knowledgeGroupsForEntity(req.hubUser, 'company', company.id, { includeStale: showHistory });

  res.render('hub/crm-company', {
    ...crmPageData(req.hubUser), company, contacts,
    meetings, upcomingMeetings, pastMeetings,
    facts, availableContacts, tasks, showHistory, knowledgeByPredicate,
  });
});

router.post('/crm/company/:id/contacts', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  let contact;
  if (req.body.contact_id === '__new__') {
    const newName = String(req.body.new_name || '').trim();
    if (!newName) return res.status(400).send('New person needs a name');
    const existing = hub.prepare('SELECT id FROM contacts WHERE user = ? AND name = ?').get(req.hubUser, newName);
    if (existing) contact = existing;
    else {
      const newId = uuid();
      hub.prepare('INSERT INTO contacts (id, user, name, email) VALUES (?, ?, ?, ?)').run(
        newId, req.hubUser, newName, String(req.body.new_email || '').trim().toLowerCase() || null
      );
      contact = { id: newId };
    }
  } else {
    contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.body.contact_id, req.hubUser);
  }
  if (!company || !contact) return res.status(404).send('Company or contact not found');
  const hasPrimary = hub.prepare(
    'SELECT 1 FROM contact_companies WHERE contact_id = ? AND is_primary = 1'
  ).get(contact.id);
  const makePrimary = Boolean(req.body.is_primary) || !hasPrimary;
  if (makePrimary) {
    hub.prepare('UPDATE contact_companies SET is_primary = 0 WHERE contact_id = ?').run(contact.id);
  }
  hub.prepare(`
    INSERT INTO contact_companies (contact_id, company_id, role, is_primary)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(contact_id, company_id) DO UPDATE SET role = excluded.role, is_primary = excluded.is_primary
  `).run(contact.id, company.id, String(req.body.role || '').trim() || null, makePrimary ? 1 : 0);
  syncContactVaultProfile(req.hubUser, contact.id);
  res.redirect(`/crm/company/${company.id}`);
});

router.post('/crm/company/:id', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).send('Company name required');
  const result = hub.prepare(`
    UPDATE companies SET name = ?, type = ?, website = ?, notes = ?
    WHERE id = ? AND user = ?
  `).run(
    name, String(req.body.type || '').trim() || null,
    String(req.body.website || '').trim() || null, String(req.body.notes || '').trim() || null,
    req.params.id, req.hubUser
  );
  if (!result.changes) return res.status(404).send('Company not found');
  for (const contact of hub.prepare(
    'SELECT contact_id AS id FROM contact_companies WHERE company_id = ?'
  ).all(req.params.id)) {
    syncContactVaultProfile(req.hubUser, contact.id);
  }
  res.redirect(`/crm/company/${req.params.id}`);
});

router.post('/crm/company/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!company) return res.status(404).send('Company not found');
  const contactIds = hub.prepare(
    'SELECT contact_id AS id FROM contact_companies WHERE company_id = ?'
  ).all(company.id);
  hub.transaction(() => {
    hub.prepare('DELETE FROM contact_companies WHERE company_id = ?').run(company.id);
    hub.prepare('UPDATE meetings SET company_id = NULL WHERE company_id = ? AND user = ?').run(company.id, req.hubUser);
    hub.prepare('UPDATE crm_facts SET company_id = NULL WHERE company_id = ? AND user = ?').run(company.id, req.hubUser);
    hub.prepare('DELETE FROM companies WHERE id = ?').run(company.id);
  })();
  for (const contact of contactIds) syncContactVaultProfile(req.hubUser, contact.id);
  res.redirect('/crm/companies');
});

router.get('/crm/meetings', requireAuth, (req, res) => {
  const hub = db.hub();
  const meetings = hub.prepare(`
    SELECT m.*, co.name AS company_name, COUNT(ma.contact_id) AS attendee_count
    FROM meetings m
    LEFT JOIN companies co ON co.id = m.company_id
    LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
    WHERE m.user = ?
    GROUP BY m.id
    ORDER BY m.meeting_date DESC, m.meeting_time DESC
  `).all(req.hubUser);
  const contacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  res.render('hub/crm-meetings', {
    ...crmPageData(req.hubUser), meetings, contacts, companies, query: req.query,
  });
});

router.post('/crm/meetings', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const title = String(req.body.title || '').trim();
  const meetingDate = String(req.body.meeting_date || '').trim();
  if (!title || !meetingDate) return res.status(400).send('Title and date required');
  const id = uuid();
  const requestedCompanyId = String(req.body.company_id || '').trim();
  const company = requestedCompanyId
    ? hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(requestedCompanyId, req.hubUser)
    : null;
  const create = hub.transaction(() => {
    hub.prepare(`
      INSERT INTO meetings
        (id, user, title, meeting_date, meeting_time, duration_mins, location, notes, company_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
    `).run(
      id, req.hubUser, title, meetingDate, String(req.body.meeting_time || '').trim() || null,
      Number(req.body.duration_mins) || null, String(req.body.location || '').trim() || null,
      String(req.body.notes || '').trim() || null, company?.id || null
    );
    const insert = hub.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, contact_id) VALUES (?, ?)');
    for (const contactId of asArray(req.body.attendee_ids)) {
      const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(contactId, req.hubUser);
      if (contact) insert.run(id, contact.id);
    }
  });
  create();
  res.redirect(`/crm/meeting/${id}`);
});

router.post('/crm/meetings/sync-calendar', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const result = await syncCalendarMeetings(req.hubUser);
    res.redirect(`/crm/meetings?synced=${result.events}&matched=${result.attendeesMatched}`);
  } catch (err) {
    console.error('[crm calendar sync]', err);
    res.status(500).send(`Calendar sync failed: ${err.message}`);
  }
});

router.get('/crm/meeting-intake', requireAuth, (req, res) => {
  const hub = db.hub();
  const { isPlaceholderPersonName } = require('../lib/meeting-intake');
  const meetings = hub.prepare(`
    SELECT m.id, m.title, m.meeting_date, m.meeting_time, co.name AS company_name
    FROM meetings m
    LEFT JOIN companies co ON co.id = m.company_id
    WHERE m.user = ?
    ORDER BY m.meeting_date DESC, m.meeting_time DESC
    LIMIT 80
  `).all(req.hubUser);
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(req.hubUser);
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  const projectContacts = hub.prepare(`
    SELECT DISTINCT c.id, c.name, p.slug AS project_slug
    FROM contacts c
    JOIN contact_projects cp ON cp.contact_id = c.id
    JOIN projects p ON p.id = cp.project_id
    WHERE c.user = ?
    ORDER BY p.slug, c.name
  `).all(req.hubUser).filter(contact => !isPlaceholderPersonName(contact.name));
  const allContacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser)
    .filter(contact => !isPlaceholderPersonName(contact.name));
  const recent = hub.prepare(`
    SELECT mi.*, m.title AS meeting_title
    FROM meeting_intakes mi
    LEFT JOIN meetings m ON m.id = mi.meeting_id
    WHERE mi.user = ?
    ORDER BY mi.created_at DESC
    LIMIT 12
  `).all(req.hubUser);
  const defaultActiveIntake = recent.find(item => ['draft', 'needs_speaker_review', 'error'].includes(item.status)) || null;
  const activeIntakeId = String(
    req.query.draft
    || req.query.review
    || req.query.queued
    || req.query.intake
    || defaultActiveIntake?.id
    || ''
  ).trim();
  const activeIntake = activeIntakeId
    ? hub.prepare(`
        SELECT mi.*, m.title AS meeting_title
        FROM meeting_intakes mi
        LEFT JOIN meetings m ON m.id = mi.meeting_id
        WHERE mi.id = ? AND mi.user = ?
      `).get(activeIntakeId, req.hubUser)
    : null;
  res.render('hub/crm-meeting-intake', {
    ...crmPageData(req.hubUser), meetings, projects, companies, projectContacts, allContacts, recent, activeIntake, query: req.query,
  });
});

function queueMeetingIntakeProcessing({ user, intakeId, transcript, body = {}, sourceFilename = '' }) {
  setImmediate(async () => {
    try {
      const { processMeetingTranscript } = require('../lib/meeting-intake');
      const result = await processMeetingTranscript(user, {
        intakeId,
        transcript,
        title: body.title,
        meetingDate: body.meeting_date,
        meetingId: body.meeting_id,
        projectSlug: body.project_slug,
        companyId: body.company_id,
        attendeeContactIds: body.attendee_contact_ids,
        sourceFilename,
      });
      console.log(`[meeting-intake] processed ${intakeId}: meeting=${result.meetingId} facts=${result.counts.facts} actions=${result.counts.actions || 0} tasks=${result.counts.tasks}`);
    } catch (err) {
      console.error('[meeting-intake async]', err);
      try {
        db.hub().prepare(`
          UPDATE meeting_intakes
          SET status = 'error', error = ?, created_counts = COALESCE(NULLIF(created_counts, ''), '{}')
          WHERE id = ? AND user = ?
        `).run(err.message, intakeId, user);
      } catch (_) {}
    }
  });
}

function parseMeetingIntakeExtraction(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function queueStoredMeetingIntake(user, intake) {
  const extraction = parseMeetingIntakeExtraction(intake.extraction);
  const options = extraction.intake_options || {};
  db.hub().prepare(`
    UPDATE meeting_intakes
    SET status = 'processing', error = NULL
    WHERE id = ? AND user = ?
  `).run(intake.id, user);
  queueMeetingIntakeProcessing({
    user,
    intakeId: intake.id,
    transcript: intake.transcript,
    body: {
      title: intake.title || options.title,
      meeting_date: options.meeting_date,
      meeting_id: intake.meeting_id || options.meeting_id,
      project_slug: intake.project_slug || options.project_slug,
      company_id: options.company_id,
      attendee_contact_ids: options.attendee_contact_ids,
    },
    sourceFilename: intake.source_filename || '',
  });
}

function validKrispWebhook(req) {
  const secret = process.env.KRISP_WEBHOOK_SECRET;
  if (!secret) return { ok: false, configured: false };
  const auth = req.headers.authorization || '';
  const token = req.headers['x-krisp-token'] || req.headers['x-api-key'];
  return {
    ok: auth === `Bearer ${secret}` || token === secret,
    configured: true,
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function collectKrispText(payload) {
  const parts = [];
  const seen = new Set();
  function formatItem(item) {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return String(item || '');
    const assignee = item.assignee
      ? [item.assignee.first_name, item.assignee.last_name].filter(Boolean).join(' ')
      : '';
    return [
      item.title || item.description || item.text || item.name || JSON.stringify(item),
      assignee ? `Owner: ${assignee}` : null,
      item.due_date ? `Due: ${item.due_date}` : null,
      item.priority ? `Priority: ${item.priority}` : null,
    ].filter(Boolean).join(' - ');
  }
  function add(label, value) {
    if (typeof value === 'string' && value.trim() && !seen.has(`${label}:${value}`)) {
      seen.add(`${label}:${value}`);
      parts.push(`## ${label}\n${value.trim()}`);
    } else if (Array.isArray(value) && value.length) {
      const text = value.map(item => `- ${formatItem(item)}`).join('\n');
      if (text.trim() && !seen.has(`${label}:${text}`)) {
        seen.add(`${label}:${text}`);
        parts.push(`## ${label}\n${text.trim()}`);
      }
    }
  }

  const candidates = [
    payload,
    payload.data,
    payload.payload,
    payload.meeting,
    payload.data?.meeting,
    payload.payload?.meeting,
    payload.generated_content,
    payload.data?.generated_content,
  ].filter(Boolean);

  for (const item of candidates) {
    add('Transcript', item.transcript_text || item.transcriptText || item.transcript);
    add('Notes', item.notes || item.key_points || item.keyPoints || item.summary);
    add('Action Items', item.action_items || item.actionItems);
    add('Outline', item.outline);
    add('Krisp Notes', item.raw_content || item.rawContent);
    if (item.sections) {
      add('Action Items', item.sections.action_items || item.sections.actionItems);
      add('Key Points', item.sections.key_points || item.sections.keyPoints);
      add('Outline', item.sections.outline);
    }
  }
  return parts.join('\n\n').trim();
}

function normalizeKrispPayload(payload) {
  const data = payload?.data || {};
  const body = payload?.payload || {};
  const meeting = payload?.meeting || data.meeting || body.meeting || {};
  const eventType = firstString(payload.event_type, payload.eventType, payload.event, payload.type, data.event_type, body.event_type, 'krisp');
  const eventId = firstString(payload.event_id, payload.eventId, payload.id, data.event_id, body.event_id);
  const meetingId = firstString(meeting.id, meeting.meeting_id, meeting.meetingId, data.meeting_id, body.meeting_id);
  const title = firstString(meeting.title, meeting.name, meeting.topic, payload.title, data.title, body.title, 'Krisp meeting');
  const meetingDate = firstString(
    meeting.started_at,
    meeting.start_time,
    meeting.start_date,
    meeting.startDate,
    meeting.date,
    data.started_at,
    data.start_date,
    payload.created_at
  ).slice(0, 10);
  const transcript = collectKrispText(payload);
  const sourceKey = ['krisp', meetingId || 'unknown-meeting', eventType || 'event', eventId || 'unknown-event']
    .join(':')
    .replace(/\s+/g, '-')
    .slice(0, 240);
  return { eventType, eventId, meetingId, title, meetingDate, transcript, sourceKey };
}

router.post('/api/krisp/webhook', writeLimiter, (req, res) => {
  const auth = validKrispWebhook(req);
  if (!auth.configured) return res.status(503).json({ error: 'Krisp webhook not configured' });
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });

  const user = String(req.body?.user || process.env.KRISP_WEBHOOK_USER || 'douglas').trim();
  const normalized = normalizeKrispPayload(req.body || {});
  const hub = db.hub();
  const existing = hub.prepare('SELECT id, status FROM meeting_intakes WHERE user = ? AND source_filename = ?')
    .get(user, normalized.sourceKey);
  if (existing) return res.json({ ok: true, duplicate: true, intakeId: existing.id, status: existing.status });

  if (!normalized.transcript) {
    const intakeId = uuid();
    hub.prepare(`
      INSERT INTO meeting_intakes
        (id, user, meeting_id, project_slug, title, source_filename, transcript, status, error, extraction, created_counts)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, 'error', ?, ?, '{}')
    `).run(
      intakeId,
      user,
      normalized.title || 'Krisp webhook',
      normalized.sourceKey,
      JSON.stringify(req.body || {}, null, 2),
      'No transcript, notes, outline, or action items found in Krisp payload',
      JSON.stringify({
        source: 'krisp',
        krisp: {
          event_type: normalized.eventType,
          event_id: normalized.eventId,
          meeting_id: normalized.meetingId,
        },
        raw_payload_captured: true,
      })
    );
    console.warn(`[krisp webhook] captured unrecognized payload as intake ${intakeId}`);
    return res.json({ ok: true, intakeId, status: 'error', message: 'Payload captured for parser review' });
  }

  const intakeId = uuid();
  const { speakerReviewForTranscript } = require('../lib/meeting-intake');
  const speakerReview = speakerReviewForTranscript(normalized.transcript);
  const status = speakerReview ? 'needs_speaker_review' : 'draft';
  hub.prepare(`
    INSERT INTO meeting_intakes
      (id, user, meeting_id, project_slug, title, source_filename, transcript, status, extraction, created_counts)
    VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, '{}')
  `).run(
    intakeId,
    user,
    normalized.title,
    normalized.sourceKey,
    normalized.transcript,
    status,
    JSON.stringify({
      source: 'krisp',
      krisp: {
        event_type: normalized.eventType,
        event_id: normalized.eventId,
        meeting_id: normalized.meetingId,
      },
      intake_options: {
        title: normalized.title,
        meeting_date: normalized.meetingDate,
        meeting_id: '',
        project_slug: null,
      },
      ...(speakerReview ? { speaker_review: speakerReview } : {}),
    })
  );

  res.json({ ok: true, intakeId, status });
});

router.post('/crm/meeting-intake', requireAuth, requireSameOrigin, uploadLimiter, upload.single('transcript_file'), async (req, res) => {
  const transcript = req.file
    ? req.file.buffer.toString('utf8')
    : String(req.body.transcript || '');
  if (!transcript.trim()) return res.status(400).send('Transcript required');
  const hub = db.hub();
  const intakeId = uuid();
  const title = String(req.body.title || '').trim() || 'Meeting transcript';
  const projectSlug = String(req.body.project_slug || '').trim() || null;
  const sourceFilename = req.file?.originalname || '';
  const { speakerReviewForTranscript } = require('../lib/meeting-intake');
  const speakerReview = speakerReviewForTranscript(transcript);
  const status = speakerReview ? 'needs_speaker_review' : 'draft';
  const intakeOptions = {
    title,
    meeting_date: String(req.body.meeting_date || '').trim(),
    meeting_id: String(req.body.meeting_id || '').trim(),
    project_slug: projectSlug,
    company_id: '',
    attendee_contact_ids: [],
  };
  hub.prepare(`
    INSERT INTO meeting_intakes
      (id, user, meeting_id, project_slug, title, source_filename, transcript, status, extraction, created_counts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
  `).run(
    intakeId, req.hubUser, String(req.body.meeting_id || '').trim() || null,
    projectSlug, title, sourceFilename || null, transcript, status,
    JSON.stringify({
      intake_options: intakeOptions,
      ...(speakerReview ? { speaker_review: speakerReview } : {}),
    }),
  );

  const params = new URLSearchParams(speakerReview ? { review: intakeId } : { draft: intakeId });
  res.redirect(`/crm/meeting-intake?${params.toString()}`);
});

router.post('/crm/meeting-intake/:id/update', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const intake = hub.prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!intake) return res.status(404).send('Intake not found');
  if (intake.status === 'processing' || intake.status === 'processed') {
    return res.status(400).send('This intake has already been sent to CRM');
  }

  const title = String(req.body.title || '').trim() || 'Meeting transcript';
  const transcript = String(req.body.transcript || '').trim();
  if (!transcript) return res.status(400).send('Transcript required');

  const meetingId = String(req.body.meeting_id || '').trim();
  const projectSlug = String(req.body.project_slug || '').trim();
  let companyId = String(req.body.company_id || '').trim();
  const newCompanyName = String(req.body.new_company || '').trim();
  const meetingDate = String(req.body.meeting_date || '').trim();
  const attendeeIds = asArray(req.body.attendee_contact_ids).map(id => String(id).trim()).filter(Boolean);
  const newAttendeeNames = String(req.body.new_attendees || '')
    .split(/\r?\n|,/)
    .map(name => name.trim())
    .filter(Boolean);

  if (meetingId && !hub.prepare('SELECT id FROM meetings WHERE id = ? AND user = ?').get(meetingId, req.hubUser)) {
    return res.status(400).send('Selected meeting was not found');
  }
  if (projectSlug && !hub.prepare('SELECT slug FROM projects WHERE slug = ? AND user = ?').get(projectSlug, req.hubUser)) {
    return res.status(400).send('Selected project was not found');
  }
  if (companyId && !hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(companyId, req.hubUser)) {
    return res.status(400).send('Selected company was not found');
  }
  if (!companyId && newCompanyName) {
    const existing = hub.prepare('SELECT id FROM companies WHERE user = ? AND lower(name) = lower(?)').get(req.hubUser, newCompanyName);
    companyId = existing?.id || uuid();
    if (!existing) {
      hub.prepare('INSERT INTO companies (id, user, name) VALUES (?, ?, ?)').run(companyId, req.hubUser, newCompanyName);
    }
  }

  const { isPlaceholderPersonName, speakerReviewForTranscript } = require('../lib/meeting-intake');
  const contacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const contactByName = new Map(contacts.map(contact => [contact.name.toLowerCase(), contact]));
  for (const name of newAttendeeNames) {
    if (isPlaceholderPersonName(name)) return res.status(400).send('Speaker labels are placeholders. Please enter the real person name.');
    const existing = contactByName.get(name.toLowerCase());
    if (existing) {
      attendeeIds.push(existing.id);
      continue;
    }
    const id = uuid();
    hub.prepare('INSERT INTO contacts (id, user, name) VALUES (?, ?, ?)').run(id, req.hubUser, name);
    attendeeIds.push(id);
    contactByName.set(name.toLowerCase(), { id, name });
  }

  const extraction = parseMeetingIntakeExtraction(intake.extraction);
  const speakerReview = speakerReviewForTranscript(transcript);
  const status = speakerReview ? 'needs_speaker_review' : 'draft';
  const intakeOptions = {
    ...(extraction.intake_options || {}),
    title,
    meeting_date: meetingDate,
    meeting_id: meetingId,
    project_slug: projectSlug || null,
    company_id: companyId,
    attendee_contact_ids: [...new Set(attendeeIds)],
  };
  const nextExtraction = {
    ...extraction,
    intake_options: intakeOptions,
    ...(speakerReview ? { speaker_review: speakerReview } : { speaker_review: undefined }),
  };
  if (!speakerReview) delete nextExtraction.speaker_review;

  hub.prepare(`
    UPDATE meeting_intakes
    SET title = ?, meeting_id = ?, project_slug = ?, transcript = ?, status = ?, extraction = ?, error = NULL
    WHERE id = ? AND user = ?
  `).run(
    title,
    meetingId || null,
    projectSlug || null,
    transcript,
    status,
    JSON.stringify(nextExtraction),
    intake.id,
    req.hubUser
  );

  if (req.body.action === 'submit' && status !== 'needs_speaker_review') {
    queueStoredMeetingIntake(req.hubUser, {
      ...intake,
      title,
      meeting_id: meetingId || null,
      project_slug: projectSlug || null,
      transcript,
      status,
      extraction: JSON.stringify(nextExtraction),
    });
    return res.redirect(`/crm/meeting-intake?submitted=${encodeURIComponent(intake.id)}`);
  }

  const params = new URLSearchParams(status === 'needs_speaker_review'
    ? { saved: intake.id, review: intake.id }
    : { saved: intake.id, draft: intake.id });
  res.redirect(`/crm/meeting-intake?${params.toString()}`);
});

router.post('/crm/meeting-intake/:id/preview', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const { previewMeetingIntake } = require('../lib/meeting-intake');
    await previewMeetingIntake(req.hubUser, req.params.id);
    res.redirect(`/crm/meeting-intake?draft=${encodeURIComponent(req.params.id)}&previewed=1`);
  } catch (err) {
    console.error('[meeting-intake preview]', err);
    res.status(400).send(err.message);
  }
});

router.get('/api/crm/meeting-intake/:id/inventory', requireAuth, (req, res) => {
  const { intakeDeleteInventory } = require('../lib/meeting-intake');
  const inventory = intakeDeleteInventory(req.hubUser, req.params.id);
  if (!inventory) return res.status(404).json({ error: 'Intake not found' });
  res.json({ ok: true, inventory });
});

router.post('/crm/meeting-intake/:id/save', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const intake = hub.prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!intake) return res.status(404).send('Intake not found');
  if (intake.status === 'needs_speaker_review') {
    return res.status(400).send('Identify the detected speakers before saving this intake to CRM');
  }
  if (intake.status === 'processing') return res.redirect(`/crm/meeting-intake?submitted=${encodeURIComponent(intake.id)}`);
  if (intake.status === 'processed') return res.redirect(`/crm/meeting-intake?intake=${encodeURIComponent(intake.id)}&meeting=${encodeURIComponent(intake.meeting_id || '')}`);
  queueStoredMeetingIntake(req.hubUser, intake);
  res.redirect(`/crm/meeting-intake?submitted=${encodeURIComponent(intake.id)}`);
});

router.post('/crm/meeting-intake/:id/speakers', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const intake = hub.prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!intake) return res.status(404).send('Intake not found');
  if (intake.status !== 'needs_speaker_review') return res.status(400).send('This intake does not need speaker review');

  const extraction = (() => { try { return JSON.parse(intake.extraction || '{}'); } catch { return {}; } })();
  const speakers = extraction.speaker_review?.speakers || [];
  const speakerMap = {};
  const attendeeIds = new Set(extraction.intake_options?.attendee_contact_ids || []);
  const { isPlaceholderPersonName } = require('../lib/meeting-intake');
  const contacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  for (const speaker of speakers) {
    const key = speaker.label.replace(/[^a-z0-9]/gi, '_');
    const newName = String(req.body[`new_${key}`] || '').trim();
    const contactId = String(req.body[`contact_${key}`] || '').trim();
    let contact = contactId ? contacts.find(c => c.id === contactId) : null;
    if (contact && isPlaceholderPersonName(contact.name)) {
      return res.status(400).send('Speaker labels are placeholders. Please choose or enter the real person name.');
    }
    if (!contact && newName) {
      if (isPlaceholderPersonName(newName)) return res.status(400).send('Speaker labels are placeholders. Please choose or enter the real person name.');
      const id = uuid();
      hub.prepare('INSERT INTO contacts (id, user, name) VALUES (?, ?, ?)').run(id, req.hubUser, newName);
      contact = { id, name: newName };
      if (intake.project_slug) {
        const project = hub.prepare('SELECT id FROM projects WHERE user = ? AND slug = ?').get(req.hubUser, intake.project_slug);
        if (project) hub.prepare('INSERT OR IGNORE INTO contact_projects (contact_id, project_id, role) VALUES (?, ?, ?)').run(id, project.id, 'meeting attendee');
      }
    }
    if (contact) {
      speakerMap[speaker.label] = contact.name;
      attendeeIds.add(contact.id);
    }
  }
  if (Object.keys(speakerMap).length < speakers.length) {
    return res.status(400).send('Please map every detected speaker before processing');
  }

  const { applySpeakerMap } = require('../lib/meeting-intake');
  const resolvedTranscript = applySpeakerMap(intake.transcript, speakerMap);
  hub.prepare(`
    UPDATE meeting_intakes
    SET transcript = ?, status = 'draft', extraction = ?, error = NULL
    WHERE id = ? AND user = ?
  `).run(
    resolvedTranscript,
    JSON.stringify({
      ...extraction,
      speaker_map: speakerMap,
      intake_options: {
        ...(extraction.intake_options || {}),
        attendee_contact_ids: [...attendeeIds],
      },
    }),
    intake.id,
    req.hubUser
  );
  res.redirect(`/crm/meeting-intake?draft=${encodeURIComponent(intake.id)}`);
});

router.post('/api/crm/meeting-intake', requireAuth, requireSameOrigin, uploadLimiter, upload.single('transcript_file'), async (req, res) => {
  const transcript = req.file
    ? req.file.buffer.toString('utf8')
    : String(req.body.transcript || '');
  if (!transcript.trim()) return res.status(400).json({ error: 'Transcript required' });
  try {
    const { processMeetingTranscript } = require('../lib/meeting-intake');
    const result = await processMeetingTranscript(req.hubUser, {
      transcript,
      title: req.body.title,
      meetingDate: req.body.meeting_date,
      meetingId: req.body.meeting_id,
      projectSlug: req.body.project_slug,
      sourceFilename: req.file?.originalname || '',
    });
    res.json(result);
  } catch (err) {
    console.error('[meeting-intake]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/crm/meeting-intake/:id/delete', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const { deleteMeetingIntake } = require('../lib/meeting-intake');
    const result = await deleteMeetingIntake(req.hubUser, req.params.id);
    if (!result.ok) return res.status(404).send(result.error || 'Intake not found');
    const counts = result.deleted || {};
    const params = new URLSearchParams({
      deleted: req.params.id,
      meetings: String(counts.meeting || 0),
      facts: String(counts.facts || 0),
      tasks: String(counts.tasks || 0),
      docs: String(counts.documents || 0),
    });
    res.redirect(`/crm/meeting-intake?${params.toString()}`);
  } catch (err) {
    console.error('[meeting-intake delete]', err);
    res.status(500).send(`Delete failed: ${err.message}`);
  }
});

router.get('/crm/meeting/:id', requireAuth, (req, res) => {
  const hub = db.hub();
  const meeting = hub.prepare(`
    SELECT m.*, co.name AS company_name
    FROM meetings m LEFT JOIN companies co ON co.id = m.company_id
    WHERE m.id = ? AND m.user = ?
  `).get(req.params.id, req.hubUser);
  if (!meeting) return res.status(404).send('Meeting not found');
  const attendees = hub.prepare(`
    SELECT c.* FROM meeting_attendees ma JOIN contacts c ON c.id = ma.contact_id
    WHERE ma.meeting_id = ? ORDER BY c.name
  `).all(meeting.id);
  const facts = hub.prepare(`
    SELECT f.*, c.name AS subject_name
    FROM crm_facts f JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.meeting_id = ?
    ORDER BY f.created_at DESC
  `).all(req.hubUser, meeting.id);
  const contactMap = new Map(hub.prepare('SELECT id, name FROM contacts WHERE user = ?').all(req.hubUser).map(c => [c.id, c]));
  const touchedIds = new Set(attendees.map(c => c.id));
  for (const fact of facts) {
    touchedIds.add(fact.contact_id);
    for (const id of parseJsonArray(fact.linked_contacts)) touchedIds.add(id);
  }
  const touchedContacts = [...touchedIds].map(id => contactMap.get(id)).filter(Boolean);
  const contacts = [...contactMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  res.render('hub/crm-meeting', {
    ...crmPageData(req.hubUser), meeting, attendees, facts, touchedContacts, contacts, companies,
  });
});

router.post('/crm/meeting/:id/fact', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const meeting = hub.prepare('SELECT * FROM meetings WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.body.contact_id, req.hubUser);
  const fact = String(req.body.fact || '').trim();
  const factType = ['fact', 'decision', 'action', 'note'].includes(req.body.fact_type) ? req.body.fact_type : 'fact';
  if (!meeting || !contact || !fact) return res.status(400).send('Meeting, subject, and text required');
  const validContactIds = new Set(
    hub.prepare('SELECT id FROM contacts WHERE user = ?').all(req.hubUser).map(row => row.id)
  );
  const linked = asArray(req.body.linked_contacts)
    .filter(id => id !== contact.id && validContactIds.has(id));
  hub.prepare(`
    INSERT INTO crm_facts
      (id, user, contact_id, fact, status, source, meeting_id, company_id, linked_contacts, fact_type)
    VALUES (?, ?, ?, ?, 'active', 'meeting', ?, ?, ?, ?)
  `).run(uuid(), req.hubUser, contact.id, fact, meeting.id, meeting.company_id, JSON.stringify(linked), factType);
  res.redirect(`/crm/meeting/${meeting.id}`);
});

router.post('/crm/meeting/:id', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const meeting = hub.prepare('SELECT id FROM meetings WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!meeting) return res.status(404).send('Meeting not found');
  const title = String(req.body.title || '').trim();
  const meetingDate = String(req.body.meeting_date || '').trim();
  if (!title || !meetingDate) return res.status(400).send('Title and date required');
  const company = req.body.company_id
    ? hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.body.company_id, req.hubUser)
    : null;
  hub.transaction(() => {
    hub.prepare(`
      UPDATE meetings SET title = ?, meeting_date = ?, meeting_time = ?, duration_mins = ?,
        location = ?, notes = ?, company_id = ?
      WHERE id = ? AND user = ?
    `).run(
      title, meetingDate,
      String(req.body.meeting_time || '').trim() || null, Number(req.body.duration_mins) || null,
      String(req.body.location || '').trim() || null, String(req.body.notes || '').trim() || null,
      company?.id || null, meeting.id, req.hubUser
    );
    hub.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meeting.id);
    const insert = hub.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, contact_id) VALUES (?, ?)');
    const validIds = new Set(hub.prepare('SELECT id FROM contacts WHERE user = ?').all(req.hubUser).map(row => row.id));
    for (const contactId of asArray(req.body.attendee_ids)) {
      if (validIds.has(contactId)) insert.run(meeting.id, contactId);
    }
  })();
  res.redirect(`/crm/meeting/${meeting.id}`);
});

router.post('/crm/meeting/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const meeting = hub.prepare('SELECT id FROM meetings WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!meeting) return res.status(404).send('Meeting not found');
  hub.transaction(() => {
    hub.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meeting.id);
    hub.prepare('UPDATE crm_facts SET meeting_id = NULL WHERE meeting_id = ? AND user = ?').run(meeting.id, req.hubUser);
    hub.prepare('DELETE FROM meetings WHERE id = ?').run(meeting.id);
  })();
  res.redirect('/crm/meetings');
});

router.post('/crm/facts/:id/complete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare(`
    UPDATE crm_facts SET status = 'done', updated_at = unixepoch()
    WHERE id = ? AND user = ?
  `).run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).send('Fact not found');
  res.redirect(safeBack(req, '/crm/contacts'));
});

router.post('/api/crm/contacts/:id/projects', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const project = hub.prepare('SELECT id FROM projects WHERE id = ? AND user = ?').get(req.body.project_id, req.hubUser);
  if (!contact || !project) return res.status(404).json({ error: 'Not found' });
  hub.prepare(`
    INSERT OR IGNORE INTO contact_projects (contact_id, project_id, role) VALUES (?, ?, ?)
  `).run(contact.id, project.id, String(req.body.role || '').trim() || null);
  syncContactVaultProfile(req.hubUser, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/projects/unlink', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  hub.prepare('DELETE FROM contact_projects WHERE contact_id = ? AND project_id = ?')
    .run(req.params.id, req.body.project_id);
  syncContactVaultProfile(req.hubUser, req.params.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/companies', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.body.company_id, req.hubUser);
  if (!contact || !company) return res.status(404).json({ error: 'Not found' });
  const hasPrimary = hub.prepare(
    'SELECT 1 FROM contact_companies WHERE contact_id = ? AND is_primary = 1'
  ).get(contact.id);
  const makePrimary = Boolean(req.body.is_primary) || !hasPrimary;
  if (makePrimary) {
    hub.prepare('UPDATE contact_companies SET is_primary = 0 WHERE contact_id = ?').run(contact.id);
  }
  hub.prepare(`
    INSERT INTO contact_companies (contact_id, company_id, role, is_primary)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(contact_id, company_id) DO UPDATE SET
      role = excluded.role,
      is_primary = excluded.is_primary
  `).run(contact.id, company.id, String(req.body.role || '').trim() || null, makePrimary ? 1 : 0);
  syncContactVaultProfile(req.hubUser, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/companies/unlink', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const linked = hub.prepare(`
    SELECT is_primary FROM contact_companies WHERE contact_id = ? AND company_id = ?
  `).get(contact.id, req.body.company_id);
  if (!linked) return res.status(404).json({ error: 'Company link not found' });
  hub.prepare('DELETE FROM contact_companies WHERE contact_id = ? AND company_id = ?')
    .run(contact.id, req.body.company_id);
  if (linked.is_primary) promoteFirstLinkedCompany(hub, contact.id);
  syncContactVaultProfile(req.hubUser, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/companies/role', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const role = String(req.body.role || '').trim() || null;
  const result = hub.prepare(`
    UPDATE contact_companies SET role = ? WHERE contact_id = ? AND company_id = ?
  `).run(role, contact.id, req.body.company_id);
  if (!result.changes) return res.status(404).json({ error: 'Company link not found' });
  syncContactVaultProfile(req.hubUser, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/companies/primary', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.body.company_id, req.hubUser);
  if (!contact || !company) return res.status(404).json({ error: 'Not found' });
  const linked = hub.prepare(`
    SELECT 1 FROM contact_companies WHERE contact_id = ? AND company_id = ?
  `).get(contact.id, company.id);
  if (!linked) return res.status(404).json({ error: 'Company link not found' });
  setPrimaryCompany(hub, contact.id, company.id);
  syncContactVaultProfile(req.hubUser, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/companies/:id/projects', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const project = hub.prepare('SELECT id FROM projects WHERE id = ? AND user = ?').get(req.body.project_id, req.hubUser);
  if (!company || !project) return res.status(404).json({ error: 'Not found' });
  hub.prepare(`
    INSERT OR IGNORE INTO company_projects (company_id, project_id, role) VALUES (?, ?, ?)
  `).run(company.id, project.id, String(req.body.role || '').trim() || null);
  res.json({ ok: true });
});

router.post('/api/crm/companies/:id/projects/unlink', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  hub.prepare('DELETE FROM company_projects WHERE company_id = ? AND project_id = ?')
    .run(req.params.id, req.body.project_id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/edit', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const aliases = String(req.body.aliases || '').split(',').map(a => a.trim()).filter(Boolean);
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const birthday = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.birthday || '')) ? req.body.birthday : null;
  const keepWarm = [30, 60, 90].includes(parseInt(req.body.keep_warm_days, 10)) ? parseInt(req.body.keep_warm_days, 10) : null;
  const phone = String(req.body.phone || '').trim() || null;
  hub.prepare('UPDATE contacts SET name = ?, email = ?, phone = ?, aliases = ?, birthday = ?, keep_warm_days = ? WHERE id = ?')
    .run(name, email, phone, JSON.stringify(aliases), birthday, keepWarm, contact.id);
  const profileSync = syncContactVaultProfile(req.hubUser, contact.id);
  res.json({
    ok: true,
    profileSynced: profileSync.synced,
    profileWarning: profileSync.synced ? null : profileSync.reason,
  });
});

// Manual touchpoint (call, message, chance meeting) — stored as a crm_fact so
// the nightly last_contacted_at recompute (lib/crm-nudges.js) counts it; the
// column is also bumped immediately so the UI reflects it without waiting.
router.post('/api/crm/contacts/:id/touchpoint', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id, name FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || '')) ? req.body.date : null;
  if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  const ts = Math.floor(Date.parse(date + 'T12:00:00Z') / 1000);
  if (ts > Math.floor(Date.now() / 1000) + 86400) return res.status(400).json({ error: 'date is in the future' });
  const note = String(req.body.note || '').trim();
  const fact = note ? `Touchpoint (${date}): ${note}` : `Touchpoint: spoke on ${date}`;
  hub.prepare(`
    INSERT INTO crm_facts (id, user, contact_id, fact, status, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', 'manual', ?, ?)
  `).run(uuid(), req.hubUser, contact.id, fact, ts, ts);
  hub.prepare('UPDATE contacts SET last_contacted_at = MAX(COALESCE(last_contacted_at, 0), ?) WHERE id = ?').run(ts, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  hub.transaction(() => {
    hub.prepare('DELETE FROM contact_companies WHERE contact_id = ?').run(contact.id);
    hub.prepare('DELETE FROM contact_projects WHERE contact_id = ?').run(contact.id);
    hub.prepare('DELETE FROM meeting_attendees WHERE contact_id = ?').run(contact.id);
    hub.prepare('DELETE FROM crm_facts WHERE contact_id = ? AND user = ?').run(contact.id, req.hubUser);
    const linkedFacts = hub.prepare(
      "SELECT id, linked_contacts FROM crm_facts WHERE user = ? AND linked_contacts LIKE ?"
    ).all(req.hubUser, `%"${contact.id}"%`);
    const updateLinks = hub.prepare('UPDATE crm_facts SET linked_contacts = ? WHERE id = ?');
    for (const fact of linkedFacts) {
      updateLinks.run(JSON.stringify(parseJsonArray(fact.linked_contacts).filter(id => id !== contact.id)), fact.id);
    }
    hub.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);
  })();
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/archive', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare(
    "UPDATE crm_facts SET status = 'archived', updated_at = unixepoch() WHERE id = ? AND user = ?"
  ).run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/unarchive', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare(
    "UPDATE crm_facts SET status = 'active', updated_at = unixepoch() WHERE id = ? AND user = ?"
  ).run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/wrong', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare(
    "UPDATE crm_facts SET status = 'wrong', updated_at = unixepoch() WHERE id = ? AND user = ?"
  ).run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/unwrong', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare(
    "UPDATE crm_facts SET status = 'active', updated_at = unixepoch() WHERE id = ? AND user = ?"
  ).run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/edit', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const factText = String(req.body.fact || '').trim();
  if (!factText) return res.status(400).json({ error: 'Fact text is required' });
  if (factText.length > 4000) return res.status(400).json({ error: 'Fact text is too long' });

  const hub = db.hub();
  const existing = hub.prepare(`
    SELECT f.id, f.fact, f.status, f.due_date, c.name AS contact_name
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.id = ? AND f.user = ?
  `).get(req.params.id, req.hubUser);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  if (existing.status === 'follow_up' && 'due_date' in req.body) {
    const dueDate = String(req.body.due_date || '').trim();
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return res.status(400).json({ error: 'due_date must be YYYY-MM-DD' });
    }
    hub.prepare('UPDATE crm_facts SET due_date = ?, updated_at = unixepoch() WHERE id = ? AND user = ?')
       .run(dueDate || null, existing.id, req.hubUser);
  }

  if (existing.fact === factText) return res.json({ ok: true, projectionSynced: true });

  hub.prepare(
    'UPDATE crm_facts SET fact = ?, updated_at = unixepoch() WHERE id = ? AND user = ?'
  ).run(factText, existing.id, req.hubUser);

  try {
    const projection = syncContactVaultFact({
      user: req.hubUser,
      factId: existing.id,
      contactName: existing.contact_name,
      oldFact: existing.fact,
      newFact: factText,
    });
    res.json({ ok: true, projectionSynced: projection.synced, projectionWarning: projection.reason || null });
  } catch (err) {
    console.warn(`[crm] People note sync failed for fact ${existing.id}:`, err.message);
    res.json({ ok: true, projectionSynced: false, projectionWarning: err.message });
  }
});

router.post('/api/crm/facts/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare('DELETE FROM crm_facts WHERE id = ? AND user = ?').run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

// ── Mobile app JSON APIs ─────────────────────────────────────────────────────
// Read endpoints for the native iOS CRM and Tasks apps (bearer auth via
// mobileBearerBridge). Writes reuse the existing /api/tasks and /api/crm
// endpoints, which accept the same token.
router.get('/api/mobile/tasks', requireAuth, async (req, res) => {
  let syncError = null;
  try {
    await syncTasks(req.hubUser);
  } catch (err) {
    syncError = err.message;
  }
  const tasks = getCachedTasks(req.hubUser, {}, req.query.show_history === '1');
  res.json({ tasks, syncError });
});

router.get('/api/mobile/crm', requireAuth, (req, res) => {
  const hub = db.hub();
  const contacts = hub.prepare(`
    SELECT c.id, c.name, co.name AS company_name
    FROM contacts c
    LEFT JOIN contact_companies cc ON cc.contact_id = c.id AND cc.is_primary = 1
    LEFT JOIN companies co ON co.id = cc.company_id
    WHERE c.user = ? ORDER BY c.name
  `).all(req.hubUser);
  const companies = hub.prepare(`
    SELECT co.id, co.name,
           (SELECT COUNT(*) FROM contact_companies cc WHERE cc.company_id = co.id) AS contact_count
    FROM companies co WHERE co.user = ? ORDER BY co.name
  `).all(req.hubUser);
  const projects = hub.prepare(
    'SELECT id, slug, name FROM projects WHERE user = ? ORDER BY name'
  ).all(req.hubUser);
  res.json({ contacts, companies, projects });
});

router.get('/api/mobile/crm/contact/:id', requireAuth, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT * FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const companies = hub.prepare(`
    SELECT co.id, co.name, cc.role, cc.is_primary
    FROM contact_companies cc
    JOIN companies co ON co.id = cc.company_id
    WHERE cc.contact_id = ?
    ORDER BY cc.is_primary DESC, co.name
  `).all(contact.id);
  const meetings = hub.prepare(`
    SELECT m.id, m.title, m.meeting_date, m.meeting_time, co.name AS company_name
    FROM meeting_attendees ma
    JOIN meetings m ON m.id = ma.meeting_id
    LEFT JOIN companies co ON co.id = m.company_id
    WHERE ma.contact_id = ? AND m.user = ?
    ORDER BY m.meeting_date DESC, m.meeting_time DESC
    LIMIT 30
  `).all(contact.id, req.hubUser);
  const tasks = getCachedTasks(req.hubUser, { contactId: contact.id }, false);
  const { knowledgeByPredicate } = knowledgeGroupsForEntity(req.hubUser, 'contact', contact.id, {});
  res.json({ contact, companies, meetings, tasks, knowledge: knowledgeByPredicate });
});

router.get('/api/mobile/crm/company/:id', requireAuth, (req, res) => {
  const hub = db.hub();
  const company = hub.prepare('SELECT * FROM companies WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!company) return res.status(404).json({ error: 'Not found' });
  const contacts = hub.prepare(`
    SELECT c.id, c.name, cc.role, cc.is_primary
    FROM contact_companies cc
    JOIN contacts c ON c.id = cc.contact_id
    WHERE cc.company_id = ?
    ORDER BY cc.is_primary DESC, c.name
  `).all(company.id);
  const tasks = getCachedTasks(req.hubUser, { companyId: company.id }, false);
  const { knowledgeByPredicate } = knowledgeGroupsForEntity(req.hubUser, 'company', company.id, {});
  res.json({ company, contacts, tasks, knowledge: knowledgeByPredicate });
});

router.get('/api/mobile/crm/project/:slug', requireAuth, (req, res) => {
  const hub = db.hub();
  const project = hub.prepare('SELECT * FROM projects WHERE user = ? AND slug = ?').get(req.hubUser, req.params.slug);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const tasks = getCachedTasks(req.hubUser, { projectSlug: project.slug }, false);
  const contacts = hub.prepare(`
    SELECT c.id, c.name, cp.role AS project_role
    FROM contact_projects cp
    JOIN contacts c ON c.id = cp.contact_id
    WHERE cp.project_id = ? ORDER BY c.name
  `).all(project.id);
  const companies = hub.prepare(`
    SELECT co.id, co.name, cp.role AS project_role
    FROM company_projects cp
    JOIN companies co ON co.id = cp.company_id
    WHERE cp.project_id = ? ORDER BY co.name
  `).all(project.id);
  const { knowledgeByPredicate } = knowledgeGroupsForEntity(req.hubUser, 'project', project.id, { includeEvents: true });
  res.json({ project, tasks, contacts, companies, knowledge: knowledgeByPredicate });
});

router.get('/crm/tasks', requireAuth, async (req, res) => {
  const showHistory = req.query.show_history === '1';
  let syncError = null;
  try {
    await syncTasks(req.hubUser);
  } catch (err) {
    console.warn('[tasks] sync on page load failed:', err.message);
    syncError = err.message;
  }
  const tasks = getCachedTasks(req.hubUser, {}, showHistory);
  const hub = db.hub();
  const contacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  const projects = hub.prepare('SELECT id, slug, name FROM projects WHERE user = ? ORDER BY name').all(req.hubUser);
  res.render('hub/crm-tasks', { ...crmPageData(req.hubUser), tasks, showHistory, contacts, companies, projects, syncError });
});

// The answer side of the quality boards. Every question here was raised by a
// nightly check; before this page existed there was nowhere to answer one, so
// the same question was re-asked every night and the daily brief could only
// link at the transcript it came from.
router.get('/crm/questions', requireAuth, (req, res) => {
  const { groupedClarifications, answeredRows } = require('../lib/crm-clarifications');
  const { isPlaceholderPersonName } = require('../lib/meeting-intake');
  const contacts = db.hub().prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name')
    .all(req.hubUser)
    .filter(contact => !isPlaceholderPersonName(contact.name));
  const showAll = req.query.all === '1';
  res.render('hub/crm-questions', {
    ...crmPageData(req.hubUser),
    groups: groupedClarifications(req.hubUser, { limit: showAll ? 0 : 15 }),
    showAll,
    answered: answeredRows(req.hubUser),
    contacts,
    saved: String(req.query.saved || '').slice(0, 300),
    error: String(req.query.error || '').slice(0, 300),
    restoreKey: String(req.query.restore || '').slice(0, 64),
  });
});

function questionsRedirect(res, { saved, error, key, restore }) {
  const params = new URLSearchParams();
  if (saved) params.set('saved', saved);
  if (error) params.set('error', error);
  if (restore) params.set('restore', restore);
  const anchor = key && error ? `#q-${key}` : '';
  res.redirect(`/crm/questions?${params.toString()}${anchor}`);
}

router.post('/crm/questions/answer', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const key = String(req.body.key || '').trim();
  const answer = String(req.body.answer || '').trim();
  const question = String(req.body.question || '').trim();
  if (!key || !answer || !question) {
    return questionsRedirect(res, { error: 'An answer is required.', key });
  }
  try {
    const { answerMeetingQuestion } = require('../lib/crm-clarifications');
    const { statement, discarded } = await answerMeetingQuestion(req.hubUser, {
      key,
      intakeId: String(req.body.intake_id || '').trim() || null,
      question,
      answer,
      projectSlug: String(req.body.project_slug || '').trim() || null,
      meetingTitle: String(req.body.meeting_title || '').trim() || null,
    });
    questionsRedirect(res, discarded
      ? { saved: 'Read as a discard, so nothing was written to knowledge.', restore: key }
      : { saved: `Now in the knowledge layer: ${statement}` });
  } catch (err) {
    console.error('[crm questions answer]', err);
    questionsRedirect(res, { error: err.message, key });
  }
});

router.post('/crm/questions/owner', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const key = String(req.body.key || '').trim();
  try {
    const { answerTaskOwner } = require('../lib/crm-clarifications');
    const { contact } = await answerTaskOwner(req.hubUser, {
      key,
      intakeId: String(req.body.intake_id || '').trim() || null,
      question: String(req.body.question || '').trim(),
      task: String(req.body.task || '').trim(),
      spokenOwner: String(req.body.spoken_owner || '').trim(),
      contactId: String(req.body.contact_id || '').trim() || null,
      newContactName: String(req.body.new_contact_name || '').trim() || null,
      meetingTitle: String(req.body.meeting_title || '').trim() || null,
    });
    questionsRedirect(res, { saved: `${contact.name} now owns that action.` });
  } catch (err) {
    console.error('[crm questions owner]', err);
    questionsRedirect(res, { error: err.message, key });
  }
});

router.post('/crm/questions/alias', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const key = String(req.body.key || '').trim();
  try {
    const { answerPersonAlias } = require('../lib/crm-clarifications');
    const [removeFromContactId, removeAlias] = String(req.body.remove || '').split('::');
    const result = answerPersonAlias(req.hubUser, {
      key,
      question: String(req.body.question || '').trim(),
      decision: req.body.decision === 'same_person' ? 'same_person' : 'different_people',
      contactIds: String(req.body.contact_ids || '').split(',').map(id => id.trim()).filter(Boolean),
      contactNames: String(req.body.contact_names || '').split('|').map(name => name.trim()).filter(Boolean),
      removeAlias: removeAlias || null,
      removeFromContactId: removeFromContactId || null,
    });
    const removed = result.removed ? ` Removed alias "${result.removed.alias}" from ${result.removed.contact_name}.` : '';
    questionsRedirect(res, {
      saved: `${result.same ? 'Recorded as the same person — merge the records by hand.' : 'Recorded as different people.'}${removed}`,
    });
  } catch (err) {
    console.error('[crm questions alias]', err);
    questionsRedirect(res, { error: err.message, key });
  }
});

router.post('/crm/questions/discard', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const key = String(req.body.key || '').trim();
  try {
    const { discardClarification } = require('../lib/crm-clarifications');
    discardClarification(req.hubUser, {
      key,
      kind: String(req.body.kind || '').trim() || null,
      question: String(req.body.question || '').trim(),
      sourceKind: String(req.body.source_kind || '').trim() || null,
      sourceId: String(req.body.source_id || '').trim() || null,
    });
    questionsRedirect(res, { saved: 'Discarded. It won\'t be raised again.', restore: key });
  } catch (err) {
    console.error('[crm questions discard]', err);
    questionsRedirect(res, { error: err.message, key });
  }
});

router.post('/crm/questions/restore', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const key = String(req.body.key || '').trim();
  try {
    const { restoreClarification } = require('../lib/crm-clarifications');
    const restored = restoreClarification(req.hubUser, key);
    questionsRedirect(res, restored
      ? { saved: 'Back in the queue.' }
      : { error: 'That one was answered, not discarded — nothing to restore.' });
  } catch (err) {
    console.error('[crm questions restore]', err);
    questionsRedirect(res, { error: err.message });
  }
});

router.get('/crm/suggestions', requireAuth, (req, res) => {
  const { listSuggestions } = require('../lib/suggestion-engine');
  const suggestions = listSuggestions(req.hubUser).map(suggestion => {
    let evidence = null;
    try { evidence = JSON.parse(suggestion.evidence || 'null'); } catch (_) {
      evidence = suggestion.evidence || null;
    }
    return { ...suggestion, evidenceParsed: evidence };
  });
  const counts = suggestions.reduce((result, suggestion) => {
    result.all++;
    result[suggestion.status] = (result[suggestion.status] || 0) + 1;
    return result;
  }, { all: 0 });
  res.render('hub/crm-suggestions', {
    ...crmPageData(req.hubUser), suggestions, counts,
  });
});

router.post('/api/suggestions/:id/wrong', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const { learnFromWrongSuggestion } = require('../lib/suggestion-learning');
    const learned = await learnFromWrongSuggestion(
      req.hubUser,
      req.params.id,
      String(req.body?.reason || '').trim(),
    );
    res.json({
      ok: true,
      lesson: learned.lesson.rule,
      evidenceCount: learned.lesson.evidence_count,
      usedFallback: learned.usedFallback,
    });
  } catch (err) {
    console.error('[suggestions] wrong-learning error:', err);
    const status = err.message === 'Suggestion not found' ? 404
      : err.message.startsWith('Please explain') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/api/suggestions/:id/accept', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const { acceptSuggestionById } = require('../lib/suggestion-engine');
    const result = await acceptSuggestionById(req.hubUser, req.params.id);
    res.status(result.ok ? 200 : (result.notFound ? 404 : 502)).json(result);
  } catch (err) {
    console.error('[suggestions] accept error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/suggestions/:id/dismiss', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  try {
    const { dismissSuggestionById } = require('../lib/suggestion-engine');
    const result = dismissSuggestionById(req.hubUser, req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    console.error('[suggestions] dismiss error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/suggestions/:id/not-this-time', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  try {
    const { notThisTimeSuggestionById } = require('../lib/suggestion-engine');
    const result = notThisTimeSuggestionById(req.hubUser, req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    console.error('[suggestions] not-this-time error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/suggestions/contact-reasons/run', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const { runContactSuggester } = require('../lib/suggestion-engine');
    const suggestions = await runContactSuggester(req.hubUser);
    res.json({ ok: true, created: suggestions.length });
  } catch (err) {
    console.error('[suggestions] contact reason run error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/tasks', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  const requestedProject = String(req.body.project_slug || '').trim();
  if (requestedProject) {
    const hub = db.hub();
    const project = hub.prepare('SELECT id FROM projects WHERE user = ? AND slug = ?').get(req.hubUser, requestedProject);
    if (!project) return res.status(400).json({ error: 'Project not found' });
    if (isProjectClosed(hub, req.hubUser, project.id)) return res.status(400).json({ error: 'Reopen the project before adding tasks' });
  }
  try {
    const { withTaskTags } = require('../lib/google-tasks');
    const baseNotes = String(req.body.notes || '').trim();
    const notes = withTaskTags(baseNotes, {
      priority: req.body.priority,
      effortMinutes: req.body.effort_minutes,
    });
    const task = await createTask(req.hubUser, {
      title,
      notes: notes || null,
      due: req.body.due || null,
      source: 'manual',
      contactId: req.body.contact_id || null,
      companyId: req.body.company_id || null,
      projectSlug: requestedProject || null,
    });
    res.json({ ok: true, task });
  } catch (err) {
    console.error('[tasks] create error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/complete', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const hub = db.hub();
  const row = hub.prepare('SELECT * FROM google_tasks WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    await completeTask(req.hubUser, row.google_task_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[tasks] complete error', err);
    // Fall back to local-only complete if Google API fails
    hub.prepare(`
      UPDATE google_tasks
         SET status = 'completed', completed_at = COALESCE(completed_at, unixepoch())
       WHERE id = ?
    `).run(row.id);
    res.json({ ok: true, localOnly: true });
  }
});

router.post('/api/tasks/:id/delete', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const ok = await deleteTask(req.hubUser, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[tasks] delete error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/wrong', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const { learnFromWrongTask } = require('../lib/task-learning');
    const learned = await learnFromWrongTask(
      req.hubUser,
      req.params.id,
      String(req.body?.reason || '').trim(),
    );
    const deleted = await deleteTaskEverywhere(req.hubUser, req.params.id, { status: 'wrong' });
    res.json({
      ok: true,
      lesson: learned.lesson.rule,
      evidenceCount: learned.lesson.evidence_count,
      usedFallback: learned.usedFallback,
      remoteDeleted: deleted.remoteDeleted,
      remoteWarning: deleted.remoteError,
    });
  } catch (err) {
    console.error('[tasks] wrong-learning error:', err);
    res.status(err.message === 'Task not found' ? 404 : 500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/restore', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const ok = await restoreTask(req.hubUser, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[tasks] restore error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/crm/tasks/:id', requireAuth, async (req, res) => {
  // Sync from Google first so the page always shows fresh data (due dates, etc.)
  try { await syncTasks(req.hubUser); } catch (err) {
    console.warn('[tasks] sync on detail load failed:', err.message);
  }
  const task = getTask(req.hubUser, req.params.id);
  if (!task) return res.status(404).send('Task not found');
  const hub = db.hub();
  const contacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  const projects = hub.prepare('SELECT id, slug, name FROM projects WHERE user = ? ORDER BY name').all(req.hubUser);

  // Origin + active escalations: the meeting id is parsed from source_id
  // ("meeting:<id>:…") rather than stored twice, and reminders join back via
  // kind='task'/target_id — both derive from existing data, no columns.
  const { parseTaskTags } = require('../lib/google-tasks');
  const taskTags = parseTaskTags(task.notes);
  let originMeeting = null;
  const meetingMatch = String(task.source_id || '').match(/^meeting:([^:]+):/);
  if (meetingMatch) {
    originMeeting = hub.prepare('SELECT id, title, meeting_date FROM meetings WHERE id = ? AND user = ?')
      .get(meetingMatch[1], req.hubUser);
  }
  const relatedReminders = hub.prepare(`
    SELECT id, short_code, title, status, next_fire_at, escalation_level, recur
    FROM reminders WHERE user = ? AND kind = 'task' AND target_id = ?
    ORDER BY status IN ('done','cancelled'), next_fire_at
  `).all(req.hubUser, task.id);

  res.render('hub/crm-task', { ...crmPageData(req.hubUser), task, contacts, companies, projects, originMeeting, relatedReminders, taskTags });
});

router.post('/api/tasks/sync', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const items = await syncTasks(req.hubUser);
    res.json({ ok: true, count: items.length });
  } catch (err) {
    console.error('[tasks] manual sync error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/update', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const {
    title, notes, due, deadline,
    contact_id: contactId, company_id: companyId, project_slug: projectSlug,
  } = req.body;
  let finalNotes = notes;
  if (notes !== undefined && (req.body.priority !== undefined || req.body.effort_minutes !== undefined)) {
    const { withTaskTags } = require('../lib/google-tasks');
    finalNotes = withTaskTags(String(notes), {
      priority: req.body.priority,
      effortMinutes: req.body.effort_minutes,
    });
  }
  try {
    await updateTask(req.hubUser, req.params.id, {
      ...(title !== undefined && { title: String(title).trim() }),
      ...(notes !== undefined && { notes: String(finalNotes).trim() }),
      ...(due !== undefined && { due: due || null }),
      ...(deadline !== undefined && { deadline: deadline || null }),
      ...(contactId !== undefined && { contactId: contactId || null }),
      ...(companyId !== undefined && { companyId: companyId || null }),
      ...(projectSlug !== undefined && { projectSlug: projectSlug || null }),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[tasks] update error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/subtasks', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const sub = await createSubtask(req.hubUser, req.params.id, title);
    res.json({ ok: true, subtask: sub });
  } catch (err) {
    console.error('[tasks] subtask create error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Reminders ─────────────────────────────────────────────────────────────────

router.get('/crm/reminders', requireAuth, (req, res) => {
  const { listOpenReminders } = require('../lib/reminders');
  const hub = db.hub();
  const open = listOpenReminders(req.hubUser);
  // Task-kind reminders link back to the task that spawned them (target_id →
  // google_tasks), and through the task's source_id to the origin meeting.
  const taskIds = [...new Set(open.filter(r => r.kind === 'task' && r.target_id).map(r => r.target_id))];
  const taskById = taskIds.length ? new Map(hub.prepare(`
    SELECT t.id, t.title, t.source_id, m.id AS meeting_id, m.title AS meeting_title
    FROM google_tasks t
    LEFT JOIN meetings m ON m.user = t.user AND t.source_id LIKE 'meeting:' || m.id || ':%'
    WHERE t.id IN (${taskIds.map(() => '?').join(',')})
  `).all(...taskIds).map(t => [t.id, t])) : new Map();
  for (const r of open) {
    if (r.kind === 'task' && r.target_id) r.task = taskById.get(r.target_id) || null;
  }
  const todayKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const dueDay = (r) => new Date(((r.next_fire_at || r.remind_at || 0) * 1000))
    .toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const stillNeedsAction = (r) => {
    if (r.kind !== 'content') return true;
    try {
      const { evaluateCheck } = require('../lib/content-reminders');
      return Boolean(evaluateCheck(r).message);
    } catch (_) {
      return true;
    }
  };
  const today = open.filter(r => dueDay(r) <= todayKey && stillNeedsAction(r));
  const todayIds = new Set(today.map(r => r.id));
  const general = open.filter(r => !todayIds.has(r.id));
  const resolved = hub.prepare(`
    SELECT * FROM reminders
    WHERE user = ? AND status IN ('done','cancelled') AND updated_at > unixepoch() - 7 * 86400
    ORDER BY updated_at DESC LIMIT 20
  `).all(req.hubUser);
  res.render('hub/crm-reminders', { ...crmPageData(req.hubUser), open, today, general, resolved });
});

router.post('/api/reminders', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  const { createReminder, dublinIsoToEpoch, epochAtNextDublin } = require('../lib/reminders');
  let remindAt = dublinIsoToEpoch(String(req.body.remind_at || '').trim());
  if (!remindAt || remindAt < Math.floor(Date.now() / 1000) - 60) remindAt = epochAtNextDublin(9, 0);
  // recur: 'daily:HH:MM' or 'weekly:mon..sun:HH:MM' — validated here, consumed
  // by nextRecurOccurrence in lib/reminders.js
  const recurRaw = String(req.body.recur || '').trim().toLowerCase();
  const recur = /^(daily:\d{2}:\d{2}|weekly:(mon|tue|wed|thu|fri|sat|sun):\d{2}:\d{2})$/.test(recurRaw) ? recurRaw : null;
  const reminder = createReminder(req.hubUser, {
    kind: req.body.kind === 'task' ? 'task' : 'adhoc',
    targetId: req.body.target_id || null,
    title,
    remindAt,
    source: 'hub-ui',
    recur,
  });
  if (!reminder) return res.status(500).json({ error: 'Could not create reminder' });
  res.json({ ok: true, reminder });
});

router.post('/api/reminders/:id/:action(done|snooze|cancel|ack)', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const reminders = require('../lib/reminders');
  const row = db.hub().prepare('SELECT * FROM reminders WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (['done', 'cancelled'].includes(row.status)) return res.status(400).json({ error: 'Already resolved' });
  let result;
  if (req.params.action === 'done') result = await reminders.doneReminder(req.hubUser, row.short_code);
  else if (req.params.action === 'snooze') result = reminders.snoozeReminder(req.hubUser, row.short_code, String(req.body.duration || ''));
  else if (req.params.action === 'cancel') result = reminders.cancelReminder(req.hubUser, row.short_code);
  else result = reminders.ackReminder(req.hubUser, row.short_code);
  res.json(result);
});

// ── Project Report ───────────────────────────────────────────────────────────

function parseModelJson(raw, defaults) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return defaults;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return { ...defaults, ...parsed };
  } catch (_) {
    return defaults;
  }
}

function sourceLabel(kind) {
  return ({
    document: 'doc',
    email_summary: 'email',
    meeting_intake: 'meeting',
    crm_fact: 'fact',
    completed_task: 'task',
    messaging_message: 'message',
  })[kind] || kind;
}

function parseSourceRefs(json) {
  try {
    const refs = JSON.parse(json || '[]');
    return Array.isArray(refs) ? refs.filter(r => r && r.kind && r.id) : [];
  } catch (_) {
    return [];
  }
}

function knowledgeGroupsForEntity(user, subjectKind, subjectId, { includeEvents = false, includeStale = false } = {}) {
  const { atomsForEntity } = require('../lib/atoms');
  const hub = db.hub();
  const knowledgeByPredicate = {};
  const events = [];
  for (const a of atomsForEntity(user, subjectKind, subjectId, { includeProposed: true, includeStale })) {
    const sources = parseSourceRefs(a.source_refs);
    const view = {
      id: a.id,
      predicate: a.predicate,
      value: a.value,
      confidence: a.confidence,
      status: a.status,
      sources,
    };
    (knowledgeByPredicate[a.predicate] ||= []).push(view);
    if (includeEvents && a.status === 'active') {
      events.push({
        _kind: 'knowledge_event',
        ts: sourceEventTimestamp(hub, user, sources) || a.updated_at || a.first_seen,
        predicate: a.predicate,
        value: a.value,
        confidence: a.confidence,
        sources,
      });
    }
  }
  return { knowledgeByPredicate, events };
}

function sourceEventTimestamp(hub, user, sources) {
  for (const s of sources || []) {
    if (s.kind === 'completed_task') {
      const row = hub.prepare('SELECT completed_at, synced_at, created_at FROM google_tasks WHERE id = ? AND user = ?').get(s.id, user);
      if (row) return row.completed_at || row.synced_at || row.created_at;
    }
    if (s.kind === 'email_summary') {
      const row = hub.prepare('SELECT received_at, processed_at FROM email_summaries WHERE id = ? AND user = ?').get(s.id, user);
      if (row) return row.received_at || row.processed_at;
    }
    if (s.kind === 'meeting_intake') {
      const row = hub.prepare('SELECT created_at FROM meeting_intakes WHERE id = ? AND user = ?').get(s.id, user);
      if (row) return row.created_at;
    }
    if (s.kind === 'document') {
      const row = hub.prepare('SELECT uploaded_at FROM documents WHERE id = ? AND user = ?').get(s.id, user);
      if (row) return row.uploaded_at;
    }
    if (s.kind === 'crm_fact') {
      const row = hub.prepare('SELECT created_at FROM crm_facts WHERE id = ? AND user = ?').get(s.id, user);
      if (row) return row.created_at;
    }
    if (s.kind === 'messaging_message') {
      const row = hub.prepare('SELECT received_at FROM messaging_messages WHERE id = ? AND user = ?').get(s.id, user);
      if (row) return row.received_at;
    }
  }
  return null;
}

function atomRowsForProject(user, projectId) {
  const { atomsForEntity } = require('../lib/atoms');
  return atomsForEntity(user, 'project', projectId, { includeProposed: true }).map(a => {
    const refs = parseSourceRefs(a.source_refs);
    return {
      predicate: a.predicate,
      value: a.value,
      confidence: a.confidence,
      status: a.status,
      sources: refs.filter(r => r && r.kind && r.id).map(r => ({ ...r, label: sourceLabel(r.kind) })),
    };
  });
}

function buildProjectReportEvidence(user, project, { days = 90 } = {}) {
  const hub = db.hub();
  const since = new Date(Date.now() - days * 86400 * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const tasks = getCachedTasks(user, { projectSlug: project.slug }, true).slice(0, 60);

  const meetings = hub.prepare(`
    SELECT DISTINCT m.id, m.title, m.meeting_date, m.meeting_time, m.notes, co.name AS company_name,
           mi.summary AS intake_summary, mi.project_slug AS intake_project_slug,
           CASE WHEN mi.project_slug = ? THEN 'direct'
                WHEN cop.project_id IS NOT NULL THEN 'company'
                ELSE 'attendee' END AS link_kind
      FROM meetings m
      LEFT JOIN companies co ON co.id = m.company_id
      LEFT JOIN meeting_intakes mi ON mi.meeting_id = m.id AND mi.user = m.user
      LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
      LEFT JOIN contact_projects cp ON cp.contact_id = ma.contact_id AND cp.project_id = ?
      LEFT JOIN company_projects cop ON cop.company_id = m.company_id AND cop.project_id = ?
     WHERE m.user = ?
       AND m.meeting_date >= ?
       AND (mi.project_slug = ? OR cp.project_id IS NOT NULL OR cop.project_id IS NOT NULL)
     ORDER BY m.meeting_date DESC, COALESCE(m.meeting_time,'') DESC
     LIMIT 20
  `).all(project.slug, project.id, project.id, user, since, project.slug);

  const emails = hub.prepare(`
    SELECT subject, from_name, from_email, summary, received_at
      FROM email_summaries
     WHERE user = ? AND project_slug = ?
     ORDER BY received_at DESC
     LIMIT 12
  `).all(user, project.slug);

  const docs = hub.prepare(`
    SELECT filename, uploaded_at
      FROM documents
     WHERE user = ? AND project_id = ?
     ORDER BY uploaded_at DESC
     LIMIT 12
  `).all(user, project.id);

  const atoms = atomRowsForProject(user, project.id).slice(0, 40);
  const { archiveEvidenceForProject } = require('../lib/messaging-archive');
  const archive = archiveEvidenceForProject(user, project.id, { sinceDay: since, limit: 120 });

  return { project, days, since, tasks, meetings, emails, docs, atoms, archive };
}

function evidenceText(evidence) {
  const fmtTs = ts => ts ? new Date(ts * 1000).toLocaleDateString('en-GB', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const taskLines = evidence.tasks.map(t => {
    const state = t.deleted_at ? 'deleted' : t.status === 'completed' ? 'completed' : 'open';
    const due = t.due ? ` due ${t.due}` : '';
    const done = t.completed_at ? ` completed ${fmtTs(t.completed_at)}` : '';
    return `- [${state}] ${t.title}${due}${done}${t.notes ? ` — ${String(t.notes).slice(0, 180)}` : ''}`;
  }).join('\n') || '- none';
  const meetingLines = evidence.meetings.map(m =>
    `- ${m.meeting_date}${m.meeting_time ? ` ${m.meeting_time}` : ''}: ${m.title}${m.company_name ? ` (${m.company_name})` : ''}${m.intake_summary || m.notes ? ` — ${String(m.intake_summary || m.notes).slice(0, 220)}` : ''}`
  ).join('\n') || '- none';
  const emailLines = evidence.emails.map(e =>
    `- ${fmtTs(e.received_at)}: ${e.subject} from ${e.from_name || e.from_email || 'unknown'}${e.summary ? ` — ${String(e.summary).slice(0, 220)}` : ''}`
  ).join('\n') || '- none';
  const atomLines = evidence.atoms.map(a =>
    `- ${a.predicate}: ${a.value} (${a.status}, ${Math.round(a.confidence * 100)}%, sources: ${a.sources.map(s => s.label).join(', ') || 'none'})`
  ).join('\n') || '- none';
  const docLines = evidence.docs.map(d => `- ${fmtTs(d.uploaded_at)}: ${d.filename}`).join('\n') || '- none';
  const archiveLines = evidence.archive.messages.map(m =>
    `- ${fmtTs(m.received_at)}: ${m.sender_name || 'unknown'} in ${m.chat_name || 'WhatsApp'} — ${String(m.body || '').slice(0, 220)}`
  ).join('\n') || '- none';
  const archiveHeader = evidence.archive.truncated
    ? `ARCHIVED WHATSAPP TIMELINE (${evidence.archive.messages.length} most recent of ${evidence.archive.total} messages in window)`
    : `ARCHIVED WHATSAPP TIMELINE (${evidence.archive.total} messages in window)`;

  return [
    `Project: ${evidence.project.name} /${evidence.project.slug}`,
    `Evidence window: last ${evidence.days} days, since ${evidence.since}`,
    '',
    'TASKS',
    taskLines,
    '',
    'MEETINGS',
    meetingLines,
    '',
    'EMAILS',
    emailLines,
    '',
    'DOCUMENTS',
    docLines,
    '',
    archiveHeader,
    archiveLines,
    '',
    'DERIVED KNOWLEDGE',
    atomLines,
  ].join('\n');
}

function fallbackProjectReport(evidence, error = null) {
  const fmtTs = ts => ts ? new Date(ts * 1000).toLocaleDateString('en-GB', {
    timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', year: 'numeric',
  }) : '';
  const open = evidence.tasks.filter(t => t.status === 'needsAction' && !t.deleted_at);
  const completed = evidence.tasks.filter(t => t.status === 'completed' && !t.deleted_at);
  const activeAtoms = evidence.atoms.filter(a => a.status === 'active');
  const narrativeParts = [];
  if (completed.length)
    narrativeParts.push(`${completed.length} task(s) have been completed, including: ${completed.slice(0, 3).map(t => t.title).join('; ')}.`);
  if (evidence.meetings.length)
    narrativeParts.push(`There ${evidence.meetings.length === 1 ? 'was' : 'were'} ${evidence.meetings.length} relevant meeting(s) in the evidence window, most recently ${evidence.meetings[0].meeting_date}: ${evidence.meetings[0].title}.`);
  if (activeAtoms.length)
    narrativeParts.push(`The knowledge layer has ${activeAtoms.length} active claim(s) about this project, including: ${activeAtoms.slice(0, 2).map(a => `${a.predicate.replace(/_/g, ' ')}: ${a.value}`).join('; ')}.`);
  if (open.length)
    narrativeParts.push(`Currently open: ${open.slice(0, 4).map(t => `${t.title}${t.due ? ` (due ${t.due})` : ''}`).join('; ')}.`);
  if (error)
    narrativeParts.push(`AI synthesis was unavailable: ${error}`);
  return {
    headline: `${evidence.project.name}: evidence summary`,
    status: evidence.meetings.length || open.length || completed.length ? 'active' : 'unclear',
    narrative: narrativeParts.join('\n\n') || 'No project activity was found in the selected evidence window.',
    summary: `${evidence.meetings.length} meeting(s), ${open.length} open task(s), ${completed.length} completed, ${evidence.emails.length} email(s), ${evidence.atoms.length} knowledge claim(s).`,
    meetings: evidence.meetings.slice(0, 6).map(m => `${m.meeting_date}: ${m.title}`),
    tasks: [
      ...open.slice(0, 6).map(t => `Open: ${t.title}${t.due ? ` due ${t.due}` : ''}`),
      ...completed.slice(0, 4).map(t => `Completed: ${t.title}`),
    ],
    timeline: [
      ...evidence.archive.messages.slice(0, 8).map(m =>
        `${fmtTs(m.received_at)}: ${m.sender_name || 'WhatsApp'} — ${String(m.body || '').slice(0, 160)}`
      ),
      ...activeAtoms.slice(0, 8).map(a => `${a.predicate.replace(/_/g, ' ')}: ${a.value}`),
    ].slice(0, 8),
    risks: evidence.meetings.length || evidence.tasks.length ? [] : ['No recent project meetings or tasks were found in the selected evidence window.'],
    next_actions: open.slice(0, 5).map(t => t.title),
  };
}

async function generateProjectReport(user, evidence) {
  const defaults = fallbackProjectReport(evidence);
  if (!process.env.OPENROUTER_API_KEY) return { report: defaults, model: null, fallback: true, error: 'OPENROUTER_API_KEY is not set' };
  const modelId = getSystemModelId('project_report', 'system', 'anthropic/claude-haiku-4-5');
  const started = Date.now();
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.CRM),
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: getSystemPrompt('project_report', 'system', PROMPTS.project_report) },
        { role: 'user', content: evidenceText(evidence).slice(0, 30000) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user, feature: 'project-report', modelKey: 'project_report', fallbackModelId: modelId,
    data, durationMs: Date.now() - started, taskCode: TASK_CODES.CRM,
  });
  const raw = data.choices?.[0]?.message?.content || '';
  return { report: parseModelJson(raw, defaults), model: modelId, fallback: false, error: null };
}

// ── Project report PDF + email ─────────────────────────────────────────────

const PUR = '#7c6af5';

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildProjectReportPdfHtml(report, project, evidence) {
  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Dublin' });
  const statusColour = { on_track: '#22c55e', active: PUR, blocked: '#ef4444', quiet: '#94a3b8', unclear: '#94a3b8' };
  const statusBg = { on_track: '#f0fdf4', active: '#f5f3ff', blocked: '#fef2f2', quiet: '#f8fafc', unclear: '#f8fafc' };
  const st = report.status || 'unclear';

  const narrativeHtml = (report.narrative || report.summary || '')
    .split(/\n\n+/).filter(p => p.trim())
    .map(p => `<p class="rpt-p">${escHtml(p.trim())}</p>`)
    .join('');

  const listSection = (title, items) => {
    if (!items || !items.length) return '';
    return `<h3 class="rpt-h3">${escHtml(title)}</h3><ul class="rpt-ul">${items.map(i => `<li class="rpt-li">${escHtml(i)}</li>`).join('')}</ul>`;
  };

  const statsHtml = [
    `${evidence.meetings.length} meeting${evidence.meetings.length === 1 ? '' : 's'}`,
    `${evidence.tasks.filter(t => t.status === 'needsAction' && !t.deleted_at).length} open task${evidence.tasks.filter(t => t.status === 'needsAction' && !t.deleted_at).length === 1 ? '' : 's'}`,
    `${evidence.tasks.filter(t => t.status === 'completed' && !t.deleted_at).length} completed`,
    `${evidence.atoms.length} knowledge claim${evidence.atoms.length === 1 ? '' : 's'}`,
  ].map(s => `<span class="stat">${escHtml(s)}</span>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,700;0,800;1,700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#272432}
@page cover{size:A4;margin:0}
@page report{size:A4;margin:25mm 19mm 23mm}
.cover{page:cover;width:210mm;height:297mm;display:flex;flex-direction:column;position:relative;overflow:hidden;background:#fff;break-after:page}
.cover-bar{height:2.5mm;background:${PUR};flex-shrink:0}
.cover-orbit{position:absolute;width:112mm;height:112mm;border:1px solid #ded8ff;border-radius:50%;right:-43mm;top:24mm}
.cover-orbit::before,.cover-orbit::after{content:'';position:absolute;border-radius:50%;border:1px solid #eeeaff}
.cover-orbit::before{inset:13mm}.cover-orbit::after{inset:27mm}
.cover-block{position:absolute;width:21mm;height:21mm;background:${PUR};right:17mm;top:69.5mm;border-radius:4mm;transform:rotate(12deg);box-shadow:0 8mm 20mm rgba(124,106,245,.18)}
.cover-body{flex:1;padding:21mm 21mm 17mm;display:flex;flex-direction:column;position:relative;z-index:1}
.cover-label{font-size:8pt;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:${PUR};margin-bottom:28mm}
.cover-title{font-family:'Playfair Display',Georgia,serif;font-size:46pt;font-weight:800;line-height:1.05;color:#15131e;margin-bottom:8mm;max-width:155mm}
.cover-rule{width:15mm;height:1.2mm;background:${PUR};border-radius:2mm;margin-bottom:6mm}
.cover-status{display:inline-block;font-size:10pt;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2mm 5mm;border-radius:2mm;background:${statusBg[st]};color:${statusColour[st]};margin-bottom:5mm}
.cover-date{font-size:10pt;color:#8a8693;margin-bottom:3mm}
.cover-window{font-size:9pt;color:#aaa6b5}
.cover-stats{display:flex;flex-wrap:wrap;gap:4mm;margin-top:6mm}
.stat{font-size:8.5pt;font-weight:600;color:#5f4bd8;background:#f5f3ff;padding:1.5mm 3.5mm;border-radius:1.5mm}
.cover-spacer{flex:1}
.cover-footer{padding-top:6mm;border-top:1px solid #e9e6ee;display:flex;justify-content:space-between}
.cover-footer span{font-size:8.5pt;color:#777381}
.report{page:report}
.report-masthead{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12mm;padding-bottom:4mm;border-bottom:1px solid #e9e6ee;font-size:7.5pt;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8a8693}
.report-masthead .brand{color:${PUR}}
.report-end{display:flex;justify-content:space-between;align-items:flex-end;margin-top:12mm;padding-top:4mm;border-top:1px solid #e9e6ee;break-inside:avoid;font-size:7.5pt;color:#8a8693}
.rpt-h2{font-family:'Playfair Display',Georgia,serif;font-size:20pt;font-weight:700;line-height:1.15;color:#15131e;margin:10mm 0 4mm;padding-bottom:3mm;border-bottom:1.2mm solid ${PUR};break-after:avoid}
.rpt-h2:first-child{margin-top:0}
.rpt-h3{font-size:8pt;font-weight:800;text-transform:uppercase;letter-spacing:.13em;color:${PUR};margin:7mm 0 2.5mm;break-after:avoid}
.rpt-p{font-size:10.5pt;line-height:1.72;color:#3d3b46;margin-bottom:4.2mm;orphans:3;widows:3}
.rpt-ul{list-style:none;padding-left:0;margin:2mm 0 5mm}
.rpt-li{font-size:10pt;line-height:1.6;color:#3d3b46;margin-bottom:2.5mm;padding-left:6mm;position:relative;break-inside:avoid}
.rpt-li::before{content:'';position:absolute;left:0;top:2.5mm;width:1.8mm;height:1.8mm;background:${PUR};border-radius:50%}
</style></head><body>

<section class="cover">
  <div class="cover-bar"></div>
  <div class="cover-orbit"></div>
  <div class="cover-block"></div>
  <div class="cover-body">
    <div class="cover-label">McLellan Hub · Project Report</div>
    <div class="cover-title">${escHtml(project.name)}</div>
    <div class="cover-rule"></div>
    <div class="cover-status">${escHtml(st.replace('_', ' '))}</div>
    <div class="cover-date">Generated ${dateStr}</div>
    <div class="cover-window">Evidence window: last ${evidence.days} days</div>
    <div class="cover-stats">${statsHtml}</div>
    <div class="cover-spacer"></div>
    <div class="cover-footer">
      <span>Douglas McLellan</span>
      <span>mclellan.scot</span>
    </div>
  </div>
</section>

<main class="report">
  <div class="report-masthead">
    <span class="brand">McLellan Hub · CRM</span>
    <span>${escHtml(dateStr)}</span>
  </div>
  <h2 class="rpt-h2">${escHtml(report.headline || project.name)}</h2>
  ${narrativeHtml}
  ${listSection('Next actions', report.next_actions)}
  ${listSection('Tasks', report.tasks)}
  ${listSection('Meetings', report.meetings)}
  ${listSection('Timeline', report.timeline)}
  ${listSection('Risks & gaps', report.risks)}
  <div class="report-end">
    <span>Douglas McLellan · McLellan Hub</span>
    <span>${escHtml(project.slug)} · ${dateStr}</span>
  </div>
</main>

</body></html>`;
}

async function renderProjectReportPdf(report, project, evidence) {
  const puppeteer = require('puppeteer');
  const html = buildProjectReportPdfHtml(report, project, evidence);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

async function emailProjectReport(user, project, days, recipient = null, { scheduled = false } = {}) {
  const to = recipient || process.env.AGENTMAIL_TO_DOUGLAS || process.env.HUB_REPORT_EMAIL || 'aio.mclellan@gmail.com';
  const evidence = buildProjectReportEvidence(user, project, { days });
  const generated = await generateProjectReport(user, evidence);
  const report = generated.report;
  const pdfBuffer = await renderProjectReportPdf(report, project, evidence);

  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Dublin' });
  const filename = `Project Report — ${project.name} — ${dateStr}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');

  await amSendEmail({
    to,
    subject: `Project Report: ${project.name} — ${dateStr}`,
    html: `<p style="font-family:sans-serif;font-size:14px;color:#272432;">Your ${scheduled ? 'scheduled ' : ''}project report for <strong>${escHtml(project.name)}</strong> is attached.</p>
<p style="font-family:sans-serif;font-size:14px;color:#272432;margin-top:8px;"><strong>Status:</strong> ${escHtml(report.status || 'unclear')}</p>
<p style="font-family:sans-serif;font-size:13px;color:#666;margin-top:8px;">${escHtml(report.summary || '')}</p>
<p style="font-family:sans-serif;font-size:12px;color:#999;margin-top:16px;">Evidence window: last ${days} days · Generated by McLellan Hub${scheduled ? ' (scheduled)' : ''}</p>`,
    attachments: [{
      filename,
      content_type: 'application/pdf',
      content: Buffer.from(pdfBuffer).toString('base64'),
    }],
  });

  console.log(`[project-report-email] sent to ${to}: ${filename}${scheduled ? ' (scheduled)' : ''}`);
  return { to, filename };
}

router.post('/crm/project-report/email', requireAuth, requireSameOrigin, async (req, res) => {
  const selectedSlug = String(req.body.project || '').trim();
  const days = Math.max(14, Math.min(365, parseInt(req.body.days, 10) || 90));

  if (!selectedSlug) return res.json({ ok: false, error: 'No project selected.' });

  const projects = [...crmProjectsForUser(req.hubUser), ...reportableWorkspacesForUser(req.hubUser)];
  const project = projects.find(p => p.slug === selectedSlug);
  if (!project) return res.json({ ok: false, error: 'Project not found.' });

  try {
    const { to } = await emailProjectReport(req.hubUser, project, days);
    res.json({ ok: true, message: `Report sent to ${to}` });
  } catch (err) {
    console.error('[project-report-email]', err);
    res.json({ ok: false, error: err.message });
  }
});

// Scheduled report runner — invoked by the project_report_schedules job.
// Cadence 'weekly:mon..sun' or 'monthly:1..28' evaluated in Dublin time; a
// 20-hour guard stops double sends when the hourly job fires repeatedly on
// the due day.
async function runDueProjectReportSchedules() {
  const hub = db.hub();
  const nowTs = Math.floor(Date.now() / 1000);
  const dublinNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Dublin' }));
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const rows = hub.prepare('SELECT * FROM project_report_schedules WHERE enabled = 1').all();
  let sent = 0, errors = 0;
  for (const s of rows) {
    const [mode, arg] = String(s.cadence || '').split(':');
    const due = mode === 'weekly' ? dayNames[dublinNow.getDay()] === arg
      : mode === 'monthly' ? dublinNow.getDate() === parseInt(arg, 10)
      : false;
    if (!due) continue;
    if (s.last_run_at && (nowTs - s.last_run_at) < 20 * 3600) continue;
    const projects = [...crmProjectsForUser(s.user), ...reportableWorkspacesForUser(s.user)];
    const project = projects.find(p => p.slug === s.project_slug);
    if (!project) {
      console.warn(`[project-report-schedule] project ${s.project_slug} not found for ${s.user} — disabling schedule`);
      hub.prepare('UPDATE project_report_schedules SET enabled = 0 WHERE id = ?').run(s.id);
      continue;
    }
    try {
      await emailProjectReport(s.user, project, s.window_days || 30, s.recipient, { scheduled: true });
      hub.prepare('UPDATE project_report_schedules SET last_run_at = ? WHERE id = ?').run(nowTs, s.id);
      sent++;
    } catch (err) {
      errors++;
      console.error('[project-report-schedule]', s.project_slug, err.message);
    }
  }
  return { considered: rows.length, sent, errors };
}
router.runDueProjectReportSchedules = runDueProjectReportSchedules;
router._test = {
  buildProjectReportEvidence,
  evidenceText,
  fallbackProjectReport,
};

router.post('/api/crm/project-report/schedule', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const slug = String(req.body.project || '').trim();
  const projects = [...crmProjectsForUser(req.hubUser), ...reportableWorkspacesForUser(req.hubUser)];
  if (!projects.some(p => p.slug === slug)) return res.status(404).json({ error: 'Project not found' });
  const mode = String(req.body.mode || '').trim();
  if (mode === 'off') {
    hub.prepare('DELETE FROM project_report_schedules WHERE user = ? AND project_slug = ?').run(req.hubUser, slug);
    return res.json({ ok: true, message: 'Schedule removed.' });
  }
  let cadence = null;
  if (mode === 'weekly' && ['mon','tue','wed','thu','fri','sat','sun'].includes(String(req.body.day))) {
    cadence = `weekly:${req.body.day}`;
  } else if (mode === 'monthly') {
    const dom = parseInt(req.body.day, 10);
    if (dom >= 1 && dom <= 28) cadence = `monthly:${dom}`;
  }
  if (!cadence) return res.status(400).json({ error: 'Invalid cadence' });
  const windowDays = Math.max(14, Math.min(365, parseInt(req.body.window_days, 10) || 30));
  hub.prepare(`
    INSERT INTO project_report_schedules (id, user, project_slug, cadence, window_days, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(user, project_slug) DO UPDATE SET cadence = excluded.cadence, window_days = excluded.window_days, enabled = 1
  `).run(uuid(), req.hubUser, slug, cadence, windowDays);
  res.json({ ok: true, message: `Scheduled ${cadence.replace(':', ' ')} · ${windowDays}-day window.` });
});

router.get('/crm/project-report', requireAuth, async (req, res) => {
  const crmProjects = crmProjectsForUser(req.hubUser);
  const workspaceProjects = reportableWorkspacesForUser(req.hubUser, crmProjects);
  const projects = [...crmProjects, ...workspaceProjects];
  const selectedSlug = String(req.query.project || '').trim();
  const days = Math.max(14, Math.min(365, parseInt(req.query.days, 10) || 90));
  const project = selectedSlug ? projects.find(p => p.slug === selectedSlug) : null;
  let evidence = null, report = null, model = null, error = null, fallback = false;

  if (selectedSlug && !project) {
    error = 'Project not found.';
  } else if (project) {
    evidence = buildProjectReportEvidence(req.hubUser, project, { days });
    try {
      const generated = await generateProjectReport(req.hubUser, evidence);
      ({ report, model, error, fallback } = generated);
    } catch (err) {
      error = err.message;
      fallback = true;
      report = fallbackProjectReport(evidence, error);
    }
  }

  const reportSchedule = project
    ? db.hub().prepare('SELECT * FROM project_report_schedules WHERE user = ? AND project_slug = ?').get(req.hubUser, project.slug)
    : null;

  res.render('hub/crm-project-report', {
    ...crmPageData(req.hubUser),
    projects, crmProjects, workspaceProjects,
    selectedSlug, days, project, evidence, report, model, error, fallback,
    reportSchedule,
  });
});

// ── Knowledge query ───────────────────────────────────────────────────────────

router.get('/crm/knowledge', requireAuth, async (req, res) => {
  const { getInsightAtoms } = require('../lib/knowledge-synthesis');
  const hub = db.hub();
  const query    = String(req.query.q || '').trim();
  const insights = getInsightAtoms(req.hubUser);
  let result = null, error = null;

  if (query) {
    try {
      const { answerKnowledgeQuery } = require('../lib/knowledge-synthesis');
      result = await answerKnowledgeQuery(req.hubUser, query);
    } catch (err) {
      error = err.message;
    }
  }

  // Browse mode: the knowledge base as a filterable structured layer, not
  // only a natural-language query target.
  const browse = req.query.browse === '1';
  let browseAtoms = null, browseFilters = null;
  if (browse) {
    const kind = ['contact', 'company', 'project', 'document'].includes(String(req.query.kind)) ? req.query.kind : '';
    const status = ['active', 'proposed', 'stale', 'disputed', 'retired'].includes(String(req.query.status)) ? req.query.status : '';
    const minConf = Math.min(1, Math.max(0, parseFloat(req.query.minconf) || 0));
    const conditions = ['user = ?'];
    const params = [req.hubUser];
    if (kind) { conditions.push('subject_kind = ?'); params.push(kind); }
    if (status) { conditions.push('status = ?'); params.push(status); }
    else { conditions.push("status != 'retired'"); }
    if (minConf > 0) { conditions.push('confidence >= ?'); params.push(minConf); }
    const rows = hub.prepare(`
      SELECT id, subject_kind, subject_id, subject_label, predicate, value, confidence, status, derived_by, last_confirmed
      FROM knowledge_atoms
      WHERE ${conditions.join(' AND ')}
      ORDER BY predicate, confidence DESC
      LIMIT 400
    `).all(...params);
    browseAtoms = {};
    for (const a of rows) {
      if (!browseAtoms[a.predicate]) browseAtoms[a.predicate] = [];
      browseAtoms[a.predicate].push(a);
    }
    browseFilters = { kind, status, minConf };
  }

  const engineHealth = getCrmKnowledgeHealth(req.hubUser);
  const health = {
    duplicateEmails: hub.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT email FROM contacts WHERE user = ? AND email IS NOT NULL AND email != ''
        GROUP BY email HAVING COUNT(*) > 1
      )`).get(req.hubUser)?.n || 0,
    staleAtoms: hub.prepare("SELECT COUNT(*) AS n FROM knowledge_atoms WHERE user = ? AND status = 'stale'").get(req.hubUser)?.n || 0,
    disputedAtoms: hub.prepare("SELECT COUNT(*) AS n FROM knowledge_atoms WHERE user = ? AND status = 'disputed'").get(req.hubUser)?.n || 0,
    orphanFacts: hub.prepare(`
      SELECT COUNT(*) AS n FROM crm_facts f
      WHERE f.user = ? AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = f.contact_id)
    `).get(req.hubUser)?.n || 0,
  };

  res.render('hub/crm-knowledge', {
    ...crmPageData(req.hubUser),
    query, result, error, insights,
    browse, browseAtoms, browseFilters,
    engineStages: engineHealth.stages,
    engineErrors: engineHealth.currentErrors.slice(0, 12),
    engineErrorSourceCount: engineHealth.erroredSourceCount,
    health,
  });
});

// Manual engine trigger — same code path as the self-scheduling job, run once.
router.post('/api/crm/knowledge/run', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const { runCrmKnowledgeEngine } = require('../lib/crm-knowledge-engine');
  setImmediate(async () => {
    try {
      const out = await runCrmKnowledgeEngine(req.hubUser, { limit: 8, linkBudget: 12 });
      console.log(`[crm] manual knowledge engine run for ${req.hubUser}:`, out);
    } catch (err) {
      console.error('[crm] manual knowledge engine run failed:', err.message);
    }
  });
  res.json({ ok: true, message: 'Engine run started — receipts will appear as sources are processed.' });
});

router.post('/api/crm/knowledge/retry-errors', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  if (knowledgeRetryUsers.has(req.hubUser)) {
    return res.status(409).json({ error: 'A knowledge retry batch is already running.' });
  }
  const { retryCrmKnowledgeErrors } = require('../lib/crm-knowledge-engine');
  knowledgeRetryUsers.add(req.hubUser);
  setImmediate(async () => {
    try {
      const out = await retryCrmKnowledgeErrors(req.hubUser, { limit: 8, linkBudget: 12 });
      console.log(`[crm] knowledge error retry for ${req.hubUser}:`, out);
    } catch (err) {
      console.error('[crm] knowledge error retry failed:', err.message);
    } finally {
      knowledgeRetryUsers.delete(req.hubUser);
    }
  });
  return res.json({ ok: true, message: 'Retrying up to 8 errored sources through the full knowledge pipeline.' });
});

// User feedback on atoms: dispute / mark stale / restore. The status change is
// visible immediately; a user_feedback receipt records why, so the synthesis
// loop consumes the correction the same way it consumes any other evidence.
router.post('/api/crm/atoms/:id/:action(dispute|stale|restore)', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const atom = hub.prepare('SELECT * FROM knowledge_atoms WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!atom) return res.status(404).json({ error: 'Atom not found' });
  const nextStatus = { dispute: 'disputed', stale: 'stale', restore: 'active' }[req.params.action];
  hub.prepare('UPDATE knowledge_atoms SET status = ?, updated_at = unixepoch() WHERE id = ?').run(nextStatus, atom.id);
  hub.prepare(`
    INSERT INTO knowledge_receipts (id, user, source_kind, source_id, stage, status, summary, payload)
    VALUES (?, ?, 'knowledge_atom', ?, 'user_feedback', 'done', ?, ?)
  `).run(
    uuid(), req.hubUser, atom.id,
    `${req.params.action}: ${atom.predicate} = ${String(atom.value).slice(0, 120)}`,
    JSON.stringify({ action: req.params.action, reason: String(req.body.reason || '').slice(0, 500) || null, previous_status: atom.status })
  );
  res.json({ ok: true, status: nextStatus });
});

// ── Projects ──────────────────────────────────────────────────────────────────

// Manual project declarations (status, deadline, scope, milestones) live in
// knowledge_atoms with derived_by='manual' — declared knowledge enters the
// same compiled layer the synthesis engine writes to, instead of new columns.
const PROJECT_META_PREDICATES = ['status', 'deadline', 'scope', 'milestone'];
const PROJECT_STATUS_VALUES = ['planning', 'active', 'blocked', 'completed', 'closed'];

function upsertManualProjectAtom(user, project, predicate, value) {
  const hub = db.hub();
  const trimmed = String(value || '').trim();
  const existing = hub.prepare(`
    SELECT id FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'project' AND subject_id = ? AND predicate = ? AND derived_by = 'manual'
  `).get(user, project.id, predicate);
  if (!trimmed) {
    if (existing) hub.prepare('DELETE FROM knowledge_atoms WHERE id = ?').run(existing.id);
    return;
  }
  if (existing) {
    hub.prepare(`
      UPDATE knowledge_atoms SET value = ?, status = 'active', confidence = 1.0,
        last_confirmed = unixepoch(), updated_at = unixepoch()
      WHERE id = ?
    `).run(trimmed, existing.id);
  } else {
    hub.prepare(`
      INSERT INTO knowledge_atoms (id, user, subject_kind, subject_id, subject_label, predicate, value, source_refs, confidence, status, derived_by)
      VALUES (?, ?, 'project', ?, ?, ?, ?, '[]', 1.0, 'active', 'manual')
    `).run(uuid(), user, project.id, project.name, predicate, trimmed);
  }
}

function projectMetaAtoms(user, projectIds) {
  if (!projectIds.length) return new Map();
  const rows = db.hub().prepare(`
    SELECT id, subject_id, predicate, value, status FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'project'
      AND predicate IN ('status','deadline')
      AND status = 'active' AND derived_by = 'manual'
      AND subject_id IN (${projectIds.map(() => '?').join(',')})
  `).all(user, ...projectIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.subject_id)) map.set(r.subject_id, {});
    map.get(r.subject_id)[r.predicate] = r.value;
  }
  return map;
}

// Health signal: manual status wins; otherwise derive from last activity so
// projects show a truthful pulse without anyone maintaining a field.
function deriveProjectHealth(manualStatus, lastActivityTs) {
  if (manualStatus) return manualStatus;
  if (!lastActivityTs) return null;
  const days = Math.floor((Date.now() / 1000 - lastActivityTs) / 86400);
  if (days < 30) return 'active';
  if (days < 90) return 'quiet';
  return 'stale';
}

router.post('/crm/projects', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).send('Name required');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hub = db.hub();
  try {
    hub.prepare(
      'INSERT INTO projects (id, user, name, slug, project_kind) VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?)'
    ).run(req.hubUser, name, slug, 'crm');
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).send('A project with that name already exists');
    throw err;
  }
  const project = hub.prepare('SELECT id, name FROM projects WHERE user = ? AND slug = ?').get(req.hubUser, slug);
  if (project) {
    const status = PROJECT_STATUS_VALUES.includes(String(req.body.status || '')) ? req.body.status : null;
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.target_date || '')) ? req.body.target_date : null;
    if (status) upsertManualProjectAtom(req.hubUser, project, 'status', status);
    if (deadline) upsertManualProjectAtom(req.hubUser, project, 'deadline', deadline);
    if (String(req.body.description || '').trim()) upsertManualProjectAtom(req.hubUser, project, 'scope', req.body.description);
  }
  res.redirect('/crm/project/' + slug);
});

router.post('/api/crm/project/:slug/meta', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const project = hub.prepare('SELECT id, name FROM projects WHERE user = ? AND slug = ?').get(req.hubUser, req.params.slug);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if ('status' in req.body) {
    const status = String(req.body.status || '').trim();
    if (status && !PROJECT_STATUS_VALUES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    upsertManualProjectAtom(req.hubUser, project, 'status', status);
  }
  if ('deadline' in req.body) {
    const deadline = String(req.body.deadline || '').trim();
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return res.status(400).json({ error: 'Invalid deadline (YYYY-MM-DD)' });
    upsertManualProjectAtom(req.hubUser, project, 'deadline', deadline);
  }
  if ('scope' in req.body) upsertManualProjectAtom(req.hubUser, project, 'scope', req.body.scope);
  res.json({ ok: true });
});

router.post('/api/crm/project/:slug/rename', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const project = hub.prepare('SELECT id FROM projects WHERE user = ? AND slug = ?').get(req.hubUser, req.params.slug);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const result = renameProject(hub, {
      user: req.hubUser, projectId: project.id, name: req.body.name, slug: req.body.slug,
    });
    res.json({ ok: true, project: result.project, referencesUpdated: result.referencesUpdated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/crm/project/:slug/milestones', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const project = hub.prepare('SELECT id, name FROM projects WHERE user = ? AND slug = ?').get(req.hubUser, req.params.slug);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Milestone name required' });
  const target = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.target_date || '')) ? req.body.target_date : null;
  const value = target ? `${name} — target ${target}` : name;
  hub.prepare(`
    INSERT INTO knowledge_atoms (id, user, subject_kind, subject_id, subject_label, predicate, value, source_refs, confidence, status, derived_by)
    VALUES (?, ?, 'project', ?, ?, 'milestone', ?, '[]', 1.0, 'active', 'manual')
  `).run(uuid(), req.hubUser, project.id, project.name, value);
  res.json({ ok: true });
});

router.post('/api/crm/project-milestones/:id/:action', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const atom = hub.prepare(`
    SELECT id FROM knowledge_atoms
    WHERE id = ? AND user = ? AND subject_kind = 'project' AND predicate = 'milestone' AND derived_by = 'manual'
  `).get(req.params.id, req.hubUser);
  if (!atom) return res.status(404).json({ error: 'Milestone not found' });
  if (req.params.action === 'done') {
    hub.prepare("UPDATE knowledge_atoms SET status = 'retired', updated_at = unixepoch() WHERE id = ?").run(atom.id);
  } else if (req.params.action === 'reopen') {
    hub.prepare("UPDATE knowledge_atoms SET status = 'active', updated_at = unixepoch() WHERE id = ?").run(atom.id);
  } else if (req.params.action === 'delete') {
    hub.prepare('DELETE FROM knowledge_atoms WHERE id = ?').run(atom.id);
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }
  res.json({ ok: true });
});

router.get('/crm/projects', requireAuth, (req, res) => {
  const hub = db.hub();
  const showClosed = req.query.show_closed === '1';
  const projects = crmProjectsForUser(req.hubUser, { includeClosed: showClosed });
  const closed = closedProjectIds(hub, req.hubUser);

  // Annotate each project with open task count, last activity, and health
  const metaByProject = projectMetaAtoms(req.hubUser, projects.map(p => p.id));
  const annotated = projects.map(p => {
    const openTasks = hub.prepare(
      "SELECT COUNT(*) AS n FROM google_tasks WHERE user = ? AND project_slug = ? AND status = 'needsAction' AND deleted_at IS NULL"
    ).get(req.hubUser, p.slug)?.n || 0;
    const lastMsg = hub.prepare(
      'SELECT MAX(ts) AS ts FROM messages WHERE project_id = ?'
    ).get(p.id)?.ts;
    const meta = metaByProject.get(p.id) || {};
    return {
      ...p, openTasks, lastActivity: lastMsg,
      health: closed.has(p.id) ? 'closed' : deriveProjectHealth(meta.status, lastMsg),
      manualStatus: meta.status || null,
      deadline: meta.deadline || null,
    };
  });

  res.render('hub/crm-projects', { ...crmPageData(req.hubUser), projects: annotated, showClosed, closedCount: closed.size });
});

router.get('/crm/project/:slug', requireAuth, (req, res) => {
  const hub = db.hub();
  const project = hub.prepare(
    'SELECT * FROM projects WHERE user = ? AND slug = ?'
  ).get(req.hubUser, req.params.slug);
  if (!project) return res.status(404).send('Project not found');

  const todayIsoStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const showHistory = req.query.show_history === '1';

  // Tasks for this project
  const tasks = getCachedTasks(req.hubUser, { projectSlug: project.slug }, showHistory);

  // Contacts: directly linked first, then via tasks/emails
  const directContacts = hub.prepare(`
    SELECT c.*, cp.role AS project_role, cc.name AS company_name
    FROM contact_projects cp
    JOIN contacts c ON c.id = cp.contact_id
    LEFT JOIN contact_companies ccj ON ccj.contact_id = c.id AND ccj.is_primary = 1
    LEFT JOIN companies cc ON cc.id = ccj.company_id
    WHERE cp.project_id = ? ORDER BY c.name
  `).all(project.id);
  const directContactIds = new Set(directContacts.map(c => c.id));

  const contactIdsFromTasks = tasks.map(t => t.contact_id).filter(Boolean);
  const contactIdsFromEmail = hub.prepare(
    "SELECT DISTINCT contact_id FROM email_summaries WHERE user = ? AND project_slug = ? AND contact_id IS NOT NULL"
  ).all(req.hubUser, project.slug).map(r => r.contact_id);
  const indirectIds = [...new Set([...contactIdsFromTasks, ...contactIdsFromEmail])].filter(id => !directContactIds.has(id));
  const indirectContacts = indirectIds.length
    ? hub.prepare(
        `SELECT c.*, cc.name AS company_name
         FROM contacts c
         LEFT JOIN contact_companies ccj ON ccj.contact_id = c.id AND ccj.is_primary = 1
         LEFT JOIN companies cc ON cc.id = ccj.company_id
         WHERE c.id IN (${indirectIds.map(() => '?').join(',')})
         ORDER BY c.name`
      ).all(...indirectIds)
    : [];
  const contacts = [...directContacts, ...indirectContacts];

  // Available contacts to link
  const allContacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const availableContacts = allContacts.filter(c => !directContactIds.has(c.id));

  // Companies: directly linked
  const linkedCompanies = hub.prepare(`
    SELECT co.id, co.name, cp.role AS project_role
    FROM company_projects cp
    JOIN companies co ON co.id = cp.company_id
    WHERE cp.project_id = ? ORDER BY co.name
  `).all(project.id);
  const linkedCompanyIds = new Set(linkedCompanies.map(c => c.id));
  const allCompanies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  const availableCompanies = allCompanies.filter(c => !linkedCompanyIds.has(c.id));

  // Recent email summaries for this project
  const recentEmails = hub.prepare(`
    SELECT e.*, c.name AS contact_name
    FROM email_summaries e
    LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.user = ? AND e.project_slug = ?
    ORDER BY e.received_at DESC
    LIMIT 10
  `).all(req.hubUser, project.slug);

  // Facts timeline: facts explicitly routed to this project.
  // Older versions showed every fact for every linked contact, which leaked
  // unrelated Douglas/work-admin facts into broad projects.
  const projectFacts = hub.prepare(`
    SELECT f.id, f.fact, f.fact_type, f.source, f.created_at, f.vault_projection,
           c.id AS contact_id, c.name AS contact_name
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ?
      AND f.project_slug = ?
      AND f.status NOT IN ('archived', 'wrong')
    ORDER BY f.created_at DESC
    LIMIT 200
  `).all(req.hubUser, project.slug);
  const dedupedProjectFacts = dedupeProjectFacts(projectFacts);

  // Recent messages in the project chat (for last-activity context)
  const recentMessages = hub.prepare(`
    SELECT role, content, ts FROM messages
    WHERE project_id = ? AND role IN ('user','assistant')
    ORDER BY ts DESC LIMIT 5
  `).all(project.id);

  const projectDocs = hub.prepare(
    'SELECT id, filename, size_bytes, uploaded_at FROM documents WHERE project_id = ? ORDER BY uploaded_at DESC'
  ).all(project.id);

  // Knowledge layer (compiled): claims and events about this project. Legacy
  // projectFacts remain visible while CRM views migrate to compiled knowledge.
  const { knowledgeByPredicate, events: projectKnowledgeEvents } =
    knowledgeGroupsForEntity(req.hubUser, 'project', project.id, { includeEvents: true, includeStale: showHistory });

  // Manual meta/milestone atoms get dedicated UI on this page — drop them from
  // the generic knowledge card so they don't render twice.
  for (const pred of PROJECT_META_PREDICATES) delete knowledgeByPredicate[pred];

  const metaRows = hub.prepare(`
    SELECT id, predicate, value, status FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'project' AND subject_id = ? AND derived_by = 'manual'
      AND predicate IN ('status','deadline','scope')
  `).all(req.hubUser, project.id);
  const projectMeta = {};
  for (const r of metaRows) { if (r.status === 'active') projectMeta[r.predicate] = r.value; }

  const milestones = hub.prepare(`
    SELECT id, value, status, updated_at FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'project' AND subject_id = ? AND predicate = 'milestone' AND derived_by = 'manual'
    ORDER BY status = 'retired', first_seen
  `).all(req.hubUser, project.id);

  const lastMsg = hub.prepare('SELECT MAX(ts) AS ts FROM messages WHERE project_id = ?').get(project.id)?.ts;
  const projectHealth = isProjectClosed(hub, req.hubUser, project.id) ? 'closed' : deriveProjectHealth(projectMeta.status, lastMsg);

  res.render('hub/crm-project', {
    ...crmPageData(req.hubUser),
    project, tasks, contacts, directContactIds: [...directContactIds],
    availableContacts, linkedCompanies, linkedCompanyIds: [...linkedCompanyIds],
    availableCompanies, recentEmails, projectFacts: dedupedProjectFacts, projectKnowledgeEvents, recentMessages, showHistory, todayIsoStr,
    projectDocs, knowledgeByPredicate, projectMeta, milestones, projectHealth,
  });
});

router.post('/api/crm/note', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const result = await processCrmCommand(req.hubUser, text.trim(), 'hub-ui');
    res.json(result);
  } catch (err) {
    console.error('[crm note]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
