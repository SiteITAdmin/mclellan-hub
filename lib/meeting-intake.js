'use strict';

const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { PROMPTS } = require('./prompts');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { createTask } = require('./google-tasks');

function todayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanText(value, max = 5000) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function slugifyTitle(value) {
  return String(value || 'Meeting')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70)
    || 'Meeting';
}

function personTerms(contact) {
  return [contact.name, ...parseJsonArray(contact.aliases)].filter(Boolean);
}

function findContact(contacts, name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return null;
  return contacts.find(contact =>
    personTerms(contact).some(term => String(term).trim().toLowerCase() === normalized)
  ) || null;
}

function resolveOrCreateContact(hub, user, contacts, name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const existing = findContact(contacts, clean);
  if (existing) return existing;
  const id = uuid();
  hub.prepare('INSERT INTO contacts (id, user, name) VALUES (?, ?, ?)').run(id, user, clean);
  const created = hub.prepare('SELECT id, name, aliases FROM contacts WHERE id = ?').get(id);
  contacts.push(created);
  return created;
}

function exactProject(projects, slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  return projects.find(project => project.slug.toLowerCase() === normalized) || null;
}

function validDate(value, fallback = todayIso()) {
  const str = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : fallback;
}

function validFactType(value) {
  return ['fact', 'decision', 'action', 'note'].includes(value) ? value : 'note';
}

function meetingMarkdown({ title, date, summary, attendees, outcomes, projectNotes, openQuestions, transcript }) {
  const lines = [
    `# ${title}`,
    '',
    `Date: ${date}`,
    attendees.length ? `Attendees: ${attendees.map(a => a.name).join(', ')}` : null,
    '',
    '## Summary',
    summary || 'No summary captured.',
    '',
    '## Outcomes',
  ].filter(line => line !== null);

  if (outcomes.length) {
    for (const item of outcomes) {
      lines.push(`- [${item.type}] ${item.subject}: ${item.text}`);
    }
  } else {
    lines.push('None captured.');
  }

  lines.push('', '## Project Notes');
  if (projectNotes.length) {
    for (const item of projectNotes) lines.push(`- /${item.project_slug}: ${item.note}`);
  } else {
    lines.push('None captured.');
  }

  lines.push('', '## Open Questions');
  if (openQuestions.length) {
    for (const question of openQuestions) lines.push(`- ${question}`);
  } else {
    lines.push('None captured.');
  }

  lines.push('', '## Transcript', transcript.trim());
  return lines.join('\n').trimEnd() + '\n';
}

function buildPrompt(user, options, context) {
  const knownPeople = context.contacts
    .map(contact => personTerms(contact).join(' | '))
    .join('\n') || 'none';
  const knownProjects = context.projects
    .map(project => `${project.slug}: ${project.name}`)
    .join('\n') || 'none';
  const knownCompanies = context.companies
    .map(company => company.name)
    .join('\n') || 'none';

  return getSystemPrompt('meeting_intake', user, PROMPTS.meeting_intake)
    .replace('[DATE]', todayIso())
    .replace('[PEOPLE]', knownPeople)
    .replace('[PROJECTS]', knownProjects)
    .replace('[COMPANIES]', knownCompanies)
    .replace('[TITLE]', cleanText(options.title, 200) || 'none')
    .replace('[MEETING_DATE]', cleanText(options.meetingDate, 20) || 'none')
    .replace('[PROJECT_HINT]', cleanText(options.projectSlug, 80) || 'none')
    .replace('[TRANSCRIPT]', cleanText(options.transcript, 28000));
}

async function extractMeetingIntelligence(user, options, context) {
  const modelId = getSystemModelId('meeting_intake', user, 'google/gemini-2.5-pro-preview');
  const started = Date.now();
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.MEETING_INTAKE),
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: buildPrompt(user, options, context) }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });
  if (!resp.ok) throw new Error(`Meeting intake LLM ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user,
    feature: 'meeting-intake',
    modelKey: 'meeting_intake',
    fallbackModelId: modelId,
    data,
    taskCode: TASK_CODES.MEETING_INTAKE,
    durationMs: Date.now() - started,
  });
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!parsed || typeof parsed !== 'object' || !parsed.meeting) {
    throw new Error('Meeting intake model returned an empty or invalid extraction');
  }
  return parsed;
}

async function processMeetingTranscript(user, {
  intakeId: providedIntakeId = '',
  transcript,
  title = '',
  meetingDate = '',
  meetingId = '',
  projectSlug = '',
  sourceFilename = '',
} = {}) {
  const hub = db.hub();
  const cleanTranscript = cleanText(transcript, 200000);
  if (!cleanTranscript) throw new Error('Transcript is required');
  const intakeId = providedIntakeId || uuid();

  const context = {
    contacts: hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ? ORDER BY name').all(user),
    projects: hub.prepare('SELECT id, slug, name FROM projects WHERE user = ? ORDER BY name').all(user),
    companies: hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(user),
  };

  const extraction = await extractMeetingIntelligence(user, {
    transcript: cleanTranscript,
    title,
    meetingDate,
    projectSlug,
  }, context);

  const extractedMeeting = extraction.meeting || {};
  const explicitProject = exactProject(context.projects, projectSlug);
  const extractedProjects = (extractedMeeting.projects || [])
    .map(slug => exactProject(context.projects, slug))
    .filter(Boolean);
  const primaryProject = explicitProject || extractedProjects[0] || null;
  const meetingTitle = cleanText(title, 160) || cleanText(extractedMeeting.title, 160) || 'Meeting transcript';
  const date = validDate(meetingDate || extractedMeeting.date);
  const summary = cleanText(extractedMeeting.summary, 4000);
  let meeting = meetingId
    ? hub.prepare('SELECT * FROM meetings WHERE id = ? AND user = ?').get(meetingId, user)
    : null;
  if (meetingId && !meeting) throw new Error('Selected meeting was not found');

  const attendeeContacts = [];
  for (const attendee of extractedMeeting.attendees || []) {
    const contact = findContact(context.contacts, attendee.matched_contact)
      || resolveOrCreateContact(hub, user, context.contacts, attendee.name);
    if (contact && !attendeeContacts.some(c => c.id === contact.id)) attendeeContacts.push(contact);
  }

  const selectedCompany = (extractedMeeting.companies || [])
    .map(name => context.companies.find(company => company.name.toLowerCase() === String(name).toLowerCase()))
    .find(Boolean) || null;

  if (!meeting) {
    const newMeetingId = uuid();
    hub.prepare(`
      INSERT INTO meetings
        (id, user, title, meeting_date, meeting_time, duration_mins, location, notes, company_id, source)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 'transcript')
    `).run(newMeetingId, user, meetingTitle, date, summary, selectedCompany?.id || null);
    meeting = hub.prepare('SELECT * FROM meetings WHERE id = ?').get(newMeetingId);
  } else if (summary) {
    const notes = [meeting.notes, `Transcript intake ${todayIso()}:\n${summary}`].filter(Boolean).join('\n\n');
    hub.prepare('UPDATE meetings SET notes = ? WHERE id = ? AND user = ?').run(notes, meeting.id, user);
    meeting.notes = notes;
  }

  const addAttendee = hub.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, contact_id) VALUES (?, ?)');
  for (const contact of attendeeContacts) addAttendee.run(meeting.id, contact.id);

  const validContactIds = new Set(context.contacts.map(contact => contact.id));
  const factsCreated = [];
  for (const update of extraction.crm_updates || []) {
    const subject = findContact(context.contacts, update.matched_contact)
      || resolveOrCreateContact(hub, user, context.contacts, update.subject);
    const text = cleanText(update.text, 1200);
    if (!subject || !text) continue;
    const linked = (update.linked_people || [])
      .map(name => findContact(context.contacts, name)?.id)
      .filter(id => id && id !== subject.id && validContactIds.has(id));
    const factId = uuid();
    const project = exactProject(context.projects, update.project_slug) || primaryProject;
    hub.prepare(`
      INSERT INTO crm_facts
        (id, user, contact_id, fact, status, source, meeting_id, company_id, linked_contacts, fact_type)
      VALUES (?, ?, ?, ?, 'active', 'meeting-transcript', ?, ?, ?, ?)
    `).run(
      factId, user, subject.id, text, meeting.id, meeting.company_id,
      JSON.stringify([...new Set(linked)]), validFactType(update.type)
    );
    factsCreated.push({ id: factId, subject: subject.name, text, type: validFactType(update.type), projectSlug: project?.slug || null });
  }

  let tasksCreated = 0;
  for (const update of extraction.crm_updates || []) {
    if (!update.google_task || validFactType(update.type) !== 'action') continue;
    const subject = findContact(context.contacts, update.matched_contact) || findContact(context.contacts, update.subject);
    const titleText = cleanText(update.text, 180);
    if (!titleText) continue;
    const project = exactProject(context.projects, update.project_slug) || primaryProject;
    const task = await createTask(user, {
      title: titleText,
      notes: [`From ${meetingTitle}`, summary ? summary.slice(0, 500) : null].filter(Boolean).join('\n\n'),
      due: validDate(update.due_date, '') || undefined,
      source: 'meeting-transcript',
      sourceId: `meeting:${meeting.id}:${titleText.slice(0, 80)}`,
      contactId: subject?.id || null,
      companyId: meeting.company_id || null,
      projectSlug: project?.slug || null,
    }).catch(err => {
      console.warn('[meeting-intake] task create failed:', err.message);
      return null;
    });
    if (task) tasksCreated++;
  }

  const linkedProjectSlugs = [...new Set([
    primaryProject?.slug,
    ...extractedProjects.map(project => project.slug),
    ...(extraction.project_notes || []).map(note => note.project_slug),
    ...factsCreated.map(fact => fact.projectSlug),
  ].filter(Boolean))];

  const markdown = meetingMarkdown({
    title: meetingTitle,
    date,
    summary,
    attendees: attendeeContacts,
    outcomes: factsCreated,
    projectNotes: (extraction.project_notes || []).filter(note => note?.project_slug && note?.note),
    openQuestions: extraction.open_questions || [],
    transcript: cleanTranscript,
  });
  const docIds = [];
  for (const slug of linkedProjectSlugs) {
    const project = exactProject(context.projects, slug);
    if (!project) continue;
    const docId = uuid();
    const filename = `${date} ${slugifyTitle(meetingTitle)} [meeting].md`;
    hub.prepare(`
      INSERT INTO documents (id, user, project_id, filename, mimetype, size_bytes, markdown)
      VALUES (?, ?, ?, ?, 'text/markdown', ?, ?)
    `).run(docId, user, project.id, filename, Buffer.byteLength(markdown), markdown);
    docIds.push(docId);
    for (const contact of attendeeContacts) {
      hub.prepare('INSERT OR IGNORE INTO contact_projects (contact_id, project_id, role) VALUES (?, ?, ?)')
        .run(contact.id, project.id, 'meeting attendee');
    }
  }

  const counts = {
    attendees: attendeeContacts.length,
    facts: factsCreated.length,
    tasks: tasksCreated,
    projectDocuments: docIds.length,
  };

  const existingIntake = hub.prepare('SELECT id FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, user);
  if (existingIntake) {
    hub.prepare(`
      UPDATE meeting_intakes
      SET meeting_id = ?, project_slug = ?, title = ?, source_filename = ?,
          transcript = ?, summary = ?, extraction = ?, created_counts = ?,
          status = 'processed', error = NULL
      WHERE id = ? AND user = ?
    `).run(
      meeting.id, primaryProject?.slug || null, meetingTitle, sourceFilename || null,
      cleanTranscript, summary, JSON.stringify(extraction), JSON.stringify(counts),
      intakeId, user
    );
  } else {
    hub.prepare(`
      INSERT INTO meeting_intakes
        (id, user, meeting_id, project_slug, title, source_filename, transcript, summary, extraction, created_counts, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processed')
    `).run(
      intakeId, user, meeting.id, primaryProject?.slug || null, meetingTitle, sourceFilename || null,
      cleanTranscript, summary, JSON.stringify(extraction), JSON.stringify(counts)
    );
  }

  return {
    ok: true,
    intakeId,
    meetingId: meeting.id,
    meetingTitle,
    summary,
    counts,
    warnings: extraction.warnings || [],
  };
}

async function deleteMeetingIntake(user, intakeId) {
  const hub = db.hub();
  const intake = hub.prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, user);
  if (!intake) return { ok: false, error: 'Intake not found' };

  const counts = parseJsonObject(intake.created_counts);
  const shouldDeleteArtifacts = intake.status === 'processed'
    || Object.values(counts).some(value => Number(value) > 0);
  const result = {
    ok: true,
    deleted: {
      intake: 1,
      tasks: 0,
      facts: 0,
      documents: 0,
      contactProjectLinks: 0,
      meeting: 0,
    },
    taskErrors: [],
  };

  if (!shouldDeleteArtifacts || !intake.meeting_id) {
    hub.prepare('DELETE FROM meeting_intakes WHERE id = ? AND user = ?').run(intake.id, user);
    return result;
  }

  const meeting = hub.prepare('SELECT * FROM meetings WHERE id = ? AND user = ?').get(intake.meeting_id, user);
  const tasks = hub.prepare(`
    SELECT id FROM google_tasks
    WHERE user = ? AND source = 'meeting-transcript' AND source_id LIKE ?
  `).all(user, `meeting:${intake.meeting_id}:%`);
  for (const task of tasks) {
    try {
      const deleted = await createTaskDelete(user, task.id);
      if (deleted.ok) result.deleted.tasks++;
      if (deleted.remoteError) result.taskErrors.push(deleted.remoteError);
    } catch (err) {
      result.taskErrors.push(err.message);
    }
  }

  const deletedFacts = hub.prepare(`
    DELETE FROM crm_facts
    WHERE user = ? AND meeting_id = ? AND source = 'meeting-transcript'
  `).run(user, intake.meeting_id);
  result.deleted.facts = deletedFacts.changes || 0;

  const docs = hub.prepare(`
    SELECT id, project_id, markdown FROM documents
    WHERE user = ? AND filename LIKE '% [meeting].md'
  `).all(user);
  const transcriptNeedle = cleanText(intake.transcript, 1000);
  const matchingDocs = docs
    .filter(doc => transcriptNeedle && String(doc.markdown || '').includes(transcriptNeedle));
  const docIds = matchingDocs.map(doc => doc.id);
  const projectIds = [...new Set(matchingDocs.map(doc => doc.project_id).filter(Boolean))];
  if (docIds.length) {
    const deleteDoc = hub.prepare('DELETE FROM documents WHERE id = ? AND user = ?');
    for (const id of docIds) result.deleted.documents += deleteDoc.run(id, user).changes || 0;
  }

  if (meeting) {
    const attendeeIds = hub.prepare('SELECT contact_id FROM meeting_attendees WHERE meeting_id = ?')
      .all(meeting.id).map(row => row.contact_id);
    if (attendeeIds.length && projectIds.length) {
      const deleteLink = hub.prepare(`
        DELETE FROM contact_projects
        WHERE contact_id = ? AND project_id = ? AND role = 'meeting attendee'
      `);
      for (const contactId of attendeeIds) {
        for (const projectId of projectIds) {
          result.deleted.contactProjectLinks += deleteLink.run(contactId, projectId).changes || 0;
        }
      }
    }

    if (meeting.source === 'transcript') {
      hub.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meeting.id);
      hub.prepare('DELETE FROM meetings WHERE id = ? AND user = ?').run(meeting.id, user);
      result.deleted.meeting = 1;
    }
  }

  hub.prepare('DELETE FROM meeting_intakes WHERE id = ? AND user = ?').run(intake.id, user);
  return result;
}

async function createTaskDelete(user, taskId) {
  const { deleteTaskEverywhere } = require('./google-tasks');
  return deleteTaskEverywhere(user, taskId, { status: 'wrong' });
}

module.exports = {
  processMeetingTranscript,
  deleteMeetingIntake,
  parseJsonArray,
};
