#!/usr/bin/env node
'use strict';

// Deliberate one-shot repair for the knowledge review queue: collapse paraphrase
// duplicates and auto-resolve any proposed atom that matches a fact already
// approved or rejected. Same code path the nightly synthesis job and the
// /admin/knowledge "dedup" button now run — this just lets an operator trigger
// it immediately (e.g. after deploy) where the embedding + model plane is live.
//
//   node scripts/dedup-knowledge-queue.js            # all briefing users
//   node scripts/dedup-knowledge-queue.js douglas    # one user
//
// Requires the production model plane (Ollama embeddings + subscription worker).
// Fail-closed: without embeddings it reports embeddingsUnavailable and changes
// nothing.

const { dedupProposedAtoms } = require('../lib/atom-dedup');

function briefingUsers() {
  const raw = process.env.BRIEFING_USERS || 'douglas';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

(async () => {
  const users = process.argv[2] ? [process.argv[2]] : briefingUsers();
  for (const user of users) {
    try {
      const res = await dedupProposedAtoms(user);
      console.log(`[dedup] ${user}:`, JSON.stringify(res));
    } catch (err) {
      console.error(`[dedup] ${user} error:`, err.message);
      process.exitCode = 1;
    }
  }
})();
