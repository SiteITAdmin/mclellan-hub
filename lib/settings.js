'use strict';
const db = require('./db');
const { uuid } = require('./id');

const KEY_PREFIX = 'hub_sys_model_';

// Returns the OpenRouter model_id for a configured system model slot.
// Looks up the stored model key in model_config to get the live model_id.
// Falls back to fallbackModelId if the slot is not configured or the model has been deleted.
function getSystemModelId(feature, userScope, fallbackModelId) {
  try {
    const hub = db.hub();
    const row = hub.prepare(
      'SELECT value FROM crm_context WHERE user = ? AND key = ?'
    ).get(userScope, KEY_PREFIX + feature);
    if (row?.value) {
      const modelRow = hub.prepare(
        'SELECT model_id FROM model_config WHERE key = ? AND enabled = 1'
      ).get(row.value);
      if (modelRow) return modelRow.model_id;
    }
  } catch (_) {}
  return fallbackModelId;
}

// Returns the model config KEY (not ID) for features that go through routeMessage().
function getSystemModelKey(feature, userScope, fallbackKey) {
  try {
    const row = db.hub().prepare(
      'SELECT value FROM crm_context WHERE user = ? AND key = ?'
    ).get(userScope, KEY_PREFIX + feature);
    if (row?.value) return row.value;
  } catch (_) {}
  return fallbackKey;
}

// Persists a model key selection for a system slot. Pass null/empty to reset to default.
function setSystemModel(feature, userScope, modelKey) {
  const hub = db.hub();
  if (!modelKey) {
    hub.prepare('DELETE FROM crm_context WHERE user = ? AND key = ?')
      .run(userScope, KEY_PREFIX + feature);
    return;
  }
  hub.prepare(`
    INSERT INTO crm_context (id, user, key, value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), userScope, KEY_PREFIX + feature, modelKey);
}

// Returns the configured label for a slot, for display purposes.
function getSystemModelLabel(feature, userScope) {
  try {
    const hub = db.hub();
    const row = hub.prepare(
      'SELECT value FROM crm_context WHERE user = ? AND key = ?'
    ).get(userScope, KEY_PREFIX + feature);
    if (row?.value) {
      const modelRow = hub.prepare(
        'SELECT label FROM model_config WHERE key = ?'
      ).get(row.value);
      return { key: row.value, label: modelRow?.label || row.value };
    }
  } catch (_) {}
  return null;
}

module.exports = { getSystemModelId, getSystemModelKey, setSystemModel, getSystemModelLabel };
