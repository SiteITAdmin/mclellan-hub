#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
RUNNER="$BIN_DIR/mclellan-workday-vault-sync"
PLIST="$LAUNCH_DIR/com.mclellan.workday-vault-sync.plist"

mkdir -p "$BIN_DIR" "$LAUNCH_DIR"

cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail

ROOT="$ROOT"
VPS_HOST="\${WORKDAY_SYNC_HOST:-178.104.235.142}"
VPS_USER="\${WORKDAY_SYNC_USER:-root}"
REMOTE_DIR="\${WORKDAY_SYNC_REMOTE_DIR:-/app/data/synthadoc/mclellan-hub-knowledge/raw_sources/workday/}"
LOCAL_DIR="\${WORKDAY_SYNC_LOCAL_DIR:-\$ROOT/data/synthadoc/mclellan-hub-knowledge/raw_sources/workday/}"
LOG_DIR="\$ROOT/data/logs"
LOCK_DIR="\${TMPDIR:-/tmp}/mclellan-workday-vault-sync.lock"

mkdir -p "\$LOCAL_DIR" "\$LOG_DIR"

if ! mkdir "\$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "\$LOCK_DIR"' EXIT

{
  printf '[%s] sync start\n' "\$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  rsync -az \
    -e "ssh -o StrictHostKeyChecking=accept-new" \
    --include='*/' \
    --include='*.md' \
    --exclude='*' \
    "\${VPS_USER}@\${VPS_HOST}:\${REMOTE_DIR}" \
    "\$LOCAL_DIR"
  /usr/bin/env node "\$ROOT/scripts/build-workday-daily-index.js"
  printf '[%s] sync ok -> %s\n' "\$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "\$LOCAL_DIR"
} >> "\$LOG_DIR/workday-vault-sync.log" 2>&1
EOF
chmod +x "$RUNNER"

sed "s#/Users/dm_mini/Documents/mclellan hub/scripts/sync-workday-vault.sh#$RUNNER#g" \
  "$ROOT/scripts/com.mclellan.workday-vault-sync.plist" > "$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.mclellan.workday-vault-sync"

launchctl print "gui/$(id -u)/com.mclellan.workday-vault-sync" | head -40
