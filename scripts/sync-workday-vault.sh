#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VPS_HOST="${WORKDAY_SYNC_HOST:-178.104.235.142}"
VPS_USER="${WORKDAY_SYNC_USER:-root}"
VAULT_ROOT="${WORKDAY_SYNC_LOCAL_DIR:-$ROOT/data/synthadoc/mclellan-hub-knowledge}"
REMOTE_VAULT="${WORKDAY_SYNC_REMOTE_DIR:-/app/data/synthadoc/mclellan-hub-knowledge}"
LOG_DIR="$ROOT/data/logs"
LOCK_DIR="${TMPDIR:-/tmp}/mclellan-workday-vault-sync.lock"

mkdir -p "$VAULT_ROOT" "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

# ── Synthadoc env ─────────────────────────────────────────────────────────────
SYNTHADOC_PYTHON="${SYNTHADOC_PYTHON:-$ROOT/.tools/synthadoc-venv/bin/python}"
SYNTHADOC_SRC="${SYNTHADOC_SRC:-$ROOT/.tools/synthadoc}"
export PYTHONPATH="$SYNTHADOC_SRC"

# Load local .env if present so OPENROUTER_API_KEY etc. are available
if [ -f "$ROOT/.env" ]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +o allexport
fi

# synthadoc needs OPENAI_* env vars; bridge from OPENROUTER if needed
export OPENAI_API_KEY="${OPENAI_API_KEY:-${OPENROUTER_API_KEY:-}}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://openrouter.ai/api/v1}"

{
  printf '[%s] vault sync start\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # ── 1. Sync full vault from VPS (exclude compiled wiki and synthadoc internals) ──
  rsync -az \
    -e "ssh -o StrictHostKeyChecking=accept-new" \
    --exclude='.synthadoc/' \
    --exclude='wiki/' \
    --filter='+ */' \
    --filter='+ *.md' \
    --filter='+ *.path' \
    --filter='+ *.url' \
    --filter='+ *.json' \
    --filter='- *' \
    "${VPS_USER}@${VPS_HOST}:${REMOTE_VAULT}/" \
    "$VAULT_ROOT/"

  printf '[%s] rsync ok\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # ── 2. Process ingest queue ───────────────────────────────────────────────
  QUEUE_DIR="$VAULT_ROOT/raw_sources/ingest-queue"

  if [ -d "$QUEUE_DIR" ] && [ -x "$SYNTHADOC_PYTHON" ]; then
    # .path files → local file paths to ingest
    find "$QUEUE_DIR" -maxdepth 1 -name '*.path' | sort | while read -r qfile; do
      target="$(cat "$qfile" | tr -d '[:space:]')"
      if [ -f "$target" ]; then
        printf '[%s] ingest path: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$target"
        (cd "$VAULT_ROOT" && "$SYNTHADOC_PYTHON" -m synthadoc ingest "$target") && rm -f "$qfile" \
          || printf '[%s] ingest failed: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$target"
      else
        printf '[%s] path not found (skipping): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$target"
        rm -f "$qfile"
      fi
    done

    # .url files → JSON {"url":"..."} to ingest
    find "$QUEUE_DIR" -maxdepth 1 -name '*.url' | sort | while read -r qfile; do
      url="$("$SYNTHADOC_PYTHON" -c "import sys,json; print(json.load(open(sys.argv[1]))['url'])" "$qfile" 2>/dev/null || true)"
      if [ -n "$url" ]; then
        printf '[%s] ingest url: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$url"
        (cd "$VAULT_ROOT" && "$SYNTHADOC_PYTHON" -m synthadoc ingest "$url") && rm -f "$qfile" \
          || printf '[%s] ingest url failed: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$url"
      else
        printf '[%s] malformed url file (skipping): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$qfile"
        rm -f "$qfile"
      fi
    done
  elif [ ! -x "$SYNTHADOC_PYTHON" ]; then
    printf '[%s] synthadoc python not found at %s — skipping queue\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$SYNTHADOC_PYTHON"
  fi

  # ── 3. Push compiled wiki pages back to VPS ──────────────────────────────
  rsync -az \
    -e "ssh -o StrictHostKeyChecking=accept-new" \
    "$VAULT_ROOT/wiki/" \
    "${VPS_USER}@${VPS_HOST}:${REMOTE_VAULT}/wiki/"
  printf '[%s] wiki push ok\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # ── 4. Rebuild workday daily index ───────────────────────────────────────
  /usr/bin/env node "$ROOT/scripts/build-workday-daily-index.js"

  # ── 5. Daily topic digest (once per day) ─────────────────────────────────
  DIGEST_STAMP="$LOG_DIR/.digest-last-run"
  TODAY="$(date -u '+%Y-%m-%d')"
  if [ "$(cat "$DIGEST_STAMP" 2>/dev/null)" != "$TODAY" ]; then
    printf '[%s] running daily digest\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    /usr/bin/env node "$ROOT/scripts/daily-digest.js" --days=7 --user=douglas \
      && echo "$TODAY" > "$DIGEST_STAMP" \
      || printf '[%s] digest failed\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  fi

  printf '[%s] sync ok -> %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$VAULT_ROOT"
} >> "$LOG_DIR/workday-vault-sync.log" 2>&1
