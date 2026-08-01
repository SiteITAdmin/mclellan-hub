'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sources, extractLinks, verdict } = require('../scripts/check-us-block-sources');

test('US source health catalogue includes every configured authority/newsroom', () => {
  const all = sources();
  assert.equal(all.length, 107);
  assert.equal(all.filter(source => source.kind === 'financial-regulator').length, 55);
  assert.equal(all.filter(source => source.kind === 'attorney-general-newsroom').length, 51);
  assert.equal(all.filter(source => source.kind === 'national-attorneys-general').length, 1);
});

test('US source health extracts same-domain news links', () => {
  const links = extractLinks(
    '<a href="/news/block">Block enforcement release</a><a href="https://other.example/story">Other story</a>',
    'https://authority.gov/news'
  );
  assert.deepEqual(links.map(link => link.url), ['https://authority.gov/news/block']);
});

test('US source health accepts a search or browser recovery as checkable', () => {
  assert.equal(verdict({
    direct: { ok: false, status: 403, error: 'blocked' },
    browser: { ok: false, newsLinkCount: 0, contentSignal: false },
    firecrawl: { markdownLength: 0 },
    brave: { sameDomainCount: 2 },
    exa: { sameDomainCount: 0 },
  }), 'checkable');
});
