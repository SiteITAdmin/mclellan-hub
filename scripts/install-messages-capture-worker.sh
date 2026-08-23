#!/usr/bin/env bash
# Install the read-only Apple Messages → Hub capture worker on this Mac.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
LABEL="com.mclellan.hub.messages-capture"
SOURCE_PLIST="$ROOT/scripts/launchd/${LABEL}.plist"
DEST_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [ ! -f "$ENV_FILE" ]; then echo "missing $ENV_FILE" >&2; exit 1; fi
if ! grep -qE '^HUB_URL=.+|^HUB_MESSAGING_CAPTURE_URL=.+' "$ENV_FILE"; then
  echo 'HUB_URL or HUB_MESSAGING_CAPTURE_URL is required in .env' >&2
  exit 1
fi
if ! grep -qE '^HERMES_WEBHOOK_SECRET=.+' "$ENV_FILE"; then
  echo 'HERMES_WEBHOOK_SECRET is required in .env' >&2
  exit 1
fi
if [ ! -r "${HOME}/Library/Messages/chat.db" ]; then
  echo 'Messages chat.db is not readable. Grant Full Disk Access to the Node binary before installing.' >&2
  exit 1
fi

plutil -lint "$SOURCE_PLIST" >/dev/null
mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
cp "$SOURCE_PLIST" "$DEST_PLIST"

UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}" "$DEST_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$DEST_PLIST"
launchctl enable "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"

echo "Installed ${LABEL}. It starts at the current Messages row; no historical archive was imported."
echo "State: ${HOME}/Library/Application Support/McLellan Hub/messages-capture-state.json"
echo "Logs:  ${HOME}/Library/Logs/mclellan-hub.messages-capture.{out,err}.log"
