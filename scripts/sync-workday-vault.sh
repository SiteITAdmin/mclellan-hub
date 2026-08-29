#!/usr/bin/env bash
set -euo pipefail

if [ -n "${MCLELLAN_ROOT:-}" ]; then
  ROOT="$MCLELLAN_ROOT"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

VPS_HOST="${WORKDAY_SYNC_HOST:-178.104.235.142}"
VPS_USER="${WORKDAY_SYNC_USER:-root}"
SSH_CONTROL="/tmp/mclellan-workday-$$"
SSH_BASE_OPTS="-o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath=${SSH_CONTROL} -o ControlPersist=120"
trap 'ssh -o ControlPath="${SSH_CONTROL}" -O exit "${VPS_USER}@${VPS_HOST}" 2>/dev/null || true' EXIT
VAULT_ROOT="${WORKDAY_SYNC_LOCAL_DIR:-$ROOT/data/synthadoc/mclellan-hub-knowledge}"
REMOTE_VAULT="${WORKDAY_SYNC_REMOTE_DIR:-/app/data/synthadoc/mclellan-hub-knowledge}"
LOG_DIR="$ROOT/data/logs"
LOCK_DIR="${TMPDIR:-/tmp}/mclellan-workday-vault-sync.lock"

mkdir -p "$VAULT_ROOT" "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

remove_remote_queue_file() {
  local rel_path="$1"
  local remote_path="${REMOTE_VAULT}/${rel_path}"
  ssh ${SSH_BASE_OPTS} "${VPS_USER}@${VPS_HOST}" "rm -f -- \"$remote_path\"" || true
}

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
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-hub-model://v1}"

{
  printf '[%s] vault sync start\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # ── 1. Sync full vault from VPS (exclude compiled wiki and synthadoc internals) ──
  rsync -az \
    -e "ssh ${SSH_BASE_OPTS}" \
    --exclude='.synthadoc/' \
    --exclude='wiki/' \
    --filter='+ */' \
    --filter='+ *.md' \
    --filter='+ *.path' \
    --filter='+ *.url' \
    --filter='+ *.json' \
    --filter='+ *.pdf' \
    --filter='+ *.docx' \
    --filter='+ *.txt' \
    --filter='+ *.csv' \
    --filter='+ *.png' \
    --filter='+ *.jpg' \
    --filter='+ *.jpeg' \
    --filter='+ *.webp' \
    --filter='- *' \
    "${VPS_USER}@${VPS_HOST}:${REMOTE_VAULT}/" \
    "$VAULT_ROOT/"

  printf '[%s] rsync ok\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # ── 2. Pull web-created and web-edited wiki pages ────────────────────────
  mkdir -p "$VAULT_ROOT/wiki"
  rsync -az \
    -e "ssh ${SSH_BASE_OPTS}" \
    "${VPS_USER}@${VPS_HOST}:${REMOTE_VAULT}/wiki/" \
    "$VAULT_ROOT/wiki/"
  printf '[%s] wiki pull ok\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # ── 3. Apply wiki deletions made through the web app ─────────────────────
  WIKI_DELETE_QUEUE="$VAULT_ROOT/raw_sources/wiki-delete-queue"
  if [ -d "$WIKI_DELETE_QUEUE" ]; then
    find "$WIKI_DELETE_QUEUE" -maxdepth 1 -name '*.json' | sort | while read -r qfile; do
      slug="$(basename "$qfile" .json)"
      rel_qfile="${qfile#$VAULT_ROOT/}"
      if [[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
        rm -f "$VAULT_ROOT/wiki/$slug.md"
        rm -f "$qfile"
        remove_remote_queue_file "$rel_qfile"
        printf '[%s] wiki delete applied: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$slug"
      else
        printf '[%s] invalid wiki delete ignored: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$qfile"
      fi
    done
  fi

  # ── 4. Daily Boox / Onyx Drive notebook ingest ───────────────────────────
  BOOX_STAMP="$LOG_DIR/.boox-drive-last-run"
  TODAY="$(date -u '+%Y-%m-%d')"
  if [ "${BOOX_DRIVE_ENABLED:-0}" = "1" ] && [ "$(cat "$BOOX_STAMP" 2>/dev/null)" != "$TODAY" ]; then
    printf '[%s] running Boox Drive ingest\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    /usr/bin/env node "$ROOT/scripts/ingest-boox-drive-notes.js" \
      && echo "$TODAY" > "$BOOX_STAMP" \
      || printf '[%s] Boox Drive ingest failed\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  fi

  # ── 4b. Recognise handwritten Boox pages ─────────────────────────────────
  # macOS-only (Vision framework), so this is the machine that does it. Bounded
  # per run: a fat notebook must not hold up the rest of the sync. Nothing here
  # enters the knowledge base — each reading is surfaced on /crm/questions for
  # Douglas to check against the original page.
  if [ "$(uname -s)" = "Darwin" ]; then
    /usr/bin/env node "$ROOT/scripts/ocr-boox-notes.js" --limit=5 \
      || printf '[%s] Boox note OCR reported failures\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  fi

  # ── 5. Process ingest queue ───────────────────────────────────────────────
  QUEUE_DIR="$VAULT_ROOT/raw_sources/ingest-queue"

  if [ -d "$QUEUE_DIR" ] && [ -x "$SYNTHADOC_PYTHON" ]; then
    # .path files → vault-relative (or absolute) paths to ingest
    find "$QUEUE_DIR" -maxdepth 1 -name '*.path' | sort | while read -r qfile; do
      rel_qfile="${qfile#$VAULT_ROOT/}"
      raw="$(cat "$qfile" | tr -d '[:space:]')"
      # Resolve relative paths against the local vault root
      if [[ "$raw" = /* ]]; then
        target="$raw"
      else
        target="$VAULT_ROOT/$raw"
      fi
      if [ -f "$target" ]; then
        printf '[%s] ingest path: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$target"
        if (cd "$VAULT_ROOT" && "$SYNTHADOC_PYTHON" -m synthadoc ingest "$target"); then
          rm -f "$qfile"
          remove_remote_queue_file "$rel_qfile"
        else
          printf '[%s] ingest failed: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$target"
        fi
      else
        printf '[%s] path not found (skipping): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$target"
        rm -f "$qfile"
      fi
    done

    # .url files → JSON {"url":"..."} to ingest
    find "$QUEUE_DIR" -maxdepth 1 -name '*.url' | sort | while read -r qfile; do
      rel_qfile="${qfile#$VAULT_ROOT/}"
      url="$("$SYNTHADOC_PYTHON" -c "import sys,json; print(json.load(open(sys.argv[1]))['url'])" "$qfile" 2>/dev/null || true)"
      if [ -n "$url" ]; then
        printf '[%s] ingest url: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$url"
        if (cd "$VAULT_ROOT" && "$SYNTHADOC_PYTHON" -m synthadoc ingest "$url"); then
          rm -f "$qfile"
          remove_remote_queue_file "$rel_qfile"
        else
          printf '[%s] ingest url failed: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$url"
        fi
      else
        printf '[%s] malformed url file (skipping): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$qfile"
        rm -f "$qfile"
      fi
    done
  elif [ ! -x "$SYNTHADOC_PYTHON" ]; then
    printf '[%s] synthadoc python not found at %s — skipping queue\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$SYNTHADOC_PYTHON"
  fi

  # ── 6. Push compiled wiki pages back to VPS ──────────────────────────────
  rsync -az \
    -e "ssh ${SSH_BASE_OPTS}" \
    "$VAULT_ROOT/wiki/" \
    "${VPS_USER}@${VPS_HOST}:${REMOTE_VAULT}/wiki/"
  ssh ${SSH_BASE_OPTS} "${VPS_USER}@${VPS_HOST}" \
    "chown -R hub:hub \"$REMOTE_VAULT/wiki\" && chmod -R u+rwX \"$REMOTE_VAULT/wiki\""
  printf '[%s] wiki push ok\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # ── 7. Rebuild workday daily index ───────────────────────────────────────
  /usr/bin/env node "$ROOT/scripts/build-workday-daily-index.js"

  # ── 8. Daily topic digest (once per day) ─────────────────────────────────
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
