#!/bin/bash
# Installs the McLellan Hub tap into the Hermes WhatsApp bridge on the Mac and
# puts Hermes in capture-only mode. Safe to run again, and must be run again
# after `hermes update` (which replaces bridge.js); the Hub's Today screen says
# "Hermes hasn't checked in" when the tap has gone.
#
#   HUB_TAP_SECRET=<HERMES_WEBHOOK_SECRET from the VPS> scripts/install-hermes-tap.sh
#
# The secret is only needed the first time; it is kept in
# ~/.hermes/hub-capture/hub-tap.json (mode 600).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_DIR="${HERMES_BRIDGE_DIR:-$HOME/.hermes/hermes-agent/scripts/whatsapp-bridge}"
HERMES_ENV="${HERMES_ENV_FILE:-$HOME/.hermes/.env}"
SPOOL="${HUB_TAP_SPOOL:-$HOME/.hermes/hub-capture}"
TAP_CONFIG="$SPOOL/hub-tap.json"
HUB_URL="${HUB_TAP_URL:-https://douglas.mclellan.scot}"

[ -f "$BRIDGE_DIR/bridge.js" ] || { echo "No Hermes bridge at $BRIDGE_DIR. Install Hermes first." >&2; exit 1; }

cp "$REPO/integrations/hermes-whatsapp/hub-tap.mjs" "$BRIDGE_DIR/hub-tap.mjs"

# Two anchors in bridge.js. If Hermes changes them, stop rather than guess.
node - "$BRIDGE_DIR/bridge.js" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
let s = fs.readFileSync(file, 'utf8');
const MARK = '// mclellan-hub-tap';
if (s.includes(MARK)) {
  // Upgrade an earlier tap so reminders can be sent through the same socket.
  const old = 'hubTap.start(() => connectionState);';
  if (s.includes(old)) { s = s.replace(old, 'hubTap.start(() => connectionState, () => sock);'); fs.writeFileSync(file, s); console.log('bridge.js tap upgraded'); }
  else console.log('bridge.js already has the tap');
  process.exit(0);
}
const anchors = [
  ["let connectionState = 'disconnected';",
   `let connectionState = 'disconnected';\nconst hubTap = createHubTap(); ${MARK}\nhubTap.start(() => connectionState, () => sock); ${MARK}`],
  ["const senderNumber = resolvedSenderId.replace(/@.*/, '');",
   `const senderNumber = resolvedSenderId.replace(/@.*/, '');\n      hubTap.onMessage(msg, { sock, senderId: resolvedSenderId, isGroup, lidToPhone }); ${MARK}`],
];
for (const [a] of anchors) {
  if (s.split(a).length !== 2) { console.error(`bridge.js has changed: anchor not found once: ${a}`); process.exit(1); }
}
for (const [a, b] of anchors) s = s.replace(a, b);
s = s.replace(/^(#!.*\n)?/, m => `${m}import { createHubTap } from './hub-tap.mjs'; ${MARK}\n`);
fs.writeFileSync(file, s);
console.log('bridge.js patched');
NODE

mkdir -p "$SPOOL" && chmod 700 "$SPOOL"
if [ -n "${HUB_TAP_SECRET:-}" ]; then
  umask 077
  printf '{"url":"%s","secret":"%s"}\n' "$HUB_URL" "$HUB_TAP_SECRET" > "$TAP_CONFIG"
  chmod 600 "$TAP_CONFIG"
  echo "Hub config written to $TAP_CONFIG"
fi
[ -f "$TAP_CONFIG" ] || { echo "No $TAP_CONFIG yet: run again with HUB_TAP_SECRET=..." >&2; exit 1; }

# Capture only: the bridge's own filters let nothing through to the Hermes
# agent, so Hermes never answers anyone. The tap sits before those filters.
set_env() {
  touch "$HERMES_ENV"
  if grep -q "^$1=" "$HERMES_ENV"; then
    sed -i '' "s|^$1=.*|$1=$2|" "$HERMES_ENV"
  else
    printf '%s=%s\n' "$1" "$2" >> "$HERMES_ENV"
  fi
}
set_env WHATSAPP_ENABLED true
set_env WHATSAPP_MODE bot
set_env WHATSAPP_DM_POLICY allowlist
set_env WHATSAPP_ALLOWED_USERS ''
set_env WHATSAPP_GROUP_POLICY disabled
set_env WHATSAPP_FORWARD_OWNER_MESSAGES false
echo "Hermes set to capture only (no replies)."
echo "Restart the gateway to load the tap: hermes gateway restart"
