'use strict';

// Durable identity resolution for ingested content.
//
// The linking failure this module fixes: extraction models emit person names as
// spoken or transcribed ("Alec Kangley", a bare "Ken"), and the only linker was
// an exact string match against contacts.name/aliases. The moment audio garbled
// a surname or dropped one, the name did not match, matched_contact was null,
// and the same person turned up forever in the Questions board — even after
// Douglas answered "that is Ken Murray" a dozen times, because the answer was
// never written back as reusable knowledge.
//
// Knowledge-first contract:
//   raw source      -> extracted person names on a meeting intake
//   synthesis       -> resolveEntities: exact/alias match first, then a bounded
//                      LLM adjudication (feature 'entity_resolution', Terra,
//                      fail-closed) scoped to the meeting's people
//   compiled layer  -> contacts.aliases (the single durable identity store every
//                      reader already consults via findContact/personTerms) plus
//                      a knowledge_receipts row per resolution for provenance
//   visible surface -> matched_contact populated on the stored extraction, so
//                      attendees, actions, atoms, and the Questions board all see
//                      the link
//
// The store is contacts.aliases, not a new table: a resolved garbled name is
// learned as an alias, so the next transcript is a free exact match and no model
// call is spent. Every auto-learned alias is receipted (derived_by:
// 'auto_resolver') so a later correction pass can audit or reverse it.
//
// Boundaries: this resolver only ever MATCHES existing contact rows. It never
// creates a contact (that stays a deliberate CRM UI action), never resolves a
// name that is really a known company/project, and fails closed — an uncertain
// name is left unmatched rather than mislinked, because a wrong auto-alias
// misattributes someone's words.

const db = require('./db');
const { chatJson } = require('./chat-completions');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { writeReceipt } = require('./crm-receipts');

// A model resolution below this is treated as "not sure" and left unmatched.
const AUTO_LEARN_MIN_CONFIDENCE = 0.85;

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

// name + aliases, matching what findContact/personTerms compares against.
function contactTerms(contact) {
  return [contact.name, ...parseArray(contact.aliases)].filter(Boolean);
}

function isPlaceholderPersonName(name) {
  const clean = normalizeName(name).replace(/\s+/g, ' ');
  return !clean
    || /^(speaker|participant)(?:\s*\d+)?$/.test(clean)
    || /^(unknown|unnamed|unassigned|client|team|everyone|all|group)(?:\s+(speaker|participant|person|team))?$/.test(clean);
}

function findExactContact(contacts, name) {
  const target = normalizeName(name);
  if (!target) return null;
  const matches = contacts.filter(contact =>
    contactTerms(contact).some(term => normalizeName(term) === target)
  );
  return matches.length === 1 ? matches[0] : null;
}

function isKnownNonPerson(name, { projects = [], companies = [] } = {}) {
  const target = normalizeName(name);
  if (!target) return false;
  return projects.some(p => normalizeName(p.name) === target || normalizeName(p.slug) === target)
    || companies.some(c => normalizeName(c.name) === target);
}

// Persist a resolved spelling as a durable alias so every future exact-match
// reader (meeting intake, CRM engine, quality board) links it without a model
// call. Mutates the in-memory contact too, so the rest of the current run sees
// it immediately. Returns true when a new alias was actually added.
function learnAlias(user, contact, aliasName, { source = 'auto_resolver', confidence = 1, reason = '', sourceKind = null, sourceId = null } = {}) {
  const alias = String(aliasName || '').trim();
  if (!contact || !alias) return false;
  if (isPlaceholderPersonName(alias)) return false;
  const existing = parseArray(contact.aliases);
  const terms = [contact.name, ...existing].map(normalizeName);
  if (terms.includes(normalizeName(alias))) return false;
  // Hard invariant, enforced for every caller (auto-resolver, human answer,
  // task-owner): never alias to a name that denotes a different contact.
  const others = db.hub().prepare('SELECT id, name, aliases FROM contacts WHERE user = ? AND id != ?').all(user, contact.id);
  if (aliasCollidesWithOtherContact(alias, contact.id, others)) {
    try {
      writeReceipt(user, sourceKind || 'contact', sourceId || contact.id, 'entity_resolution', {
        summary: `Refused alias "${alias}" for ${contact.name} — it denotes a different contact`,
        status: 'skipped',
        payload: { contact_id: contact.id, contact_name: contact.name, alias, refused: 'collides_with_distinct_contact', derived_by: source },
      });
    } catch (_) { /* best-effort */ }
    return false;
  }
  const next = [...existing, alias];
  db.hub().prepare('UPDATE contacts SET aliases = ? WHERE id = ? AND user = ?')
    .run(JSON.stringify(next), contact.id, user);
  contact.aliases = JSON.stringify(next); // keep the in-memory copy authoritative
  try {
    writeReceipt(user, sourceKind || 'contact', sourceId || contact.id, 'entity_resolution', {
      summary: `Learned alias "${alias}" for ${contact.name}`,
      status: 'done',
      payload: { contact_id: contact.id, contact_name: contact.name, alias, derived_by: source, confidence, reason },
    });
  } catch (_) { /* provenance is best-effort; the alias itself is the durable fact */ }
  return true;
}

function firstToken(name) {
  return normalizeName(name).split(/\s+/).filter(Boolean)[0] || '';
}

// The alias invariant. An alias is an alternate name for the SAME person ("Dad"
// = Alister). A name that already denotes a DIFFERENT contact can never be an
// alias of someone else: "Nick" cannot be an alias of Duncan Sackfield while
// Nick Chin exists — that is a CRM failure, not a nickname. It usually happens
// from a narrow read of one sentence ("Duncan: ...Nick will handle imports...")
// binding a mentioned name to the speaker. A transcript error between two known
// people (Alec/Alan) must likewise stay a per-transcript resolution, never a
// frozen alias. So: refuse when the alias equals another contact's full name or
// alias, or — for a bare first name — another contact's first name.
function aliasCollidesWithOtherContact(alias, targetContactId, contacts = []) {
  const clean = normalizeName(alias);
  if (!clean) return false;
  const bare = !clean.includes(' ');
  return contacts.some(contact => {
    if (contact.id === targetContactId) return false;
    return contactTerms(contact).some(term => {
      const t = normalizeName(term);
      return t === clean || (bare && firstToken(term) === clean);
    });
  });
}

function candidateBlock(contacts, entityFacts) {
  return contacts.map(contact => {
    const aliases = parseArray(contact.aliases);
    const aka = aliases.length ? ` (aka ${aliases.join(', ')})` : '';
    const facts = (entityFacts && entityFacts.get(contact.id)) || [];
    const known = facts.length ? ` — known: ${facts.slice(0, 3).join('; ')}` : '';
    return `${contact.id} — ${contact.name}${aka}${known}`;
  }).join('\n') || '(none)';
}

// A little source-backed context per contact so the model can tell two people
// with similar names apart from what the CRM already knows about each.
function factsForContacts(user, contactIds) {
  const map = new Map();
  if (!contactIds.length) return map;
  try {
    const rows = db.hub().prepare(`
      SELECT subject_id, predicate, value FROM knowledge_atoms
      WHERE user = ? AND status = 'active' AND subject_id IN (${contactIds.map(() => '?').join(',')})
      ORDER BY last_confirmed DESC
    `).all(user, ...contactIds);
    for (const row of rows) {
      const arr = map.get(row.subject_id) || [];
      if (arr.length < 3) arr.push(`${row.predicate}: ${String(row.value).slice(0, 80)}`);
      map.set(row.subject_id, arr);
    }
  } catch (_) { /* atoms optional */ }
  return map;
}

// Adjudicate a batch of unmatched names against known contacts in one bounded
// call. Returns Map<normalizedName, {contactId, contactName, confidence, reason}>.
// Fail-closed: any error or low confidence yields no match.
async function resolveWithModel({ user, names, contacts, meetingTitle, projectLabel, participantNames }) {
  if (!names.length || !contacts.length) return new Map();
  if (process.env.SUBSCRIPTION_AGENT_DISABLED === '1' || process.env.ENTITY_RESOLUTION_DISABLED === '1') return new Map();
  const entityFacts = factsForContacts(user, contacts.map(c => c.id));
  const prompt = getSystemPrompt('entity_resolution', user, PROMPTS.entity_resolution)
    .replaceAll('[MEETING]', meetingTitle || 'a meeting')
    .replaceAll('[PROJECT]', projectLabel || 'unknown')
    .replaceAll('[PARTICIPANTS]', participantNames.join(', ') || 'unknown')
    .replaceAll('[CANDIDATES]', candidateBlock(contacts, entityFacts))
    .replaceAll('[NAMES]', names.map((n, i) => `${i + 1}. ${n}`).join('\n'));
  let result;
  try {
    const modelId = getSystemModelId('entity_resolution', user, 'subscription');
    result = await chatJson({
      feature: 'entity_resolution',
      modelId,
      messages: [{ role: 'user', content: prompt }],
      user,
      defaults: { resolutions: [] },
      label: 'entity resolution',
      temperature: 0.1,
    });
  } catch (_) {
    return new Map();
  }
  const byId = new Map(contacts.map(c => [c.id, c]));
  const out = new Map();
  for (const item of (result && Array.isArray(result.resolutions) ? result.resolutions : [])) {
    const contact = byId.get(String(item.contact_id || ''));
    const confidence = Number(item.confidence) || 0;
    if (!contact || confidence < AUTO_LEARN_MIN_CONFIDENCE) continue;
    if (!item.name) continue;
    out.set(normalizeName(item.name), {
      contactId: contact.id,
      contactName: contact.name,
      confidence,
      reason: String(item.reason || '').slice(0, 200),
    });
  }
  return out;
}

// Every distinct person name the extraction refers to, that is not a placeholder
// and not already an exact contact term.
function collectPersonNames(extraction, contacts, nonPersonCtx) {
  const meeting = extraction.meeting || {};
  const raw = [];
  for (const a of meeting.attendees || []) if (!a.matched_contact) raw.push(a.name);
  for (const u of extraction.crm_updates || []) {
    if (!u.matched_contact) raw.push(u.subject);
    for (const p of u.linked_people || []) raw.push(p);
  }
  for (const act of extraction.action_register || []) if (!act.matched_contact) raw.push(act.owner);
  const seen = new Set();
  const names = [];
  for (const name of raw) {
    const clean = String(name || '').trim();
    if (!clean) continue;
    const key = normalizeName(clean);
    if (seen.has(key)) continue;
    if (isPlaceholderPersonName(clean)) continue;
    if (findExactContact(contacts, clean)) continue; // already linked deterministically
    if (isKnownNonPerson(clean, nonPersonCtx)) continue;
    seen.add(key);
    names.push(clean);
  }
  return names;
}

const STALE_IDENTITY_WARNING = /(not (present|found|listed|a known)|could not be (confidently )?matched|not in the known|is only identified by|unknown (name|speaker|contact)|no (known )?crm match|not a (known )?crm)/i;

// A warning that a name could not be matched is false once we have matched it.
function stripStaleWarnings(extraction, resolvedNames) {
  if (!Array.isArray(extraction.warnings) || !resolvedNames.length) return 0;
  const before = extraction.warnings.length;
  const lowered = resolvedNames.map(normalizeName);
  extraction.warnings = extraction.warnings.filter(w => {
    const text = String(w || '');
    if (!STALE_IDENTITY_WARNING.test(text)) return true;
    return !lowered.some(name => normalizeName(text).includes(name));
  });
  return before - extraction.warnings.length;
}

function applyResolution(extraction, name, resolution, contacts) {
  const target = normalizeName(name);
  const meeting = extraction.meeting || {};
  for (const a of meeting.attendees || []) {
    if (!a.matched_contact && normalizeName(a.name) === target) a.matched_contact = resolution.contactName;
  }
  for (const u of extraction.crm_updates || []) {
    if (!u.matched_contact && normalizeName(u.subject) === target) u.matched_contact = resolution.contactName;
  }
  for (const act of extraction.action_register || []) {
    if (!act.matched_contact && normalizeName(act.owner) === target) {
      act.matched_contact = resolution.contactName;
      if (['unknown_speaker', 'external', 'unknown'].includes(act.owner_type)) act.owner_type = 'known_person';
    }
  }
}

// The orchestration meeting intake (and the repair script) calls. Mutates
// `extraction` and the in-memory `contacts` (learned aliases), persists aliases
// and receipts, and returns a summary. `useModel:false` restricts to
// deterministic exact/alias matching (free — used by the historical repair so it
// touches no model plane and re-queues nothing).
async function resolveMeetingEntities({
  user = 'douglas',
  extraction,
  contacts = [],
  projects = [],
  companies = [],
  meetingTitle = '',
  projectSlug = null,
  sourceKind = 'meeting_intake',
  sourceId = null,
  useModel = true,
} = {}) {
  if (!extraction || typeof extraction !== 'object') return { resolved: [], learned: 0, warningsStripped: 0 };
  const nonPersonCtx = { projects, companies };
  const resolved = [];
  const resolvedNames = [];
  let learned = 0;

  // Pass 1: deterministic exact/alias re-link for any name that a current alias
  // already covers (this alone fixes frozen extractions once aliases exist).
  const meeting = extraction.meeting || {};
  const seedNames = new Set();
  for (const a of meeting.attendees || []) if (!a.matched_contact && a.name) seedNames.add(String(a.name).trim());
  for (const u of extraction.crm_updates || []) if (!u.matched_contact && u.subject) seedNames.add(String(u.subject).trim());
  for (const act of extraction.action_register || []) if (!act.matched_contact && act.owner) seedNames.add(String(act.owner).trim());
  for (const name of seedNames) {
    if (isPlaceholderPersonName(name)) continue;
    const contact = findExactContact(contacts, name);
    if (!contact) continue;
    applyResolution(extraction, name, { contactName: contact.name }, contacts);
    resolved.push({ name, contact: contact.name, method: 'exact' });
    resolvedNames.push(name);
  }

  // Pass 2: model adjudication for what is still unmatched.
  if (useModel) {
    const names = collectPersonNames(extraction, contacts, nonPersonCtx);
    if (names.length) {
      const participantNames = (meeting.attendees || [])
        .map(a => a.matched_contact || a.name).filter(Boolean);
      const projectLabel = projects.find(p => p.slug === projectSlug)?.name || projectSlug || 'unknown';
      const modelResolved = await resolveWithModel({
        user, names, contacts, meetingTitle, projectLabel, participantNames,
      });
      for (const name of names) {
        const hit = modelResolved.get(normalizeName(name));
        if (!hit) continue;
        const contact = contacts.find(c => c.id === hit.contactId);
        if (!contact) continue;
        applyResolution(extraction, name, hit, contacts);
        // Persist the spelling as a durable alias so the next transcript is a
        // free exact match. learnAlias enforces the alias invariant, so a name
        // that denotes another contact resolves for this meeting from context
        // but is never frozen as an alias.
        const didLearn = learnAlias(user, contact, name, {
          source: 'auto_resolver', confidence: hit.confidence, reason: hit.reason, sourceKind, sourceId,
        });
        if (didLearn) learned += 1;
        resolved.push({ name, contact: contact.name, method: didLearn ? 'model' : 'model_context_only', confidence: hit.confidence, reason: hit.reason });
        resolvedNames.push(name);
      }
    }
  }

  const warningsStripped = stripStaleWarnings(extraction, resolvedNames);

  if (resolved.length || warningsStripped) {
    try {
      writeReceipt(user, sourceKind, sourceId || 'unknown', 'entity_resolution', {
        summary: `${resolved.length} name(s) linked, ${learned} alias(es) learned, ${warningsStripped} stale warning(s) cleared`,
        status: resolved.length ? 'done' : 'skipped',
        payload: { resolved, learned, warnings_stripped: warningsStripped, use_model: useModel },
      });
    } catch (_) { /* best-effort */ }
  }
  return { resolved, learned, warningsStripped };
}

module.exports = {
  AUTO_LEARN_MIN_CONFIDENCE,
  aliasCollidesWithOtherContact,
  contactTerms,
  findExactContact,
  isPlaceholderPersonName,
  learnAlias,
  normalizeName,
  resolveMeetingEntities,
};
