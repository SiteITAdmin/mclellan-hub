#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');

const USER = 'douglas';
const COMPANY_NAMES = ['My Excel Care', 'IT Department'];
const ALISTER_NAME = 'Alister McLellan';

function args(argv) {
  const options = { db: process.env.HUB_DB_PATH || 'data/hub.db', apply: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') options.db = argv[++i];
    else if (argv[i] === '--apply') options.apply = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function tableHasColumn(hub, table, column) {
  return hub.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function referencesForContact(hub, contactId) {
  const refs = {};
  for (const [table, column] of [
    ['crm_facts', 'contact_id'],
    ['contact_projects', 'contact_id'],
    ['contact_companies', 'contact_id'],
    ['meeting_attendees', 'contact_id'],
    ['email_summaries', 'contact_id'],
    ['google_tasks', 'contact_id'],
  ]) {
    refs[table] = hub.prepare(`SELECT count(*) n FROM ${table} WHERE ${column} = ?`).get(contactId).n;
  }
  refs.knowledge_atoms = hub.prepare(
    "SELECT count(*) n FROM knowledge_atoms WHERE subject_kind = 'contact' AND subject_id = ?"
  ).get(contactId).n;
  return refs;
}

function repairCompanyDuplicate(hub, company, contact) {
  hub.prepare(`
    INSERT OR IGNORE INTO company_projects (company_id, project_id, role, created_at)
    SELECT ?, project_id, role, created_at FROM contact_projects WHERE contact_id = ?
  `).run(company.id, contact.id);
  hub.prepare('DELETE FROM contact_projects WHERE contact_id = ?').run(contact.id);

  hub.prepare(`
    UPDATE google_tasks
       SET company_id = ?, contact_id = NULL
     WHERE contact_id = ?
  `).run(company.id, contact.id);
  hub.prepare('UPDATE email_summaries SET contact_id = NULL WHERE contact_id = ?').run(contact.id);

  hub.prepare(`
    UPDATE knowledge_atoms
       SET subject_kind = 'company', subject_id = ?, subject_label = ?, updated_at = unixepoch()
     WHERE user = ?
       AND subject_kind = 'contact'
       AND (subject_id = ? OR lower(trim(subject_label)) = lower(trim(?)))
  `).run(company.id, company.name, USER, contact.id, company.name);

  const facts = hub.prepare('SELECT * FROM crm_facts WHERE contact_id = ?').all(contact.id);
  for (const fact of facts) {
    if (!fact.meeting_id) {
      throw new Error(`${contact.name} fact ${fact.id} has no durable source to replace its legacy CRM provenance`);
    }
    const atoms = hub.prepare(
      'SELECT id, source_refs FROM knowledge_atoms WHERE source_refs LIKE ?'
    ).all(`%"${fact.id}"%`);
    for (const atom of atoms) {
      const refs = parseJson(atom.source_refs, [])
        .filter(ref => !(ref?.kind === 'crm_fact' && ref.id === fact.id));
      if (!refs.some(ref => ref?.kind === 'meeting' && ref.id === fact.meeting_id)) {
        refs.push({ kind: 'meeting', id: fact.meeting_id });
      }
      hub.prepare(`
        UPDATE knowledge_atoms
           SET subject_kind = 'company', subject_id = ?, subject_label = ?,
               source_refs = ?, updated_at = unixepoch()
         WHERE id = ?
      `).run(company.id, company.name, JSON.stringify(refs), atom.id);
    }
    hub.prepare('DELETE FROM crm_facts WHERE id = ?').run(fact.id);
  }

  hub.prepare('DELETE FROM meeting_attendees WHERE contact_id = ?').run(contact.id);
  hub.prepare('DELETE FROM contact_companies WHERE contact_id = ?').run(contact.id);
  hub.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);
}

function repairAlisterKnowledge(hub) {
  const alister = hub.prepare(
    'SELECT id FROM contacts WHERE user = ? AND lower(name) = lower(?)'
  ).get(USER, ALISTER_NAME);
  if (!alister) throw new Error('Alister McLellan contact not found');

  const messages = hub.prepare(`
    SELECT id, raw_json FROM messaging_messages
    WHERE user = ? AND lower(chat_name) = 'dad information group'
  `).all(USER);
  for (const message of messages) {
    const raw = parseJson(message.raw_json, {});
    raw.route = { ...(raw.route || {}), subject_contact_name: ALISTER_NAME };
    raw.subject_contact_name = ALISTER_NAME;
    hub.prepare('UPDATE messaging_messages SET raw_json = ? WHERE id = ?')
      .run(JSON.stringify(raw), message.id);
  }

  hub.prepare(`
    UPDATE knowledge_atoms
       SET subject_id = ?, subject_label = ?, status = 'active', updated_at = unixepoch()
     WHERE user = ?
       AND subject_kind = 'contact'
       AND subject_id IS NULL
       AND lower(subject_label) = lower(?)
       AND json_valid(knowledge_atoms.source_refs)
       AND EXISTS (
         SELECT 1 FROM json_each(knowledge_atoms.source_refs) ref
         JOIN messaging_messages m ON m.id = json_extract(ref.value, '$.id')
         WHERE json_extract(ref.value, '$.kind') = 'messaging_message'
           AND lower(m.chat_name) = 'dad information group'
       )
  `).run(alister.id, ALISTER_NAME, USER, ALISTER_NAME);

  hub.prepare(`
    UPDATE knowledge_atoms
       SET status = 'retired', updated_at = unixepoch()
     WHERE user = ?
       AND json_valid(knowledge_atoms.source_refs)
       AND EXISTS (
         SELECT 1 FROM json_each(knowledge_atoms.source_refs) ref
         JOIN crm_facts f ON f.id = json_extract(ref.value, '$.id')
         WHERE json_extract(ref.value, '$.kind') = 'crm_fact'
           AND f.status IN ('wrong', 'archived')
       )
  `).run(USER);
}

function main() {
  const options = args(process.argv.slice(2));
  const hub = new Database(options.db);
  const plan = COMPANY_NAMES.map(name => {
    const company = hub.prepare(
      'SELECT * FROM companies WHERE user = ? AND lower(trim(name)) = lower(trim(?))'
    ).get(USER, name);
    const contact = hub.prepare(
      'SELECT * FROM contacts WHERE user = ? AND lower(trim(name)) = lower(trim(?))'
    ).get(USER, name);
    return {
      name,
      company_id: company?.id || null,
      contact_id: contact?.id || null,
      references: contact ? referencesForContact(hub, contact.id) : null,
    };
  });

  if (!options.apply) {
    console.log(JSON.stringify({ apply: false, db: options.db, plan }, null, 2));
    return;
  }

  if (!tableHasColumn(hub, 'crm_facts', 'contact_id')) throw new Error('crm_facts.contact_id missing');
  hub.transaction(() => {
    for (const item of plan) {
      if (!item.company_id || !item.contact_id) continue;
      const company = hub.prepare('SELECT * FROM companies WHERE id = ?').get(item.company_id);
      const contact = hub.prepare('SELECT * FROM contacts WHERE id = ?').get(item.contact_id);
      repairCompanyDuplicate(hub, company, contact);
    }
    repairAlisterKnowledge(hub);
  })();
  console.log(JSON.stringify({ apply: true, db: options.db, plan }, null, 2));
}

main();
