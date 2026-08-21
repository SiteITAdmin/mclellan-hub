#!/usr/bin/env bash
# Safe hub.db swap on the VPS. Moving/replacing hub.db while hub.service is
# running causes SQLITE_READONLY_DBMOVED — every write in the Hub fails as
# "attempt to write a readonly database" until the next restart (this broke
# email corrections and sent-mail sync on 20 Aug 2026).
#
# Usage: run ON the VPS as root.
#   vps-db-swap.sh /path/to/new-hub.db
#
# Stops the service, backs up the live DB, swaps the file in, restarts, and
# verifies a real write before declaring success.
set -euo pipefail

NEW_DB="${1:?usage: vps-db-swap.sh /path/to/new-hub.db}"
DB="/app/data/hub.db"
STAMP="$(date +%Y-%m-%dT%H%M%S)"
BACKUP="/app/data/hub.db.before-swap-${STAMP}"

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }
[ -f "$NEW_DB" ] || { echo "not found: $NEW_DB" >&2; exit 1; }

echo "[swap] integrity check on replacement DB..."
sqlite3 "$NEW_DB" "PRAGMA integrity_check;" | grep -qx ok \
  || { echo "replacement DB failed integrity_check" >&2; exit 1; }

echo "[swap] stopping hub.service..."
systemctl stop hub.service

echo "[swap] backing up live DB to ${BACKUP}..."
cp -a "$DB" "$BACKUP"

echo "[swap] installing replacement..."
install -o hub -g hub -m 600 "$NEW_DB" "$DB"

echo "[swap] starting hub.service..."
systemctl start hub.service
sleep 3
systemctl is-active --quiet hub.service || { echo "hub.service failed to start — restore with: cp -a ${BACKUP} ${DB} && systemctl restart hub" >&2; exit 1; }

echo "[swap] verifying writes..."
sudo -u hub sqlite3 -cmd ".timeout 8000" "$DB" \
  "CREATE TABLE IF NOT EXISTS _swap_write_test(t TEXT); INSERT INTO _swap_write_test VALUES(datetime('now')); DELETE FROM _swap_write_test; DROP TABLE _swap_write_test;" \
  || { echo "write test FAILED — DB may still be locked/readonly" >&2; exit 1; }

echo "[swap] done. Previous DB kept at ${BACKUP}"
