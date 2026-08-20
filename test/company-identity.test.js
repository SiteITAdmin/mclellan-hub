'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-identity-'));
const tempDb = path.join(tempDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tempDb);
process.env.HUB_DB_PATH = tempDb;

const db = require('../lib/db');
const {
  companyIdentity, upsertManualCompanyAtom, extractCompanyIdentitySuggestions, COMPANY_IDENTITY_PREDICATES,
} = require('../lib/company-identity');

let seq = 0;
function insertAtom({ user, label, subjectId = null, predicate = 'fact', value, status = 'active', derivedBy = 'synthesis' }) {
  const id = `atom-ci-${++seq}`;
  db.hub().prepare(`
    INSERT INTO knowledge_atoms (id, user, subject_kind, subject_id, subject_label, predicate, value,
      source_refs, confidence, status, derived_by, first_seen, last_confirmed, updated_at)
    VALUES (?, ?, 'company', ?, ?, ?, ?, '[]', 0.99, ?, ?, unixepoch(), unixepoch(), unixepoch())
  `).run(id, user, subjectId, label, predicate, value, status, derivedBy);
  return id;
}
const field = (identity, key) => identity.find(f => f.key === key);
const manualAtoms = (user, companyId) => db.hub().prepare(
  `SELECT predicate, value FROM knowledge_atoms WHERE user = ? AND subject_kind = 'company' AND subject_id = ? AND derived_by = 'manual'`
).all(user, companyId);

test('extractCompanyIdentitySuggestions pulls VAT, company number, charity number and address from facts', () => {
  const s = extractCompanyIdentitySuggestions([
    { predicate: 'fact', value: "H3O Digital Limited's VAT number is GB279886811." },
    { predicate: 'fact', value: 'Registered in England and Wales under company number 10986998.' },
    { predicate: 'lives_at', value: 'The registered office of H3O Digital Limited is 54 Charlotte Street, London, W1T 2NS.' },
    { predicate: 'fact', value: 'Registered charity number 1122334.' },
  ]);
  assert.equal(s.vat_number, 'GB279886811');
  assert.equal(s.company_number, '10986998');
  assert.equal(s.charity_number, '1122334');
  assert.match(s.registered_address, /54 Charlotte Street, London, W1T 2NS/);
});

test('companyIdentity suggests from unlinked (subject_id NULL) footer facts under the same name', () => {
  const user = 'ci-suggest';
  const company = { id: 'co-ci-1', name: 'H3O' };
  db.hub().prepare("INSERT INTO companies (id, user, name) VALUES (?, ?, ?)").run(company.id, user, company.name);
  insertAtom({ user, label: 'H3O', subjectId: null, value: "H3O Digital Limited's VAT number is GB279886811." });
  insertAtom({ user, label: 'H3O', subjectId: null, predicate: 'lives_at', value: 'The registered office of H3O Digital Limited is 54 Charlotte Street, London, W1T 2NS.' });

  const identity = companyIdentity(user, company);
  assert.equal(field(identity, 'vat_number').value, '', 'no manual value yet');
  assert.equal(field(identity, 'vat_number').suggestion, 'GB279886811');
  assert.match(field(identity, 'registered_address').suggestion, /Charlotte Street/);
});

test('saving an identity field writes a manual atom and clears the suggestion', () => {
  const user = 'ci-save';
  const company = { id: 'co-ci-2', name: 'H3O' };
  db.hub().prepare("INSERT INTO companies (id, user, name) VALUES (?, ?, ?)").run(company.id, user, company.name);
  insertAtom({ user, label: 'H3O', subjectId: null, value: "H3O Digital Limited's VAT number is GB279886811." });

  upsertManualCompanyAtom(user, company, 'vat_number', 'GB279886811');
  let identity = companyIdentity(user, company);
  assert.equal(field(identity, 'vat_number').value, 'GB279886811', 'manual value now shown');
  assert.equal(field(identity, 'vat_number').suggestion, null, 'suggestion suppressed once set');

  const atoms = manualAtoms(user, company.id);
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].predicate, 'vat_number');
  assert.equal(atoms[0].value, 'GB279886811');

  // Editing updates in place rather than duplicating.
  upsertManualCompanyAtom(user, company, 'vat_number', 'GB999999999');
  identity = companyIdentity(user, company);
  assert.equal(field(identity, 'vat_number').value, 'GB999999999');
  assert.equal(manualAtoms(user, company.id).length, 1, 'no duplicate manual atom');
});

test('clearing an identity field deletes its manual atom', () => {
  const user = 'ci-clear';
  const company = { id: 'co-ci-3', name: 'Acme Ltd' };
  db.hub().prepare("INSERT INTO companies (id, user, name) VALUES (?, ?, ?)").run(company.id, user, company.name);
  upsertManualCompanyAtom(user, company, 'company_number', '10986998');
  assert.equal(manualAtoms(user, company.id).length, 1);
  upsertManualCompanyAtom(user, company, 'company_number', '   ');
  assert.equal(manualAtoms(user, company.id).length, 0, 'blank value removes the atom');
});

test('all four identity predicates are covered', () => {
  assert.deepEqual(
    [...COMPANY_IDENTITY_PREDICATES].sort(),
    ['charity_number', 'company_number', 'registered_address', 'vat_number'],
  );
});
