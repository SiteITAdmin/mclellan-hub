#!/usr/bin/env bash
# Run from your Mac to push the latest code to the VPS
set -euo pipefail

VPS_IP="${1:-178.104.235.142}"
VPS_USER="root"
APP_DIR="/Users/dm_mini/Documents/mclellan hub"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy.sh [VPS_IP] [--password]

Defaults to SSH key authentication. Pass --password to prompt for or use
VPS_PASSWORD when you need a temporary password-based deploy.
EOF
}

USE_PASSWORD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)
      USE_PASSWORD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      VPS_IP="$1"
      shift
      ;;
  esac
done

SSH_CMD=(ssh "${SSH_OPTS[@]}")
RSYNC_RSH="${SSH_CMD[*]}"

if [[ "$USE_PASSWORD" -eq 1 ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "Error: sshpass is required for --password deploys." >&2
    exit 1
  fi

  if [[ -z "${VPS_PASSWORD:-}" ]]; then
    read -rsp "VPS password: " VPS_PASSWORD
    echo
  fi

  export SSHPASS="$VPS_PASSWORD"
  SSH_CMD=(sshpass -e ssh "${SSH_OPTS[@]}")
  RSYNC_RSH="sshpass -e ssh ${SSH_OPTS[*]}"
fi

echo "==> Pushing to GitHub..."
cd "$APP_DIR"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "    Uncommitted changes detected — commit before deploying."
  git status --short
  exit 1
fi
git push origin main
echo "    GitHub up to date: $(git rev-parse --short HEAD)"

echo "==> Syncing code to VPS..."
rsync -avz --progress -e "$RSYNC_RSH" \
  --exclude .git \
  --exclude .claude \
  --exclude .tools \
  --exclude .next \
  --exclude node_modules \
  --exclude data \
  --exclude .env \
  --exclude '.env*' \
  --exclude exports \
  --exclude '*.rtf' \
  --exclude '*.zip' \
  --exclude 'mclellan-hub-*.json' \
  --exclude 'mclellan hub' \
  "$APP_DIR/" \
  "${VPS_USER}@${VPS_IP}:/app/"

echo "==> Syncing wiki policy and Synthadoc ingest override..."
rsync -avz --progress -e "$RSYNC_RSH" \
  "$APP_DIR/data/synthadoc/mclellan-hub-knowledge/AGENTS.md" \
  "$APP_DIR/data/synthadoc/mclellan-hub-knowledge/wiki/purpose.md" \
  "$APP_DIR/data/synthadoc/mclellan-hub-knowledge/wiki/mclellan-hub-overview.md" \
  "${VPS_USER}@${VPS_IP}:/app/data/synthadoc/mclellan-hub-knowledge/"
"${SSH_CMD[@]}" "${VPS_USER}@${VPS_IP}" \
  "mv /app/data/synthadoc/mclellan-hub-knowledge/purpose.md /app/data/synthadoc/mclellan-hub-knowledge/wiki/purpose.md &&
   mv /app/data/synthadoc/mclellan-hub-knowledge/mclellan-hub-overview.md /app/data/synthadoc/mclellan-hub-knowledge/wiki/mclellan-hub-overview.md &&
   chown -R hub:hub /app/data/synthadoc/mclellan-hub-knowledge/wiki &&
   cd /app/.tools/synthadoc &&
   (git apply --reverse --check /app/patches/synthadoc-strict-ingest.patch >/dev/null 2>&1 ||
    git apply /app/patches/synthadoc-strict-ingest.patch) &&
   systemctl restart synthadoc"

echo "==> Installing dependencies..."
"${SSH_CMD[@]}" "${VPS_USER}@${VPS_IP}" "cd /app && npm install --production"

echo "==> Updating nginx config..."
"${SSH_CMD[@]}" "${VPS_USER}@${VPS_IP}" "cp /app/nginx/mclellan.conf /etc/nginx/sites-enabled/mclellan.conf && nginx -t && systemctl reload nginx"

echo "==> Restarting service..."
"${SSH_CMD[@]}" "${VPS_USER}@${VPS_IP}" "systemctl restart hub"

echo "==> Status:"
"${SSH_CMD[@]}" "${VPS_USER}@${VPS_IP}" "systemctl status hub --no-pager -l | head -12"

echo "Done."
