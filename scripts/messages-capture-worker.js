#!/usr/bin/env node
'use strict';

// One-shot Mac reader for Apple Messages. launchd runs this every minute. It
// reads chat.db without modifying it, posts each new text bubble through the
// Hub's existing messaging ingest door, and advances its local cursor only
// after Hub accepts (or de-duplicates) that exact provider message.

const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');

try {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) require(path.join(root, 'node_modules', 'dotenv')).config({ path: envPath, override: false });
} catch (error) {
  console.warn(`[messages-capture-worker] dotenv load skipped: ${error.message}`);
}

const {
  DEFAULT_MESSAGES_DB,
  DEFAULT_ADDRESS_BOOK_ROOT,
  AppleMessagesReader,
  readContactNames,
  buildMessagesCapturePayload,
} = require('../lib/apple-messages-capture');

const HUB_URL = String(process.env.HUB_URL || '').replace(/\/$/, '');
const CAPTURE_URL = String(
  process.env.HUB_MESSAGING_CAPTURE_URL || (HUB_URL ? `${HUB_URL}/api/messaging/capture` : '')
).trim();
const SECRET = String(process.env.HERMES_WEBHOOK_SECRET || '').trim();
const USER = String(process.env.MESSAGES_CAPTURE_USER || 'douglas').trim();
const OWNER_NAME = String(process.env.MESSAGES_OWNER_NAME || 'Douglas McLellan').trim();
const DATABASE_PATH = String(process.env.MESSAGES_DB_PATH || DEFAULT_MESSAGES_DB);
const ADDRESS_BOOK_ROOT = String(process.env.MESSAGES_ADDRESS_BOOK_ROOT || DEFAULT_ADDRESS_BOOK_ROOT);
const STATE_PATH = String(process.env.MESSAGES_CAPTURE_STATE_PATH || path.join(
  os.homedir(), 'Library', 'Application Support', 'McLellan Hub', 'messages-capture-state.json',
));
const MAX_PER_RUN = Math.max(1, Math.min(2000, Number(process.env.MESSAGES_CAPTURE_MAX_PER_RUN) || 500));

function heartbeatUrl(captureUrl = CAPTURE_URL) {
  const url = new URL(captureUrl);
  url.pathname = '/api/messaging/heartbeat';
  url.search = '';
  return url.toString();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function readState(statePath = STATE_PATH) {
  if (!fs.existsSync(statePath)) return null;
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch (error) { throw new Error(`invalid cursor state ${statePath}: ${error.message}`); }
  if (!state || state.version !== 1 || !Number.isSafeInteger(Number(state.last_rowid))) {
    throw new Error(`invalid cursor state ${statePath}: expected version 1 and last_rowid`);
  }
  state.last_rowid = Number(state.last_rowid);
  state.counters = state.counters && typeof state.counters === 'object' ? state.counters : {};
  return state;
}

function writeState(state, statePath = STATE_PATH) {
  const directory = path.dirname(statePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

function increment(state, key) {
  state.counters[key] = Number(state.counters[key] || 0) + 1;
}

async function sendHeartbeat(detail, { captureUrl = CAPTURE_URL, post = postJson } = {}) {
  if (!captureUrl || !SECRET) return;
  await post(heartbeatUrl(captureUrl), {
    worker_id: `mac:${os.hostname()}:messages`,
    ...detail,
  });
}

async function runOnce({
  databasePath = DATABASE_PATH,
  addressBookRoot = ADDRESS_BOOK_ROOT,
  statePath = STATE_PATH,
  captureUrl = CAPTURE_URL,
  initializeOnly = process.env.MESSAGES_CAPTURE_INITIALIZE_ONLY === '1',
  post = postJson,
} = {}) {
  if (!captureUrl || !SECRET) throw new Error('HUB_URL/HUB_MESSAGING_CAPTURE_URL and HERMES_WEBHOOK_SECRET are required');
  const reader = new AppleMessagesReader({ databasePath });
  try {
    let state = readState(statePath);
    if (!state) {
      const timestamp = Math.floor(Date.now() / 1000);
      state = {
        version: 1,
        last_rowid: reader.maxRowId(),
        initialized_at: timestamp,
        last_success_at: timestamp,
        last_error: null,
        last_unreadable_at: null,
        counters: {},
      };
      writeState(state, statePath);
      await sendHeartbeat({ ok: true, status: 'initialized_at_current_message', last_rowid: state.last_rowid }, { captureUrl, post });
      console.log(`[messages-capture-worker] initialized at Messages row ${state.last_rowid}; historical messages were not imported`);
      return { initialized: true, captured: 0, skipped: 0, state };
    }

    if (initializeOnly) {
      await sendHeartbeat({ ok: true, status: 'initialized', last_rowid: state.last_rowid }, { captureUrl, post });
      return { initialized: false, captured: 0, skipped: 0, state };
    }

    const contactNames = readContactNames({ root: addressBookRoot });
    const rows = reader.messagesAfter(state.last_rowid, { limit: MAX_PER_RUN });
    let captured = 0;
    let skipped = 0;
    for (const row of rows) {
      const built = buildMessagesCapturePayload(row, { user: USER, ownerName: OWNER_NAME, contactNames });
      if (built.payload) {
        await post(captureUrl, built.payload);
        captured += 1;
        increment(state, 'captured');
      } else {
        skipped += 1;
        increment(state, `skipped_${built.skip_reason || 'unknown'}`);
        if (built.skip_reason === 'unreadable_attributed_body') {
          state.last_unreadable_at = Math.floor(Date.now() / 1000);
        }
      }
      state.last_rowid = Number(row.rowid);
      state.last_success_at = Math.floor(Date.now() / 1000);
      state.last_error = null;
      writeState(state, statePath);
    }

    await sendHeartbeat({
      ok: true,
      status: rows.length ? 'processed' : 'idle',
      last_rowid: state.last_rowid,
      captured,
      skipped,
      last_unreadable_at: state.last_unreadable_at,
      counters: state.counters,
    }, { captureUrl, post });
    console.log(`[messages-capture-worker] row=${state.last_rowid} captured=${captured} skipped=${skipped}`);
    return { initialized: false, captured, skipped, state };
  } finally {
    reader.close();
  }
}

async function main() {
  try {
    await runOnce();
  } catch (error) {
    console.error(`[messages-capture-worker] ${error.message}`);
    try {
      const state = readState();
      if (state) {
        state.last_error = String(error.message || error).slice(0, 500);
        state.last_error_at = Math.floor(Date.now() / 1000);
        writeState(state);
      }
      await sendHeartbeat({ ok: false, error: String(error.message || error).slice(0, 500) });
    } catch (_) {}
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { heartbeatUrl, postJson, readState, writeState, runOnce };
