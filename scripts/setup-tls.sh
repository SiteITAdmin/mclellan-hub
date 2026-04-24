#!/usr/bin/env bash
# Run on the VPS after DNS A records are pointing to this server's IP.
# All four subdomains must resolve before running certbot.
set -euo pipefail

DOMAINS=(
  dchat.mclellan.scot
  nchat.mclellan.scot
  douglas.mclellan.scot
  nakai.mclellan.scot
)

echo "==> Checking DNS resolution..."
for d in "${DOMAINS[@]}"; do
  ip=$(dig +short "$d" 2>/dev/null | head -1)
  echo "  $d -> ${ip:-NOT RESOLVING}"
done

echo ""
read -rp "Do all domains resolve to this server? (y/N) " confirm
[[ "$confirm" == "y" ]] || { echo "Aborting — fix DNS first."; exit 1; }

echo "==> Enabling Nginx config"
ln -sf /etc/nginx/sites-available/mclellan.conf /etc/nginx/sites-enabled/mclellan.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Obtaining TLS certificates"
for d in "${DOMAINS[@]}"; do
  certbot --nginx -d "$d" --non-interactive --agree-tos -m aio.mclellan@gmail.com
done

echo "==> Reloading Nginx"
systemctl reload nginx

echo "==> Setting up Certbot auto-renewal"
systemctl enable certbot.timer
systemctl start certbot.timer

echo "Done. TLS is live."
