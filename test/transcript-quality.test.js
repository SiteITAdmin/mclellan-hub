'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assessTranscriptIntelligibility,
  extractionDeclaresUnintelligible,
  monumentalTranscriptError,
  UNINTELLIGIBLE_COMPLETENESS,
} = require('../lib/transcript-quality');

function fragmentDump(wordsNeeded = 2000) {
  const fragments = [
    'Fair enough.',
    'I show that.',
    'Something.',
    'Something medical.',
    "I don't know.",
    "I'm like, that's not GDP or of Davis.",
    'The man had black teeth.',
    "I can't remember.",
    "He was at Ike's next visit from the hospital.",
    'Yeah.',
    'Come on.',
    'We walk, she moves.',
    'Strange people.',
    'OK, I want to anyway.',
  ];
  const lines = ['## Krisp Notes', 'Douglas McLellan | 00:00'];
  let words = 0;
  let i = 0;
  while (words < wordsNeeded) {
    const fragment = fragments[i % fragments.length];
    lines.push(fragment);
    words += fragment.split(/\s+/).length;
    i += 1;
  }
  return lines.join('\n');
}

function diarizedMeeting() {
  const sentence = 'We need to finish the RoPA register before Friday and then circulate the draft to Neil and the privacy team.';
  const lines = ['## Krisp Notes'];
  for (let i = 0; i < 40; i++) {
    const speaker = i % 2 ? 'Douglas McLellan' : 'Jane Whelan';
    const mm = String(Math.floor((i * 2) / 60)).padStart(2, '0');
    const ss = String((i * 2) % 60).padStart(2, '0');
    lines.push(`${speaker} | ${mm}:${ss}`);
    lines.push(sentence);
  }
  return lines.join('\n');
}

function longMonologue() {
  const sentence = 'The privacy team will complete the RoPA entries for Beacon Hospital this week and then send the draft register to Neil for review before Friday.';
  const lines = ['Douglas McLellan | 00:00'];
  for (let i = 0; i < 80; i++) lines.push(sentence);
  return lines.join('\n');
}

test('a collapsed Krisp dump of sentence fragments is unintelligible', () => {
  const assessment = assessTranscriptIntelligibility(fragmentDump(2000));
  assert.equal(assessment.unintelligible, true);
  assert.equal(assessment.completeness, UNINTELLIGIBLE_COMPLETENESS);
  assert.equal(assessment.turnCount, 1);
  assert.ok(assessment.wordCount >= 800);
  assert.match(monumentalTranscriptError(assessment), /MONUMENTAL TRANSCRIPT FAILURE/);
});

test('a diarized meeting with real sentences is not unintelligible', () => {
  const assessment = assessTranscriptIntelligibility(diarizedMeeting());
  assert.equal(assessment.unintelligible, false);
  assert.ok(assessment.turnCount > 10);
});

test('a long well-formed monologue is not unintelligible', () => {
  const assessment = assessTranscriptIntelligibility(longMonologue());
  assert.equal(assessment.unintelligible, false);
  assert.equal(assessment.turnCount, 1);
  assert.ok(assessment.wordCount >= 800);
});

test('a 15-word clip is not a monumental failure', () => {
  const assessment = assessTranscriptIntelligibility([
    'Douglas McLellan | 00:00',
    'Just testing the microphone. Hello.',
  ].join('\n'));
  assert.equal(assessment.unintelligible, false);
});

test('the extractor warning that we ignored is itself a hard fail', () => {
  assert.equal(extractionDeclaresUnintelligible({
    warnings: [
      'The transcript is severely degraded and contains substantial unrelated or unintelligible material, so several speaker attributions and technical details are uncertain.',
    ],
  }), true);
  assert.equal(extractionDeclaresUnintelligible({
    warnings: ['Michael Cullen is not in the known CRM people list.'],
  }), false);
});
