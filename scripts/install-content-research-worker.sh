#!/usr/bin/env bash
# Install the Mac mini content-research pull-worker (launchd).
# Prerequisites in the Hub .env (or environment):
#   HUB_URL=https://dchat.mclellan.scot   # or your Douglas Hub host
#   CONTENT_RESEARCH_WORKER_SECRET=...     # same value as VPS /app/.env
#   OPENROUTER_API_KEY=...                 # for Grok on the Mac
#   LAST30DAYS_ENGINE_PATH=...             # optional
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
LABEL="com.mclellan.hub.content-research-worker"
SRC_PLIST="$ROOT/scripts/launchd/${LABEL}.plist"
DEST_PLIST="$LAUNCH_DIR/${LABEL}.plist"
NODE_BIN="${CONTENT_RESEARCH_WORKER_NODE:-}"

if [ -z "$NODE_BIN" ]; then
  for candidate in \
    /opt/homebrew/opt/node@24/bin/node \
    /opt/homebrew/bin/node \
    "$(command -v node 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "error: node not found — set CONTENT_RESEARCH_WORKER_NODE" >&2
  exit 1
fi

if [ ! -f "$SRC_PLIST" ]; then
  echo "error: missing $SRC_PLIST" >&2
  exit 1
fi

# Shell-check required config without printing secrets.
if [ -f "$ROOT/.env" ]; then
  # shellcheck disable=SC1091
  set -a
  # Only pull the keys we need; ignore parse errors from exotic .env lines.
  eval "$(grep -E '^(HUB_URL|CONTENT_RESEARCH_HUB_URL|CONTENT_RESEARCH_WORKER_SECRET|OPENROUTER_API_KEY)=' "$ROOT/.env" | sed 's/\r$//')" || true
  set +a
fi

missing=()
[ -z "${HUB_URL:-${CONTENT_RESEARCH_HUB_URL:-}}" ] && missing+=("HUB_URL")
[ -z "${CONTENT_RESEARCH_WORKER_SECRET:-}" ] && missing+=("CONTENT_RESEARCH_WORKER_SECRET")
[ -z "${OPENROUTER_API_KEY:-}" ] && missing+=("OPENROUTER_API_KEY")
if [ "${#missing[@]}" -gt 0 ]; then
  echo "warning: missing env on Mac: ${missing[*]}"
  echo "  Worker will exit until these are set in $ROOT/.env or the launchd environment."
fi

mkdir -p "$LAUNCH_DIR" "$HOME/Library/Logs"

# Rewrite node path + working directory into a user-local plist copy.
python3 - "$SRC_PLIST" "$DEST_PLIST" "$NODE_BIN" "$ROOT" <<'PY'
import sys
from pathlib import Path
src, dest, node, root = sys.argv[1:5]
text = Path(src).read_text()
# Replace the first ProgramArguments node path and script path if needed.
import re
text = re.sub(
    r"(<key>ProgramArguments</key>\s*<array>\s*<string>)[^<]+(</string>\s*<string>)[^<]+(</string>)",
    rf"\1{node}\2{root}/scripts/content-research-worker.js\3",
    text,
    count=1,
)
text = re.sub(
    r"(<key>WorkingDirectory</key>\s*<string>)[^<]+(</string>)",
    rf"\1{root}\2",
    text,
    count=1,
)
Path(dest).write_text(text)
print(f"wrote {dest}")
PY

UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}" "$DEST_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$DEST_PLIST"
launchctl enable "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"

echo ""
echo "Installed ${LABEL}"
echo "  node:  $NODE_BIN"
echo "  root:  $ROOT"
echo "  logs:  ~/Library/Logs/mclellan-hub.content-research-worker.{out,err}.log"
echo "  poll:  every 180s"
echo ""
echo "VPS side: set CONTENT_RESEARCH_DRIVER=mac and the same"
echo "CONTENT_RESEARCH_WORKER_SECRET in /app/.env, then restart hub.service."
launchctl print "gui/${UID_NUM}/${LABEL}" 2>/dev/null | head -30 || true
