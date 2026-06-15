#!/bin/bash
# Deploy McLellan Hub to VPS and restart the service.
# Run from anywhere — uses the script's own directory as the source.
set -e

VPS="root@178.104.235.142"
REMOTE="/app"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Syncing to $VPS:$REMOTE …"
rsync -av --delete \
  --exclude-from="$DIR/.rsync-exclude" \
  "$DIR/" "$VPS:$REMOTE/"

echo "Restarting hub.service …"
ssh "$VPS" "systemctl restart hub.service && sleep 2 && systemctl is-active hub.service"
echo "Done."
