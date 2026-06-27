'use strict';

function legacyDirectCrmWritesEnabled() {
  return String(process.env.CRM_LEGACY_DIRECT_WRITES || '').trim() === '1';
}

module.exports = { legacyDirectCrmWritesEnabled };
