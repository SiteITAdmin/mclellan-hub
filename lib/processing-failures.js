'use strict';

const db = require('./db');

function recordProcessingFailure(source, externalId, error) {
  const message = String(error?.message || error || 'Unknown processing failure').slice(0, 1000);
  db.hub().prepare(`
    INSERT INTO processing_failures
      (source, external_id, attempts, last_error, first_failed_at, last_failed_at, resolved_at)
    VALUES (?, ?, 1, ?, unixepoch(), unixepoch(), NULL)
    ON CONFLICT(source, external_id) DO UPDATE SET
      attempts = processing_failures.attempts + 1,
      last_error = excluded.last_error,
      last_failed_at = unixepoch(),
      resolved_at = NULL
  `).run(source, externalId, message);
}

function resolveProcessingFailure(source, externalId) {
  db.hub().prepare(`
    UPDATE processing_failures
       SET resolved_at = unixepoch()
     WHERE source = ? AND external_id = ? AND resolved_at IS NULL
  `).run(source, externalId);
}

module.exports = { recordProcessingFailure, resolveProcessingFailure };
