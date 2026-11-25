'use strict';

// A real quote is not enough to close or create work: its words must bear on
// the action itself. "I will review the rota on Friday" is genuinely in an
// email, but it says nothing about resetting the payroll server. Verdicts:
//   supported  the quote (or, for a bare "Done", the subject) is about the action
//   uncertain  related, but not enough to act on alone: Douglas is asked instead
//   unrelated  different matter, or a different month/year/number: ignore it

const STOP = new Set(('a an the and or but of to for from on in at by with without about into onto as is are was were be been being am '
  + 'i me my we us our you your he she it its they them their his her this that these those there here then than so if not no yes '
  + 'will would shall should can could may might must do does did done have has had having get got let lets just also very too '
  + 'please thanks thank ok okay sure hi hello dear regards best kind re fw fwd aw will ill ive ll '
  + 'send sent sending attach attached attaching forward forwarded share shared provide provided complete completed finish finished '
  + 'deliver delivered sort sorted handle handled '
  + 'today tomorrow yesterday tonight morning afternoon evening week weekend next last monday tuesday wednesday thursday friday saturday sunday '
  + 'now soon later asap again all any some one it').split(/\s+/));
// Words that only say "it happened": a reply made of these has no subject
// matter of its own, so what it is about comes from the subject line.
const DONE_RAW = ('paid settled received ready enclosed below here attached delivered sent complete completed finished sorted fixed '
  + 'resolved uploaded submitted posted promised agreed approved').split(/\s+/);
// "may" is left out: it is far more often a verb.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

const DONE_WORDS = new Set(DONE_RAW.map(stem));

// Words that carry meaning, and "marks": months, years, quarters and other
// numbers that tell one piece of work from another of the same kind.
function parts(text) {
  const words = [];
  const marks = { month: new Set(), year: new Set(), num: new Set() };
  const raw = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’‘'`]/g, '');
  for (const w of raw.split(/[^a-z0-9]+/).filter(Boolean)) {
    const month = MONTHS.findIndex(m => w.startsWith(m) && /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/.test(w));
    if (month >= 0) marks.month.add(month);
    else if (/^(?:19|20)\d\d$/.test(w)) marks.year.add(w);
    else if (/\d/.test(w)) marks.num.add(w);
    else if (w.length > 1 && !STOP.has(w)) words.push(stem(w));
  }
  return { words: new Set(words.filter(w => w.length > 1 && !STOP.has(w))), marks };
}

function conflicts(action, evidence) {
  return Object.keys(action.marks).some(k => {
    const a = action.marks[k];
    const e = evidence[k];
    return a.size && e.size && ![...a].some(x => e.has(x));
  });
}

function overlap(a, b) {
  return [...a].filter(w => b.has(w));
}

/**
 * How well an email quote (and its subject) bear on what was promised or what a task says.
 * `action` is the promise's action text or the task's title; `who` the other party's name, if any.
 */
function bind(quote, action, subject = '', who = '') {
  // A topical match cannot settle whether a negated or conditional action happened.
  if (/\b(?:no|not|never|cannot|unless|if|(?:did|has|have|had|is|was|were|can|could|will|would|should)n[’']?t|won[’']?t)\b/i.test(quote)) return 'uncertain';
  const q = parts(quote);
  const a = parts(action);
  // Quotes say "you" for the other person, so their name is not needed to match.
  for (const w of parts(who).words) a.words.delete(w);
  const s = parts(subject);
  if (!a.words.size) return 'uncertain';
  // The quote's own marks decide; a subject only speaks when the quote has none.
  const evidence = {};
  for (const k of Object.keys(q.marks)) evidence[k] = q.marks[k].size ? q.marks[k] : s.marks[k];
  if (conflicts(a, evidence)) return 'unrelated';
  const need = Math.min(2, a.words.size);
  const hit = overlap(q.words, a.words);
  const residual = [...q.words].filter(w => !a.words.has(w) && !DONE_WORDS.has(w)).length;
  if (hit.length >= need || (hit.length >= 1 && residual === 0)) return 'supported';
  if (hit.length >= 1) return 'uncertain';
  // Nothing in the quote touches the action. A reply with no subject matter of
  // its own ("Done", "Attached, thanks") leans on the subject. One with its own
  // subject matter is about something else, unless the subject at least shares
  // a word with the action, which is worth asking about but never acting on.
  const subjectHit = overlap(s.words, a.words).length;
  if (residual === 0) return subjectHit >= need ? 'supported' : 'uncertain';
  return subjectHit ? 'uncertain' : 'unrelated';
}

module.exports = { bind, parts };
