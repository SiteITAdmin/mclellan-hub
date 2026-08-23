#!/usr/bin/env bash
# Run after any dependency update, Node.js upgrade, or infrastructure change.
# Checks the tools and services that make the system work — not features.
#
# SSH RULE: all VPS checks go over ONE ControlMaster connection. Do not add
# additional ssh/rsync calls without routing them through the shared socket.
set -euo pipefail

VPS="${VPS:-root@178.104.235.142}"
SSH_CONTROL="/tmp/mclellan-healthcheck-$$"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o "ControlPath=${SSH_CONTROL}" -o ControlPersist=60)
trap 'ssh -o ControlPath="${SSH_CONTROL}" -O exit "${VPS}" 2>/dev/null || true' EXIT

PASS=0
FAIL=0

ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL+1)); }
hdr()  { echo ""; echo "── $* ──────────────────────────────────────────"; }

echo ""
echo "McLellan Hub — dependency health check"
echo "$(date '+%Y-%m-%d %H:%M %Z')"

# ── Local ─────────────────────────────────────────────────────────────────────
hdr "Local"

if command -v node >/dev/null 2>&1; then
  ok "Node.js $(node --version)"
else
  fail "Node.js not found"
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm --version)"
else
  fail "npm not found"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$ROOT/node_modules/.package-lock.json" ] || [ -d "$ROOT/node_modules" ]; then
  ok "node_modules present"
else
  fail "node_modules missing — run npm install"
fi

if crontab -l 2>/dev/null | grep -q "pull-backup\|sync-workday"; then
  ok "Mac cron jobs registered"
else
  fail "Mac cron jobs missing — check crontab -l"
fi

if launchctl print "gui/$(id -u)/com.mclellan.hub.content-research-worker" >/dev/null 2>&1; then
  ok "Content research Mac worker launchd loaded"
else
  # Not a hard fail: only required when VPS uses CONTENT_RESEARCH_DRIVER=mac
  echo "  · Content research Mac worker not loaded (ok if VPS driver is not mac)"
fi

if launchctl print "gui/$(id -u)/com.mclellan.hub.messages-capture" >/dev/null 2>&1; then
  ok "Apple Messages capture worker launchd loaded"
else
  echo "  · Apple Messages capture worker not loaded (install with scripts/install-messages-capture-worker.sh)"
fi

SYNTHADOC_PY="$ROOT/.tools/synthadoc-venv/bin/python"
if [ -x "$SYNTHADOC_PY" ] && "$SYNTHADOC_PY" --version >/dev/null 2>&1; then
  ok "Synthadoc Python venv ($("$SYNTHADOC_PY" --version 2>&1))"
else
  fail "Synthadoc Python venv broken at $SYNTHADOC_PY — rebuild on Mac"
fi

SSH_KEY=""
for k in ~/.ssh/id_ed25519 ~/.ssh/id_rsa; do
  if [ -f "$k" ]; then SSH_KEY="$k"; break; fi
done
if [ -n "$SSH_KEY" ]; then
  ok "SSH key found: $SSH_KEY"
else
  fail "No SSH key found in ~/.ssh/"
fi

# ── VPS — all checks in one SSH call ──────────────────────────────────────────
hdr "VPS"

if ! ssh "${SSH_OPTS[@]}" "${VPS}" "echo connected" >/dev/null 2>&1; then
  fail "Cannot reach VPS — skipping all VPS checks"
  FAIL=$((FAIL + 8))
else
  ok "SSH connection"

  VPS_RESULTS=$(ssh "${SSH_OPTS[@]}" "${VPS}" 'bash -s' <<'REMOTE'
set -euo pipefail

# hub service
if systemctl is-active hub >/dev/null 2>&1; then
  echo "OK:hub service is active"
else
  echo "FAIL:hub service is NOT active"
fi

# nginx
if systemctl is-active nginx >/dev/null 2>&1; then
  echo "OK:nginx is active"
else
  echo "FAIL:nginx is NOT active"
fi

# Node.js on VPS
NODE_VER=$(node --version 2>/dev/null || echo "missing")
if [[ "$NODE_VER" != "missing" ]]; then
  echo "OK:Node.js ${NODE_VER} on VPS"
else
  echo "FAIL:Node.js not found on VPS"
fi

# Puppeteer Chrome binary
CHROME_BIN=$(find /home/hub/.cache/puppeteer -name "chrome" -type f -executable 2>/dev/null | head -1)
if [[ -n "$CHROME_BIN" ]]; then
  echo "OK:Puppeteer Chrome binary present (${CHROME_BIN})"
else
  echo "FAIL:Puppeteer Chrome binary missing — run: cd /app && PUPPETEER_CACHE_DIR=/home/hub/.cache/puppeteer npx puppeteer browsers install chrome"
fi

# better-sqlite3 (native module — breaks on Node.js version changes)
SQLITE_CHECK=$(cd /app && node -e "
try { const db = require('better-sqlite3'); db('/app/data/hub.db',{readonly:true,fileMustExist:true}).close(); console.log('ok'); }
catch(e) { console.log('error:'+e.message); }
" 2>/dev/null || echo "error:node failed")
if [[ "$SQLITE_CHECK" == "ok" ]]; then
  echo "OK:better-sqlite3 opens DB"
else
  echo "FAIL:better-sqlite3 failed — ${SQLITE_CHECK} (run npm rebuild after Node.js upgrade)"
fi

# Critical job queue entries
EMAIL_JOB=$(cd /app && node -e "
const db = require('better-sqlite3')('/app/data/hub.db',{readonly:true,fileMustExist:true});
const r = db.prepare(\"SELECT COUNT(*) as n FROM system_jobs WHERE type='email_process' AND status='pending'\").get();
console.log(r.n);
" 2>/dev/null || echo "0")
if [[ "$EMAIL_JOB" -gt 0 ]]; then
  echo "OK:email_process job is pending"
else
  echo "FAIL:email_process has NO pending job — email processing has stopped"
fi

REMINDER_JOB=$(cd /app && node -e "
const db = require('better-sqlite3')('/app/data/hub.db',{readonly:true,fileMustExist:true});
const r = db.prepare(\"SELECT COUNT(*) as n FROM system_jobs WHERE type='reminder_sweep' AND status='pending'\").get();
console.log(r.n);
" 2>/dev/null || echo "0")
if [[ "$REMINDER_JOB" -gt 0 ]]; then
  echo "OK:reminder_sweep job is pending"
else
  echo "FAIL:reminder_sweep has NO pending job — reminders will not fire"
fi

# Synthadoc service (runs on system Python, not the venv)
if systemctl is-active synthadoc >/dev/null 2>&1; then
  echo "OK:synthadoc service is active"
else
  echo "FAIL:synthadoc service is NOT active"
fi

if python3 --version >/dev/null 2>&1; then
  echo "OK:system Python $(python3 --version 2>&1) available for synthadoc"
else
  echo "FAIL:system Python not found — synthadoc will not work"
fi

# npm audit (high/critical only)
AUDIT=$(cd /app && npm audit --json --omit=dev 2>/dev/null | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
const hi=(d.metadata?.vulnerabilities?.high||0)+(d.metadata?.vulnerabilities?.critical||0);
console.log(hi);
" 2>/dev/null || echo "0")
if [[ "$AUDIT" == "0" ]]; then
  echo "OK:No high/critical npm vulnerabilities"
else
  echo "FAIL:${AUDIT} high/critical npm vulnerabilities — run npm audit"
fi

REMOTE
  )

  while IFS= read -r line; do
    if [[ "$line" == OK:* ]];   then ok  "${line#OK:}";
    elif [[ "$line" == FAIL:* ]]; then fail "${line#FAIL:}";
    fi
  done <<< "$VPS_RESULTS"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Passed: ${PASS}   Failed: ${FAIL}"
if [[ "$FAIL" -eq 0 ]]; then
  echo "  ✓ All checks passed."
else
  echo "  ✗ ${FAIL} check(s) failed — see above."
fi
echo ""
