#!/usr/bin/env bash
# Pull a fresh copy of the production database to data/prod-latest.db.
#
# Lighter than pull-prod-snapshot.sh — no logs, no env.sh, no dated directories.
# Use this for a quick local reference copy or before a troubleshooting session.
# Use pull-prod-snapshot.sh when you need logs, job queue state, or a dated archive.
set -euo pipefail

VPS="${VPS:-root@178.104.235.142}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${ROOT}/data/prod-latest.db"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SSH_CONTROL="/tmp/mclellan-sync-data-$$"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ControlMaster=auto -o "ControlPath=${SSH_CONTROL}" -o ControlPersist=60)
trap 'ssh -o ControlPath="${SSH_CONTROL}" -O exit "${VPS}" 2>/dev/null || true' EXIT

mkdir -p "${ROOT}/data"

echo "==> Syncing production DB → ${DEST}"
echo "    ${STAMP}"

# Use SQLite's online backup API via node so we get a consistent snapshot
# even if the server is writing at the same moment.
REMOTE_TMP="/tmp/mclellan-sync-db-$$"
ssh "${SSH_OPTS[@]}" "${VPS}" "
  set -euo pipefail
  cd /app
  node <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('/app/data/hub.db', { readonly: true, fileMustExist: true });
db.backup('${REMOTE_TMP}.db').then(() => {
  process.stdout.write('ok\n');
}).catch(err => { console.error(err); process.exit(1); });
NODE
"

rsync -az --progress \
  -e "ssh ${SSH_OPTS[*]}" \
  "${VPS}:${REMOTE_TMP}.db" \
  "${DEST}"

ssh "${SSH_OPTS[@]}" "${VPS}" "rm -f '${REMOTE_TMP}.db'" || true

SIZE=$(du -sh "${DEST}" | cut -f1)
echo
echo "==> Done — ${DEST} (${SIZE})"
echo
echo "Run Hub locally against this data:"
echo "  HUB_DB_PATH='${DEST}' npm start"
