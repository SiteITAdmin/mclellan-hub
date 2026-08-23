# Apple Messages → Hub capture

Knowledge-first path:

```text
new Apple Messages text bubble (received or sent)
  → read-only Mac chat.db worker (every minute)
  → POST /api/messaging/capture (raw evidence)
  → source admission receipt (`messaging:messages`)
  → crm_knowledge_engine (`messaging_message`)
  → compiled atoms/actions + high-confidence Google Tasks
```

The worker does not write to Messages, Contacts, or their databases. It reads
new provider rows, resolves a display name from macOS Contacts when one is
unambiguous, and preserves the provider GUID, chat GUID, direction, service,
participants, timestamps, and body in the existing `messaging_messages` raw
store. Contact/project meaning is still synthesized by the Hub.

## Live policy

- Capture begins at the current highest Messages row on first installation.
  Existing history is not silently imported or reprocessed.
- Both received and sent text bubbles are captured. Sent replies are necessary
  same-chat context, and sent commitments are valid source evidence.
- One provider bubble remains one Hub source. Same-chat neighbours are prompt
  context only, exactly as for WhatsApp.
- Reactions, system events, and attachment-only bubbles are skipped. Text that
  accompanies an attachment is captured, with attachment presence retained in
  the raw provider envelope. Attachment bytes are not copied.
- Edits and unsends are retained as provider metadata when visible but do not
  rewrite an already-admitted source. This matches the current WhatsApp
  bubble-capture contract.

## Installation

Prerequisites in the repository `.env`:

```text
HUB_URL=https://dchat.mclellan.scot
HERMES_WEBHOOK_SECRET=<same trusted messaging-capture secret as the Hub>
```

Install the minute LaunchAgent:

```bash
scripts/install-messages-capture-worker.sh
```

The installed job is `com.mclellan.hub.messages-capture`. Its files are:

| Item | Location |
|---|---|
| Reader | `scripts/messages-capture-worker.js` |
| Provider adapter | `lib/apple-messages-capture.js` |
| Durable cursor | `~/Library/Application Support/McLellan Hub/messages-capture-state.json` |
| stdout | `~/Library/Logs/mclellan-hub.messages-capture.out.log` |
| stderr | `~/Library/Logs/mclellan-hub.messages-capture.err.log` |

If the job reports that `chat.db` is unreadable, grant Full Disk Access to
`/opt/homebrew/opt/node@24/bin/node`, then rerun the installer. Access can be
verified without reading message bodies:

```bash
/opt/homebrew/opt/node@24/bin/node -e "const D=require('better-sqlite3'); const d=new D(process.env.HOME+'/Library/Messages/chat.db',{readonly:true}); console.log(d.prepare('select max(rowid) n from message').get().n); d.close()"
```

## Verification

```bash
node --test test/apple-messages-capture.test.js test/messaging-capture.test.js test/messaging-chat-resolution.test.js
launchctl print "gui/$(id -u)/com.mclellan.hub.messages-capture"
tail -20 ~/Library/Logs/mclellan-hub.messages-capture.out.log
```

After sending a fresh, harmless Messages text, verify:

1. the cursor advances and the log reports `captured=1`;
2. `/api/messaging/recent` contains `platform: messages` and the provider GUID;
3. `/crm/knowledge` shows a `source_admitted` receipt attributed to
   `messaging:messages`;
4. after the five-minute settle window, normal CRM triage/synthesis receipts
   appear. A high-confidence action may project only through the existing
   Google Tasks effect gate.

The worker heartbeats to `/api/messaging/heartbeat`. Once installed, a failed
or stale heartbeat is surfaced in the daily system report's INGEST section.

## Recovery

The cursor advances only after Hub accepts or de-duplicates a provider GUID.
On network/Hub failure the current row remains pending and is retried on the
next run. A crash after Hub acceptance but before cursor persistence is also
safe: Hub de-duplicates `(user, platform, external_message_id)` and the retry
then advances the cursor.

Do not delete or hand-edit the cursor to request history. Historical import is
a separate, explicit, bounded backfill decision because old action language
must never become current tasks.
