#!/usr/bin/env bash
# Run on the VPS to install the systemd service
set -euo pipefail

cp /app/scripts/hub.service /etc/systemd/system/hub.service
systemctl daemon-reload
systemctl enable hub
systemctl start hub
systemctl status hub --no-pager
