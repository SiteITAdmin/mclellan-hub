'use strict';

const assert = require('assert');
const {
  buildResearchQuery,
  suggestionsFromSearch,
} = require('../lib/content-research');
const {
  resolveTopicContext,
  researchWindowStart,
} = require('../lib/content-research-core');
const { DEFAULT_TOPICS } = require('../lib/content-taxonomy');
const { PROMPTS } = require('../lib/prompts');

const query = buildResearchQuery({
  topic: 'EU Policy & Regulation',
  tone: 'provocative',
  date: '2026-06-26',
});
assert.match(query, /EU Policy & Regulation/);
assert.match(query, /latest news/);
assert.match(query, /contrarian/);

const suggestions = suggestionsFromSearch({
  topic: 'Digital Transformation',
  tone: 'professional',
  planDate: '2026-06-30',
  searchResult: {
    provider: 'test',
    sources: [
      { title: 'Public sector AI delivery changes', url: 'https://example.com/a', snippet: 'New guidance affects transformation teams.' },
      { title: 'Public sector AI delivery changes', url: 'https://example.com/dupe', snippet: 'Duplicate title.' },
      { title: 'Transformation governance lessons', url: 'https://example.com/b', snippet: 'Operating model change and adoption.' },
      { title: 'Data platform update', url: 'https://example.com/c', snippet: 'A third candidate angle.' },
    ],
  },
  limit: 3,
});

assert.strictEqual(suggestions.length, 3);
assert.strictEqual(suggestions[0].topic, 'Digital Transformation');
assert.strictEqual(suggestions[0].tone, 'professional');
assert.strictEqual(suggestions[0].source_provider, 'test');
assert.strictEqual(new Set(suggestions.map(s => s.title)).size, 3);

// 30-day window math (inclusive 30 calendar days ending plan date)
assert.strictEqual(researchWindowStart('2026-07-18'), '2026-06-19');
assert.strictEqual(researchWindowStart('bad'), '');

// Defaults carry searchQuery for abstract / keyword-trap topics
const dt = DEFAULT_TOPICS.find((t) => t.name === 'Digital Transformation');
assert.ok(dt?.searchQuery);
assert.match(dt.searchQuery, /transformation|adoption|operating model/i);

// Unknown user falls back to defaults via resolveTopicContext
const ctx = resolveTopicContext('content-research-test-user-no-taxonomy', 'Digital Transformation');
assert.ok(ctx.description);
assert.ok(ctx.searchQuery);

// Driver prompt hardens against pre-window analyst padding
assert.match(PROMPTS.content_research_driver, /window_start/);
assert.match(PROMPTS.content_research_driver, /AUTHORITATIVE/i);
assert.match(PROMPTS.content_research_driver, /keyword traps/i);
assert.match(PROMPTS.content_research_driver, /CITATION PRIORITY/i);
assert.match(PROMPTS.content_research_driver, /PEOPLE are saying/i);

// Structural filters: analyst press dropped unless thin-signal honesty
const {
  filterSuggestions,
  isAnalystPressUrl,
  isSocialUrl,
  parseSuggestionsJson,
  postEngineReinforcement,
} = require('../lib/grok-research-driver');

assert.strictEqual(isAnalystPressUrl('https://www.gartner.com/en/newsroom/press-releases/2025-06-25-foo'), true);
assert.strictEqual(isSocialUrl('https://www.reddit.com/r/msp/comments/abc'), true);
assert.strictEqual(isSocialUrl('https://news.ycombinator.com/item?id=1'), true);

const filtered = filterSuggestions([
  {
    title: 'Gartner says 40% cancel',
    summary: 'Analyst projection for agentic AI.',
    source_url: 'https://www.gartner.com/en/newsroom/press-releases/2025-06-25',
    evidence_origin: 'web',
  },
  {
    title: 'r/msp thread on Copilot adoption',
    summary: 'Practitioners report sub-5% weekly use.',
    source_url: 'https://www.reddit.com/r/msp/comments/xyz',
    evidence_origin: 'engine',
  },
]);
assert.strictEqual(filtered.length, 1);
assert.match(filtered[0].title, /r\/msp/);

// Thin-signal honesty may keep an analyst URL if explicitly framed
const thinOk = filterSuggestions([
  {
    title: 'Thin community signal this window',
    summary: 'Thin community signal this window - only analyst coverage found, no practitioner threads.',
    source_url: 'https://www.mckinsey.com/foo',
    evidence_origin: 'web',
  },
]);
assert.strictEqual(thinOk.length, 1);

const parsed = parseSuggestionsJson(JSON.stringify({
  suggestions: [
    {
      title: 'Estonia AI ID codes for agents',
      summary: 'HN discussion on official digital IDs for AI agents.',
      source_url: 'https://news.ycombinator.com/item?id=99',
      source_title: 'HN',
      evidence_origin: 'engine',
    },
  ],
}), { topic: 'Digital Transformation', tone: 'professional', planDate: '2026-07-18', limit: 3 });
assert.strictEqual(parsed.length, 1);
assert.strictEqual(parsed[0].evidence_origin, 'engine');

const reinforce = postEngineReinforcement({ windowStart: '2026-06-19', planDate: '2026-07-18' });
assert.match(reinforce, /PRIMARY evidence/i);
assert.match(reinforce, /Gartner/);

console.log('Content research tests passed.');
