'use strict';

// Remove aliases that violate the alias invariant, and revert the links they
// produced.
//
// An alias is an alternate name for the SAME person ("Dad" = Alister). A name
// that already denotes a DIFFERENT contact can never be an alias of someone
// else: "Nick" is not an alias of Duncan Sackfield while Nick Chin exists — it
// is a CRM failure, usually from a narrow read of one sentence where the speaker
// merely mentions another person. `aliasCollidesWithOtherContact` is the
// invariant; `learnAlias` now enforces it going forward. This cleans the ones
// already stored and un-does the frozen `matched_contact` links that relied on
// them (so a wrongly-attributed action returns to unresolved rather than staying
// silently mis-owned).
//
//   node scripts/repair-bad-aliases.js            # dry run
//   node scripts/repair-bad-aliases.js --apply
//   HUB_DB_PATH=<snapshot> node scripts/repair-bad-aliases.js

const db = require('./../lib/db');
const { aliasCollidesWithOtherContact, normalizeName } = require('./../lib/entity-resolution');

const APPLY = process.argv.includes('--apply');
const USER = process.env.HUB_USER || 'douglas';

function parseArr(v) { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }

function main() {
  const hub = db.hub();
  const contacts = hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(USER);

  // 1. Find and remove colliding aliases.
  const removed = []; // { contactId, contactName, alias }
  for (const contact of contacts) {
    const aliases = parseArr(contact.aliases);
    const others = contacts.filter(c => c.id !== contact.id);
    const bad = aliases.filter(a => aliasCollidesWithOtherContact(a, contact.id, others));
    if (!bad.length) continue;
    const kept = aliases.filter(a => !bad.includes(a));
    for (const alias of bad) {
      removed.push({ contactId: contact.id, contactName: contact.name, alias });
      console.log(`• remove alias "${alias}" from [${contact.name}] — it denotes a different contact`);
    }
    if (APPLY) {
      hub.prepare('UPDATE contacts SET aliases = ? WHERE id = ? AND user = ?').run(JSON.stringify(kept), contact.id, USER);
      const { writeReceipt } = require('./../lib/crm-receipts');
      for (const alias of bad) {
        writeReceipt(USER, 'contact', contact.id, 'entity_resolution', {
          summary: `Removed invalid alias "${alias}" from ${contact.name} (denotes a different contact)`,
          status: 'done',
          payload: { contact_id: contact.id, contact_name: contact.name, alias, action: 'remove_colliding_alias', derived_by: 'alias_integrity_repair' },
        });
      }
    }
  }

  if (!removed.length) { console.log('No colliding aliases found.'); return; }

  // 2. Revert frozen links that depended on a removed alias: any stored
  // extraction where a name resolves to the removed alias and was matched to
  // that contact goes back to unresolved (it becomes an honest Question again).
  const byContact = new Map();
  for (const r of removed) {
    const key = r.contactId;
    if (!byContact.has(key)) byContact.set(key, { name: r.contactName, aliases: new Set() });
    byContact.get(key).aliases.add(normalizeName(r.alias));
  }
  const intakes = hub.prepare(
    "SELECT id, title, extraction FROM meeting_intakes WHERE user = ? AND status = 'processed' AND extraction IS NOT NULL AND extraction != ''"
  ).all(USER);
  let revertedLinks = 0;
  let touchedIntakes = 0;
  for (const intake of intakes) {
    let e;
    try { e = JSON.parse(intake.extraction); } catch (_) { continue; }
    let changed = false;
    const revert = (obj, nameField) => {
      const name = normalizeName(obj[nameField]);
      if (!obj.matched_contact) return;
      for (const { name: contactName, aliases } of byContact.values()) {
        if (normalizeName(obj.matched_contact) === normalizeName(contactName) && aliases.has(name)) {
          obj.matched_contact = null;
          if (obj.owner_type === 'known_person') obj.owner_type = 'unknown_speaker';
          changed = true; revertedLinks += 1;
          console.log(`    revert ${obj[nameField]} ✗ ${contactName} in "${intake.title || intake.id}"`);
        }
      }
    };
    for (const a of e.meeting?.attendees || []) revert(a, 'name');
    for (const u of e.crm_updates || []) revert(u, 'subject');
    for (const act of e.action_register || []) revert(act, 'owner');
    if (changed) {
      touchedIntakes += 1;
      if (APPLY) hub.prepare('UPDATE meeting_intakes SET extraction = ? WHERE id = ? AND user = ?').run(JSON.stringify(e), intake.id, USER);
    }
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — ${removed.length} alias(es) removed, ${revertedLinks} link(s) reverted across ${touchedIntakes} intake(s).`);
  if (!APPLY) console.log('Re-run with --apply to write the changes.');
}

main();
process.exit(0);
