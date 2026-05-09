#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VPS_HOST="${WORKDAY_SYNC_HOST:-178.104.235.142}"
VPS_USER="${WORKDAY_SYNC_USER:-root}"
REMOTE_DIR="${WORKDAY_SYNC_REMOTE_DIR:-/app/data/synthadoc/mclellan-hub-knowledge/raw_sources/workday/}"
LOCAL_DIR="${WORKDAY_SYNC_LOCAL_DIR:-$ROOT/data/synthadoc/mclellan-hub-knowledge/raw_sources/workday/}"
LOG_DIR="$ROOT/data/logs"
LOCK_DIR="${TMPDIR:-/tmp}/mclellan-workday-vault-sync.lock"

mkdir -p "$LOCAL_DIR" "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

{
  printf '[%s] sync start\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  rsync -az \
    -e "ssh -o StrictHostKeyChecking=accept-new" \
    --include='*/' \
    --include='*.md' \
    --exclude='*' \
    "${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}" \
    "$LOCAL_DIR"
  /usr/bin/env node "$ROOT/scripts/build-workday-daily-index.js"
  printf '[%s] sync ok -> %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$LOCAL_DIR"
} >> "$LOG_DIR/workday-vault-sync.log" 2>&1
