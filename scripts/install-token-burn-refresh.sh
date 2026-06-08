#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_PLIST="$ROOT/scripts/com.mclellan.token-burn-refresh.plist"
TARGET_PLIST="$HOME/Library/LaunchAgents/com.mclellan.token-burn-refresh.plist"
OLD_PLIST="$HOME/Library/LaunchAgents/com.mclellan.hermes-token-burn.plist"
DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/data/logs"
plutil -lint "$SOURCE_PLIST"
cp "$SOURCE_PLIST" "$TARGET_PLIST"

launchctl bootout "$DOMAIN/com.mclellan.hermes-token-burn" 2>/dev/null || true
launchctl bootout "$DOMAIN/com.mclellan.token-burn-refresh" 2>/dev/null || true
rm -f "$OLD_PLIST"

launchctl bootstrap "$DOMAIN" "$TARGET_PLIST"
launchctl enable "$DOMAIN/com.mclellan.token-burn-refresh"
launchctl kickstart -k "$DOMAIN/com.mclellan.token-burn-refresh"

echo "Installed token-burn refresh: immediate run plus nightly at 02:00."
