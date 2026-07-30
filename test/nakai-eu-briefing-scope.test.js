'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROMPTS } = require('../lib/prompts');
const { _test: briefingTest } = require('../scripts/build-nakai-daily-briefing');

test('Nakai briefing prompt is EU/UK/Irish-only for regulatory coverage', () => {
  assert.match(PROMPTS.nakai_daily_briefing, /Exclude US federal and state regulatory/);
  assert.doesNotMatch(PROMPTS.nakai_daily_briefing, /"## US Regulatory Watch"/);
  assert.match(briefingTest.CURRENT_SCOPE_DIRECTIVE, /Do not include a US Regulatory Watch section/);
});

test('US regulatory evidence is excluded from Nakai live-source eligibility', () => {
  assert.equal(briefingTest.isUsRegulatoryItem({
    site: 'US Attorney General — New York Attorney General',
    url: 'https://ag.ny.gov/press-release/example',
  }), true);
  assert.equal(briefingTest.isUsRegulatoryItem({
    site: 'US official source (news.rochesternh.gov)',
    url: 'https://news.rochesternh.gov/example',
  }), true);
  assert.equal(briefingTest.isUsRegulatoryItem({
    site: 'FCA',
    url: 'https://www.fca.org.uk/news/blogs/example',
  }), false);
  assert.equal(briefingTest.isUsRegulatoryItem({
    site: 'Central Bank of Ireland',
    url: 'https://www.centralbank.ie/news/article/example',
  }), false);
  assert.equal(briefingTest.isUsRegulatoryItem({
    site: 'ESMA',
    url: 'https://www.esma.europa.eu/press-news/esma-news/example',
    detail_json: '{"authority_boundary":"official-us-regulator"}',
  }), true);
});
