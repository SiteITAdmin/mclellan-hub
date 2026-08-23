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
const { isAskableAttributionReview } = require('./attribution-reconciliation');

const KINDS = {
  MEETING_QUESTION: 'meeting_question',
  TASK_OWNER: 'task_owner',
  PERSON_ALIAS: 'person_alias',
  ATTRIBUTION_CORRECTION: 'attribution_correction',
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
    case KINDS.ATTRIBUTION_CORRECTION:
      return hash(['ac', item.intake_id || '', item.review_key || '', item.target_key || '']);
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

function attributionCorrectionQuestions(user) {
  const rows = db.hub().prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_kind = 'meeting_intake' AND stage = 'attribution_reconciliation'
    ORDER BY created_at DESC, rowid DESC
  `).all(user);
  const latestBySource = new Map();
  for (const row of rows) {
    if (!latestBySource.has(row.source_id)) latestBySource.set(row.source_id, row);
  }
  const questions = [];
  for (const row of latestBySource.values()) {
    if (row.status !== 'review') continue;
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
    for (const review of payload.reviews || []) {
      if (!isAskableAttributionReview(review)) continue;
      const current = review.current_contact?.name || review.written_name || 'unresolved';
      const proposed = review.proposed_contact_name || null;
      const question = review.target_kind === 'task_owner_conflict'
        ? `Who actually owns "${review.task?.title || review.context || 'this task'}"? Its linked evidence names more than one owner.`
        : review.verdict === 'not_participant'
          ? `Was ${review.written_name || current} only mentioned, rather than a participant in this meeting?`
          : proposed
            ? `Should ${current} be corrected to ${proposed} for this ${String(review.target_kind || 'attribution').replace(/_/g, ' ')}?`
            : `Should the current ${String(review.target_kind || 'attribution').replace(/_/g, ' ')} link for ${current} be removed?`;
      questions.push({
        kind: KINDS.ATTRIBUTION_CORRECTION,
        intake_id: row.source_id,
        review_key: review.review_key,
        target_key: review.target_key,
        target_kind: review.target_kind,
        question,
        evidence: review.evidence_quote || review.reason,
        reason: review.reason,
        current_contact: review.current_contact || null,
        proposed_contact_id: review.proposed_contact_id || null,
        proposed_contact_name: review.proposed_contact_name || null,
        confidence: review.confidence || 0,
        task: review.task || null,
        owners: review.owners || [],
      });
    }
  }
  return questions;
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
    ...attributionCorrectionQuestions(user),
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
  const attribution = items.filter(item => item.kind === KINDS.ATTRIBUTION_CORRECTION);
  const shownItems = [...take(attribution), ...take(meeting), ...take(owners), ...take(aliases)];
  attachContext(user, shownItems);
  return {
    total: items.length,
    shown: shownItems.length,
    counts: { attribution_corrections: attribution.length, meeting_questions: meeting.length, task_owners: owners.length, person_aliases: aliases.length },
    attribution_corrections: take(attribution),
    meeting_questions: take(meeting),
    task_owners: take(owners),
    person_aliases: take(aliases),
  };
}

// ── Context: what was actually said ───────────────────────────────────────────
//
// "The identity of the meeting lead (Speaker 3) is not mentioned" is unanswerable
// without hearing Speaker 3. Krisp transcripts are "Name | 00:42" headers
// followed by the turn, so the speaker's own words can be pulled back out.

const TURN_HEADER = /^\s*(.{1,40}?)\s*\|\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*$/;
const STOPWORDS = new Set(['what', 'when', 'which', 'where', 'that', 'this', 'with', 'from', 'have',
  'been', 'they', 'their', 'there', 'about', 'would', 'could', 'should', 'known', 'list', 'person',
  'people', 'mentioned', 'unable', 'match', 'treated', 'unknown', 'transcript', 'meeting', 'owns',
  'says', 'exact', 'current', 'currently', 'still', 'into', 'name', 'names', 'context', 'unclear']);

function transcriptTurns(transcript) {
  const lines = String(transcript || '').split('\n');
  const turns = [];
  let current = null;
  for (const line of lines) {
    const header = line.match(TURN_HEADER);
    if (header) {
      if (current && current.text.trim()) turns.push(current);
      current = { speaker: header[1].trim(), time: header[2], text: '' };
      continue;
    }
    if (!current) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    current.text += `${line.trim()} `;
  }
  if (current && current.text.trim()) turns.push(current);
  return turns.map(turn => ({ ...turn, text: turn.text.replace(/\s+/g, ' ').trim() }));
}

function trimWords(text, max = 85) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(' ');
  return `${words.slice(0, max).join(' ')}…`;
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

// Enough of a speaker to recognise them: their longest turns in order, up to ~85
// words. A single "Yeah." tells Douglas nothing.
function speakerExcerpt(turns, speaker) {
  const theirs = turns.filter(turn => normalizeSpeaker(turn.speaker) === normalizeSpeaker(speaker));
  if (!theirs.length) return null;
  const ranked = [...theirs].sort((a, b) => wordCount(b.text) - wordCount(a.text)).slice(0, 3);
  const chosen = theirs.filter(turn => ranked.includes(turn));
  let out = [];
  let used = 0;
  for (const turn of chosen) {
    if (used >= 85) break;
    const take = trimWords(turn.text, 85 - used);
    out.push({ time: turn.time, text: take });
    used += wordCount(take);
  }
  return { speaker, quotes: out, turn_count: theirs.length };
}

function normalizeSpeaker(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function questionTerms(question) {
  return [...new Set(String(question || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !STOPWORDS.has(word)))];
}

// No speaker named in the question: find the turn that actually discusses it.
function bestMatchingTurn(turns, question, extraTerms = []) {
  const terms = [...questionTerms(question), ...extraTerms.map(t => String(t).toLowerCase())];
  if (!terms.length) return null;
  let best = null;
  let bestScore = 0;
  for (const turn of turns) {
    const text = turn.text.toLowerCase();
    let score = 0;
    for (const term of terms) if (text.includes(term)) score += term.length > 6 ? 2 : 1;
    if (wordCount(turn.text) < 6) score -= 1;
    if (score > bestScore) { bestScore = score; best = turn; }
  }
  if (!best || bestScore < 2) return null;
  return { speaker: best.speaker, quotes: [{ time: best.time, text: trimWords(best.text, 85) }], matched: true };
}

// A name the question is asking about: "Speaker 3", 'Ashwin', or a task owner.
function namedSpeaker(question, turns) {
  const speakerLabel = String(question || '').match(/\b((?:speaker|participant)[\s_]?\d+)\b/i);
  if (speakerLabel) return speakerLabel[1].replace(/[\s_]+/g, ' ');
  const quoted = String(question || '').match(/['"]([^'"]{2,40})['"]/);
  if (quoted && turns.some(turn => normalizeSpeaker(turn.speaker) === normalizeSpeaker(quoted[1]))) return quoted[1];
  for (const turn of turns) {
    const name = turn.speaker;
    if (name.length < 3) continue;
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(question)) return name;
  }
  return null;
}

function contextForMeetingItem(item, turns) {
  if (!turns.length) return null;
  const speaker = item.owner || namedSpeaker(item.question, turns);
  if (speaker) {
    const excerpt = speakerExcerpt(turns, speaker);
    if (excerpt) return excerpt;
  }
  return bestMatchingTurn(turns, item.question, [item.task, item.owner].filter(Boolean));
}

// Two contacts, no transcript between them: show what the Hub already holds on
// each, which is what tells them apart.
function contextForPerson(user, contactIds = [], contactNames = []) {
  const hub = db.hub();
  return contactIds.map((id, index) => {
    let evidence = null;
    try {
      evidence = hub.prepare(`
        SELECT value AS text FROM knowledge_atoms
        WHERE user = ? AND subject_id = ? AND status = 'active'
        ORDER BY last_confirmed DESC LIMIT 1
      `).get(user, id)?.text || null;
      if (!evidence) {
        evidence = hub.prepare(`
          SELECT text FROM crm_facts WHERE user = ? AND contact_id = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(user, id)?.text || null;
      }
    } catch (_) { evidence = null; }
    return { name: contactNames[index] || 'Contact', id, evidence: evidence ? trimWords(evidence, 45) : null };
  });
}

// Only the items actually on screen get their transcript parsed — the full queue
// is hundreds of questions across 45 days of recordings.
function attachContext(user, items = []) {
  const transcripts = new Map();
  const getTurns = intakeId => {
    if (!intakeId) return [];
    if (!transcripts.has(intakeId)) {
      let turns = [];
      try {
        const row = db.hub().prepare('SELECT transcript FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, user);
        turns = transcriptTurns(row?.transcript);
      } catch (_) { turns = []; }
      transcripts.set(intakeId, turns);
    }
    return transcripts.get(intakeId);
  };

  for (const item of items) {
    if (item.kind === KINDS.PERSON_ALIAS) {
      item.people_context = contextForPerson(user, item.contact_ids, item.contacts);
      continue;
    }
    item.context = contextForMeetingItem(item, getTurns(item.intake_id));
  }
  return items;
}

// ── Answering ─────────────────────────────────────────────────────────────────

// The answer is not the knowledge. "100GB" on its own is unusable to retrieval;
// a declarative sentence is. The model writes that sentence; if it is
// unavailable the deterministic join still reads correctly and still retrieves.
async function composeAnswerStatement({ question, answer, context = '' }) {
  const fallback = `${String(question).replace(/\s*\?\s*$/, '')} — ${answer}`;
  if (process.env.SUBSCRIPTION_AGENT_DISABLED === '1') return fallback;
  try {
    const { getSystemModelId, getSystemPrompt } = require('./settings');
    const { PROMPTS } = require('./prompts');
    const { requestModelObject } = require('./model-request');
    const { TASK_CODES } = require('./openrouter-attribution');
    const modelId = getSystemModelId('clarification_answer', 'system', 'anthropic/claude-sonnet-4-6');
    const system = getSystemPrompt('clarification_answer', 'system', PROMPTS.clarification_answer);
    const result = await requestModelObject({
      modelId,
      messages: [{
        role: 'user',
        content: [
          system,
          '',
          context ? `Context: ${context}` : '',
          `Question: ${question}`,
          `Answer: ${answer}`,
        ].filter(Boolean).join('\n'),
      }],
      user: 'douglas',
      feature: 'clarification_answer',
      modelKey: 'clarification_answer',
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

// The unresolved name a meeting question is asking about: the "X" in "X may be
// Y", "X is not present in the known CRM", "Speaker 'X' could not be matched".
function unresolvedNameFromQuestion(question) {
  const text = String(question || '');
  const speaker = text.match(/speaker\s+['"]([^'"]{2,40})['"]/i);
  if (speaker) return speaker[1].trim();
  const lead = text.match(/^\s*['"]?([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,2})['"]?\s+(?:may be|is not|could not|is only|was spoken|is mentioned|is present)/);
  if (lead) return lead[1].trim();
  return null;
}

// A whole-word match of a known contact (by name or alias) inside free answer
// text. Returns the distinct contacts named, longest terms first so "Ken Murray"
// wins over a bare "Ken".
function contactsNamedIn(text, contacts) {
  const haystack = String(text || '');
  const found = new Map();
  for (const contact of contacts) {
    let aliases = [];
    try { aliases = JSON.parse(contact.aliases || '[]'); } catch (_) { aliases = []; }
    const terms = [contact.name, ...aliases].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const term of terms) {
      if (String(term).length < 3) continue;
      const re = new RegExp(`\\b${String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(haystack)) { found.set(contact.id, contact); break; }
    }
  }
  return [...found.values()];
}

// Turn a human correction into durable knowledge: when the answer names exactly
// one known contact and is not a "they are different people" denial, the
// unresolved name in the question becomes an alias on that contact, so the same
// spoken name links automatically on the next transcript instead of being asked
// forever. Best-effort — never throws into the answer flow.
function learnAliasFromMeetingAnswer(user, { question, answer }) {
  try {
    if (/\b(not|different|isn'?t|aren'?t|separate|distinct|two (different )?people|no,)\b/i.test(answer)) return null;
    const unresolved = unresolvedNameFromQuestion(question);
    if (!unresolved) return null;
    const contacts = db.hub().prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(user);
    const named = contactsNamedIn(answer, contacts);
    if (named.length !== 1) return null; // ambiguous or unrecognised → do not guess
    const { learnAlias } = require('./entity-resolution');
    const learned = learnAlias(user, named[0], unresolved, {
      source: 'human_correction', confidence: 1, sourceKind: 'meeting_intake',
    });
    return learned ? { contact: named[0].name, alias: unresolved } : null;
  } catch (_) {
    return null;
  }
}

// A meeting open question: the answer becomes project knowledge (or intake-level
// knowledge when the meeting has no project), carrying provenance to the intake.
async function answerMeetingQuestion(user, { key, intakeId, question, answer, projectSlug, meetingTitle }) {
  if (isDeleteIntent(answer)) {
    discardClarification(user, { key, kind: KINDS.MEETING_QUESTION, question, sourceKind: 'meeting_intake', sourceId: intakeId });
    return { atomId: null, statement: null, discarded: true };
  }
  learnAliasFromMeetingAnswer(user, { question, answer });
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
  // learnAlias enforces the alias invariant: a spoken name that denotes another
  // contact (Nick, when Nick Chin exists) assigns the action but is never frozen
  // as this contact's alias.
  if (spokenOwner && !/^speaker[\s_]?\d*$/i.test(spokenOwner)) {
    const { learnAlias } = require('./entity-resolution');
    learnAlias(user, contact, spokenOwner, { source: 'human_correction', sourceKind: 'meeting_intake', sourceId: intakeId });
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

async function answerAttributionCorrection(user, { key, intakeId, reviewKey, question, contactId }) {
  const { applyReviewedAttribution } = require('./attribution-reconciliation');
  const result = await applyReviewedAttribution(user, { intakeId, reviewKey, contactId: contactId || null });
  const contactName = result.contact?.name || result.item?.proposed_contact_name || null;
  const answer = contactName
    ? `${contactName} is the correct person for ${result.item.target_key}.`
    : `Apply ${result.item.verdict} to ${result.item.target_key}.`;
  recordAnswerRow(user, {
    key,
    kind: KINDS.ATTRIBUTION_CORRECTION,
    sourceKind: 'meeting_intake',
    sourceId: intakeId,
    question,
    answer,
    atomId: result.applied?.after?.split_to_atom_id || null,
    resolution: {
      review_key: reviewKey,
      target_key: result.item.target_key,
      decision: result.item.verdict,
      contact_id: result.contact?.id || result.item.proposed_contact_id || null,
      contact_name: contactName,
      applied: result.applied,
      task_update: result.taskResult,
    },
  });
  return { ...result, answer };
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
  attachContext,
  discardClarification,
  isDeleteIntent,
  restoreClarification,
  answerMeetingQuestion,
  answerAttributionCorrection,
  answerPersonAlias,
  answerTaskOwner,
  answeredKeys,
  answeredRows,
  clarificationKey,
  composeAnswerStatement,
  contactsNamedIn,
  groupedClarifications,
  learnAliasFromMeetingAnswer,
  openClarifications,
  overlappingAliases,
  transcriptTurns,
  unresolvedNameFromQuestion,
};
