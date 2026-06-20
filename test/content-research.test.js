'use strict';

const assert = require('assert');
const {
  buildResearchQuery,
  suggestionsFromSearch,
} = require('../lib/content-research');

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

console.log('Content research tests passed.');
