#!/usr/bin/env bash
# Pull latest VPS backups to Google Drive for off-site storage.
# Runs on the Mac (crontab: 0 7 * * *) — after the VPS 2am backup has completed.
set -euo pipefail

VPS="root@178.104.235.142"
VPS_SRC="/var/backups/mclellan-hub/daily/"
GDRIVE=~/Library/CloudStorage/GoogleDrive-douglas@mclellan.scot/My\ Drive
DEST="${GDRIVE}/mclellan-backups"
LOG="${DEST}/pull.log"

mkdir -p "${DEST}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG}"; }

log "Pull started"

# Sync all daily backup dirs from VPS — no --delete so Google Drive keeps full history
rsync -az --progress \
  -e "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes" \
  "${VPS}:${VPS_SRC}" \
  "${DEST}/" \
  2>&1 | tee -a "${LOG}"

log "Pull complete"
