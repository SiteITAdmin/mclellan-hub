'use strict';

// The Wiki is a view over compiled knowledge. Vault notes remain useful
// source material, but they must not decide what the Hub knows today.

const db = require('./db');
const { semanticSearch } = require('./retrieval');
const {
  resolveSourceEvidence,
  sourceDisplay,
  isCanonicalEvidenceExcluded,
} = require('./source-evidence');
const { contactNameTerms, loadContactIdentities, normalizeName } = require('./contact-identity');
const { requestModelObject } = require('./model-request');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');

const MAX_DIRECT_ATOMS = 24;
const MAX_TEXT_ATOMS = 24;
const MAX_COMPILED_EVIDENCE = 24;
const MAX_TOTAL_EVIDENCE = 30;
const MAX_SEMANTIC_HITS = 12;
const MAX_VAULT_FALLBACKS = 4;
const MAX_ATOM_EXCERPT_CHARS = 900;
const MAX_RAW_EXCERPT_CHARS = 800;

const QUERY_FILLER = new Set([
  'a', 'an', 'and', 'are', 'about', 'can', 'could', 'do', 'does', 'everything',
  'first', 'for', 'from', 'give', 'has', 'have', 'how', 'i', 'in', 'is', 'it',
  'knowledge', 'latest', 'me', 'most', 'my', 'of', 'on', 'please', 'recent',
  'show', 'tell', 'that', 'the', 'their', 'there', 'these', 'this', 'to', 'was',
  'what', 'when', 'where', 'which', 'who', 'with', 'would', 'you',
]);

const SOURCE_KIND_LABELS = Object.freeze({
  email_summary: 'Email',
  messaging_message: 'Message',
  meeting_intake: 'Meeting',
  document: 'Document',
  debrief_session: 'Debrief',
  completed_task: 'Completed task',
  open_task: 'Open task',
  crm_fact: 'CRM fact',
});

function queryTerms(query) {
  const terms = normalizeName(query)
    .split(' ')
    .filter(term => term.length >= 3 && !QUERY_FILLER.has(term));
  return [...new Set(terms)];
}

function timestamp(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function dateLabel(value) {
  const valueTs = timestamp(value);
  return valueTs ? new Date(valueTs * 1000).toISOString().slice(0, 10) : null;
}

function escapedPhrase(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function queryMentionsIdentity(query, identity) {
  const normalisedQuery = normalizeName(query);
  const normalisedIdentity = normalizeName(identity);
  if (!normalisedQuery || normalisedIdentity.length < 3) return false;
  return new RegExp(`(?:^|\\s)${escapedPhrase(normalisedIdentity)}(?=$|\\s|')`, 'i')
    .test(normalisedQuery);
}

function directlyMentionedContacts(user, query, { hub = db.hub() } = {}) {
  const matches = [];
  for (const contact of loadContactIdentities(user, { hub })) {
    if (contactNameTerms(contact).some(term => queryMentionsIdentity(query, term))) {
      matches.push(contact);
    }
  }
  return matches;
}

function atomsForContacts(user, contacts, { hub = db.hub(), limit = MAX_DIRECT_ATOMS } = {}) {
  const ids = [...new Set((contacts || []).map(contact => contact.id).filter(Boolean))];
  if (!ids.length) return [];
  return hub.prepare(`
    SELECT * FROM knowledge_atoms
    WHERE user = ?
      AND subject_kind = 'contact'
      AND subject_id IN (${ids.map(() => '?').join(', ')})
      AND status IN ('active', 'stale')
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
             last_confirmed DESC, confidence DESC, updated_at DESC
    LIMIT ?
  `).all(user, ...ids, limit);
}

function textMatchedAtoms(user, query, { hub = db.hub(), limit = MAX_TEXT_ATOMS } = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const scoreSql = terms.map(() => `
    CASE
      WHEN lower(subject_label) LIKE ? THEN 8
      WHEN lower(value) LIKE ? THEN 3
      WHEN lower(predicate) LIKE ? THEN 2
      ELSE 0
    END
  `).join(' + ');
  const whereSql = terms.map(() => `
    (lower(subject_label) LIKE ? OR lower(predicate) LIKE ? OR lower(value) LIKE ?)
  `).join(' OR ');
  const scoreParams = terms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`]);
  const whereParams = terms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`]);
  return hub.prepare(`
    SELECT *, (${scoreSql}) AS match_score
    FROM knowledge_atoms
    WHERE user = ? AND status IN ('active', 'stale') AND (${whereSql})
    ORDER BY match_score DESC,
             CASE status WHEN 'active' THEN 0 ELSE 1 END,
             last_confirmed DESC, confidence DESC, updated_at DESC
    LIMIT ?
  `).all(...scoreParams, user, ...whereParams, limit);
}

function parseSourceRefs(value) {
  let refs = [];
  try { refs = JSON.parse(value || '[]'); } catch (_) { refs = []; }
  if (!Array.isArray(refs)) return [];
  const seen = new Set();
  return refs
    .map(ref => ({ kind: String(ref?.kind || ''), id: String(ref?.id || '') }))
    .filter(ref => ref.kind && ref.id && !seen.has(`${ref.kind}:${ref.id}`) && (seen.add(`${ref.kind}:${ref.id}`), true))
    .slice(0, 4);
}

function predicateLabel(predicate) {
  return String(predicate || 'knowledge claim').replace(/_/g, ' ');
}

function atomEvidence(atom) {
  return {
    sourceId: '',
    kind: 'atom',
    type: 'knowledge',
    typeLabel: 'Knowledge claim',
    title: `${atom.subject_label || 'Knowledge'} — ${predicateLabel(atom.predicate)}`,
    excerpt: String(atom.value || '').slice(0, MAX_ATOM_EXCERPT_CHARS),
    date: dateLabel(atom.last_confirmed || atom.updated_at || atom.first_seen),
    status: atom.status || 'active',
    sourceRefs: parseSourceRefs(atom.source_refs),
    atom,
  };
}

function rawEvidence(hit, evidence, display) {
  return {
    sourceId: '',
    kind: hit.source_kind,
    type: 'source',
    typeLabel: SOURCE_KIND_LABELS[hit.source_kind] || 'Source evidence',
    title: display.title,
    meta: display.meta,
    excerpt: String(hit.chunk_text || evidence.text || '').slice(0, MAX_RAW_EXCERPT_CHARS),
    date: dateLabel(evidence.ts),
    sourceRefs: [{ kind: hit.source_kind, id: hit.source_id }],
    score: Number(hit.score || 0),
  };
}

function vaultEvidence(page) {
  return {
    sourceId: '',
    kind: 'vault_note',
    type: 'vault',
    typeLabel: `Vault ${page.typeLabel || 'note'}`,
    title: page.title || 'Vault note',
    excerpt: String(page.excerpt || page.content || '').slice(0, MAX_RAW_EXCERPT_CHARS),
    date: page.created || null,
    project: page.project || null,
    filename: page.filename || null,
    tags: page.tags || [],
    url: page.url || null,
    sourceRefs: [],
  };
}

function evidenceContext(entry) {
  const date = entry.date ? ` | ${entry.status === 'stale' ? 'stale, last confirmed' : 'confirmed'} ${entry.date}` : '';
  const provenance = entry.sourceRefs?.length
    ? `\nProvenance: ${entry.sourceRefs.map(ref => SOURCE_KIND_LABELS[ref.kind] || ref.kind).join(', ')}`
    : '';
  const meta = entry.meta ? ` | ${entry.meta}` : '';
  return `[${entry.sourceId} | ${entry.typeLabel} | ${entry.title}${date}${meta}]\n${entry.excerpt}${provenance}`;
}

function addUnique(entries, entry, seen) {
  const key = entry.kind === 'atom'
    ? `atom:${entry.atom.id}`
    : `${entry.kind}:${entry.sourceRefs?.[0]?.id || entry.title}:${entry.excerpt.slice(0, 120)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  entries.push(entry);
  return true;
}

function compiledEvidenceCount(entries) {
  return entries.filter(entry => entry.type === 'knowledge').length;
}

function assignSourceIds(entries) {
  const counters = { atom: 0, source: 0, vault: 0 };
  for (const entry of entries) {
    if (entry.type === 'knowledge') entry.sourceId = `A${++counters.atom}`;
    else if (entry.type === 'vault') entry.sourceId = `V${++counters.vault}`;
    else entry.sourceId = `S${++counters.source}`;
  }
  return entries;
}

async function gatherWikiKnowledgeEvidence(user, query, {
  hub = db.hub(),
  semanticSearchFn = semanticSearch,
  resolveSourceEvidenceFn = resolveSourceEvidence,
  sourceDisplayFn = sourceDisplay,
  vaultFallback = [],
} = {}) {
  const entries = [];
  const seen = new Set();
  const directContacts = directlyMentionedContacts(user, query, { hub });
  for (const atom of atomsForContacts(user, directContacts, { hub })) {
    if (compiledEvidenceCount(entries) >= MAX_COMPILED_EVIDENCE) break;
    addUnique(entries, atomEvidence(atom), seen);
  }
  for (const atom of textMatchedAtoms(user, query, { hub })) {
    if (compiledEvidenceCount(entries) >= MAX_COMPILED_EVIDENCE) break;
    addUnique(entries, atomEvidence(atom), seen);
  }

  let semanticHits = [];
  let semanticError = null;
  try {
    semanticHits = await semanticSearchFn(user, query, MAX_SEMANTIC_HITS, {
      sourceKinds: [
        'atom', 'email_summary', 'messaging_message', 'meeting_intake', 'document',
        'debrief_session', 'completed_task', 'open_task', 'crm_fact',
      ],
      minScore: 0.12,
    });
  } catch (error) {
    semanticError = error.message;
  }

  for (const hit of semanticHits) {
    if (entries.length >= MAX_TOTAL_EVIDENCE) break;
    if (hit.source_kind === 'atom') {
      if (compiledEvidenceCount(entries) >= MAX_COMPILED_EVIDENCE) continue;
      const atom = hub.prepare(`
        SELECT * FROM knowledge_atoms
        WHERE user = ? AND id = ? AND status IN ('active', 'stale')
      `).get(user, hit.source_id);
      if (atom) addUnique(entries, atomEvidence(atom), seen);
      continue;
    }
    const evidence = resolveSourceEvidenceFn(user, hit.source_kind, hit.source_id);
    if (!evidence?.complete || isCanonicalEvidenceExcluded(evidence)) continue;
    addUnique(entries, rawEvidence(hit, evidence, sourceDisplayFn(evidence)), seen);
  }

  // A hand-written vault page can still answer a question the compiled layer
  // has not yet seen. It is an explicit fallback, never the priority source.
  if (!entries.length) {
    for (const page of vaultFallback.slice(0, MAX_VAULT_FALLBACKS)) {
      addUnique(entries, vaultEvidence(page), seen);
    }
  }

  assignSourceIds(entries);
  return {
    evidence: entries,
    directContacts: directContacts.map(contact => ({ id: contact.id, name: contact.name })),
    semanticHits: semanticHits.length,
    semanticError,
  };
}

function normaliseSynthesis(value, evidence, query) {
  const validIds = new Set(evidence.map(entry => entry.sourceId));
  const facts = Array.isArray(value?.facts) ? value.facts : [];
  return {
    headline: String(value?.headline || query).slice(0, 180),
    summary: String(value?.summary || '').slice(0, 2_400),
    facts: facts
      .map(fact => ({
        label: String(fact?.label || '').slice(0, 180),
        detail: String(fact?.detail || '').slice(0, 1_400),
        source_ids: [...new Set((Array.isArray(fact?.source_ids) ? fact.source_ids : [])
          .map(id => String(id)).filter(id => validIds.has(id)))],
      }))
      .filter(fact => fact.label && fact.detail && fact.source_ids.length)
      .slice(0, 7),
    gaps: (Array.isArray(value?.gaps) ? value.gaps : [])
      .map(gap => String(gap).slice(0, 500)).filter(Boolean).slice(0, 5),
    assessment: String(value?.assessment || 'Based on the retrieved private evidence.').slice(0, 800),
  };
}

async function answerWikiSearch(user, query, options = {}) {
  const { requestModelObjectFn = requestModelObject, ...gatherOptions } = options;
  const gathered = await gatherWikiKnowledgeEvidence(user, query, gatherOptions);
  if (!gathered.evidence.length) {
    return {
      ...gathered,
      synthesis: {
        headline: 'No relevant knowledge found',
        summary: 'No compiled knowledge or readable source evidence matched that question.',
        facts: [],
        gaps: ['No matching evidence was retrieved.'],
        assessment: 'The Hub did not find a source-backed answer.',
      },
      error: null,
    };
  }

  const modelId = getSystemModelId('wiki_search', 'system', 'claude/sonnet');
  const prompt = getSystemPrompt('wiki_search', 'system', PROMPTS.wiki_search);
  const sourceDirectory = gathered.evidence.map(entry =>
    `${entry.sourceId}: ${entry.typeLabel} | ${entry.title}${entry.date ? ` | ${entry.date}` : ''}`
  ).join('\n');
  const excerpts = gathered.evidence.map(evidenceContext).join('\n\n---\n\n');
  try {
    const response = await requestModelObjectFn({
      modelId,
      feature: 'wiki_search',
      modelKey: 'wiki_search',
      user,
      label: 'Wiki knowledge answer',
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: `Question: ${query}\n\nSource directory:\n${sourceDirectory}\n\nSource excerpts:\n${excerpts}`,
        },
      ],
    });
    return { ...gathered, synthesis: normaliseSynthesis(response, gathered.evidence, query), error: null };
  } catch (error) {
    return {
      ...gathered,
      synthesis: null,
      error: `The answerer is unavailable; retrieved evidence is shown below. ${error.message}`,
    };
  }
}

module.exports = {
  answerWikiSearch,
  gatherWikiKnowledgeEvidence,
  directlyMentionedContacts,
  textMatchedAtoms,
  normaliseSynthesis,
  queryTerms,
};
