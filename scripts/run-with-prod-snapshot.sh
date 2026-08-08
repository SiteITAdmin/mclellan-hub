#!/usr/bin/env bash
# Run a command with HUB_DB_PATH pointed at the latest pulled production snapshot.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT="${1:-${HUB_SNAPSHOT_ROOT:-${HOME}/Library/Application Support/mclellan-hub/prod-snapshots}/latest}"

if [[ ! -f "${SNAPSHOT}/hub.db" ]]; then
  echo "No snapshot DB found at ${SNAPSHOT}/hub.db" >&2
  echo "Run scripts/pull-prod-snapshot.sh first." >&2
  exit 1
fi

shift || true
export HUB_DB_PATH="${SNAPSHOT}/hub.db"

if [[ $# -eq 0 ]]; then
  echo "HUB_DB_PATH=${HUB_DB_PATH}"
  exec npm start
fi

echo "HUB_DB_PATH=${HUB_DB_PATH}"
exec "$@"
