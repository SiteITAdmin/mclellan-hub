#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'automation-discovery-run' || ent.name === 'preview' || ent.name === 'data') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|ejs|py|md)$/.test(ent.name)) out.push(p);
  }
  return out;
}

const admin = fs.readFileSync(path.join(ROOT, 'routes/hub-admin.js'), 'utf8');
const registered = new Map(); // feature -> { group, label, note, fallback }
let currentGroup = null;
const groupStart = /\{ id: '([^']+)', label: '([^']+)', slots: \[/g;
const lines = admin.split('\n');
for (let i = 0; i < lines.length; i++) {
  const g = lines[i].match(/\{ id: '([^']+)', label: '([^']+)', slots:/);
  if (g) currentGroup = g[2];
  const f = lines[i].match(/\{\s*feature: '([^']+)',\s*scope: '([^']+)',\s*label: '([^']+)',\s*note: '([^']*)',\s*fallback: '([^']*)'/);
  if (f && currentGroup) {
    registered.set(f[1], { group: currentGroup, scope: f[2], label: f[3], note: f[4], fallback: f[5] });
  }
}

// PROMPTS keys
const promptsSrc = fs.readFileSync(path.join(ROOT, 'lib/prompts.js'), 'utf8');
const promptKeys = new Set();
const pm = promptsSrc.match(/const PROMPTS\s*=\s*\{([\s\S]*?)\n\};/);
if (pm) {
  for (const km of pm[1].matchAll(/^\s{2}([a-zA-Z0-9_]+)\s*:/gm)) promptKeys.add(km[1]);
}

const files = walk(ROOT).filter(f => f.endsWith('.js'));
const usages = new Map();

function touch(feat, file, kind, snip) {
  if (!feat || feat.includes('/')) return;
  // skip obvious non-features
  if (/^(ok|error|system|user|douglas|openrouter)$/i.test(feat)) return;
  if (!usages.has(feat)) usages.set(feat, { models: false, prompts: false, features: false, files: new Set(), snips: [] });
  const u = usages.get(feat);
  if (kind === 'models') u.models = true;
  if (kind === 'prompts') u.prompts = true;
  if (kind === 'feature') u.features = true;
  u.files.add(path.relative(ROOT, file));
  if (u.snips.length < 3) u.snips.push(snip);
}

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const pairs = [
    [/getSystemModelId\(\s*['"`]([^'"`]+)['"`]/g, 'models'],
    [/getSystemPrompt\(\s*['"`]([^'"`]+)['"`]/g, 'prompts'],
    [/getSystemPromptOverride\(\s*['"`]([^'"`]+)['"`]/g, 'prompts'],
    [/PROMPTS\.([a-zA-Z0-9_]+)/g, 'prompts'],
    [/feature:\s*['"`]([a-zA-Z0-9_-]+)['"`]/g, 'feature'],
    [/modelKey:\s*['"`]([a-zA-Z0-9_-]+)['"`]/g, 'feature'],
  ];
  for (const [rx, kind] of pairs) {
    let m;
    while ((m = rx.exec(text))) touch(m[1], file, kind, m[0]);
  }
}

function norm(k) {
  return String(k || '').replace(/-/g, '_');
}

const missing = [];
const seen = new Set();

// From PROMPTS
for (const k of promptKeys) {
  if (registered.has(k)) continue;
  if (seen.has(norm(k))) continue;
  seen.add(norm(k));
  missing.push({ key: k, reason: 'in PROMPTS but not SYSTEM_MODEL_GROUPS', usage: usages.get(k) });
}

// From getSystemModelId / getSystemPrompt
for (const [k, u] of usages) {
  if (!u.models && !u.prompts) continue;
  const nk = norm(k);
  if (registered.has(k) || registered.has(nk)) continue;
  if (seen.has(nk)) continue;
  seen.add(nk);
  missing.push({ key: k, reason: 'used via getSystemModelId/getSystemPrompt but not registered', usage: u });
}

// Features that look like system slots but unregistered (hyphen form of known patterns)
const knownHyphenAliases = [];
for (const [k, u] of usages) {
  if (!u.features) continue;
  const nk = norm(k);
  if (registered.has(k) || registered.has(nk)) continue;
  // if there's a corresponding registered slot with different naming, note alias
  if ([...registered.keys()].some(r => norm(r) === nk)) {
    knownHyphenAliases.push({ logKey: k, slot: [...registered.keys()].find(r => norm(r) === nk) });
    continue;
  }
  if (seen.has(nk)) continue;
  // only if also used as model/prompt OR looks like system feature snake/kebab
  if (u.models || u.prompts || /_/.test(k) || /-/.test(k)) {
    // filter noise from tests with random names
    if (/^(test|tmp|policy|approved|wiki_overview)/i.test(k)) continue;
    if (k.length < 3) continue;
    seen.add(nk);
    missing.push({ key: k, reason: 'feature/modelKey logged but no admin slot', usage: u });
  }
}

console.log('Registered SYSTEM_MODEL_GROUPS slots:', registered.size);
console.log('PROMPTS keys:', promptKeys.size);
console.log('');
console.log('=== MISSING FROM SYSTEM_MODEL_GROUPS ===');
for (const m of missing.sort((a, b) => a.key.localeCompare(b.key))) {
  const files = m.usage ? [...m.usage.files].join(', ') : '';
  const flags = m.usage
    ? [m.usage.models && 'model', m.usage.prompts && 'prompt', m.usage.features && 'feature'].filter(Boolean).join('+')
    : '';
  console.log(`- ${m.key}`);
  console.log(`  reason: ${m.reason}`);
  if (flags) console.log(`  flags: ${flags}`);
  if (files) console.log(`  files: ${files}`);
}

console.log('');
console.log('=== IN GROUPS, NOT IN PROMPTS (prompt-only empty ok if intentional) ===');
for (const k of [...registered.keys()].sort()) {
  if (!promptKeys.has(k)) console.log(`- ${k}  (${registered.get(k).group} / ${registered.get(k).label})`);
}

console.log('');
console.log('=== HYPHEN LOG KEYS THAT MAP TO EXISTING SLOTS ===');
for (const a of knownHyphenAliases) console.log(`- ${a.logKey} -> ${a.slot}`);
console.log('');
console.log('Total missing candidates:', missing.length);

module.exports = { registered, promptKeys, usages, missing };
