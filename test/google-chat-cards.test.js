'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReminderCard, buildSuggestionCard, buildFireCard } = require('../lib/google-chat');

test('builds reminder cards with command actions', () => {
  const card = buildReminderCard([{
    short_code: 4,
    title: 'Review <cadence> & publish',
    next_fire_at: 1781773200,
  }]);

  const section = card.cardsV2[0].card.sections[0];
  assert.match(section.widgets[0].textParagraph.text, /Review &lt;cadence&gt; &amp; publish/);
  assert.equal(section.widgets[2].buttonList.buttons[0].onClick.action.function, 'done 4');
  assert.equal(section.widgets[2].buttonList.buttons[1].onClick.action.function, 'snooze 4 2h');
  assert.equal(section.widgets[2].buttonList.buttons[2].onClick.action.function, 'ok 4');
});

test('builds suggestion cards when body is blank', () => {
  const card = buildSuggestionCard([{
    short_code: 2,
    domain: 'content',
    title: 'Draft a post',
    body: null,
  }]);

  const section = card.cardsV2[0].card.sections[0];
  assert.equal(section.widgets[1].textParagraph.text, '');
  assert.equal(section.widgets[2].buttonList.buttons[0].onClick.action.function, 'accept 2');
});

test('builds reminder fire cards with snooze and ok actions', () => {
  const card = buildFireCard({
    short_code: 7,
    title: 'Chase thing',
    escalation_level: 1,
  });

  const buttons = card.cardsV2[0].card.sections[0].widgets[0].buttonList.buttons;
  assert.match(card.cardsV2[0].card.header.title, /Still open #7/);
  assert.equal(buttons[0].onClick.action.function, 'done 7');
  assert.equal(buttons[2].onClick.action.function, 'snooze 7 tomorrow');
  assert.equal(buttons[3].onClick.action.function, 'ok 7');
});
