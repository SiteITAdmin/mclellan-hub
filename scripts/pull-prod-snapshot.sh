#!/usr/bin/env bash
# Pull a production diagnostic snapshot for local debugging.
#
# This is not the off-site backup flow. It creates a consistent SQLite backup
# on the VPS, pulls it plus recent service context, and writes an env.sh that
# points local Hub code at the snapshot without replacing data/hub.db.
set -euo pipefail

VPS="${VPS:-root@178.104.235.142}"
REMOTE_APP="${REMOTE_APP:-/app}"
SINCE="${SINCE:-24 hours ago}"
STAMP="${SNAPSHOT_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Local-only path, NOT ~/Documents (iCloud-synced): keeps the ~327MB prod DB
# copy off Apple's cloud and avoids launchd EDEADLK on cloud-evicted files.
SNAPSHOT_ROOT="${SNAPSHOT_ROOT:-${HUB_SNAPSHOT_ROOT:-${HOME}/Library/Application Support/mclellan-hub/prod-snapshots}}"
DEST="${SNAPSHOT_ROOT}/${STAMP}"
REMOTE_TMP="/tmp/mclellan-prod-snapshot-${STAMP}"
SSH_CONTROL="/tmp/mclellan-snapshot-$$"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ControlMaster=auto -o "ControlPath=${SSH_CONTROL}" -o ControlPersist=120)
trap 'ssh -o ControlPath="${SSH_CONTROL}" -O exit "${VPS}" 2>/dev/null || true' EXIT

mkdir -p "${DEST}"

echo "==> Creating production SQLite snapshot on ${VPS}"
ssh "${SSH_OPTS[@]}" "${VPS}" "set -euo pipefail
  rm -rf '${REMOTE_TMP}'
  mkdir -p '${REMOTE_TMP}'
  cd '${REMOTE_APP}'
  node <<'NODE'
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const out = process.env.REMOTE_TMP || '${REMOTE_TMP}';
fs.mkdirSync(out, { recursive: true });
const source = '/app/data/hub.db';
const target = path.join(out, 'hub.db');
const db = new Database(source, { readonly: true, fileMustExist: true });
db.backup(target).then(() => {
  const info = {
    source,
    target,
    copiedAt: new Date().toISOString(),
    sizeBytes: fs.statSync(target).size,
  };
  fs.writeFileSync(path.join(out, 'snapshot.json'), JSON.stringify(info, null, 2) + '\\n');
}).catch(err => {
  console.error(err);
  process.exit(1);
});
NODE
  journalctl -u hub.service --since '${SINCE}' --no-pager -o short > '${REMOTE_TMP}/hub.service.log' 2>/dev/null || true
  git status --short > '${REMOTE_TMP}/git-status.txt' || true
  git rev-parse HEAD > '${REMOTE_TMP}/deployed-head.txt' || true
  cat '${REMOTE_APP}/.deployed-revision' > '${REMOTE_TMP}/deployed-revision.txt' 2>/dev/null || true
  node <<'NODE' > '${REMOTE_TMP}/jobs.json' || true
const Database = require('better-sqlite3');
const db = new Database('/app/data/hub.db', { readonly: true, fileMustExist: true });
const jobs = db.prepare(\"SELECT id, type, status, run_at, ran_at, source, error FROM system_jobs ORDER BY run_at DESC LIMIT 200\").all();
console.log(JSON.stringify(jobs, null, 2));
NODE
"

echo "==> Pulling snapshot into ${DEST}"
rsync -az --progress -e "ssh ${SSH_OPTS[*]}" "${VPS}:${REMOTE_TMP}/" "${DEST}/"

cat > "${DEST}/env.sh" <<EOF
# Source this file to run McLellan Hub locally against this production snapshot.
export HUB_DB_PATH="${DEST}/hub.db"
EOF

cat > "${DEST}/README.md" <<EOF
# McLellan Hub Production Diagnostic Snapshot

- Created: ${STAMP}
- Source: ${VPS}:${REMOTE_APP}/data/hub.db
- Logs: hub.service.log
- Job queue sample: jobs.json

Use locally:

\`\`\`bash
source "${DEST}/env.sh"
npm start
\`\`\`

This snapshot is production data. Keep it out of git and do not copy it into tickets, prompts, or public artifacts.
EOF

ln -sfn "${DEST}" "${SNAPSHOT_ROOT}/latest"

echo "==> Cleaning remote temp"
ssh "${SSH_OPTS[@]}" "${VPS}" "rm -rf '${REMOTE_TMP}'" || true

echo "Snapshot ready:"
echo "  ${DEST}"
echo
echo "Run against it with:"
echo "  source \"${DEST}/env.sh\" && npm start"
