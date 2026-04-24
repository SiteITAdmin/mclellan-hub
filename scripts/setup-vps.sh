#!/usr/bin/env bash
# Run this once on a fresh Hetzner CX22 (Ubuntu 24.04) as root
set -euo pipefail

echo "==> Updating system"
apt-get update && apt-get upgrade -y

echo "==> Installing Node.js 22 (LTS)"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "==> Installing Nginx, Certbot, Git"
apt-get install -y nginx certbot python3-certbot-nginx git

echo "==> Creating app user"
useradd -m -s /bin/bash hub || true

echo "==> Creating app directory"
mkdir -p /app /app/data /app/exports/douglas /app/exports/nakai
chown -R hub:hub /app

echo "==> Copying app files (run from your local machine with rsync)"
# From your Mac:
# rsync -avz --exclude node_modules --exclude data --exclude .env \
#   "/Users/dm_mini/Documents/mclellan hub/" root@VPS_IP:/app/

echo ""
echo "Next steps:"
echo "  1. rsync the app to /app on the VPS"
echo "  2. cp /app/.env.example /app/.env && nano /app/.env"
echo "  3. cd /app && npm install"
echo "  4. node scripts/init-db.js"
echo "  5. Set up TLS (see scripts/setup-tls.sh)"
echo "  6. Set up systemd service (see scripts/hub.service)"
echo "  7. Enable Nginx config"
