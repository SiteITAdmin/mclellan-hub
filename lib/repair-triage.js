'use strict';

// Phase 1 of the self-repair venue: decide whether a reproducer qualifies for
// auto-repair (fixable-narrow) or must go to Douglas. Deterministic rules run
// first; a model may optionally be consulted afterwards, and it can only
// DOWNGRADE a fixable-narrow verdict (to config_fix or escalate) — it can
// never widen the venue's reach, mirroring the remediation advisor's
// choose-from-a-menu safety property.
//
// Verdicts:
//   fixable-narrow — proceed to the repair venue (Phase 2)
//   config_fix     — the fix is a model-slot change, not code; email Douglas
//   escalate       — needs a human; email Douglas with the diagnosis
//   skip           — transient/infra noise the existing remediation already
//                    retries; log and move on

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { writeRepairReceipt, SNAPSHOT_DIR } = require('./repair-reproducer');

const ROOT = path.join(__dirname, '..');
const TRIAGE_FEATURE = 'repair_triage';
const TRIAGE_FALLBACK_MODEL = 'claude-opus-4-8';

// Model/prompt slots are configured in the PROD admin UI and travel to the Mac
// mini inside the snapshot — read them from there, never from the local dev DB.
// Key layout must match lib/settings.js exactly, hence the shared prefixes.
function openSnapshot(snapshotDir = SNAPSHOT_DIR) {
  const dbPath = path.join(snapshotDir, 'hub.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (_) {
    return null;
  }
}

function getSnapshotModelId(feature, fallback, snapshotDir = SNAPSHOT_DIR) {
  const { KEY_PREFIX } = require('./settings');
  const db = openSnapshot(snapshotDir);
  if (!db) return fallback;
  try {
    const row = db.prepare(
      "SELECT value FROM crm_context WHERE user = 'system' AND key = ?"
    ).get(`${KEY_PREFIX}${feature}`);
    if (row?.value) {
      const modelRow = db.prepare(
        'SELECT model_id FROM model_config WHERE key = ? AND enabled = 1'
      ).get(row.value);
      if (modelRow) return modelRow.model_id;
    }
  } catch (_) { /* fall through */ } finally {
    try { db.close(); } catch (_) { /* ignore */ }
  }
  return fallback;
}

function getSnapshotPrompt(feature, fallback, snapshotDir = SNAPSHOT_DIR) {
  const { PROMPT_PREFIX } = require('./settings');
  const db = openSnapshot(snapshotDir);
  if (!db) return fallback;
  try {
    const row = db.prepare(
      "SELECT value FROM crm_context WHERE user = 'system' AND key = ?"
    ).get(`${PROMPT_PREFIX}${feature}`);
    if (row?.value) return row.value;
  } catch (_) { /* fall through */ } finally {
    try { db.close(); } catch (_) { /* ignore */ }
  }
  return fallback;
}

// Which models served the slot that produced this error, from the snapshot's
// request_logs (mined into the reproducer). We match the reproducer's label
// ("Email classifier response") to model keys ("email-classifier") loosely by
// shared words. If only one model has served the slot recently we cannot rule
// out a model problem — that is a config_suspect note for the PR/email, not
// grounds to block a code fix: the parsing path must handle bad shapes
// whichever model is on the slot.
function modelCorrelation(reproducer) {
  const label = String(reproducer.triggering_input?.label || '').toLowerCase();
  const words = label.split(/[^a-z]+/).filter(w => w.length >= 4);
  const related = (reproducer.model_usage || []).filter(u => {
    const key = String(u.model_key || '').toLowerCase();
    return words.some(w => key.includes(w));
  });
  const distinctModels = [...new Set(related.map(u => u.model_id).filter(Boolean))];
  return {
    matched_model_keys: [...new Set(related.map(u => u.model_key))],
    distinct_models: distinctModels,
    single_model: distinctModels.length === 1,
    current_model: distinctModels[0] || null,
  };
}

function withinAllowedScope(reproducer) {
  const allowed = reproducer.constraints?.allowed_paths || [];
  const forbidden = reproducer.constraints?.forbidden || [];
  if (!allowed.length) return { ok: false, reason: 'no located source files — cannot confine the fix' };
  if (allowed.length > (reproducer.constraints?.max_files_changed || 3)) {
    return { ok: false, reason: `fix spans ${allowed.length} files — over scope limit` };
  }
  for (const file of allowed) {
    if (!file.startsWith('lib/')) return { ok: false, reason: `${file} is outside lib/` };
    if (forbidden.some(f => file === f || file.startsWith(f))) {
      return { ok: false, reason: `${file} is on the forbidden list` };
    }
  }
  return { ok: true };
}

// Ask a cheap model to sanity-check a fixable-narrow verdict. It may only
// confirm, or downgrade to config_fix/escalate — a "fixable" answer for a
// verdict the deterministic rules rejected is ignored.
async function adviseTriage(reproducer, verdict, { snapshotDir = SNAPSHOT_DIR } = {}) {
    const { chatJson } = require('./chat-completions');
    const { parseModelObject } = require('./model-response');
  const modelId = getSnapshotModelId(TRIAGE_FEATURE, TRIAGE_FALLBACK_MODEL, snapshotDir);
  const { PROMPTS } = require('./prompts');
  const system = getSnapshotPrompt(TRIAGE_FEATURE, PROMPTS.repair_triage, snapshotDir);

  const prompt = [
    system,
    '',
    `Error class: ${reproducer.error_class}`,
    `Error message: ${reproducer.error.message}`,
    `Located files: ${(reproducer.constraints.allowed_paths || []).join(', ')}`,
    `Models serving this slot recently: ${JSON.stringify(verdict.config.distinct_models)}`,
  ].join('\n');

  try {
    const parsed = await chatJson({
      feature: 'repair_triage',
      messages: [{ role: 'user', content: prompt }],
      defaults: { decision: 'confirm', reason: '' },
      label: 'repair triage reviewer',
    });
    const decision = ['confirm', 'config_fix', 'escalate'].includes(parsed.decision)
      ? parsed.decision : 'confirm';
    return { decision, reason: String(parsed.reason || ''), model_id: modelId };
  } catch (_) {
    return null;
  }
}

// Deterministic triage. Order matters — each rule is a gate the reproducer
// must clear before the next.
function triageDeterministic(reproducer) {
  const correlation = modelCorrelation(reproducer);
  const base = {
    category: reproducer.error_class,
    config: correlation,
    checks: {},
  };

  // Rule 1: transient/infra noise — existing remediation retries these.
  if (reproducer.classification?.verdict_hint === 'skip') {
    return { ...base, verdict: 'skip', reason: 'transient or upstream error — remediation retries cover this', confidence: 0.95 };
  }

  // Rule 2 (Step 0): a model emitting broken JSON is a model problem. A code
  // "fix" would be a silent-failure guard (CLAUDE.md Rule 5).
  if (reproducer.classification?.verdict_hint === 'config_fix') {
    return {
      ...base,
      verdict: 'config_fix',
      reason: `model on this slot emits unparseable output; change the slot in /admin/models/system`
        + (correlation.current_model ? ` (currently ${correlation.current_model})` : ''),
      confidence: 0.85,
    };
  }

  // Rule 3: classes that are never auto-repairable (schema, unclassified).
  if (!reproducer.classification?.fixable) {
    return { ...base, verdict: 'escalate', reason: `${reproducer.error_class} is outside the fixable-narrow whitelist`, confidence: 0.9 };
  }

  // Rule 4: recurrence — a previously "fixed" error that came back means the
  // fix was wrong. Never loop; hand it to a human.
  if (reproducer.history?.everFixed) {
    return { ...base, verdict: 'escalate', reason: 'this error class was auto-repaired before and recurred — the fix was wrong', confidence: 0.95 };
  }

  // Rule 5: scope containment.
  const scope = withinAllowedScope(reproducer);
  base.checks.scope = scope;
  if (!scope.ok) {
    return { ...base, verdict: 'escalate', reason: `scope check failed: ${scope.reason}`, confidence: 0.9 };
  }

  // Rule 6: no reproduction, no repair. Nondeterministic classes need the
  // synthetic mock test; deterministic ones need a snapshot repro command.
  if (!reproducer.reproduction?.synthetic_test && !reproducer.reproduction?.deterministic) {
    return { ...base, verdict: 'escalate', reason: 'no reproduction path — cannot verify a fix', confidence: 0.9 };
  }

  return {
    ...base,
    verdict: 'fixable-narrow',
    reason: `${reproducer.error_class} confined to ${reproducer.constraints.allowed_paths.join(', ')}`
      + (correlation.single_model
        ? `; note: only ${correlation.current_model || 'one model'} has served this slot recently — model may share blame (config_suspect)`
        : ''),
    confidence: correlation.single_model ? 0.75 : 0.9,
  };
}

async function triageReproducer(reproducer, { useModel = false, snapshotDir = SNAPSHOT_DIR } = {}) {
  const verdict = triageDeterministic(reproducer);

  if (useModel && verdict.verdict === 'fixable-narrow') {
    const advice = await adviseTriage(reproducer, verdict, { snapshotDir });
    if (advice && advice.decision !== 'confirm') {
      verdict.verdict = advice.decision;
      verdict.reason = `model reviewer downgraded: ${advice.reason || advice.decision}`;
      verdict.model_review = advice;
    } else if (advice) {
      verdict.model_review = advice;
    }
  }

  writeRepairReceipt({
    sourceId: reproducer.id,
    stage: 'triage',
    status: verdict.verdict === 'fixable-narrow' ? 'pass' : (verdict.verdict === 'skip' ? 'warn' : 'fail'),
    summary: `Self-repair triage: ${reproducer.error_class} → ${verdict.verdict} (${verdict.reason})`,
    payload: {
      agent: 'hub_repair',
      error_class: reproducer.error_class,
      error_signature: reproducer.error_signature,
      verdict: verdict.verdict,
      reason: verdict.reason,
      confidence: verdict.confidence,
      config: verdict.config,
      model_review: verdict.model_review || null,
      run_at: new Date().toISOString(),
    },
  });

  return verdict;
}

module.exports = {
  TRIAGE_FEATURE,
  TRIAGE_FALLBACK_MODEL,
  getSnapshotModelId,
  getSnapshotPrompt,
  modelCorrelation,
  withinAllowedScope,
  triageDeterministic,
  triageReproducer,
};
