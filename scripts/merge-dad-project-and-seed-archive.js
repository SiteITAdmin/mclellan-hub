#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');

const USER = 'douglas';
const TARGET_SLUG = 'dad';
const SOURCE_SLUG = 'alister';
const BUCKET_ID = 'dad-whatsapp-history';
const BUCKET_NAME = 'Dad WhatsApp history';

function parseArgs(argv) {
  const options = {
    db: process.env.HUB_DB_PATH || 'data/hub.db',
    sourceDb: null,
    apply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--db') options.db = argv[++i];
    else if (argv[i] === '--source-db') options.sourceDb = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!options.sourceDb) throw new Error('--source-db is required');
  return options;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function historicalRows(source) {
  return source.prepare('SELECT * FROM messaging_messages ORDER BY received_at, id').all()
    .filter(row => {
      const raw = parseJson(row.raw_json, {});
      return raw?.raw?.historical_backfill === true
        && String(raw?.raw?.source_name || '').includes('Dad Information Group');
    });
}

function sourceRefs(value) {
  const refs = parseJson(value, []);
  return Array.isArray(refs) ? refs : [];
}

function mergeRefs(left, right) {
  const merged = [];
  for (const ref of [...sourceRefs(left), ...sourceRefs(right)]) {
    if (!ref?.kind || !ref?.id) continue;
    if (!merged.some(existing => existing.kind === ref.kind && existing.id === ref.id)) merged.push(ref);
  }
  return merged;
}

function routedRawJson(value, target) {
  const raw = parseJson(value, {});
  raw.project_slug = target.slug;
  raw.project_name = target.name;
  raw.route = {
    ...(raw.route && typeof raw.route === 'object' ? raw.route : {}),
    project_slug: target.slug,
    project_name: target.name,
  };
  raw.raw = {
    ...(raw.raw && typeof raw.raw === 'object' ? raw.raw : {}),
    source: 'sealed_messaging_archive',
    historical_backfill: true,
  };
  return JSON.stringify(raw);
}

function tableCount(hub, table, column, value) {
  return Number(hub.prepare(`SELECT count(*) n FROM ${table} WHERE ${column} = ?`).get(value).n || 0);
}

function buildPlan(hub, source) {
  const target = hub.prepare('SELECT * FROM projects WHERE user = ? AND slug = ?').get(USER, TARGET_SLUG);
  if (!target) throw new Error('Dad target project not found');
  const sourceProject = hub.prepare('SELECT * FROM projects WHERE user = ? AND slug = ?').get(USER, SOURCE_SLUG);
  const archiveRows = historicalRows(source);
  if (!archiveRows.length) throw new Error('No Dad Information Group historical messages found in source database');
  const existingBucket = hub.prepare('SELECT * FROM messaging_archive_buckets WHERE id = ?').get(BUCKET_ID);

  return {
    target,
    sourceProject,
    archiveRows,
    existingBucket,
    merge: sourceProject ? {
      tasks: tableCount(hub, 'google_tasks', 'project_slug', SOURCE_SLUG),
      atoms: Number(hub.prepare(
        "SELECT count(*) n FROM knowledge_atoms WHERE user = ? AND subject_kind = 'project' AND subject_id = ?"
      ).get(USER, sourceProject.id).n || 0),
      documents: tableCount(hub, 'documents', 'project_id', sourceProject.id),
      messages: tableCount(hub, 'messages', 'project_id', sourceProject.id),
      contactLinks: tableCount(hub, 'contact_projects', 'project_id', sourceProject.id),
      companyLinks: tableCount(hub, 'company_projects', 'project_id', sourceProject.id),
    } : null,
  };
}

function mergeProjectAtoms(hub, sourceProject, target) {
  const atoms = hub.prepare(`
    SELECT * FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'project' AND subject_id = ?
  `).all(USER, sourceProject.id);
  let moved = 0;
  let merged = 0;
  for (const atom of atoms) {
    const duplicate = hub.prepare(`
      SELECT * FROM knowledge_atoms
      WHERE user = ? AND subject_kind = 'project' AND subject_id = ?
        AND predicate = ? AND lower(value) = lower(?)
      LIMIT 1
    `).get(USER, target.id, atom.predicate, atom.value);
    if (duplicate) {
      hub.prepare(`
        UPDATE knowledge_atoms
        SET source_refs = ?, confidence = ?, last_confirmed = max(last_confirmed, ?),
            updated_at = unixepoch()
        WHERE id = ?
      `).run(
        JSON.stringify(mergeRefs(duplicate.source_refs, atom.source_refs)),
        Math.max(Number(duplicate.confidence) || 0, Number(atom.confidence) || 0),
        Number(atom.last_confirmed) || 0,
        duplicate.id
      );
      hub.prepare("DELETE FROM embeddings WHERE source_kind = 'atom' AND source_id = ?").run(atom.id);
      hub.prepare('DELETE FROM knowledge_atoms WHERE id = ?').run(atom.id);
      merged += 1;
    } else {
      hub.prepare(`
        UPDATE knowledge_atoms
        SET subject_id = ?, subject_label = ?, updated_at = unixepoch()
        WHERE id = ?
      `).run(target.id, target.name, atom.id);
      hub.prepare("DELETE FROM embeddings WHERE source_kind = 'atom' AND source_id = ?").run(atom.id);
      moved += 1;
    }
  }
  return { moved, merged };
}

function moveProjectReferences(hub, sourceProject, target) {
  hub.prepare(`
    INSERT OR IGNORE INTO contact_projects (contact_id, project_id, role, created_at)
    SELECT contact_id, ?, role, created_at FROM contact_projects WHERE project_id = ?
  `).run(target.id, sourceProject.id);
  hub.prepare('DELETE FROM contact_projects WHERE project_id = ?').run(sourceProject.id);
  hub.prepare(`
    INSERT OR IGNORE INTO company_projects (company_id, project_id, role, created_at)
    SELECT company_id, ?, role, created_at FROM company_projects WHERE project_id = ?
  `).run(target.id, sourceProject.id);
  hub.prepare('DELETE FROM company_projects WHERE project_id = ?').run(sourceProject.id);
  hub.prepare('UPDATE documents SET project_id = ? WHERE project_id = ?').run(target.id, sourceProject.id);
  hub.prepare('UPDATE messages SET project_id = ? WHERE project_id = ?').run(target.id, sourceProject.id);

  for (const table of [
    'crm_facts',
    'email_summaries',
    'google_tasks',
    'inbound_email_records',
    'meeting_intakes',
    'request_logs',
    'task_extraction_feedback',
  ]) {
    hub.prepare(`UPDATE ${table} SET project_slug = ? WHERE project_slug = ?`).run(target.slug, sourceProject.slug);
  }

  const sourceSchedule = hub.prepare(
    'SELECT * FROM project_report_schedules WHERE user = ? AND project_slug = ?'
  ).get(USER, sourceProject.slug);
  const targetSchedule = hub.prepare(
    'SELECT 1 FROM project_report_schedules WHERE user = ? AND project_slug = ?'
  ).get(USER, target.slug);
  if (sourceSchedule && !targetSchedule) {
    hub.prepare('UPDATE project_report_schedules SET project_slug = ? WHERE id = ?')
      .run(target.slug, sourceSchedule.id);
  } else if (sourceSchedule) {
    hub.prepare('DELETE FROM project_report_schedules WHERE id = ?').run(sourceSchedule.id);
  }

  const atoms = mergeProjectAtoms(hub, sourceProject, target);
  hub.prepare('DELETE FROM projects WHERE id = ? AND user = ?').run(sourceProject.id, USER);
  return atoms;
}

function seedArchive(hub, plan) {
  if (plan.existingBucket) {
    const existingCount = Number(hub.prepare(
      'SELECT count(*) n FROM messaging_archive_messages WHERE bucket_id = ?'
    ).get(BUCKET_ID).n || 0);
    if (existingCount !== plan.archiveRows.length || !plan.existingBucket.sealed_at) {
      throw new Error(`Existing archive is incomplete: ${existingCount}/${plan.archiveRows.length}`);
    }
    return { imported: 0, existing: existingCount };
  }

  hub.prepare(`
    INSERT INTO messaging_archive_buckets
      (id, user, project_id, name, source_name, total_messages, sealed_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `).run(
    BUCKET_ID,
    USER,
    plan.target.id,
    BUCKET_NAME,
    'WhatsApp Chat - Dad Information Group.zip/_chat.txt',
    plan.archiveRows.length
  );
  const insert = hub.prepare(`
    INSERT INTO messaging_archive_messages
      (id, bucket_id, user, platform, external_message_id, chat_id, chat_name,
       is_group, sender_id, sender_name, body, received_at, raw_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  `);
  for (const row of plan.archiveRows) {
    insert.run(
      row.id,
      BUCKET_ID,
      USER,
      row.platform,
      row.external_message_id,
      row.chat_id,
      row.chat_name,
      row.is_group,
      row.sender_id,
      row.sender_name,
      row.body,
      row.received_at,
      routedRawJson(row.raw_json, plan.target)
    );
  }
  hub.prepare('UPDATE messaging_archive_buckets SET sealed_at = unixepoch() WHERE id = ?')
    .run(BUCKET_ID);
  return { imported: plan.archiveRows.length, existing: 0 };
}

function applyPlan(hub, plan) {
  return hub.transaction(() => {
    const archive = seedArchive(hub, plan);
    const merge = plan.sourceProject
      ? moveProjectReferences(hub, plan.sourceProject, plan.target)
      : { moved: 0, merged: 0 };
    return { archive, project_atoms: merge };
  })();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  process.env.HUB_DB_PATH = options.db;
  const hub = require('../lib/db').hub();
  const source = new Database(options.sourceDb, { readonly: true });
  try {
    const plan = buildPlan(hub, source);
    const printable = {
      mode: options.apply ? 'apply' : 'dry-run',
      target_project: `${plan.target.name} /${plan.target.slug}`,
      source_project: plan.sourceProject ? `${plan.sourceProject.name} /${plan.sourceProject.slug}` : 'already merged',
      project_merge: plan.merge,
      archive_messages: plan.archiveRows.length,
      archive_already_exists: Boolean(plan.existingBucket),
    };
    console.log(JSON.stringify(printable, null, 2));
    if (!options.apply) return;

    const result = applyPlan(hub, plan);
    const sourceStillExists = hub.prepare(
      'SELECT count(*) n FROM projects WHERE user = ? AND slug = ?'
    ).get(USER, SOURCE_SLUG).n;
    const archive = hub.prepare(`
      SELECT b.total_messages, b.sealed_at, count(m.id) AS stored
      FROM messaging_archive_buckets b
      LEFT JOIN messaging_archive_messages m ON m.bucket_id = b.id
      WHERE b.id = ?
      GROUP BY b.id
    `).get(BUCKET_ID);
    if (sourceStillExists || !archive?.sealed_at || archive.stored !== archive.total_messages) {
      throw new Error('Post-repair verification failed');
    }
    console.log(JSON.stringify({ result, source_project_remaining: sourceStillExists, archive }, null, 2));
  } finally {
    source.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
