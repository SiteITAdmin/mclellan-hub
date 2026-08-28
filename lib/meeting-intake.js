'use strict';

const db = require('./db');
const { uuid } = require('./id');
const { PROMPTS } = require('./prompts');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES } = require('./openrouter-attribution');
const { chatJson } = require('./chat-completions');
const { createTask } = require('./google-tasks');
const { legacyDirectCrmWritesEnabled } = require('./crm-pipeline-mode');
const { admitSource } = require('./source-admission');
const { resolveMeetingEntities } = require('./entity-resolution');
const {
  assessTranscriptIntelligibility,
  extractionDeclaresUnintelligible,
  monumentalTranscriptError,
} = require('./transcript-quality');

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

// Transcript evidence is canonical raw input.  Unlike display/model fields it
// must never be clipped by an acquisition limit; downstream prompts may bound
// a copy, but the complete source remains in meeting_intakes for chunked CRM
// knowledge synthesis and retry.
function rawTranscriptText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n');
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
  if (isPlaceholderPersonName(normalized)) return null;
  return contacts.find(contact =>
    personTerms(contact).some(term => String(term).trim().toLowerCase() === normalized)
  ) || null;
}

function findProject(projects, nameOrSlug) {
  const normalized = String(nameOrSlug || '').trim().toLowerCase();
  if (!normalized) return null;
  return (projects || []).find(project =>
    project.slug?.toLowerCase() === normalized
    || project.name?.toLowerCase() === normalized
  ) || null;
}

function findCompany(companies, name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return null;
  return (companies || []).find(company => company.name?.toLowerCase() === normalized) || null;
}

function isNonPersonEntityName(context, name) {
  return !!(findProject(context.projects, name) || findCompany(context.companies, name));
}

function isPlaceholderPersonName(name) {
  const clean = String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return /^(speaker|participant)(?:\s*\d+)?$/.test(clean)
    || /^(unknown|unnamed)(?:\s+(speaker|participant|person))?$/.test(clean);
}

// Model-extracted names are evidence for synthesis, not permission to create
// operational contacts.  Explicit attendee names are entered through the CRM
// UI first, then arrive here as attendeeContactIds; this resolver may only
// match an existing contact row.
function resolveExistingContact(contacts, name, context = {}) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  if (isPlaceholderPersonName(clean)) return null;
  if (isNonPersonEntityName(context, clean)) return null;
  return findContact(contacts, clean);
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

function validActionOwnerType(value) {
  return ['douglas', 'known_person', 'unknown_speaker', 'external', 'team', 'project'].includes(value)
    ? value
    : 'external';
}

function validActionStatus(value) {
  return ['open', 'blocked', 'done', 'unknown'].includes(value) ? value : 'open';
}

function genericSpeakerLabels(transcript) {
  const speakerRe = /^\s*((?:speaker|participant)(?:\s*\d+)?)\s*(?:[:：-]\s*|\|\s*(?:(?:\d{1,2}:)?\d{1,2}:\d{2})?\s*)(.*)$/i;
  const timestampOnlyRe = /^(?:(?:\d{1,2}:)?\d{1,2}:\d{2})$/;
  const byLabel = new Map();
  const lines = String(transcript || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(speakerRe);
    if (!match) continue;
    const label = match[1].replace(/\s+/g, ' ').trim();
    let quote = match[2].trim();
    if (!quote || timestampOnlyRe.test(quote)) {
      quote = '';
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        if (speakerRe.test(candidate)) break;
        quote = candidate;
        break;
      }
    }
    if (!quote) continue;
    const existing = byLabel.get(label) || [];
    if (existing.length < 4) existing.push(quote.slice(0, 260));
    byLabel.set(label, existing);
  }
  return [...byLabel.entries()].map(([label, samples]) => ({ label, samples }));
}

function speakerReviewForTranscript(transcript) {
  const speakers = genericSpeakerLabels(transcript);
  return speakers.length ? { speakers } : null;
}

function applySpeakerMap(transcript, speakerMap = {}) {
  let resolved = String(transcript || '');
  const entries = Object.entries(speakerMap)
    .filter(([, name]) => String(name || '').trim())
    .sort((a, b) => b[0].length - a[0].length);
  for (const [label, name] of entries) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Krisp transcripts label lines as "Speaker 1 | 00:00", not "Speaker 1:"
    const re = new RegExp(`(^|\\n)(\\s*)${escaped}\\s*([:：-]|\\|)`, 'gi');
    resolved = resolved.replace(re, (_, prefix, indent, sep) => `${prefix}${indent}${name}${sep === '|' ? ' |' : ':'}`);
  }
  return resolved;
}

function meetingMarkdown({ title, date, summary, attendees, outcomes, actionItems, projectNotes, openQuestions, transcript, signals = {} }) {
  const signalLine = [
    signals.urgency && signals.urgency !== 'routine' ? `Urgency: ${signals.urgency}` : null,
    signals.decision_quality ? `Decision quality: ${signals.decision_quality}` : null,
    (signals.risk_flags || []).length ? `Risk flags: ${signals.risk_flags.join(', ')}` : null,
  ].filter(Boolean).join(' · ');
  const lines = [
    `# ${title}`,
    '',
    `Date: ${date}`,
    attendees.length ? `Attendees: ${attendees.map(a => a.name).join(', ')}` : null,
    signalLine || null,
    '',
    '## Summary',
    summary || 'No summary captured.',
    '',
    '## Action Register',
  ].filter(line => line !== null);

  if (actionItems.length) {
    for (const item of actionItems) {
      const meta = [
        item.owner_type && item.owner_type !== 'known_person' ? item.owner_type.replace('_', ' ') : null,
        item.due_date ? `due ${item.due_date}` : null,
        item.follow_up_by_douglas ? 'Douglas to track' : null,
        item.status && item.status !== 'open' ? item.status : null,
        item.blocked_by ? `blocked by: ${item.blocked_by}` : null,
      ].filter(Boolean).join('; ');
      lines.push(`- ${item.owner}: ${item.task}${meta ? ` (${meta})` : ''}`);
      if (item.detail) lines.push(`  - ${item.detail}`);
      if (item.success_criteria) lines.push(`  - Done when: ${item.success_criteria}`);
    }
  } else {
    lines.push('None captured.');
  }

  lines.push(
    '',
    '## Outcomes',
  );

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

function normalizeActionRegister(extraction, context, primaryProject) {
  const actions = [];
  const addAction = (item = {}) => {
    const task = cleanText(item.task || item.text, 500);
    if (!task) return;
    const matched = findContact(context.contacts, item.matched_contact);
    const owner = cleanText(item.owner || item.subject || matched?.name || 'Unassigned', 120);
    const project = exactProject(context.projects, item.project_slug) || primaryProject;
    actions.push({
      owner,
      matched_contact: matched?.name || null,
      owner_type: validActionOwnerType(item.owner_type || (matched ? 'known_person' : 'external')),
      task,
      detail: cleanText(item.detail, 800),
      project_slug: project?.slug || null,
      due_date: validDate(item.due_date, '') || null,
      follow_up_by_douglas: Boolean(item.follow_up_by_douglas || item.google_task),
      status: validActionStatus(item.status),
      blocked_by: cleanText(item.blocked_by, 300) || null,
      success_criteria: cleanText(item.success_criteria, 300) || null,
    });
  };

  for (const item of extraction.action_register || []) addAction(item);
  if (!actions.length) {
    for (const update of extraction.crm_updates || []) {
      if (validFactType(update.type) !== 'action') continue;
      addAction({
        owner: update.subject,
        matched_contact: update.matched_contact,
        owner_type: update.matched_contact ? 'known_person' : 'external',
        task: update.text,
        project_slug: update.project_slug,
        due_date: update.due_date,
        follow_up_by_douglas: update.google_task,
      });
    }
  }

  const seen = new Set();
  return actions.filter(action => {
    const key = `${action.owner.toLowerCase()}|${action.task.toLowerCase()}|${action.project_slug || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const parsed = await chatJson({
    feature: 'meeting_intake',
    messages: [{ role: 'user', content: buildPrompt(user, options, context) }],
    user,
    label: 'Meeting intake response',
  });
  if (!parsed || typeof parsed !== 'object' || !parsed.meeting) {
    throw new Error('Meeting intake model returned an empty or invalid extraction');
  }
  return parsed;
}

function extractionInputHash({ transcript, title, meetingDate, projectSlug }) {
  return require('crypto').createHash('sha256')
    .update([transcript, title, meetingDate, projectSlug].map(v => String(v || '')).join('\u0000'))
    .digest('hex');
}

function buildIntakeContext(hub, user) {
  return {
    contacts: hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ? ORDER BY name').all(user),
    projects: hub.prepare('SELECT id, slug, name FROM projects WHERE user = ? ORDER BY name').all(user),
    companies: hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(user),
  };
}

// Runs the extraction on a draft and stores it (hash-keyed against the inputs)
// so the user can review what WILL be created before submitting. Submit reuses
// the stored extraction when nothing changed, so the LLM is not paid twice.
async function previewMeetingIntake(user, intakeId) {
  const hub = db.hub();
  const intake = hub.prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, user);
  if (!intake) throw new Error('Intake not found');
  if (!['draft', 'error'].includes(intake.status)) throw new Error('Only drafts can be previewed');
  const existingExtraction = parseJsonObject(intake.extraction);
  const options = existingExtraction.intake_options || {};
  const rawTranscript = rawTranscriptText(intake.transcript);
  const quality = assessTranscriptIntelligibility(rawTranscript);
  if (quality.unintelligible) {
    markIntakeUnintelligible(user, intakeId, quality, parseJsonObject(intake.extraction));
    throw new Error(monumentalTranscriptError(quality));
  }
  const inputs = {
    transcript: rawTranscript,
    title: intake.title || options.title || '',
    meetingDate: options.meeting_date || '',
    projectSlug: intake.project_slug || options.project_slug || '',
  };
  const hash = extractionInputHash(inputs);
  if (existingExtraction.preview && existingExtraction.preview_hash === hash) {
    return { ok: true, cached: true };
  }
  const context = buildIntakeContext(hub, user);
  let extraction;
  try {
    extraction = await extractMeetingIntelligence(user, inputs, context);
    if (!extraction || typeof extraction !== 'object' || !extraction.meeting) {
      throw new Error('Meeting intake model returned an empty or invalid extraction');
    }
  } catch (err) {
    // Draft preview is itself a model attempt.  Keep the complete transcript
    // and expose a retryable error rather than leaving the failure invisible.
    hub.prepare(`
      UPDATE meeting_intakes
      SET status = 'error', error = ?, transcript = ?
      WHERE id = ? AND user = ?
    `).run(err?.message || String(err), rawTranscript, intakeId, user);
    throw err;
  }
  // Preview may retain model project matches as evidence, but only an
  // explicitly selected project is an operational routing target.
  const primaryProject = exactProject(context.projects, inputs.projectSlug);
  extraction.action_register = normalizeActionRegister(extraction, context, primaryProject);
  hub.prepare('UPDATE meeting_intakes SET extraction = ? WHERE id = ? AND user = ?').run(
    JSON.stringify({ ...existingExtraction, preview: extraction, preview_hash: hash }),
    intakeId, user
  );
  return { ok: true, cached: false };
}

async function processMeetingTranscript(user, {
  intakeId: providedIntakeId = '',
  transcript,
  title = '',
  meetingDate = '',
  meetingId = '',
  projectSlug = '',
  companyId = '',
  attendeeContactIds = [],
  sourceFilename = '',
  extractMeetingIntelligenceFn = extractMeetingIntelligence,
} = {}) {
  const hub = db.hub();
  const rawTranscript = rawTranscriptText(transcript);
  if (!rawTranscript.trim()) throw new Error('Transcript is required');
  const intakeId = providedIntakeId || uuid();

  // Persist the faithful source before any model call.  This makes a direct
  // invocation retryable even when extraction fails, and prevents a bounded
  // prompt copy from masquerading as the canonical transcript.
  const existingRow = hub.prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, user);
  const persistedExtraction = existingRow ? parseJsonObject(existingRow.extraction) : {};
  const existingOptions = persistedExtraction.intake_options || {};
  const processingExtraction = JSON.stringify({
    ...persistedExtraction,
    // There is no separate updated_at column on historical intakes.  Keep a
    // processing-start receipt in the existing raw metadata so source evidence
    // can distinguish a live extraction from a crash-window stale one.
    intake_processing_started_at: Math.floor(Date.now() / 1000),
  });
  const preservedProjectSlug = projectSlug || existingRow?.project_slug || existingOptions.project_slug || null;
  const preservedTitle = title || existingRow?.title || '';
  const preservedMeetingDate = meetingDate || existingOptions.meeting_date || '';
  if (existingRow) {
    hub.prepare(`
      UPDATE meeting_intakes
      SET meeting_id = ?, project_slug = ?, title = ?, source_filename = ?,
          transcript = ?, extraction = ?, status = 'processing', error = NULL
      WHERE id = ? AND user = ?
    `).run(
      meetingId || existingRow.meeting_id || null,
      preservedProjectSlug,
      preservedTitle,
      sourceFilename || existingRow.source_filename || null,
      rawTranscript,
      processingExtraction,
      intakeId,
      user,
    );
  } else {
    hub.prepare(`
      INSERT INTO meeting_intakes
        (id, user, meeting_id, project_slug, title, source_filename, transcript, summary, extraction, created_counts, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '{}', 'processing')
    `).run(
      intakeId,
      user,
      meetingId || null,
      preservedProjectSlug,
      preservedTitle,
      sourceFilename || null,
      rawTranscript,
      processingExtraction,
    );
  }

  // The ingest door — see lib/source-admission.js.  A summary-only intake is
  // incomplete evidence, and that verdict belongs here at capture rather than
  // being rediscovered by the engine after the transcript is gone.
  const quality = assessTranscriptIntelligibility(rawTranscript);
  if (quality.unintelligible) {
    markIntakeUnintelligible(user, intakeId, quality, persistedExtraction);
    const err = new Error(monumentalTranscriptError(quality));
    err.code = 'UNINTELLIGIBLE_TRANSCRIPT';
    throw err;
  }
  try {
    admitSource(user, 'meeting_intake', intakeId, { ingester: 'meeting-intake' });
  } catch (error) {
    console.error(`[meeting-intake] source admission failed for ${intakeId}:`, error.message);
  }

  const context = buildIntakeContext(hub, user);

  const storedIntake = hub.prepare('SELECT extraction FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, user);
  const existingExtraction = storedIntake ? parseJsonObject(storedIntake.extraction) : {};

  const inputHash = extractionInputHash({
    transcript: rawTranscript,
    title: preservedTitle,
    meetingDate: preservedMeetingDate,
    projectSlug: preservedProjectSlug,
  });
  let extraction;
  try {
    extraction = (existingExtraction.preview && existingExtraction.preview_hash === inputHash)
      ? existingExtraction.preview
      : await extractMeetingIntelligenceFn(user, {
          // buildPrompt bounds only the model copy; rawTranscript remains
          // complete in the canonical meeting_intakes source row.
          transcript: rawTranscript,
          title: preservedTitle,
          meetingDate: preservedMeetingDate,
          projectSlug: preservedProjectSlug,
        }, context);
    if (!extraction || typeof extraction !== 'object' || !extraction.meeting) {
      throw new Error('Meeting intake model returned an empty or invalid extraction');
    }
    if (extractionDeclaresUnintelligible(extraction)) {
      const assessed = {
        ...quality,
        unintelligible: true,
        completeness: 'unintelligible_transcript',
        reason: 'extractor_declared_unintelligible',
      };
      markIntakeUnintelligible(user, intakeId, assessed, { ...existingExtraction, ...extraction });
      const err = new Error(monumentalTranscriptError(assessed));
      err.code = 'UNINTELLIGIBLE_TRANSCRIPT';
      throw err;
    }
  } catch (err) {
    hub.prepare(`
      UPDATE meeting_intakes
      SET status = 'error', error = ?, transcript = ?
      WHERE id = ? AND user = ?
    `).run(err?.message || String(err), rawTranscript, intakeId, user);
    throw err;
  }

  // Check data as it comes in: link spoken/transcribed names to existing
  // contacts before anything downstream reads matched_contact. Deterministic
  // exact/alias match first, then a bounded model adjudication that also learns
  // the garbled spelling as a durable alias so the next transcript is free.
  try {
    await resolveMeetingEntities({
      user,
      extraction,
      contacts: context.contacts,
      projects: context.projects,
      companies: context.companies,
      meetingTitle: preservedTitle || extraction.meeting?.title || '',
      projectSlug: preservedProjectSlug,
      sourceKind: 'meeting_intake',
      sourceId: intakeId,
    });
  } catch (resolveErr) {
    // Resolution is an enrichment: a failure must never fail the intake. The
    // unresolved name simply surfaces as a Question, as it did before.
    console.warn('[meeting-intake] entity resolution failed:', resolveErr.message);
  }

  const extractedMeeting = extraction.meeting || {};
  const explicitProject = exactProject(context.projects, preservedProjectSlug);
  // Model project matches remain in the stored extraction for synthesis and
  // review.  They are never promoted to an operational project destination.
  const primaryProject = explicitProject;
  const meetingTitle = cleanText(preservedTitle, 160) || cleanText(extractedMeeting.title, 160) || 'Meeting transcript';
  const date = validDate(preservedMeetingDate || extractedMeeting.date);
  const summary = cleanText(extractedMeeting.summary, 4000);
  let meeting = meetingId
    ? hub.prepare('SELECT * FROM meetings WHERE id = ? AND user = ?').get(meetingId, user)
    : null;
  if (meetingId && !meeting) throw new Error('Selected meeting was not found');

  const attendeeContacts = [];
  for (const attendee of extractedMeeting.attendees || []) {
    const contact = findContact(context.contacts, attendee.matched_contact)
      || resolveExistingContact(context.contacts, attendee.name, context);
    if (contact && !attendeeContacts.some(c => c.id === contact.id)) attendeeContacts.push(contact);
  }

  const explicitCompany = companyId
    ? context.companies.find(company => company.id === companyId) || null
    : null;
  const selectedCompany = explicitCompany || (extractedMeeting.companies || [])
    .map(name => context.companies.find(company => company.name.toLowerCase() === String(name).toLowerCase()))
    .find(Boolean) || null;

  const forcedAttendeeIds = new Set((Array.isArray(attendeeContactIds) ? attendeeContactIds : [attendeeContactIds]).filter(Boolean));
  for (const contact of context.contacts) {
    if (forcedAttendeeIds.has(contact.id) && !attendeeContacts.some(c => c.id === contact.id)) {
      attendeeContacts.push(contact);
    }
  }

  if (!meeting) {
    const newMeetingId = uuid();
    hub.prepare(`
      INSERT INTO meetings
        (id, user, title, meeting_date, meeting_time, duration_mins, location, notes, company_id, source)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 'transcript')
    `).run(newMeetingId, user, meetingTitle, date, summary, selectedCompany?.id || null);
    meeting = hub.prepare('SELECT * FROM meetings WHERE id = ?').get(newMeetingId);
  } else if (summary || explicitCompany || meetingTitle || date) {
    const notes = [meeting.notes, `Transcript intake ${todayIso()}:\n${summary}`].filter(Boolean).join('\n\n');
    hub.prepare(`
      UPDATE meetings
      SET title = ?, meeting_date = ?, notes = ?, company_id = COALESCE(?, company_id)
      WHERE id = ? AND user = ?
    `).run(meetingTitle, date, notes, explicitCompany?.id || null, meeting.id, user);
    meeting.title = meetingTitle;
    meeting.meeting_date = date;
    meeting.notes = notes;
    if (explicitCompany) meeting.company_id = explicitCompany.id;
  }

  const addAttendee = hub.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, contact_id) VALUES (?, ?)');
  for (const contact of attendeeContacts) addAttendee.run(meeting.id, contact.id);

  const validContactIds = new Set(context.contacts.map(contact => contact.id));
  const factsCreated = [];
  const derivedProjectNotes = [];
  for (const update of extraction.crm_updates || []) {
    // Only the explicit project selection may receive an operational fact or
    // derived project note.  Model project fields remain source evidence.
    const project = primaryProject;
    const subject = findContact(context.contacts, update.matched_contact)
      || resolveExistingContact(context.contacts, update.subject, context);
    const text = cleanText(update.text, 1200);
    if (!text) continue;
    if (!subject) {
      if (project) derivedProjectNotes.push({ project_slug: project.slug, note: text, type: validFactType(update.type) });
      continue;
    }
    const linked = (update.linked_people || [])
      .map(name => findContact(context.contacts, name)?.id)
      .filter(id => id && id !== subject.id && validContactIds.has(id));
    if (legacyDirectCrmWritesEnabled()) {
      const factId = uuid();
      hub.prepare(`
        INSERT INTO crm_facts
          (id, user, contact_id, fact, status, source, meeting_id, company_id, linked_contacts, fact_type, project_slug)
        VALUES (?, ?, ?, ?, 'active', 'meeting-transcript', ?, ?, ?, ?, ?)
      `).run(
        factId, user, subject.id, text, meeting.id, meeting.company_id,
        JSON.stringify([...new Set(linked)]), validFactType(update.type), project?.slug || null
      );
      factsCreated.push({ id: factId, subject: subject.name, text, type: validFactType(update.type), projectSlug: project?.slug || null });
    } else {
      factsCreated.push({ id: null, subject: subject.name, text, type: validFactType(update.type), projectSlug: project?.slug || null });
    }
  }

  const actionItems = normalizeActionRegister(extraction, context, primaryProject);
  let tasksCreated = 0;
  if (legacyDirectCrmWritesEnabled()) {
    for (const action of actionItems) {
      if (!action.follow_up_by_douglas && action.owner_type !== 'douglas') continue;
      const subject = findContact(context.contacts, action.matched_contact) || findContact(context.contacts, action.owner);
      const titleText = cleanText(action.task, 180);
      if (!titleText) continue;
      // Never route a model-inferred project through the legacy rollback path;
      // only the explicit user-selected project is operationally eligible.
      const project = primaryProject;
      const task = await createTask(user, {
        title: titleText,
        notes: [
          `From ${meetingTitle}`,
          action.detail || null,
          summary ? summary.slice(0, 500) : null,
        ].filter(Boolean).join('\n\n'),
        due: validDate(action.due_date, '') || undefined,
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
  }

  // Project documents/routes are allowed only when the caller selected an
  // explicit projectSlug.  Extracted project matches, notes, outcomes, and
  // actions stay in meeting_intakes evidence otherwise.
  const linkedProjectSlugs = primaryProject?.slug ? [primaryProject.slug] : [];

  const markdown = meetingMarkdown({
    title: meetingTitle,
    date,
    summary,
    attendees: attendeeContacts,
    outcomes: factsCreated,
    actionItems,
    projectNotes: [
      ...(extraction.project_notes || []).filter(note => note?.project_slug && note?.note),
      ...derivedProjectNotes,
    ],
    openQuestions: extraction.open_questions || [],
    transcript: rawTranscript,
    signals: {
      urgency: extraction.urgency,
      decision_quality: extraction.decision_quality,
      risk_flags: extraction.risk_flags || [],
    },
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
    if (legacyDirectCrmWritesEnabled()) {
      for (const contact of attendeeContacts) {
        hub.prepare('INSERT OR IGNORE INTO contact_projects (contact_id, project_id, role) VALUES (?, ?, ?)')
          .run(contact.id, project.id, 'meeting attendee');
      }
    }
  }

  const counts = {
    attendees: attendeeContacts.length,
    facts: factsCreated.length,
    actions: actionItems.length,
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
      rawTranscript, summary,
      // preview served its purpose once processed — drop it so the stored
      // extraction is the single authoritative copy
      JSON.stringify((({ preview, preview_hash, intake_processing_started_at, ...rest }) => rest)({ ...existingExtraction, ...extraction, action_register: actionItems })),
      JSON.stringify(counts),
      intakeId, user
    );
  } else {
    hub.prepare(`
      INSERT INTO meeting_intakes
        (id, user, meeting_id, project_slug, title, source_filename, transcript, summary, extraction, created_counts, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processed')
    `).run(
      intakeId, user, meeting.id, primaryProject?.slug || null, meetingTitle, sourceFilename || null,
      rawTranscript, summary, JSON.stringify({ ...extraction, action_register: actionItems }), JSON.stringify(counts)
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

function captureIngester(extraction = {}) {
  return String(extraction.source || '').toLowerCase() === 'krisp' ? 'krisp' : 'meeting-intake';
}

function captureMetadata(extraction = {}) {
  return {
    source: extraction.source || null,
    krisp: extraction.krisp || null,
    intake_options: extraction.intake_options || {},
    speaker_review: extraction.speaker_review || null,
  };
}

function markIntakeUnintelligible(user, intakeId, assessment, extraction = {}) {
  const hub = db.hub();
  const error = monumentalTranscriptError(assessment);
  hub.prepare(`
    UPDATE meeting_intakes
    SET status = 'error', error = ?, summary = '', extraction = ?, created_counts = '{}'
    WHERE id = ? AND user = ?
  `).run(
    error,
    JSON.stringify({ ...captureMetadata(extraction), transcript_quality: assessment }),
    intakeId,
    user,
  );
  try {
    admitSource(user, 'meeting_intake', intakeId, { ingester: captureIngester(extraction) });
  } catch (error_) {
    console.error(`[meeting-intake] source admission failed for ${intakeId}:`, error_.message);
  }
  return error;
}

function projectedEngineTasks(user, intakeId) {
  const hub = db.hub();
  const byLegacyKey = hub.prepare(`
    SELECT id FROM google_tasks
    WHERE user = ? AND source = 'crm-engine' AND source_id LIKE ?
  `).all(user, `crm-engine:meeting_intake:${intakeId}:%`);
  const byOutcome = hub.prepare(`
    SELECT task_id AS id FROM crm_action_outcomes
    WHERE user = ? AND source_kind = 'meeting_intake' AND source_id = ?
      AND task_id IS NOT NULL AND TRIM(task_id) != ''
  `).all(user, intakeId);
  const byActionKey = hub.prepare(`
    SELECT t.id FROM google_tasks t
    JOIN crm_action_outcomes o
      ON o.user = t.user
     AND t.source = 'crm-engine'
     AND t.source_id = ('crm-action:' || o.action_key)
    WHERE o.user = ? AND o.source_kind = 'meeting_intake' AND o.source_id = ?
  `).all(user, intakeId);
  const ids = new Set();
  for (const row of [...byLegacyKey, ...byOutcome, ...byActionKey]) {
    if (row?.id) ids.add(row.id);
  }
  return [...ids].map(id => ({ id }));
}

async function failUnintelligibleMeetingIntake(user, intakeId, { assessment = null } = {}) {
  const hub = db.hub();
  const intake = hub.prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, user);
  if (!intake) return { ok: false, error: 'Intake not found' };
  const judged = assessment || assessTranscriptIntelligibility(intake.transcript);
  const extraction = parseJsonObject(intake.extraction);
  const result = {
    ok: false,
    unintelligible: true,
    assessment: judged,
    deleted: {
      engineTasks: 0, tasks: 0, facts: 0, documents: 0, contactProjectLinks: 0,
      meeting: 0, atoms: 0, atomRefs: 0, embeddings: 0,
    },
    taskErrors: [],
  };
  await purgeIntakeDerivedKnowledge(user, intake, result);

  if (intake.meeting_id) {
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
    result.deleted.facts = hub.prepare(`
      DELETE FROM crm_facts
      WHERE user = ? AND meeting_id = ? AND source = 'meeting-transcript'
    `).run(user, intake.meeting_id).changes || 0;
    const meeting = hub.prepare('SELECT * FROM meetings WHERE id = ? AND user = ?').get(intake.meeting_id, user);
    if (meeting && meeting.source === 'transcript') {
      hub.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meeting.id);
      hub.prepare('DELETE FROM meetings WHERE id = ? AND user = ?').run(meeting.id, user);
      result.deleted.meeting = 1;
    }
  }

  markIntakeUnintelligible(user, intakeId, judged, extraction);
  hub.prepare('UPDATE meeting_intakes SET meeting_id = NULL WHERE id = ? AND user = ?').run(intakeId, user);
  result.error = monumentalTranscriptError(judged);
  return result;
}

// Deleting a meeting means deleting what was derived from it. Three of these
// were missed before, and the gap was only visible as damage: tasks the CRM
// engine projected are keyed on the intake id rather than the meeting id, so the
// meeting-transcript sweep never saw them and six survived citing a source that
// no longer existed — three of them still open, with evidence Douglas could not
// check. Embeddings were left behind too, so a deleted meeting stayed searchable
// as orphaned chunks pointing at nothing.
//
// Atoms are the exception to "delete it all": an atom may be supported by this
// meeting *and* by an email or document. Those keep their independent support
// and lose only this reference; only atoms left with no source at all are
// removed. Receipts are deliberately untouched — they are immutable audit
// evidence of what the pipeline decided, not knowledge about Douglas.
async function purgeIntakeDerivedKnowledge(user, intake, result) {
  const hub = db.hub();

  const engineTasks = projectedEngineTasks(user, intake.id);
  for (const task of engineTasks) {
    try {
      const deleted = await createTaskDelete(user, task.id);
      if (deleted.ok) result.deleted.engineTasks++;
      if (deleted.remoteError) result.taskErrors.push(deleted.remoteError);
    } catch (err) {
      result.taskErrors.push(err.message);
    }
  }

  try {
    const { removeSource } = require('./retrieval');
    const before = hub.prepare(
      'SELECT COUNT(*) n FROM embeddings WHERE source_kind = ? AND source_id = ?'
    ).get('meeting_intake', intake.id);
    removeSource('meeting_intake', intake.id);
    result.deleted.embeddings = before?.n || 0;
  } catch (err) {
    result.taskErrors.push(`embeddings: ${err.message}`);
  }

  const atoms = hub.prepare(
    'SELECT id, source_refs FROM knowledge_atoms WHERE user = ? AND source_refs LIKE ?'
  ).all(user, `%${intake.id}%`);
  const dropAtom = hub.prepare('DELETE FROM knowledge_atoms WHERE id = ? AND user = ?');
  const rewriteRefs = hub.prepare('UPDATE knowledge_atoms SET source_refs = ? WHERE id = ? AND user = ?');
  for (const atom of atoms) {
    let refs;
    try { refs = JSON.parse(atom.source_refs || '[]'); } catch (_) { continue; }
    if (!Array.isArray(refs)) continue;
    const kept = refs.filter(ref => String(ref?.id || '') !== intake.id);
    if (kept.length === refs.length) continue;
    if (kept.length) {
      rewriteRefs.run(JSON.stringify(kept), atom.id, user);
      result.deleted.atomRefs++;
    } else {
      result.deleted.atoms += dropAtom.run(atom.id, user).changes || 0;
    }
  }
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
      engineTasks: 0,
      facts: 0,
      documents: 0,
      contactProjectLinks: 0,
      meeting: 0,
      atoms: 0,
      atomRefs: 0,
      embeddings: 0,
    },
    taskErrors: [],
  };

  // Everything below is keyed on the intake, not the meeting, so it runs even
  // for an intake that never produced a meeting row.
  await purgeIntakeDerivedKnowledge(user, intake, result);

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

// Read-only mirror of deleteMeetingIntake's queries so the UI can show a
// truthful inventory of what a delete WILL remove before it is confirmed.
function intakeDeleteInventory(user, intakeId) {
  const hub = db.hub();
  const intake = hub.prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, user);
  if (!intake) return null;
  const inventory = { meeting: null, tasks: 0, engineTasks: 0, facts: 0, documents: 0, atoms: 0, embeddings: 0 };
  // Intake-keyed artifacts exist whether or not a meeting row was ever created,
  // so they are counted before the meeting_id short-circuit below.
  inventory.engineTasks = projectedEngineTasks(user, intake.id).length;
  inventory.embeddings = hub.prepare(
    'SELECT COUNT(*) AS n FROM embeddings WHERE source_kind = ? AND source_id = ?'
  ).get('meeting_intake', intake.id)?.n || 0;
  // Only atoms this intake solely supports disappear; the rest just lose a ref.
  for (const atom of hub.prepare(
    'SELECT source_refs FROM knowledge_atoms WHERE user = ? AND source_refs LIKE ?'
  ).all(user, `%${intake.id}%`)) {
    let refs;
    try { refs = JSON.parse(atom.source_refs || '[]'); } catch (_) { continue; }
    if (Array.isArray(refs) && refs.length && refs.every(ref => String(ref?.id || '') === intake.id)) {
      inventory.atoms++;
    }
  }
  if (!intake.meeting_id) return inventory;
  const meeting = hub.prepare('SELECT id, title, source FROM meetings WHERE id = ? AND user = ?').get(intake.meeting_id, user);
  if (meeting && meeting.source === 'transcript') inventory.meeting = meeting.title;
  inventory.tasks = hub.prepare(`
    SELECT COUNT(*) AS n FROM google_tasks
    WHERE user = ? AND source = 'meeting-transcript' AND source_id LIKE ?
  `).get(user, `meeting:${intake.meeting_id}:%`)?.n || 0;
  inventory.facts = hub.prepare(`
    SELECT COUNT(*) AS n FROM crm_facts
    WHERE user = ? AND meeting_id = ? AND source = 'meeting-transcript'
  `).get(user, intake.meeting_id)?.n || 0;
  const transcriptNeedle = cleanText(intake.transcript, 1000);
  if (transcriptNeedle) {
    inventory.documents = hub.prepare(`
      SELECT id, markdown FROM documents WHERE user = ? AND filename LIKE '% [meeting].md'
    `).all(user).filter(doc => String(doc.markdown || '').includes(transcriptNeedle)).length;
  }
  return inventory;
}

module.exports = {
  processMeetingTranscript,
  previewMeetingIntake,
  deleteMeetingIntake,
  failUnintelligibleMeetingIntake,
  intakeDeleteInventory,
  speakerReviewForTranscript,
  applySpeakerMap,
  isPlaceholderPersonName,
  isNonPersonEntityName,
  normalizeActionRegister,
  findProject,
  findCompany,
  parseJsonArray,
};
