'use strict';

// Capture-quality judgement for meeting transcripts. This is not meaning:
// it does not decide what a meeting was about. It only answers "did Krisp
// (or a paste) actually produce language, or 5,000 words of unintelligible
// fragments dumped as one speaker turn?"
//
// 28 Aug 2026: a Krisp mobile recording of 4,947 words as `Douglas McLellan |
// 00:00` was admitted complete, extracted into CRM facts/questions/tasks, and
// quoted on /crm/questions as "Fair enough… black teeth…". The extractor even
// warned that the transcript was severely degraded. That warning became more
// questions.

const TURN_HEADER = /^\s*(.{1,40}?)\s*\|\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*$/;
const UNINTELLIGIBLE_COMPLETENESS = 'unintelligible_transcript';
const EXTRACTION_UNINTELLIGIBLE_RE = /severely degraded|unintelligible material|unintelligible transcript/i;

function speakerTurns(transcript) {
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
  return turns.map(turn => ({
    speaker: turn.speaker,
    time: turn.time,
    wordCount: wordList(turn.text).length,
  }));
}

function wordList(text) {
  return String(text || '').toLowerCase().match(/[a-z']+/g) || [];
}

function spokenBody(transcript) {
  return String(transcript || '')
    .split('\n')
    .filter(line => !TURN_HEADER.test(line) && !/^#{1,6}\s/.test(line))
    .join(' ');
}

function shortSentenceRatio(body) {
  const sentences = String(body || '').split(/[.!?]+/).map(part => part.trim()).filter(Boolean);
  if (!sentences.length) return 0;
  const short = sentences.filter(sentence => sentence.split(/\s+/).filter(Boolean).length <= 4).length;
  return short / sentences.length;
}

function assessTranscriptIntelligibility(transcript) {
  const body = spokenBody(transcript);
  const words = wordList(body);
  const turns = speakerTurns(transcript);
  const wordCount = words.length;
  const turnCount = turns.length;
  const longestTurnWords = turns.reduce((max, turn) => Math.max(max, turn.wordCount), 0);
  const longestShare = wordCount ? longestTurnWords / wordCount : 0;
  const shortRatio = shortSentenceRatio(body);
  const collapsedDump = turnCount >= 1
    && turnCount <= 2
    && wordCount >= 800
    && longestTurnWords >= 1500
    && longestShare >= 0.7
    && shortRatio >= 0.4;
  const unstructuredNoise = turnCount === 0
    && wordCount >= 1500
    && shortRatio >= 0.45;
  const unintelligible = collapsedDump || unstructuredNoise;
  return {
    unintelligible,
    completeness: unintelligible ? UNINTELLIGIBLE_COMPLETENESS : null,
    reason: unintelligible
      ? (collapsedDump ? 'collapsed_unintelligible_speaker_dump' : 'unstructured_unintelligible_noise')
      : null,
    wordCount,
    turnCount,
    longestTurnWords,
    longestShare: Math.round(longestShare * 1000) / 1000,
    shortSentenceRatio: Math.round(shortRatio * 1000) / 1000,
  };
}

function extractionDeclaresUnintelligible(extraction) {
  const warnings = Array.isArray(extraction?.warnings) ? extraction.warnings : [];
  return warnings.some(warning => EXTRACTION_UNINTELLIGIBLE_RE.test(String(warning || '')));
}

function monumentalTranscriptError(assessment = {}) {
  const words = Number(assessment.wordCount) || 0;
  const turns = Number(assessment.turnCount) || 0;
  const pct = Math.round((Number(assessment.shortSentenceRatio) || 0) * 100);
  const turnLabel = turns === 1 ? '1 speaker turn' : `${turns} speaker turns`;
  return `MONUMENTAL TRANSCRIPT FAILURE: captured ${words} words as ${turnLabel} of unintelligible speech (${pct}% sentence fragments). This is not a meeting. The raw transcript was kept; nothing was extracted into CRM.`;
}

module.exports = {
  UNINTELLIGIBLE_COMPLETENESS,
  assessTranscriptIntelligibility,
  extractionDeclaresUnintelligible,
  monumentalTranscriptError,
};
