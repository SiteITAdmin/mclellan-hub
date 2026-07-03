#!/usr/bin/env bash
# Run from your Mac to push the latest code to the VPS
set -euo pipefail

VPS_IP="${1:-178.104.235.142}"
VPS_USER="root"
APP_DIR="/Users/dm_mini/Documents/mclellan hub"
SSH_CONTROL="/tmp/mclellan-deploy-$$"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o "ControlPath=${SSH_CONTROL}" -o ControlPersist=120)

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy.sh [VPS_IP] [--password]

Defaults to SSH key authentication. Pass --password to prompt for or use
VPS_PASSWORD when you need a temporary password-based deploy.
EOF
}

trap 'ssh -o ControlPath="${SSH_CONTROL}" -O exit "${VPS_USER}@${VPS_IP}" 2>/dev/null || true' EXIT

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
REVISION="$(git rev-parse HEAD)"
echo "    GitHub up to date: ${REVISION:0:7}"

echo "==> Syncing code to VPS..."
rsync -avz --no-perms --chmod=Du=rwx,Dg=rx,Do=rx,Fu=rw,Fg=r,Fo=r --progress -e "$RSYNC_RSH" \
  --exclude .git \
  --exclude .claude \
  --exclude .tools \
  --exclude .next \
  --exclude node_modules \
  --exclude data \
  --exclude .env \
  --exclude '.env*' \
  --exclude config/google-service-account.json \
  --exclude exports \
  --exclude '*.rtf' \
  --exclude '*.zip' \
  --exclude 'mclellan-hub-*.json' \
  --exclude 'mclellan hub' \
  "$APP_DIR/" \
  "${VPS_USER}@${VPS_IP}:/app/"

echo "==> Recording deployed revision..."
"${SSH_CMD[@]}" "${VPS_USER}@${VPS_IP}" \
  "printf '%s\n' '$REVISION' > /app/.deployed-revision &&
   chown root:hub /app/.deployed-revision &&
   chmod 640 /app/.deployed-revision &&
   rm -f /app/deploy.sh"

echo "==> Enforcing sensitive file permissions..."
"${SSH_CMD[@]}" "${VPS_USER}@${VPS_IP}" \
  "chown root:hub /app &&
   chmod 750 /app &&
   install -d -o hub -g hub -m 700 /app/data /app/exports &&
   install -d -o hub -g hub -m 750 /app/public/knowledge /app/public/knowledge/douglas /app/public/knowledge/nakai &&
   chown -R hub:hub /app/public/knowledge &&
   find /app/public/knowledge -type d -exec chmod 750 {} + &&
   find /app/public/knowledge -type f -exec chmod 640 {} + &&
   install -d -o root -g hub -m 750 /app/config &&
   find /app/config -maxdepth 1 -type f -exec chown root:hub {} + &&
   find /app/config -maxdepth 1 -type f -exec chmod 640 {} + &&
   test ! -f /app/.env || { chown root:hub /app/.env && chmod 640 /app/.env; } &&
   test ! -f /app/config/google-service-account.json || { chown root:hub /app/config/google-service-account.json && chmod 640 /app/config/google-service-account.json; } &&
   test ! -d /app/backups || { chown -R root:root /app/backups && chmod -R go-rwx /app/backups; } &&
   find /app -mindepth 1 \( -path /app/data -o -path /app/config -o -path /app/backups -o -path /app/exports -o -path /app/public/knowledge -o -name '.env*' \) -prune -o -type f ! -perm -o+r -exec chmod a+r {} + &&
   find /app -mindepth 1 \( -path /app/data -o -path /app/config -o -path /app/backups -o -path /app/exports -o -path /app/public/knowledge \) -prune -o -type d ! -perm -o+rx -exec chmod a+rx {} +"

echo "==> Syncing wiki policy and Synthadoc ingest override..."
rsync -avz --progress -e "$RSYNC_RSH" \
  "$APP_DIR/data/synthadoc/mclellan-hub-knowledge/AGENTS.md" \
  "$APP_DIR/data/synthadoc/mclellan-hub-knowledge/wiki/purpose.md" \
  "$APP_DIR/data/synthadoc/mclellan-hub-knowledge/wiki/mclellan-hub-overview.md" \
  "$APP_DIR/data/synthadoc/mclellan-hub-knowledge/wiki/personal-knowledge-management-systems.md" \
  "${VPS_USER}@${VPS_IP}:/app/data/synthadoc/mclellan-hub-knowledge/"
"${SSH_CMD[@]}" "${VPS_USER}@${VPS_IP}" \
  "mv /app/data/synthadoc/mclellan-hub-knowledge/purpose.md /app/data/synthadoc/mclellan-hub-knowledge/wiki/purpose.md &&
   mv /app/data/synthadoc/mclellan-hub-knowledge/mclellan-hub-overview.md /app/data/synthadoc/mclellan-hub-knowledge/wiki/mclellan-hub-overview.md &&
   mv /app/data/synthadoc/mclellan-hub-knowledge/personal-knowledge-management-systems.md /app/data/synthadoc/mclellan-hub-knowledge/wiki/personal-knowledge-management-systems.md &&
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
"${SSH_CMD[@]}" "${VPS_USER}@${VPS_IP}" \
  "systemctl status hub --no-pager -l | head -12 &&
   printf 'Deployed revision: ' &&
   cat /app/.deployed-revision"

echo "Done."
