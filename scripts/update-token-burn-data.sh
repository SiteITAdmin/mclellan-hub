#!/usr/bin/env bash
# Refresh scrubbed token-burn data from this Mac and publish it to the VPS.
set -euo pipefail

VPS_IP="${1:-178.104.235.142}"
VPS_USER="${VPS_USER:-root}"
APP_DIR="/Users/dm_mini/Documents/mclellan hub"
DASHBOARD_DIR="$APP_DIR/token-burn-dashboard"
REMOTE_DIR="/app/token-burn-dashboard/deploy-data"
NODE_BIN="${NODE_BIN:-/opt/homebrew/opt/node@24/bin/node}"
LOCK_DIR="${TMPDIR:-/tmp}/mclellan-token-burn-refresh.lock"
SSH_CONTROL="/tmp/mclellan-tokenburn-$$"
SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=2
  -o StrictHostKeyChecking=accept-new
  -o ControlMaster=auto
  -o "ControlPath=${SSH_CONTROL}"
  -o ControlPersist=120
)
trap 'ssh -o ControlPath="${SSH_CONTROL}" -O exit "${VPS_USER}@${VPS_IP}" 2>/dev/null || true' EXIT

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Token-burn refresh already running; skipping."
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

if [ ! -x "$NODE_BIN" ]; then
  echo "Error: Node.js not found at $NODE_BIN" >&2
  exit 1
fi

printf '[%s] Regenerating local token-burn data...\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
cd "$DASHBOARD_DIR"
"$NODE_BIN" scripts/generate-daily-burn.mjs
"$NODE_BIN" scripts/sync-openrouter-activity.mjs || {
  status=$?
  if [ "$status" -eq 2 ]; then
    printf '[%s] Live OpenRouter activity skipped; OPENROUTER_MANAGEMENT_KEY is not set.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  else
    exit "$status"
  fi
}
cd "$APP_DIR"
"$NODE_BIN" scripts/audit-token-burn.js || true

printf '[%s] Publishing scrubbed JSON to VPS...\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" "mkdir -p '$REMOTE_DIR'"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$DASHBOARD_DIR/deploy-data/daily-burn.sample.json" \
  "$DASHBOARD_DIR/deploy-data/openrouter-activity.summary.json" \
  "$DASHBOARD_DIR/deploy-data/openrouter-live.summary.json" \
  "${VPS_USER}@${VPS_IP}:${REMOTE_DIR}/"

printf '[%s] Done. The Hub reads these files on request; no service restart needed.\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
