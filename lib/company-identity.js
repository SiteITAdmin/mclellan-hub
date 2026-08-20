'use strict';

// Company identity — registered address, VAT / company / charity number — is
// declared knowledge, not new columns on `companies`. It lives in
// knowledge_atoms with derived_by='manual' (confidence 1.0, status active), the
// same compiled layer synthesis writes to and the dedup pass reads, so a value
// typed on the company page is authoritative, sticky, and sits alongside the
// footer facts the engine already extracts. Mirrors project-lifecycle's manual
// project atoms.

const db = require('./db');
const { uuid } = require('./id');

const COMPANY_IDENTITY_FIELDS = [
  { key: 'registered_address', label: 'Registered address', multiline: true },
  { key: 'vat_number', label: 'VAT number' },
  { key: 'company_number', label: 'Company number' },
  { key: 'charity_number', label: 'Charity number' },
];
const COMPANY_IDENTITY_PREDICATES = COMPANY_IDENTITY_FIELDS.map(f => f.key);

function upsertManualCompanyAtom(user, company, predicate, value) {
  const hub = db.hub();
  const trimmed = String(value || '').trim();
  const existing = hub.prepare(`
    SELECT id FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'company' AND subject_id = ? AND predicate = ? AND derived_by = 'manual'
  `).get(user, company.id, predicate);
  if (!trimmed) {
    if (existing) hub.prepare('DELETE FROM knowledge_atoms WHERE id = ?').run(existing.id);
    return;
  }
  if (existing) {
    hub.prepare(`
      UPDATE knowledge_atoms SET value = ?, status = 'active', confidence = 1.0,
        last_confirmed = unixepoch(), updated_at = unixepoch()
      WHERE id = ?
    `).run(trimmed, existing.id);
  } else {
    hub.prepare(`
      INSERT INTO knowledge_atoms (id, user, subject_kind, subject_id, subject_label, predicate, value, source_refs, confidence, status, derived_by)
      VALUES (?, ?, 'company', ?, ?, ?, ?, '[]', 1.0, 'active', 'manual')
    `).run(uuid(), user, company.id, company.name, predicate, trimmed);
  }
}

// Best-effort suggestion for an empty identity field, pulled from facts the
// synthesis engine already extracted — including footer facts that never
// resolved to the company entity (subject_id NULL, subject_label matches name).
// Never saved automatically; only pre-fills the box so Douglas can accept it.
function extractCompanyIdentitySuggestions(atoms) {
  const out = {};
  const take = (key, val) => { if (val && !out[key]) out[key] = String(val).trim(); };
  for (const a of atoms) {
    const v = String(a.value || '');
    const vat = v.match(/\bGB\s?\d{9}\b/i) || (/vat/i.test(v) ? v.match(/\b\d{9}\b/) : null);
    if (vat) take('vat_number', (vat[0] || '').replace(/\s+/g, '').toUpperCase());
    if (/charit/i.test(v)) { const m = v.match(/\b\d{6,8}\b/); if (m) take('charity_number', m[0]); }
    if (/registered (number|no\.?|in england|company)|company (number|no\.?)|registration number/i.test(v)) {
      const m = v.match(/\b\d{6,8}\b/); if (m) take('company_number', m[0]);
    }
    if (a.predicate === 'lives_at' || /registered office|registered address/i.test(v)) {
      const m = v.match(/(?:office(?:\s+is|:)?|address(?:\s+is|:)?|\bis)\s+(.+)$/i);
      take('registered_address', (m ? m[1] : v).replace(/\.\s*$/, ''));
    }
  }
  return out;
}

function companyIdentity(user, company) {
  const hub = db.hub();
  const manual = {};
  for (const r of hub.prepare(`
    SELECT predicate, value FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'company' AND subject_id = ? AND derived_by = 'manual'
      AND predicate IN (${COMPANY_IDENTITY_PREDICATES.map(() => '?').join(',')})
  `).all(user, company.id, ...COMPANY_IDENTITY_PREDICATES)) {
    manual[r.predicate] = r.value;
  }
  const atoms = hub.prepare(`
    SELECT predicate, value FROM knowledge_atoms
    WHERE user = ? AND status = 'active'
      AND (subject_id = ? OR (subject_id IS NULL AND lower(subject_label) = lower(?)))
  `).all(user, company.id, company.name);
  const suggest = extractCompanyIdentitySuggestions(atoms);
  return COMPANY_IDENTITY_FIELDS.map(f => ({
    ...f,
    value: manual[f.key] || '',
    suggestion: manual[f.key] ? null : (suggest[f.key] || null),
  }));
}

module.exports = {
  COMPANY_IDENTITY_FIELDS, COMPANY_IDENTITY_PREDICATES,
  upsertManualCompanyAtom, companyIdentity, extractCompanyIdentitySuggestions,
};
