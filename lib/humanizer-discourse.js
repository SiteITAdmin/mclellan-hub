'use strict';
// Discourse-level companion to scanTells() in lib/ai-humanizer.js.
//
// scanTells measures SURFACE style (burstiness, rule-of-three, AI vocabulary).
// The StoryScope paper (arXiv:2604.03136) shows that layer is weak: editing it
// out drops a narrative-level detector only ~1.6 points. The durable signal
// lives at the DISCOURSE layer — how information is arranged and framed, not
// what it factually asserts.
//
// Every measure here is fact-preserving by construction: it scores presentation
// (moralising, ordering, over-explanation, emotion framing, audience address).
// It never inspects the truth value of a claim, so moving these numbers never
// requires touching a fact. This pairs with the humaniser's hard rule that it
// must not invent data.
//
// Heuristics are deliberately conservative and cue-based — a cheap pre-scan so
// the UI stops giving a false "all clear" when the surface is clean but the
// structure is textbook AI. This is a signal, not a detector, and it will drift
// as models and human writing change; tune the cue lists over time.

function sentencesOf(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// 1. THEMATIC EXPLICITNESS / MORALISING — AI states the point/lesson outright
// (paper: 77% vs 52% human). Removing these editorialising sentences changes
// framing, not facts.
const MORALISING_CUES = [
  'the lesson', 'the takeaway', 'what matters', 'the key is', 'the key here',
  'at its core', 'in essence', 'ultimately,', 'the bottom line',
  'the reality is', 'the truth is', 'this shows', 'this highlights',
  'this demonstrates', 'serves as a reminder', "it's worth remembering",
  'it is worth remembering', 'the point is', 'importantly,', 'crucially,',
  'this underscores', 'this reflects', 'this speaks to', 'goes to show',
];

// 2. OVER-DETERMINATION — spelling out the implication of what was just said.
const OVEREXPLAIN_CUES = [
  'which means', 'in other words', 'put simply', 'simply put',
  'that is to say', 'to put it another way', 'what this means is',
  'in short', 'to be clear', 'essentially,',
];

// 3. EMOTION FRAMING — AI renders feeling as bodily sensation (paper: 81% vs
// 38%); humans just name it (29% vs 8%). Regexes so compositional phrases
// ("a knot formed in his stomach") are caught, not just fixed collocations.
const SOMATIC_CUES = [
  /\bheart (raced|pounded|sank|hammered|thudded|skipped|leapt)\b/g,
  /\bchest (tighten|tight|constrict|heav)/g,
  /\bstomach (churn|drop|knot|sank|sink|lurch|twist|turn)/g,
  /\bknot(ted|s)?\b[\s\S]{0,40}\b(stomach|gut|chest|throat)\b/g,
  /\bthroat (tighten|constrict|went dry|closed)/g,
  /\bpit of (his|her|their|the) stomach\b/g,
  /\bpulse (quicken|raced|pounded)/g,
  /\bbreath (caught|hitched|quicken)/g,
  /\blump in (his|her|their|the) throat\b/g,
  /\bhairs? (on|stood)/g,
  /\bpalms? (were )?(sweat|damp|clammy)/g,
  /\ba wave of \w+/g,
  /\bshiver/g, /\ba chill\b/g,
];
const NAMED_EMOTION = [
  'afraid', 'fear', 'angry', 'anger', 'happy', 'sad', 'sadness',
  'anxious', 'anxiety', 'excited', 'frustrated', 'frustration', 'proud',
  'nervous', 'relieved', 'ashamed', 'guilty', 'hopeful', 'worried',
  'delighted', 'furious', 'content', 'grateful',
];

// 4. SENSORY OVER-DESCRIPTION (smell especially — paper: 82% vs 57%).
const SMELL_CUES = ['smell', 'scent', 'aroma', 'odour', 'odor', 'fragrance',
  'whiff', 'stench', 'reek'];

// 5. LINEAR SCAFFOLDING — AI tells events first-clue-to-reveal in order. Humans
// reorder. Reordering PRESENTATION leaves the facts identical — the strongest
// fact-preserving lever for reports/emails (lead with the conclusion).
const SEQUENCE_CUES = [
  /\bfirst(ly)?\b/g, /\bto begin\b/g, /\bthen\b/g, /\bnext\b/g,
  /\bafter that\b/g, /\bsubsequently\b/g, /\bfinally\b/g, /\blastly\b/g,
  /\beventually\b/g, /\bfollowing this\b/g, /\blater\b/g,
];
const CONCLUSION_CUES = ['the result', 'in conclusion', 'therefore', 'so ',
  'the upshot', 'the outcome', 'net-net', 'bottom line'];

// 6. AUDIENCE ADDRESS / FOURTH WALL — humans acknowledge a reader far more
// (paper: 28% vs 7%). Adding a light aside is pure presentation.
const ADDRESS_CUES = [/\byou\b/gi, /\byour\b/gi, /\byou'll\b/gi,
  /\byou're\b/gi, /\bdear reader\b/gi, /\blet's\b/gi, /\bwe've all\b/gi];

// Accepts plain-string cues (matched literally) or RegExp cues (used as-is).
// Global regexes are safe to reuse with String.match (no lastIndex state).
function countCues(text, cues) {
  let n = 0;
  for (const c of cues) {
    const re = c instanceof RegExp
      ? c
      : new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    n += (text.match(re) || []).length;
  }
  return n;
}

// >2 moralising statements per 1k words reads as sermonising in non-fiction.
function isOverMoralising(per1k) { return per1k >= 2; }

function scanDiscourse(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const sents = sentencesOf(raw);
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const wc = words.length || 1;
  const per1k = n => +((n / wc) * 1000).toFixed(1);

  const moralising = countCues(lower, MORALISING_CUES);
  const overExplain = countCues(lower, OVEREXPLAIN_CUES);
  const somatic = countCues(lower, SOMATIC_CUES);
  const named = countCues(lower, NAMED_EMOTION);
  const smell = countCues(lower, SMELL_CUES);
  const sequence = countCues(lower, SEQUENCE_CUES);
  const address = ADDRESS_CUES.reduce((n, re) => n + (raw.match(re) || []).length, 0);

  const opener = (sents[0] || '').toLowerCase();
  const opensWithConclusion = CONCLUSION_CUES.some(c => opener.includes(c.trim()));

  const emoTotal = somatic + named;
  const somaticRatio = emoTotal ? +(somatic / emoTotal).toFixed(2) : null;

  const flags = {
    over_moralising: isOverMoralising(per1k(moralising)),
    over_explaining: overExplain >= 2,
    somaticised_emotion: somaticRatio != null && somaticRatio >= 0.6 && somatic >= 2,
    smell_heavy: per1k(smell) >= 3,
    linear_buried_conclusion: sequence >= 3 && !opensWithConclusion,
    no_audience: address === 0 && sents.length >= 5,
  };

  return {
    word_count: wc,
    sentence_count: sents.length,
    moralising_count: moralising,
    moralising_per_1k: per1k(moralising),
    over_explanation_count: overExplain,
    somatic_emotion_count: somatic,
    named_emotion_count: named,
    somatic_ratio: somaticRatio,        // null when no emotion language present
    smell_cue_count: smell,
    sequence_marker_count: sequence,
    opens_with_conclusion: opensWithConclusion,
    audience_address_count: address,
    flags,
    flags_raised: Object.values(flags).filter(Boolean).length,
  };
}

module.exports = { scanDiscourse, sentencesOf };
