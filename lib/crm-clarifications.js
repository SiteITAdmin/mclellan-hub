'use strict';

// The answer side of the quality boards. The boards detect and ask; nothing
// could answer, so every open question was re-asked nightly forever and the
// daily brief could only link at a transcript. This module turns each flagged
// item into an answerable question with a stable key, and turns Douglas's answer
// into knowledge.
//
// Input contract: raw store = crm_clarification_answers (his declaration is new
// raw input); synthesis = composeAnswerStatement (model writes one declarative
// sentence from question + answer); compiled layer = knowledge_atoms
// (derived_by='manual', confidence 1.0, source_refs back to the flagged row);
// visible surfaces = /crm/questions, the knowledge layer, the Consigliere brief.

const crypto = require('crypto');
const db = require('./db');
const { uuid } = require('./id');
const {
  crmContacts,
  crmProjectEvidence,
  crmTasks,
  findProjectScopedPersonIssues,
  intakeClarificationIssues,
  recentMeetingIntakes,
  taskActionIssues,
} = require('./hub-quality-board');

const KINDS = {
  MEETING_QUESTION: 'meeting_question',
  TASK_OWNER: 'task_owner',
  PERSON_ALIAS: 'person_alias',
};

// Speaker mapping already has its own screen on the intake page; do not ask for
// it a second time here.
const SPEAKER_REVIEW_TYPE = 'generic_speaker_labels';

function hash(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

// Stable across nightly re-runs: the same flagged item must produce the same key
// tomorrow, or an answered question comes back.
function clarificationKey(item = {}) {
  switch (item.kind) {
    case KINDS.MEETING_QUESTION:
      return hash(['mq', item.intake_id || '', item.type || '', item.evidence || '']);
    case KINDS.TASK_OWNER:
      return hash(['to', item.intake_id || '', item.owner || '', item.task || '']);
    case KINDS.PERSON_ALIAS:
      return hash(['pa', [...(item.contact_ids || [])].sort().join(',')]);
    default:
      return hash(['x', JSON.stringify(item)]);
  }
}

function answeredRows(user = 'douglas') {
  try {
    return db.hub().prepare(
      'SELECT * FROM crm_clarification_answers WHERE user = ? ORDER BY created_at DESC'
    ).all(user);
  } catch (_) {
    return [];
  }
}

function answeredKeys(user = 'douglas') {
  return new Set(answeredRows(user).map(row => row.question_key));
}

function projectsBySlug(user = 'douglas') {
  const map = new Map();
  try {
    for (const row of db.hub().prepare('SELECT id, slug, name FROM projects WHERE user = ?').all(user)) {
      map.set(row.slug, row);
    }
  } catch (_) { /* no projects table in a bare test db */ }
  return map;
}

// ── The open question inventory ───────────────────────────────────────────────

function meetingQuestions(intakes, contacts) {
  return intakeClarificationIssues(intakes, contacts)
    .filter(issue => issue.type !== SPEAKER_REVIEW_TYPE)
    .map(issue => ({
      kind: KINDS.MEETING_QUESTION,
      type: issue.type,
      intake_id: issue.intake_id,
      title: issue.title,
      project_slug: issue.project_slug || null,
      evidence: issue.evidence,
      question: issue.evidence,
      names: issue.names || null,
    }));
}

function taskOwnerQuestions(tasks, intakes, contacts) {
  return taskActionIssues({ tasks, intakes, contacts }).unknownOwnerActions.map(action => ({
    kind: KINDS.TASK_OWNER,
    intake_id: action.intake_id,
    title: action.title,
    project_slug: action.project_slug || null,
    owner: action.owner,
    task: action.task,
    question: `Who owns "${action.task}"? The transcript says ${action.owner}, who is not a known person.`,
  }));
}

function personAliasQuestions(contacts, projectEvidence) {
  const { duplicateCandidates, transcriptionCandidates } = findProjectScopedPersonIssues(contacts, projectEvidence);
  return [...duplicateCandidates, ...transcriptionCandidates].map(candidate => ({
    kind: KINDS.PERSON_ALIAS,
    contacts: candidate.contacts,
    contact_ids: candidate.contact_ids,
    shared_projects: candidate.shared_projects,
    reason: candidate.reason,
    question: `Are ${candidate.contacts.join(' and ')} the same person?`,
  }));
}

// The shared alias string that made the pair collide — the thing to remove when
// they are in fact different people.
function overlappingAliases(contactIds = []) {
  const overlaps = [];
  try {
    const rows = db.hub().prepare(
      `SELECT id, name, aliases FROM contacts WHERE id IN (${contactIds.map(() => '?').join(',')})`
    ).all(...contactIds);
    const parsed = rows.map(row => {
      let aliases = [];
      try { aliases = JSON.parse(row.aliases || '[]'); } catch (_) { aliases = []; }
      return { ...row, aliases: Array.isArray(aliases) ? aliases.filter(Boolean) : [] };
    });
    for (const row of parsed) {
      for (const alias of row.aliases) {
        const clash = parsed.some(other => other.id !== row.id
          && (other.aliases.some(a => a.toLowerCase() === alias.toLowerCase())
            || other.name.toLowerCase() === alias.toLowerCase()));
        if (clash) overlaps.push({ contact_id: row.id, contact_name: row.name, alias });
      }
    }
  } catch (_) { /* fall through to an empty list */ }
  return overlaps;
}

function openClarifications(user = 'douglas') {
  const intakes = recentMeetingIntakes(user);
  const contacts = crmContacts(user);
  const tasks = crmTasks(user);
  const projectEvidence = crmProjectEvidence(user);
  const answered = answeredKeys(user);
  const projects = projectsBySlug(user);

  // 45 days of transcripts is a wall of questions. Newest meeting first: the
  // thing discussed this morning is the thing he can still answer from memory.
  const intakeTimes = new Map(intakes.map(intake => [intake.id, Number(intake.created_at || 0)]));

  const items = [
    ...meetingQuestions(intakes, contacts),
    ...taskOwnerQuestions(tasks, intakes, contacts),
    ...personAliasQuestions(contacts, projectEvidence),
  ]
    .map(item => ({
      ...item,
      key: clarificationKey(item),
      created_at: item.intake_id ? (intakeTimes.get(item.intake_id) || 0) : 0,
      project_name: item.project_slug ? projects.get(item.project_slug)?.name || item.project_slug : null,
    }))
    .filter(item => !answered.has(item.key))
    .sort((a, b) => b.created_at - a.created_at);

  for (const item of items) {
    if (item.kind === KINDS.PERSON_ALIAS) item.alias_overlaps = overlappingAliases(item.contact_ids);
  }
  return items;
}

// `limit` caps each group so the page opens on the recent, answerable ones;
// nothing is hidden permanently — the page offers the full list.
function groupedClarifications(user = 'douglas', { limit = 0 } = {}) {
  const items = openClarifications(user);
  const take = list => (limit > 0 ? list.slice(0, limit) : list);
  const meeting = items.filter(item => item.kind === KINDS.MEETING_QUESTION);
  const owners = items.filter(item => item.kind === KINDS.TASK_OWNER);
  const aliases = items.filter(item => item.kind === KINDS.PERSON_ALIAS);
  return {
    total: items.length,
    shown: take(meeting).length + take(owners).length + take(aliases).length,
    counts: { meeting_questions: meeting.length, task_owners: owners.length, person_aliases: aliases.length },
    meeting_questions: take(meeting),
    task_owners: take(owners),
    person_aliases: take(aliases),
  };
}

// ── Answering ─────────────────────────────────────────────────────────────────

// The answer is not the knowledge. "100GB" on its own is unusable to retrieval;
// a declarative sentence is. The model writes that sentence; if it is
// unavailable the deterministic join still reads correctly and still retrieves.
async function composeAnswerStatement({ question, answer, context = '' }) {
  const fallback = `${String(question).replace(/\s*\?\s*$/, '')} — ${answer}`;
  if (!process.env.OPENROUTER_API_KEY) return fallback;
  try {
    const { getSystemModelId } = require('./settings');
    const { requestModelObject } = require('./model-request');
    const { TASK_CODES } = require('./openrouter-attribution');
    const modelId = getSystemModelId('clarification_answer', 'system', 'anthropic/claude-sonnet-4-6');
    const result = await requestModelObject({
      modelId,
      messages: [{
        role: 'user',
        content: [
          'Turn this question and its answer into ONE declarative sentence of durable knowledge.',
          'Keep every specific (numbers, names, dates). Do not hedge, do not add anything not stated.',
          'No "Douglas said" framing — state the fact itself.',
          context ? `Context: ${context}` : '',
          `Question: ${question}`,
          `Answer: ${answer}`,
          'Return ONE JSON object: {"statement": string}',
        ].filter(Boolean).join('\n'),
      }],
      user: 'douglas',
      feature: 'clarification_answer',
      modelKey: 'clarification-answer',
      taskCode: TASK_CODES.ADMIN,
      temperature: 0.1,
      defaults: { statement: '' },
      label: 'clarification answer',
    });
    const statement = String(result.statement || '').trim();
    return statement || fallback;
  } catch (_) {
    return fallback;
  }
}

function writeManualAtom(user, { subjectKind, subjectId, subjectLabel, predicate, value, sourceRefs }) {
  const id = uuid();
  db.hub().prepare(`
    INSERT INTO knowledge_atoms
      (id, user, subject_kind, subject_id, subject_label, predicate, value, source_refs, confidence, status, derived_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0, 'active', 'manual')
  `).run(id, user, subjectKind, subjectId, subjectLabel, predicate, value, JSON.stringify(sourceRefs || []));
  return id;
}

function recordAnswerRow(user, { key, kind, sourceKind, sourceId, question, answer, resolution, atomId }) {
  const id = uuid();
  db.hub().prepare(`
    INSERT INTO crm_clarification_answers
      (id, user, question_key, kind, source_kind, source_id, question, answer, resolution, atom_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user, question_key) DO UPDATE SET
      answer = excluded.answer, resolution = excluded.resolution,
      atom_id = excluded.atom_id, created_at = unixepoch()
  `).run(id, user, key, kind, sourceKind || null, sourceId || null, question, answer,
    JSON.stringify(resolution || {}), atomId || null);
  return id;
}

// "Delete this - not relevant" typed into the answer box is a deletion, not an
// answer. Before the Discard button existed it became knowledge: the live layer
// ended up asserting "Ashwin is not relevant to the Cybersecurity Report and
// Framework project". Only short, unqualified dismissals count — a real answer
// that happens to contain "not relevant" explains itself at length.
function isDeleteIntent(answer) {
  const text = String(answer || '').trim();
  if (text.length > 60) return false;
  return /^(delete|remove|discard|ignore|dismiss|bin|junk|skip)\b/i.test(text)
    || /\b(not|no longer|isn't|is not)\s+relevant\b/i.test(text)
    || /\b(irrelevant|side chat|not a question|not an? (real )?question)\b/i.test(text);
}

// A meeting open question: the answer becomes project knowledge (or intake-level
// knowledge when the meeting has no project), carrying provenance to the intake.
async function answerMeetingQuestion(user, { key, intakeId, question, answer, projectSlug, meetingTitle }) {
  if (isDeleteIntent(answer)) {
    discardClarification(user, { key, kind: KINDS.MEETING_QUESTION, question, sourceKind: 'meeting_intake', sourceId: intakeId });
    return { atomId: null, statement: null, discarded: true };
  }
  const project = projectSlug ? projectsBySlug(user).get(projectSlug) : null;
  const statement = await composeAnswerStatement({
    question,
    answer,
    context: [meetingTitle ? `From the meeting "${meetingTitle}"` : '', project ? `Project: ${project.name}` : '']
      .filter(Boolean).join('. '),
  });
  const atomId = writeManualAtom(user, {
    subjectKind: project ? 'project' : 'insight',
    subjectId: project ? project.id : null,
    subjectLabel: project ? project.name : (meetingTitle || 'Meeting'),
    predicate: 'decision',
    value: statement,
    sourceRefs: [{ kind: 'meeting_intake', id: intakeId, question }],
  });
  recordAnswerRow(user, {
    key, kind: KINDS.MEETING_QUESTION, sourceKind: 'meeting_intake', sourceId: intakeId,
    question, answer, atomId, resolution: { statement, project_slug: projectSlug || null },
  });
  return { atomId, statement };
}

// An unowned action: the answer is a person. Resolving it means that person
// exists in the CRM (so the next transcript matches them by name) and the
// commitment is knowledge attached to them.
async function answerTaskOwner(user, { key, intakeId, question, task, spokenOwner, contactId, newContactName, meetingTitle }) {
  const hub = db.hub();
  let contact = null;
  if (contactId) {
    contact = hub.prepare('SELECT id, name, aliases FROM contacts WHERE id = ? AND user = ?').get(contactId, user);
  }
  if (!contact && newContactName) {
    const id = uuid();
    hub.prepare('INSERT INTO contacts (id, user, name) VALUES (?, ?, ?)').run(id, user, newContactName.trim());
    contact = { id, name: newContactName.trim(), aliases: '[]' };
  }
  if (!contact) throw new Error('Choose an existing person or give a new name');

  // The transcript name that failed to match becomes an alias, so the same
  // speaker resolves automatically next time instead of being asked again.
  if (spokenOwner && !/^speaker[\s_]?\d*$/i.test(spokenOwner)) {
    let aliases = [];
    try { aliases = JSON.parse(contact.aliases || '[]'); } catch (_) { aliases = []; }
    if (Array.isArray(aliases)
      && spokenOwner.toLowerCase() !== String(contact.name).toLowerCase()
      && !aliases.some(a => String(a).toLowerCase() === spokenOwner.toLowerCase())) {
      aliases.push(spokenOwner);
      hub.prepare('UPDATE contacts SET aliases = ? WHERE id = ?').run(JSON.stringify(aliases), contact.id);
    }
  }

  const atomId = writeManualAtom(user, {
    subjectKind: 'contact',
    subjectId: contact.id,
    subjectLabel: contact.name,
    predicate: 'open_commitment',
    value: `${contact.name} owns: ${task}`,
    sourceRefs: [{ kind: 'meeting_intake', id: intakeId, action: task }],
  });
  recordAnswerRow(user, {
    key, kind: KINDS.TASK_OWNER, sourceKind: 'meeting_intake', sourceId: intakeId,
    question, answer: `${contact.name} owns "${task}"`, atomId,
    resolution: { contact_id: contact.id, contact_name: contact.name, spoken_owner: spokenOwner || null, meeting: meetingTitle || null },
  });
  return { atomId, contact };
}

// An alias collision: either they are different people (record it, and optionally
// drop the alias that made them collide) or they are the same person. Merging two
// contact records is not automated — say so rather than implying it happened.
function answerPersonAlias(user, { key, question, decision, contactIds = [], contactNames = [], removeAlias = null, removeFromContactId = null }) {
  const hub = db.hub();
  let removed = null;
  if (removeAlias && removeFromContactId) {
    const row = hub.prepare('SELECT id, name, aliases FROM contacts WHERE id = ? AND user = ?').get(removeFromContactId, user);
    if (row) {
      let aliases = [];
      try { aliases = JSON.parse(row.aliases || '[]'); } catch (_) { aliases = []; }
      const next = aliases.filter(a => String(a).toLowerCase() !== String(removeAlias).toLowerCase());
      hub.prepare('UPDATE contacts SET aliases = ? WHERE id = ?').run(JSON.stringify(next), row.id);
      removed = { contact_id: row.id, contact_name: row.name, alias: removeAlias };
    }
  }

  const same = decision === 'same_person';
  const answer = same
    ? `${contactNames.join(' and ')} are the same person; records still need merging by hand.`
    : `${contactNames.join(' and ')} are different people.`;

  let atomId = null;
  if (contactIds.length && contactNames.length) {
    atomId = writeManualAtom(user, {
      subjectKind: 'contact',
      subjectId: contactIds[0],
      subjectLabel: contactNames[0],
      predicate: same ? 'same_person_as' : 'distinct_from',
      value: same
        ? `${contactNames[0]} and ${contactNames[1] || 'the other record'} are the same person.`
        : `${contactNames[0]} is not ${contactNames[1] || 'the other record'}; they are different people.`,
      sourceRefs: [{ kind: 'contact', id: contactIds[1] || null }],
    });
  }
  recordAnswerRow(user, {
    key, kind: KINDS.PERSON_ALIAS, sourceKind: 'contacts', sourceId: contactIds.join(','),
    question, answer, atomId, resolution: { decision, removed_alias: removed },
  });
  return { atomId, removed, same };
}

// Transcripts pick up side chat, and the extraction model dutifully turns it
// into questions. A discarded item is noise, not knowledge: it is recorded so
// the boards stop asking, and no atom is written.
function discardClarification(user, { key, kind, question, sourceKind = null, sourceId = null }) {
  recordAnswerRow(user, {
    key,
    kind: kind || 'discarded',
    sourceKind,
    sourceId,
    question,
    answer: 'Discarded — not worth answering.',
    resolution: { decision: 'discarded' },
    atomId: null,
  });
}

// Undo for a mis-click: dropping the row puts the question back in the queue on
// the next read. Only discards are restorable — an answered question has an atom
// behind it and would need that unpicked too.
function restoreClarification(user, key) {
  const row = db.hub().prepare(
    'SELECT resolution FROM crm_clarification_answers WHERE user = ? AND question_key = ?'
  ).get(user, key);
  if (!row) return false;
  let resolution = {};
  try { resolution = JSON.parse(row.resolution || '{}'); } catch (_) { resolution = {}; }
  if (resolution.decision !== 'discarded') return false;
  db.hub().prepare('DELETE FROM crm_clarification_answers WHERE user = ? AND question_key = ?').run(user, key);
  return true;
}

module.exports = {
  KINDS,
  discardClarification,
  isDeleteIntent,
  restoreClarification,
  answerMeetingQuestion,
  answerPersonAlias,
  answerTaskOwner,
  answeredKeys,
  answeredRows,
  clarificationKey,
  composeAnswerStatement,
  groupedClarifications,
  openClarifications,
  overlappingAliases,
};
