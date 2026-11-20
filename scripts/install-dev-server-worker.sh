#!/usr/bin/env bash
# Install and start the fast-lane subscription agent worker on dev-server
# (handles priority <= 30: interactive chat/Ask/reports, meeting prep, digests,
# and fresh capture, while the Mac mini drains priority 50 background work).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_NAME="mclellan-hub-fast-worker.service"
UNIT_PATH="${UNIT_DIR}/${UNIT_NAME}"
NODE_BIN="$(command -v node)"
MAX_PRIORITY="${SUBSCRIPTION_AGENT_MAX_PRIORITY:-30}"
IDLE_MS="${SUBSCRIPTION_AGENT_IDLE_MS:-10000}"

if [[ ! -f "${ROOT}/.env" ]]; then
  echo "Error: ${ROOT}/.env not found (needs HUB_URL and SUBSCRIPTION_AGENT_WORKER_SECRET)." >&2
  exit 1
fi

mkdir -p "${UNIT_DIR}"
cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=McLellan Hub fast-lane subscription AI worker (priority <= ${MAX_PRIORITY})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
Environment=HOME=${HOME}
Environment=PATH=${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=SUBSCRIPTION_AGENT_WORKER_ID=dev-server-fast
Environment=SUBSCRIPTION_AGENT_MAX_PRIORITY=${MAX_PRIORITY}
Environment=SUBSCRIPTION_AGENT_IDLE_MS=${IDLE_MS}
ExecStart=${NODE_BIN} ${ROOT}/scripts/subscription-agent-worker.js
Restart=on-failure
RestartSec=10
UMask=0077

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}"
systemctl --user --no-pager status "${UNIT_NAME}"
