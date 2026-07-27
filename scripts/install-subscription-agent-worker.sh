#!/usr/bin/env bash
# Provision the scoped VPS↔Mac secret and install the Mini pull-worker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
VPS_IP="${1:-178.104.235.142}"
VPS_USER="root"
LABEL="com.mclellan.hub.subscription-agent-worker"

if [ ! -f "$ENV_FILE" ]; then echo "missing $ENV_FILE" >&2; exit 1; fi
HUB_URL="$(grep -E '^HUB_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's:/*$::')"
if [ -z "$HUB_URL" ]; then echo 'HUB_URL is required in the Mac .env' >&2; exit 1; fi
SECRET="$(grep -E '^SUBSCRIPTION_AGENT_WORKER_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [ -z "$SECRET" ]; then
  SECRET="$(openssl rand -hex 32)"
  printf '\nSUBSCRIPTION_AGENT_WORKER_SECRET=%s\n' "$SECRET" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# Pass the value over the encrypted SSH channel on stdin, not as a command-line
# argument. Preserve unrelated production .env settings.
printf '%s\n' "$SECRET" | ssh "${VPS_USER}@${VPS_IP}" '
  set -eu; umask 077; IFS= read -r secret
  env=/app/.env; tmp=$(mktemp /app/.env.subscription.XXXXXX)
  grep -vE "^(SUBSCRIPTION_AGENT_WORKER_SECRET|SUBSCRIPTION_AGENT_WORKER_ENABLED)=" "$env" > "$tmp" || true
  printf "\nSUBSCRIPTION_AGENT_WORKER_SECRET=%s\nSUBSCRIPTION_AGENT_WORKER_ENABLED=1\n" "$secret" >> "$tmp"
  chown root:hub "$tmp"; chmod 640 "$tmp"; mv "$tmp" "$env"
'

DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$ROOT/scripts/launchd/${LABEL}.plist" "$DEST"
UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}" "$DEST" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$DEST"
launchctl enable "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"

echo "Installed ${LABEL}; the VPS worker route is enabled. Restart hub.service after deploying code."
