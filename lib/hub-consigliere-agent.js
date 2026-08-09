'use strict';

const db = require('./db');
const { writeAgentReceipt } = require('./agent-receipts');

const STAGE = 'agent:hub_consigliere';
const SOURCE_KIND = 'hub_governance';
const SOURCE_ID = 'boss_layer';
const FRESH_DAYS = 3;

function verdictForFamilies(families) {
  if (families.some(f => f.verdict === 'fail')) return 'fail';
  if (families.some(f => f.verdict === 'warn')) return 'warn';
  return 'pass';
}

function sourceFamily({ name, label, thresholdDays = FRESH_DAYS, versions = [] }) {
  const present = versions.filter(v => v.present);
  const fresh = present.filter(v => v.age_days != null && v.age_days <= thresholdDays);
  const authoritativeFresh = fresh.find(v => v.authoritative);
  const anyFresh = fresh[0];
  const chosen = authoritativeFresh || anyFresh || present
    .slice()
    .sort((a, b) => (a.age_days ?? Infinity) - (b.age_days ?? Infinity))[0] || null;

  const verdict = !present.length ? 'warn' : (authoritativeFresh || anyFresh) ? 'pass' : 'fail';
  const staleActive = present.filter(v => v.age_days == null || v.age_days > thresholdDays);
  const supersededStale = staleActive.filter(v => chosen && v.name !== chosen.name && chosen.age_days != null && chosen.age_days <= thresholdDays);

  return {
    name,
    label,
    verdict,
    threshold_days: thresholdDays,
    chosen_version: chosen?.name || null,
    evidence: chosen
      ? `${chosen.label || chosen.name}: ${chosen.evidence}`
      : 'No source versions found',
    versions,
    stale_only: present.length > 0 && !fresh.length,
    superseded_stale_versions: supersededStale.map(v => v.name),
  };
}

// One nightly run writes ~40+ subordinate receipts (capos, underbosses, quality
// boards, per-post teams); the window must hold every subject or the challenge
// silently skips part of the family.
// The daily consigliere report is excluded alongside our own stage: it is a
// peer router whose verdict already reflects this audit, so counting its fail
// receipts as subordinate failures deadlocks both agents in mutual FAIL.
function latestSubordinateReceipts(user = 'douglas', since = Math.floor(Date.now() / 1000) - 48 * 3600, limit = 400) {
  try {
    return db.hub().prepare(`
      SELECT *
      FROM knowledge_receipts
      WHERE user = ?
        AND stage LIKE 'agent:%'
        AND stage NOT IN (?, 'agent:daily_consigliere_report')
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(user, STAGE, since, limit);
  } catch (_) {
    return [];
  }
}

function subordinateChallenge(user = 'douglas') {
  const rows = latestSubordinateReceipts(user);
  const latestBySubject = new Map();
  for (const row of rows) {
    const key = `${row.stage}:${row.source_kind}:${row.source_id}`;
    const current = latestBySubject.get(key);
    if (!current || Number(row.created_at || 0) > Number(current.created_at || 0)) {
      latestBySubject.set(key, row);
    }
  }
  const currentRows = Array.from(latestBySubject.values());
  const failing = currentRows.filter(r => ['fail', 'failed', 'error'].includes(String(r.status || '').toLowerCase()));
  const warnings = currentRows.filter(r => String(r.status || '').toLowerCase() === 'warn');
  return {
    name: 'subordinate_agent_receipts',
    label: 'Subordinate agent receipts',
    verdict: failing.length ? 'fail' : warnings.length ? 'warn' : currentRows.length ? 'pass' : 'warn',
    evidence: currentRows.length
      ? `${currentRows.length} current subordinate receipt subject(s); ${failing.length} fail; ${warnings.length} warn`
      : 'No subordinate agent receipts found yet',
    recent: currentRows.map(r => ({
      stage: r.stage,
      source_kind: r.source_kind,
      source_id: r.source_id,
      status: r.status,
      summary: r.summary,
      created_at: r.created_at,
    })),
  };
}

function buildConsigliereAudit(user = 'douglas', options = {}) {
  const nowMs = options.nowMs || Date.now();
  const families = options.families || [];
  const subordinate = options.subordinate || subordinateChallenge(user);
  const verdict = verdictForFamilies([...families, subordinate]);
  const staleOnlyFamilies = families.filter(f => f.stale_only);

  return {
    agent: 'hub_consigliere',
    role: 'boss_layer_challenge',
    user,
    run_at: new Date(nowMs).toISOString(),
    verdict,
    principle: 'Old data is reportable when it is the freshest authoritative version, not when a fresher version supersedes it.',
    families,
    subordinate,
    stale_only_families: staleOnlyFamilies.map(f => f.name),
    retry_or_appeal: verdict === 'pass'
      ? 'No action needed. Continue trusting fresher authoritative source versions over stale superseded files.'
      : 'Investigate failed subordinate receipts or stale-only source families. If an old source is intentionally superseded, mark the newer source as authoritative in the relevant check.',
  };
}

function writeConsigliereAudit(user = 'douglas', options = {}) {
  const audit = buildConsigliereAudit(user, options);
  const id = writeAgentReceipt({
    user,
    sourceKind: SOURCE_KIND,
    sourceId: SOURCE_ID,
    stage: STAGE,
    status: audit.verdict,
    summary: `Hub Consigliere: ${audit.verdict.toUpperCase()} (${audit.stale_only_families.length} stale-only source family/families)`,
    payload: audit,
  });
  return { id, audit };
}

module.exports = {
  STAGE,
  buildConsigliereAudit,
  sourceFamily,
  subordinateChallenge,
  writeConsigliereAudit,
};
