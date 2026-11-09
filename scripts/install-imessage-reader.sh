#!/bin/bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.mclellan.hub.imessage-reader"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
mkdir -p "$REPO/.tools" "$HOME/Library/LaunchAgents" "$HOME/.hermes/hub-capture"
swiftc "$REPO/scripts/imessage-text.swift" -o "$REPO/.tools/imessage-text"
python3 - "$PLIST" "$NODE" "$REPO" "$HOME/.hermes/hub-capture" <<'PY'
import plistlib,sys
file,node,repo,logs=sys.argv[1:]
with open(file,'wb') as f: plistlib.dump({'Label':'com.mclellan.hub.imessage-reader','ProgramArguments':[node,repo+'/scripts/imessage-capture-worker.js'],'WorkingDirectory':repo,'StartInterval':60,'RunAtLoad':True,'StandardOutPath':logs+'/imessage.log','StandardErrorPath':logs+'/imessage-error.log'},f)
PY
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo 'iMessage reader installed; its status appears on CRM Messages.'
