'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const configPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'config', 'email-taxonomy.json');

const taxonomy = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const canonical = new Set(taxonomy.canonical_labels || []);
const mappings = taxonomy.legacy_mappings || {};
const classificationRules = taxonomy.classification_rules || [];
const review = taxonomy.review_required || [];
const errors = [];

for (const [legacy, target] of Object.entries(mappings)) {
  if (!legacy.trim()) errors.push('A legacy mapping has an empty source label.');
  if (!canonical.has(target)) {
    errors.push(`Legacy label "${legacy}" maps to unknown canonical label "${target}".`);
  }
}

for (const person of taxonomy.people || []) {
  if (!person.canonical_name || !person.gmail_label) {
    errors.push('Every person entry needs canonical_name and gmail_label.');
    continue;
  }
  if (!canonical.has(person.gmail_label)) {
    errors.push(`Person "${person.canonical_name}" uses unknown label "${person.gmail_label}".`);
  }
}

for (const rule of classificationRules) {
  if (!rule.match_type || !rule.match_value) {
    errors.push('Every classification rule needs match_type and match_value.');
  }
  if (!canonical.has(rule.target_label)) {
    errors.push(`Classification rule "${rule.match_value}" maps to unknown label "${rule.target_label}".`);
  }
}

const byTarget = new Map();
for (const [legacy, target] of Object.entries(mappings)) {
  if (!byTarget.has(target)) byTarget.set(target, []);
  byTarget.get(target).push(legacy);
}

console.log(`Email taxonomy v${taxonomy.version}`);
console.log(`${canonical.size} canonical labels; ${Object.keys(mappings).length} legacy mappings; ${classificationRules.length} live rules; ${review.length} labels require review.`);
console.log('');
console.log('Consolidations');
for (const [target, sources] of [...byTarget.entries()].sort()) {
  if (sources.length > 1) console.log(`- ${target} <= ${sources.join(', ')}`);
}

if (review.length) {
  console.log('');
  console.log('Review required');
  for (const item of review) console.log(`- ${item.legacy_label}: ${item.question}`);
}

if (errors.length) {
  console.error('');
  console.error('Validation failed');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('');
  console.log('Validation passed. No Gmail changes were made.');
}
