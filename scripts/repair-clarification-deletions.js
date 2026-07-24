#!/usr/bin/env node
'use strict';

// Before /crm/questions had a Discard button, typing "Delete this - not relevant"
// into the answer box wrote it into the knowledge layer as a decision — the live
// layer ended up asserting things like "Ashwin is not relevant to the
// Cybersecurity Report and Framework project". This converts those answers into
// discards: the atom goes, the row stays so the boards keep quiet.
//
// Idempotent. Run with --apply to write; default is a dry run.

const db = require('../lib/db');
const { isDeleteIntent } = require('../lib/crm-clarifications');

const apply = process.argv.includes('--apply');
const user = process.argv.find(arg => arg.startsWith('--user='))?.split('=')[1] || 'douglas';

const hub = db.hub();
const rows = hub.prepare(
  'SELECT question_key, question, answer, atom_id, resolution FROM crm_clarification_answers WHERE user = ? AND atom_id IS NOT NULL'
).all(user);

const targets = rows.filter(row => isDeleteIntent(row.answer));
console.log(`${targets.length} of ${rows.length} answer(s) were really deletions.`);

let removed = 0;
for (const row of targets) {
  const atom = hub.prepare('SELECT subject_label, predicate, value FROM knowledge_atoms WHERE id = ?').get(row.atom_id);
  console.log(`\n  Q: ${row.question.slice(0, 90)}`);
  console.log(`  A: ${row.answer}`);
  console.log(`  atom: ${atom ? `${atom.subject_label} | ${atom.predicate} | ${atom.value.slice(0, 120)}` : '(already gone)'}`);
  if (!apply) continue;

  const tx = hub.transaction(() => {
    if (atom) hub.prepare('DELETE FROM knowledge_atoms WHERE id = ?').run(row.atom_id);
    hub.prepare(`
      UPDATE crm_clarification_answers
         SET atom_id = NULL,
             answer = 'Discarded — not worth answering.',
             resolution = json_set(COALESCE(NULLIF(resolution, ''), '{}'), '$.decision', 'discarded',
                                   '$.repaired_from_answer', ?)
       WHERE user = ? AND question_key = ?
    `).run(row.answer, user, row.question_key);
  });
  tx();
  removed++;
}

console.log(apply
  ? `\nRepaired ${removed} row(s); the questions stay closed and the false atoms are gone.`
  : '\nDry run. Re-run with --apply to remove those atoms.');
