'use strict';

const assert = require('assert');
const { isContentCandidate, topicMatches } = require('../lib/content-topic-plan');

const topics = [
  'AI & Technology',
  'M365 & Microsoft',
  'Healthcare IT',
  'Digital Transformation',
  'EU Policy & Regulation',
  'Leadership & Management',
  'Industry Analysis',
  'Product Review',
  'Case Study',
  'Career & Development',
];

assert.strictEqual(isContentCandidate({
  title: 'McLellan Hub Daily System Report - 19 June 2026',
  summary: 'Daily operational metrics for the McLellan Hub system.',
  category: 'AI & Machine Learning',
  item_type: 'analysis',
  source_url: null,
  source_name: 'AgentMail',
  source_title: 'Hub Daily Report - Friday, 19 June 2026',
}, topics), false);

assert.strictEqual(isContentCandidate({
  title: 'Ukrainian President prioritises long-range strike weapons',
  summary: 'President Volodymyr Zelenskyy is prioritizing the removal of US leverage.',
  category: 'Other',
  item_type: 'news',
  source_url: 'https://www.ft.com/example',
  source_name: 'myFT',
  source_title: 'myFT Daily Digest',
}, topics), false);

assert.strictEqual(isContentCandidate({
  title: "Colombia's Cocaine Boom",
  summary: 'Despite a 2016 peace deal, cocaine production in Colombia has tripled.',
  category: 'Other',
  item_type: 'analysis',
  source_url: 'https://www.ft.com/example',
  source_name: 'Patrick Jenkins',
  source_title: "Editor's Choice: Burnham's path to power",
}, topics), false);

const aiReport = {
  title: 'New report: How to power data centres',
  summary: 'Energy requirements and infrastructure bottlenecks facing data centre growth due to AI transformation.',
  category: 'AI & Machine Learning',
  item_type: 'analysis',
  source_url: 'https://www.ft.com/example',
  source_name: 'myFT',
  source_title: 'myFT Daily Digest',
};

assert.strictEqual(isContentCandidate(aiReport, topics), true);
assert.strictEqual(topicMatches(aiReport, 'AI & Technology'), true);
assert.strictEqual(topicMatches(aiReport, 'EU Policy & Regulation'), false);

const euPolicy = {
  title: 'Ireland prepares new AI compliance guidance',
  summary: 'Public sector teams respond to EU AI governance and data protection obligations.',
  category: 'Ireland & EU Policy',
  item_type: 'news',
  source_url: 'https://example.com/eu-ai',
  source_name: 'External Briefing',
  source_title: 'Policy Briefing',
};

assert.strictEqual(isContentCandidate(euPolicy, topics), true);
assert.strictEqual(topicMatches(euPolicy, 'EU Policy & Regulation'), true);

console.log('Content topic plan policy tests passed.');
