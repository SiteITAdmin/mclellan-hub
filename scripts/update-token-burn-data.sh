#!/usr/bin/env bash
# Refresh scrubbed token-burn data from this Mac and publish it to the VPS.
set -euo pipefail

VPS_IP="${1:-178.104.235.142}"
VPS_USER="${VPS_USER:-root}"
APP_DIR="/Users/dm_mini/Documents/mclellan hub"
DASHBOARD_DIR="$APP_DIR/token-burn-dashboard"
REMOTE_DIR="/app/token-burn-dashboard/deploy-data"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

echo "==> Regenerating local token-burn data..."
cd "$DASHBOARD_DIR"
npm run generate:data

echo "==> Publishing scrubbed JSON to VPS..."
ssh "${SSH_OPTS[@]}" "${VPS_USER}@${VPS_IP}" "mkdir -p '$REMOTE_DIR'"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$DASHBOARD_DIR/deploy-data/daily-burn.sample.json" \
  "$DASHBOARD_DIR/deploy-data/openrouter-activity.summary.json" \
  "${VPS_USER}@${VPS_IP}:${REMOTE_DIR}/"

echo "==> Done. The Hub reads these files on request; no service restart needed."
