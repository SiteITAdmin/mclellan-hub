'use strict';

const db = require('./db');

function parseAliases(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(item => String(item || '').trim()).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEmail(value) {
  const clean = String(value || '').trim().toLowerCase();
  return clean.includes('@') ? clean : '';
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('@')) return '';
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
}

function contactNameTerms(contact = {}) {
  return [contact.name, ...parseAliases(contact.aliases)]
    .map(normalizeName)
    .filter(Boolean);
}

function contactEmailTerms(contact = {}) {
  return [contact.email, ...(contact.identity_emails || [])]
    .map(normalizeEmail)
    .filter(Boolean);
}

function contactPhoneTerms(contact = {}) {
  return [contact.phone, ...(contact.identity_phones || [])]
    .map(normalizePhone)
    .filter(Boolean);
}

function loadContactIdentities(user, { hub = db.hub() } = {}) {
  let rows;
  try {
    rows = hub.prepare(`
      SELECT id, name, email, phone, aliases
      FROM contacts
      WHERE user = ?
      ORDER BY name, id
    `).all(user);
  } catch (_) {
    try {
      rows = hub.prepare(`
        SELECT id, name, aliases
        FROM contacts
        WHERE user = ?
        ORDER BY name, id
      `).all(user).map(contact => ({ ...contact, email: '', phone: '' }));
    } catch (_) {
      return [];
    }
  }
  const contacts = rows.map(contact => ({
    ...contact,
    identity_emails: [],
    identity_phones: [],
  }));
  if (!contacts.length) return contacts;

  const byId = new Map(contacts.map(contact => [contact.id, contact]));
  try {
    const atoms = hub.prepare(`
      SELECT subject_id, predicate, value
      FROM knowledge_atoms
      WHERE user = ? AND status = 'active' AND subject_id IS NOT NULL
        AND predicate IN ('email', 'phone')
    `).all(user);
    for (const atom of atoms) {
      const contact = byId.get(atom.subject_id);
      if (!contact) continue;
      if (atom.predicate === 'email') contact.identity_emails.push(atom.value);
      else if (atom.predicate === 'phone') contact.identity_phones.push(atom.value);
    }
  } catch (_) {
    // Identity atoms are compiled enrichment; a fresh database can still route
    // from the canonical contact row before the knowledge schema exists.
  }
  return contacts;
}

function compositeNameMatches(contact, observedName) {
  const observed = normalizeName(observedName);
  const tokens = [...new Set(observed.split(' ').filter(token => token.length >= 2))];
  if (tokens.length < 2) return false;
  const knownTokens = new Set(contactNameTerms(contact).flatMap(term => term.split(' ')));
  return tokens.every(token => knownTokens.has(token));
}

function firstNameMatches(contact, observedName) {
  const observed = normalizeName(observedName);
  if (!observed || observed.includes(' ')) return false;
  return contactNameTerms(contact).some(term => term.split(' ')[0] === observed);
}

function resolveContactIdentityFromContacts(contacts = [], {
  names = [],
  addresses = [],
} = {}) {
  const signals = [];
  const addSignal = (kind, value, matches) => {
    const ids = [...new Set(matches.map(contact => contact.id))];
    if (ids.length) signals.push({ kind, value: String(value || ''), ids });
  };

  for (const address of addresses) {
    const email = normalizeEmail(address);
    if (email) {
      addSignal('email', address, contacts.filter(contact => contactEmailTerms(contact).includes(email)));
      continue;
    }
    const phone = normalizePhone(address);
    if (phone) addSignal('phone', address, contacts.filter(contact => contactPhoneTerms(contact).includes(phone)));
  }

  for (const name of names) {
    const wanted = normalizeName(name);
    if (!wanted) continue;
    const canonical = contacts.filter(contact => normalizeName(contact.name) === wanted);
    if (canonical.length) {
      addSignal('canonical_name', name, canonical);
      continue;
    }
    const alias = contacts.filter(contact => parseAliases(contact.aliases).some(term => normalizeName(term) === wanted));
    if (alias.length) {
      addSignal('alias', name, alias);
      continue;
    }
    const firstName = contacts.filter(contact => firstNameMatches(contact, name));
    if (firstName.length) {
      addSignal('unique_first_name', name, firstName);
      continue;
    }
    addSignal('composite_alias', name, contacts.filter(contact => compositeNameMatches(contact, name)));
  }

  const candidateIds = [...new Set(signals.flatMap(signal => signal.ids))];
  if (candidateIds.length !== 1 || signals.some(signal => signal.ids.length !== 1 || signal.ids[0] !== candidateIds[0])) {
    return {
      status: candidateIds.length ? 'ambiguous' : 'unresolved',
      contact: null,
      candidateIds,
      signals,
    };
  }
  const contact = contacts.find(candidate => candidate.id === candidateIds[0]) || null;
  return {
    status: contact ? 'matched' : 'unresolved',
    contact,
    candidateIds,
    signals,
    matchedBy: [...new Set(signals.map(signal => signal.kind))],
  };
}

function resolveContactIdentity(user, hints, { hub = db.hub(), contacts = null } = {}) {
  return resolveContactIdentityFromContacts(contacts || loadContactIdentities(user, { hub }), hints);
}

module.exports = {
  contactEmailTerms,
  contactNameTerms,
  contactPhoneTerms,
  loadContactIdentities,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  parseAliases,
  resolveContactIdentity,
  resolveContactIdentityFromContacts,
};
