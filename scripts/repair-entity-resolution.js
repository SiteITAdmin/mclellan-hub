'use strict';

// Repair already-stored meeting-intake extractions whose person names never
// linked to a contact, using the durable aliases that now exist.
//
// Why this exists: the exact-string linker left matched_contact null on names
// audio garbled ("Alec Kangley") or shortened (a bare "Ken"). Those names are
// now aliases on the right contacts, but the frozen extraction JSON still says
// "not matched", so the Questions board kept surfacing them. This re-runs the
// deterministic (exact/alias) resolution over each stored extraction and strips
// the stale "not in the known CRM" warnings — fixing the data that the code fix
// only prevents going forward (Rule 4).
//
// Deterministic only by default: no model plane, no cost, no corpus re-queue —
// it re-applies matching that current aliases already make free. Pass --model to
// additionally adjudicate still-unmatched names (spends Terra calls; opt-in).
//
//   node scripts/repair-entity-resolution.js            # dry run, deterministic
//   node scripts/repair-entity-resolution.js --apply    # write changes back
//   node scripts/repair-entity-resolution.js --apply --model
//   HUB_DB_PATH=<snapshot> node scripts/repair-entity-resolution.js  # snapshot

const db = require('./../lib/db');
const { resolveMeetingEntities } = require('./../lib/entity-resolution');

const APPLY = process.argv.includes('--apply');
const USE_MODEL = process.argv.includes('--model');
const USER = process.env.HUB_USER || 'douglas';

function parse(value, fallback) {
  try { const v = JSON.parse(value); return v == null ? fallback : v; } catch (_) { return fallback; }
}

async function main() {
  const hub = db.hub();
  const contacts = hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(USER);
  const projects = hub.prepare('SELECT id, slug, name FROM projects WHERE user = ?').all(USER);
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ?').all(USER);
  const intakes = hub.prepare(
    "SELECT id, title, project_slug, extraction FROM meeting_intakes WHERE user = ? AND status = 'processed' AND extraction IS NOT NULL AND extraction != ''"
  ).all(USER);

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${intakes.length} processed intake(s), model=${USE_MODEL}, db=${process.env.HUB_DB_PATH || 'data/hub.db'}\n`);

  let changed = 0;
  let totalLinks = 0;
  let totalWarnings = 0;
  for (const intake of intakes) {
    const extraction = parse(intake.extraction, null);
    if (!extraction || typeof extraction !== 'object') continue;
    // Work on a copy so a resolver failure cannot corrupt the stored row.
    const working = parse(intake.extraction, null);
    const result = await resolveMeetingEntities({
      user: USER,
      extraction: working,
      contacts,
      projects,
      companies,
      meetingTitle: intake.title || '',
      projectSlug: intake.project_slug || null,
      sourceKind: 'meeting_intake',
      sourceId: intake.id,
      useModel: USE_MODEL,
    });
    if (!result.resolved.length && !result.warningsStripped) continue;
    changed += 1;
    totalLinks += result.resolved.length;
    totalWarnings += result.warningsStripped;
    console.log(`• ${intake.title || intake.id}`);
    for (const r of result.resolved) console.log(`    ${r.name} -> ${r.contact} (${r.method}${r.confidence ? ` ${r.confidence}` : ''})`);
    if (result.warningsStripped) console.log(`    cleared ${result.warningsStripped} stale identity warning(s)`);
    if (APPLY) {
      hub.prepare('UPDATE meeting_intakes SET extraction = ? WHERE id = ? AND user = ?')
        .run(JSON.stringify(working), intake.id, USER);
    }
  }

  console.log(`\n${changed} intake(s) ${APPLY ? 'updated' : 'would change'} — ${totalLinks} link(s), ${totalWarnings} stale warning(s).`);
  if (!APPLY && changed) console.log('Re-run with --apply to write the changes.');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
