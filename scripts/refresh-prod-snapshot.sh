#!/usr/bin/env bash
# Scheduled wrapper around pull-prod-snapshot.sh for the local dev machine.
#
# Pulls a fresh production diagnostic snapshot, prunes old ones, and logs the
# outcome so a silently failing schedule is visible. Run by launchd daily at
# 04:00 (see scripts/launchd/com.mclellan.hub.prod-snapshot.plist).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_ROOT="${SNAPSHOT_ROOT:-${ROOT}/data/prod-snapshots}"
KEEP="${KEEP:-7}"
LOG="${SNAPSHOT_ROOT}/refresh.log"

mkdir -p "${SNAPSHOT_ROOT}"

note() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "${LOG}"; }

note "refresh start"
if "${ROOT}/scripts/pull-prod-snapshot.sh" >> "${LOG}" 2>&1; then
  note "refresh ok — latest -> $(readlink "${SNAPSHOT_ROOT}/latest" 2>/dev/null || echo '?')"
  rm -f "${SNAPSHOT_ROOT}/LAST_RUN_FAILED"
else
  rc=$?
  note "refresh FAILED (exit ${rc})"
  # Marker file makes failure visible at a glance (and greppable by any check).
  date -u +%Y-%m-%dT%H:%M:%SZ > "${SNAPSHOT_ROOT}/LAST_RUN_FAILED"
  exit "${rc}"
fi

# Prune: keep the newest $KEEP timestamped snapshot dirs (never the symlink).
cd "${SNAPSHOT_ROOT}"
ls -1d [0-9]*Z 2>/dev/null | sort -r | tail -n "+$((KEEP + 1))" | while read -r old; do
  note "pruning ${old}"
  rm -rf "${old}"
done

note "refresh done"
