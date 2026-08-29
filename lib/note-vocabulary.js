'use strict';

// The words Douglas actually writes, published for the handwriting recogniser.
//
// Apple Vision matches glyph shapes against a generic dictionary, so it has no
// idea who Fergal is and reads him as "fangel". VNRecognizeTextRequest accepts
// `customWords`, which biases recognition toward a supplied vocabulary — so the
// names and terms the Hub already knows about are exactly the prior the reader
// was missing.
//
// Built on the VPS (the Mac's hub.db is a stale partial copy) and written into
// the vault, which already flows VPS → Mac, where the recogniser picks it up.
// Nothing here is knowledge: it is a hint list, and a wrong hint can only make
// Vision prefer a real word over a garbled one.

const fs = require('fs');
const path = require('path');
const db = require('./db');

// Vision degrades with an unbounded list, and the long tail of one-off words
// adds noise rather than signal.
const MAX_WORDS = 400;
const MIN_LENGTH = 3;

// Words Vision already knows; priming on these wastes slots.
const TOO_COMMON = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'has', 'was',
  'are', 'not', 'but', 'you', 'his', 'her', 'their', 'about', 'into', 'over',
  'meeting', 'email', 'call', 'task', 'note', 'notes', 'review', 'update',
]);

function splitName(value) {
  return String(value || '')
    .split(/[^A-Za-z0-9'’-]+/)
    .map(part => part.trim())
    .filter(part => part.length >= MIN_LENGTH && !TOO_COMMON.has(part.toLowerCase()));
}

/**
 * Names and domain terms worth priming: people and companies he writes about,
 * live project names, and the distinctive words in his open task titles.
 */
function buildVocabulary(user = 'douglas') {
  const hub = db.hub();
  const words = new Map(); // lowercase → preferred casing

  const add = (value) => {
    for (const word of splitName(value)) {
      const key = word.toLowerCase();
      if (!words.has(key)) words.set(key, word);
    }
  };

  const safely = (fn) => { try { return fn(); } catch (_) { return []; } };

  safely(() => hub.prepare('SELECT name FROM contacts WHERE user = ?').all(user)).forEach(r => add(r.name));
  safely(() => hub.prepare('SELECT name FROM companies WHERE user = ?').all(user)).forEach(r => add(r.name));
  safely(() => hub.prepare('SELECT name FROM projects WHERE user = ?').all(user)).forEach(r => add(r.name));
  safely(() => hub.prepare(
    "SELECT title FROM google_tasks WHERE user = ? AND deleted_at IS NULL ORDER BY synced_at DESC LIMIT 300",
  ).all(user)).forEach(r => add(r.title));

  return [...words.values()].slice(0, MAX_WORDS);
}

/** Publish the list into the notes inbox for the Mac-side recogniser. */
function writeVocabulary(user = 'douglas', vaultRoot) {
  const root = vaultRoot
    || process.env.BOOX_DRIVE_VAULT_ROOT
    || process.env.WORKDAY_SYNC_LOCAL_DIR
    || path.join(__dirname, '..', 'data', 'synthadoc', 'mclellan-hub-knowledge');
  const dir = path.join(root, 'raw_sources', 'boox-notes');
  fs.mkdirSync(dir, { recursive: true });
  const words = buildVocabulary(user);
  const file = path.join(dir, 'vocabulary.json');
  fs.writeFileSync(file, JSON.stringify({
    builtAt: new Date().toISOString(),
    source: 'contacts, companies, live projects, recent task titles',
    words,
  }, null, 2));
  return { file, count: words.length };
}

module.exports = { MAX_WORDS, buildVocabulary, writeVocabulary };
