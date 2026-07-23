'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Hermes WhatsApp routes resolve family chats without conflating Iain with Dad', async () => {
  const { resolveRoute, buildCapturePayload } = await import('../integrations/hermes-whatsapp/hub-capture.mjs');
  const config = require('../config/hermes-whatsapp-routes.json');

  const groupRoute = resolveRoute(config, {
    chat_type: 'group',
    chat_name: 'Dad Information Group',
    sender_name: 'Iain',
  });
  assert.equal(groupRoute.project_slug, 'alister');
  assert.equal(groupRoute.contact_name, 'Iain Clark');

  const groupLizRoute = resolveRoute(config, {
    chat_type: 'group',
    chat_name: 'Dad Information Group',
    sender_name: 'Aunt Liz Walker',
  });
  assert.equal(groupLizRoute.contact_name, 'Liz Walker');

  const groupNakaiRoute = resolveRoute(config, {
    chat_type: 'group',
    chat_name: 'Dad Information Group',
    sender_name: 'Nakai McLellan',
  });
  assert.equal(groupNakaiRoute.contact_name, 'Nakai McLellan');

  const groupLizSmithRoute = resolveRoute(config, {
    chat_type: 'group',
    chat_name: 'Dad Information Group',
    sender_name: 'Wee Lizzie',
  });
  assert.equal(groupLizSmithRoute.contact_name, 'Liz Smith');

  const catrionaRoute = resolveRoute(config, {
    chat_type: 'dm',
    chat_name: 'Catriona',
    sender_name: 'Catriona',
  });
  assert.equal(catrionaRoute.contact_name, 'Catriona McLellan');

  const lizRoute = resolveRoute(config, {
    chat_type: 'dm',
    chat_name: 'Aunt Liz',
    sender_name: 'Aunt Liz',
  });
  assert.equal(lizRoute.contact_name, 'Liz Walker');
  assert.equal(lizRoute.project_slug, 'alister');

  const iainRoute = resolveRoute(config, {
    chat_type: 'dm',
    chat_name: 'Iain',
    sender_name: 'Iain',
  });
  assert.equal(iainRoute.contact_name, 'Iain Clark');
  assert.equal(iainRoute.project_slug, 'alister');

  const unrelatedInbound = resolveRoute(config, {
    chat_type: 'dm',
    chat_name: 'Unrelated person',
    sender_name: 'Unrelated person',
    from_me: false,
  });
  assert.equal(unrelatedInbound.id, 'all-incoming-whatsapp');
  assert.equal(unrelatedInbound.project_slug, '');
  assert.equal(unrelatedInbound.contact_name, '');

  assert.equal(resolveRoute(config, {
    chat_type: 'dm',
    chat_name: 'Unrelated person',
    sender_name: 'Douglas McLellan',
    from_me: true,
  }), null);

  const unrelatedGroupInbound = resolveRoute(config, {
    chat_type: 'group',
    chat_name: 'Interview Prep Group',
    sender_name: 'Recruiter',
    from_me: false,
  });
  assert.equal(unrelatedGroupInbound.id, 'all-incoming-whatsapp');

  const payload = buildCapturePayload({
    message_id: 'wa-1',
    chat_id: 'group@g.us',
    chat_name: 'Dad Information Group',
    chat_type: 'group',
    sender_id: 'iain@s.whatsapp.net',
    sender_name: 'Iain',
    body: 'Dad needs milk.',
    timestamp: 1784738000,
  }, groupRoute);
  assert.equal(payload.project_slug, 'alister');
  assert.equal(payload.contact_name, 'Iain Clark');
  assert.equal(payload.raw.source, 'hermes_whatsapp_bridge_passive_capture');
});
