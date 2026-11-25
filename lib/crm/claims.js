'use strict';

// Two jobs for the email reader, both about not losing or mixing up facts:
//
// 1. threadAtoms: facts already held from the same conversation, shown to the
//    model as context so it can say "same_as" instead of writing a copy.
// 2. mergeTarget: the model decides what is the same thing; this only vetoes a
//    merge when the two statements can be told apart (another amount, date,
//    person order, outcome, period or promise), when a newer claim supersedes
//    the old one, or when a recurring event is not the same occurrence. When in
//    doubt both facts are kept: a duplicate costs a glance, a wrong merge
//    loses information.

const { crm } = require('./db');
const { normName } = require('./text');

const DAY = 86400;

// ── Conversation ────────────────────────────────────────────────────────────

function threadKey(title) {
  const key = String(title || '').replace(/^\s*(?:(?:re|fw|fwd|aw|sv|tr)\s*:\s*|\[[^\]]*\]\s*)+/i, '').trim().toLowerCase();
  return key.length >= 6 && key !== '(no subject)' ? key : '';
}

// Other emails with the same subject once Re:/Fw: are taken off.
function threadIds(source, limit = 100) {
  const key = source.kind === 'email' ? threadKey(source.title) : '';
  if (!key) return [];
  const like = `%${key.replace(/[\\%_]/g, c => `\\${c}`)}%`;
  return crm().prepare("SELECT id, title FROM sources WHERE space = ? AND id != ? AND kind = 'email' AND lower(title) LIKE ? ESCAPE '\\' LIMIT 300")
    .all(source.space, source.id, like).filter(r => threadKey(r.title) === key).slice(0, limit).map(r => r.id);
}

function threadAtoms(source, limit = 12) {
  const ids = threadIds(source);
  if (!ids.length) return [];
  return crm().prepare(`
    SELECT DISTINCT a.id, a.statement, a.said_at FROM atom_sources x JOIN atoms a ON a.id = x.atom_id
     WHERE x.source_id IN (${ids.map(() => '?').join(',')}) AND a.space = ? AND a.status = 'active'
     ORDER BY a.said_at DESC, a.id LIMIT ?
  `).all(...ids, source.space, limit);
}

// ── What a statement commits to ─────────────────────────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_OF = Object.fromEntries(MONTHS.flatMap(m => [[m, m], [m.slice(0, 3), m], ...(m === 'september' ? [['sept', m]] : [])]));
const WEEKDAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const SKIP_NAMES = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'he', 'she', 'they', 'we', 'you', 'i', 'his', 'her', 'their', 'our', 'its', 'my', 'your', 'please', 'there', 'also', 'all', 'any']);
const STOP = new Set(('the and for with that this from have has had been being was were are will would shall should could can may might must not but our out all any into they them their there what when which who also just than then such each both very more some about over under after before until while where because since per via its his her him she you your these those is be as at by in of on or to an do does did get got'.split(' ')));

function stem(w) {
  let s = w;
  if (s.length > 4 && s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  return s.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(s) ? s.slice(0, -1) : s;
}

// Words that turn a statement round or change how firm it is. Two statements
// that use different ones (asked/confirmed, approved/declined, not, earlier/later,
// increase/decrease…) are different statements even when everything else matches.
const STANCE = new Set(('no not never cannot cant wont dont didnt doesnt isnt wasnt arent werent wouldnt shouldnt couldnt havent hasnt hadnt without unable neither nor '
  + 'asked requested confirmed agreed accepted approved declined refused rejected denied cancelled canceled postponed delayed withdrawn failed removed paused resumed reopened closed '
  + 'proposed tentative provisional pending overdue late early earlier later before after increase decrease raise lower higher more less start end open buy sell hire add join leave allow block paid unpaid sent received signed unsigned draft final enabled disabled active inactive resolved unresolved completed planned').split(' ').map(stem));

function shape(statement) {
  const raw = String(statement || '');
  const emails = new Set((raw.match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(e => e.toLowerCase()));
  const plain = raw.replace(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, ' ');
  // 15,000 · 15k · €15000 · INV-1234 · INV1234 · 9th · 2026-11-09 all read the same however they are written.
  const text = plain.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’‘`´']/g, '')
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => ` ${Number(d)} ${MONTHS[Number(m) - 1] || ''} ${y} `)
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d+(?:\.\d+)?)\s?k\b/g, (_, n) => String(Math.round(parseFloat(n) * 1000)))
    .replace(/(\d)(?:st|nd|rd|th)\b/g, '$1');
  const toks = text.match(/[a-z]+|\d+(?:\.\d+)?/g) || [];
  const out = { numbers: new Set(), years: new Set(), months: new Set(), weekdays: new Set(), stance: new Set(), content: new Set(), tokens: new Set(), names: [], emails };
  toks.forEach((t, i) => {
    if (/^\d/.test(t)) {
      const n = String(parseFloat(t));
      (/^\d{4}$/.test(n) && n >= 1900 && n <= 2100 ? out.years : out.numbers).add(n);
      return;
    }
    out.tokens.add(t);
    const near = /^\d/.test(toks[i - 1] || '') || /^\d/.test(toks[i + 1] || '');
    if (MONTH_OF[t] && (near || MONTHS.includes(t) && t !== 'may')) { out.months.add(MONTH_OF[t]); return; }
    if (WEEKDAYS.has(t)) { out.weekdays.add(t); return; }
    const s = stem(t);
    if (STANCE.has(s)) out.stance.add(s);
    else if (t.length >= 2 && !STOP.has(t)) out.content.add(s);
  });
  for (const m of plain.match(/\b[A-Z][A-Za-z]+\b/g) || []) {
    const l = m.toLowerCase();
    if (!SKIP_NAMES.has(l) && !MONTH_OF[l] && !WEEKDAYS.has(l)) out.names.push(l);
  }
  return out;
}

const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const bothAgree = (a, b) => !a.size || !b.size || sameSet(a, b);

function jaccard(a, b) {
  let hit = 0;
  for (const x of a) if (b.has(x)) hit += 1;
  return hit / (a.size + b.size - hit || 1);
}

// Every name in the new claim is in the old one, in the same order: "Beacon
// owes Douglas" is not "Douglas owes Beacon", and Purview is not Teams Premium.
function namesFollow(names, oldText) {
  const seq = [...String(oldText).toLowerCase().matchAll(/[a-z]+/g)].map(m => m[0]);
  let at = 0;
  for (const n of names) {
    const i = seq.indexOf(n, at);
    if (i < 0) return false;
    at = i + 1;
  }
  return true;
}

function sameFigures(a, b) {
  return sameSet(a.numbers, b.numbers) && sameSet(a.months, b.months) && sameSet(a.emails, b.emails)
    && bothAgree(a.years, b.years) && bothAgree(a.weekdays, b.weekdays);
}

function sameStatement(newText, oldText, { promise = false, confirmsRequest = false } = {}) {
  if (String(newText).trim() === String(oldText).trim()) return true;
  const roleWords = text => (text.toLowerCase().match(/\b(?:from|to|by|for|before|after)\b/g) || []).join(' ');
  if (!confirmsRequest && roleWords(newText) !== roleWords(oldText)) return false;
  const a = shape(newText);
  const b = shape(oldText);
  const quantities = text => text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/(\d+(?:\.\d+)?)k\b/g, (_, n) => String(Number(n) * 1000)).match(/[$€£]|\b(?:usd|eur|gbp)\b|\d+(?:\.\d+)?/g) || [];
  const values = quantities(newText), priorValues = quantities(oldText);
  if (values.length > 1 && priorValues.length > 1 && values.join('|') !== priorValues.join('|')) return false;
  if (!sameFigures(a, b) || !namesFollow(a.names, oldText) || (!promise && !namesFollow(b.names, newText))) return false;
  return promise || (sameSet(a.stance, b.stance) && jaccard(a.content, b.content) >= 0.5);
}

// ── May this claim join that atom? ──────────────────────────────────────────

const conflict = (a, b) => !!a && !!b && a !== b;

function promiseAgrees(row, spec) {
  if (!row || !spec || row.direction !== spec.direction) return false;
  const roles = text => (String(text).toLowerCase().match(/\b(?:to|by|for|from|before|after)\b/g) || []).join(' ');
  if (roles(row.action) !== roles(spec.action)) return false;
  const who = [normName(row.who), normName(spec.who)];
  if (who[0] && who[1] && !who[0].includes(who[1]) && !who[1].includes(who[0])) return false;
  const due = /^\d{4}-\d{2}-\d{2}$/.test(spec.due || '') ? spec.due : null;
  if (conflict(row.due, due)) return false;
  // A request may become a confirmed commitment (the reader's own flow), never the reverse.
  if (!row.is_request && spec.is_request === true) return false;
  if (row.is_request && spec.is_request !== true && spec.direction !== 'owed_to_me') return false;
  return jaccard(shape(row.action).content, shape(spec.action).content) >= 0.5;
}

function sameOccurrence(source, atom, claim) {
  if (Math.abs((atom.said_at || 0) - source.occurred_at) <= 3 * DAY) return true;
  if (claim.validFrom && claim.validFrom === atom.valid_from) return true;

  const db = crm();
  return !!db.prepare('SELECT 1 FROM atom_sources WHERE atom_id = ? AND source_id = ?').get(atom.id, source.id);
}

/**
 * The active atom this claim may be added to, or null (keep it as its own atom).
 * claim: { statement, kind, validFrom, validUntil, promise, projectIds, supersedes, sameAs }
 */
function mergeTarget(source, claim) {
  if (claim.supersedes) return null;
  const db = crm();
  const found = [];
  if (claim.sameAs) found.push(db.prepare('SELECT * FROM atoms WHERE id = ? AND space = ?').get(claim.sameAs, source.space));
  found.push(...db.prepare("SELECT * FROM atoms WHERE space = ? AND statement = ? AND status = 'active' LIMIT 5").all(source.space, claim.statement.slice(0, 1000)));
  return found.find(a => {
    if (!a || a.status !== 'active' || a.space !== source.space || a.kind !== claim.kind) return false;
    if (conflict(a.valid_from, claim.validFrom) || conflict(a.valid_until, claim.validUntil)) return false;
    if (claim.forwarded && (a.valid_from !== claim.validFrom || a.valid_until !== claim.validUntil)) return false;
    if (claim.forwarded && !claim.sameAs && source.occurred_at !== a.said_at && !claim.validFrom) return false;
    const isPromise = claim.kind === 'promise';
    const existingPromise = isPromise && db.prepare('SELECT direction, who, due, action, is_request FROM promises WHERE atom_id = ?').get(a.id);
    if (isPromise && !promiseAgrees(existingPromise, claim.promise)) return false;
    const confirmsRequest = existingPromise?.is_request && claim.promise?.is_request === false;
    if (!sameStatement(claim.statement, a.statement, { promise: isPromise, confirmsRequest })) return false;
    if (claim.projectIds.length) {
      const have = new Set(db.prepare('SELECT project_id FROM atom_projects WHERE atom_id = ?').all(a.id).map(r => r.project_id));
      if (claim.projectIds.some(id => !have.has(id))) return false;
    }
    return sameOccurrence(source, a, claim);
  }) || null;
}

module.exports = { threadKey, threadAtoms, shape, sameStatement, mergeTarget };
