#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
BUILD="$(mktemp -d "${TMPDIR:-/tmp}/mclellan-boox.XXXXXX")"
"$ADB" get-state >/dev/null
# Build on local disk: the project may live on the Linux server's SMB share.
rsync -a --exclude '._*' --exclude '.gradle' --exclude build "$ROOT/boox-app/" "$BUILD/"
"$BUILD/gradlew" -p "$BUILD" assembleDebug
"$ADB" install -r "$BUILD/app/build/outputs/apk/debug/app-debug.apk"
"$ADB" shell run-as scot.mclellan.boox mkdir -p files
# Transfer the existing token directly into private app storage, never into an APK or shell argument.
ssh -o BatchMode=yes root@178.104.235.142 \
  'cd /app && node -r dotenv/config -e '\''if (!process.env.HUB_BOOX_TOKEN) process.exit(1); process.stdout.write(process.env.HUB_BOOX_TOKEN)'\''' \
  | "$ADB" shell 'run-as scot.mclellan.boox sh -c "umask 077; cat > files/device-token"'
"$ADB" shell am force-stop scot.mclellan.boox
"$ADB" shell am start -n scot.mclellan.boox/.MainActivity
printf 'Installed. APK: %s\n' "$BUILD/app/build/outputs/apk/debug/app-debug.apk"
