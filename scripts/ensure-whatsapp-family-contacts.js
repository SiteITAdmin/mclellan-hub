#!/usr/bin/env node
'use strict';

const db = require('../lib/db');
const { uuid } = require('../lib/id');

const user = process.argv[2] || 'douglas';
const hub = db.hub();

function parseAliases(value) {
  try {
    const aliases = JSON.parse(value || '[]');
    return Array.isArray(aliases) ? aliases.map(String) : [];
  } catch (_) {
    return [];
  }
}

function ensureAlias(contact, alias) {
  const aliases = parseAliases(contact.aliases);
  if (!aliases.some(value => value.toLowerCase() === alias.toLowerCase())) aliases.push(alias);
  hub.prepare('UPDATE contacts SET aliases = ? WHERE id = ? AND user = ?')
    .run(JSON.stringify(aliases), contact.id, user);
  return aliases;
}

const result = hub.transaction(() => {
  const nakai = hub.prepare('SELECT id, name, aliases FROM contacts WHERE id = ? AND user = ?')
    .get('cd023ce9-0b73-494a-9822-acbe1b2cb1c1', user);
  if (!nakai || nakai.name !== 'Nakai McLellan') {
    throw new Error('Expected Nakai McLellan contact was not found at the supplied CRM ID');
  }

  let liz = hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ? AND lower(name) = lower(?)')
    .get(user, 'Liz Smith');
  let created = false;
  if (!liz) {
    liz = { id: uuid(), name: 'Liz Smith', aliases: '[]' };
    hub.prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)')
      .run(liz.id, user, liz.name, liz.aliases);
    created = true;
  }
  const aliases = ensureAlias(liz, 'Wee Lizzie');

  const fact = 'In the Dad Information Group WhatsApp export, the sender name Wee Lizzie refers to Liz Smith.';
  let factRow = hub.prepare(`
    SELECT id FROM crm_facts
    WHERE user = ? AND contact_id = ? AND source = 'user-whatsapp-routing' AND fact = ?
    LIMIT 1
  `).get(user, liz.id, fact);
  if (!factRow) {
    factRow = { id: uuid() };
    hub.prepare(`
      INSERT INTO crm_facts (id, user, contact_id, fact, status, source)
      VALUES (?, ?, ?, ?, 'active', 'user-whatsapp-routing')
    `).run(factRow.id, user, liz.id, fact);
  }

  return {
    nakai: { id: nakai.id, name: nakai.name, aliases: parseAliases(nakai.aliases) },
    liz_smith: { id: liz.id, name: liz.name, aliases, created },
    source_fact_id: factRow.id,
  };
})();

console.log(JSON.stringify(result, null, 2));
