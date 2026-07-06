'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const { _test: regTest } = require('../lib/regulatory-monitor');
const { _test: briefingTest } = require('../scripts/build-nakai-daily-briefing');

const USER = 'nakai';
const CREATED = { sources: [], documents: [], items: [] };

test.after(() => {
  const hub = db.hub();
  for (const id of CREATED.items) hub.prepare('DELETE FROM intel_items WHERE id = ?').run(id);
  for (const id of CREATED.documents) hub.prepare('DELETE FROM intel_documents WHERE id = ?').run(id);
  for (const id of CREATED.sources) hub.prepare('DELETE FROM intel_sources WHERE id = ?').run(id);
});

test('ESMA Q&A listing parser extracts structured teaser fields', () => {
  const html = `
    <div class="views-row"><article>
      <a href="/publications-data/questions-answers/2857" rel="bookmark" class="question__header--number"><span class="field field--name-title">ESMA_QA_2857</span></a>
      <div class="field field--name-field-lqa-ist-of-topics field--type-entity-reference field--label-above">
        <div class="field__label">Topic</div><div class="field__item">Digital operational resilience testing</div>
      </div>
      <div class="field field--name-field-qa-subject-matter field--type-string field--label-above">
        <div class="field__label">Subject Matter</div><div class="field__item">Threat-led penetration testing</div>
      </div>
      <div class="field field--name-field-qa-question field--type-string-long field--label-above">
        <div class="field__label">Question</div><div class="field__item">How should firms evidence DORA testing?</div>
      </div>
      <div class="field field--name-field-qa-level1 field--type-entity-reference field--label-above">
        <div class="field__label">Level 1 Regulation</div><div class="field__item">Regulation (EU) 2022/2554 - The Digital Operational Resilience Act (DORA)</div>
      </div>
    </article></div>`;

  const rows = regTest.parseEsmaQaRows(html, 'https://www.esma.europa.eu/esma-qa-search-page/final');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].externalId, 'ESMA_QA_2857');
  assert.equal(rows[0].topic, 'Digital operational resilience testing');
  assert.equal(rows[0].subjectMatter, 'Threat-led penetration testing');
  assert.match(rows[0].url, /questions-answers\/2857$/);
});

test('ESMA Q&A detail parser extracts status, dates, question and answer', () => {
  const html = `
    <link rel="canonical" href="https://www.esma.europa.eu/publications-data/questions-answers/2857" />
    <div class="question__header--date">22/05/2026</div>
    <div class="field field--name-field-qa-subject-matter field--type-string field--label-above"><div class="field__label">Subject Matter</div><div class="field__item">Material changes</div></div>
    <div class="field field--name-field-qa-question field--type-string-long field--label-hidden field__item">What is a material change?</div>
    <div class="field field--name-field-qa-esma-response-date field--type-datetime field--label-hidden field__item">22-05-2026</div>
    <div class="clearfix text-formatted field field--name-field-qa-esma-response field--type-text-with-summary field--label-hidden field__item"><p>ESMA considers a material change to be one that affects registration conditions.</p></div>
    <div><span>Status: </span>Answer Published</div>
    <div class="field field--name-field-qa-level1 field--type-entity-reference field--label-above"><div class="field__label">Level 1 Regulation</div><div class="field__item">MiCA</div></div>`;

  const qa = regTest.parseEsmaQaDetail(html, 'https://example.test');
  assert.equal(qa.externalId, 'ESMA_QA_2857');
  assert.equal(qa.status, 'Answer Published');
  assert.equal(qa.publishedDate, '22/05/2026');
  assert.equal(qa.responseDate, '22-05-2026');
  assert.equal(qa.question, 'What is a material change?');
  assert.match(qa.answer, /material change/);
});

test('Nakai source pack includes regulator and FT email/RSS summaries only', () => {
  const hub = db.hub();
  const now = Math.floor(Date.now() / 1000);
  const sourceId = uuid();
  const documentId = uuid();
  const itemId = uuid();
  CREATED.sources.push(sourceId);
  CREATED.documents.push(documentId);
  CREATED.items.push(itemId);
  hub.prepare(`
    INSERT INTO intel_sources
      (id, user, name, source_kind, match_type, match_value, briefing_priority)
    VALUES (?, ?, 'myFT alerts test', 'email', 'sender_email', ?, 3)
  `).run(sourceId, USER, `${sourceId}@news-alerts.ft.com`);
  hub.prepare(`
    INSERT INTO intel_documents
      (id, user, source_id, external_id, source_kind, title, sender_name,
       sender_email, source_url, published_at, content_text)
    VALUES (?, ?, ?, ?, 'email', 'FT alert', 'myFT', 'myft@news-alerts.ft.com',
      'https://www.ft.com/example', ?, 'Full article body should not be emitted.')
  `).run(documentId, USER, sourceId, uuid(), now);
  hub.prepare(`
    INSERT INTO intel_items
      (id, user, document_id, title, summary, content_text, item_type,
       category, source_url, published_at)
    VALUES (?, ?, ?, 'FT regulatory context', 'Short summary only.', 'Long copied body',
      'article', 'Business & Finance', 'https://www.ft.com/example', ?)
  `).run(itemId, USER, documentId, now);

  const markdown = briefingTest.alertIntelMarkdown(now + 10);
  assert.match(markdown, /FT regulatory context/);
  assert.match(markdown, /Short summary only/);
  assert.doesNotMatch(markdown, /Long copied body/);
});
