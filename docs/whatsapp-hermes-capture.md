# WhatsApp → Hermes → Hub capture (evening setup)

Knowledge-first path:

```text
WhatsApp message (allowlisted)
  → Hermes (Baileys bridge)
  → POST /api/messaging/capture  (raw evidence)
  → crm_knowledge_engine (source kind: messaging_message)
  → atoms + high-confidence Google Tasks
```

Do **not** use `/api/crm/webhook` + `processCrmCommand` as the bulk path for family chat. That path is for intentional CRM notes you dictate.

## Prerequisites

- Hermes installed (`hermes` CLI)
- Node 18+ (WhatsApp bridge)
- Hub reachable at `https://dchat.mclellan.scot` with `HERMES_WEBHOOK_SECRET` matching Hermes env
- Phone with WhatsApp for QR pairing

## Already applied on this Mac (2026-07-19)

| Item | Location |
|---|---|
| WhatsApp + Hub env | `~/.hermes/.env` (`WHATSAPP_ENABLED`, self-chat, capture URL) |
| Gateway config | `~/.hermes/config.yaml` (ignore strangers, groups disabled) |
| Capture hook | `~/.hermes/hooks/hub-whatsapp-capture/` |
| Capture skill | `~/.hermes/skills/hub-whatsapp-capture/` |
| SOUL guidance | `~/.hermes/SOUL.md` |
| Bridge npm deps | `~/hermes/scripts/whatsapp-bridge/node_modules` |
| Evening helper | `~/bin/hermes-whatsapp-evening.sh` |

**Only remaining human step:** QR pair + leave gateway running.

```bash
~/bin/hermes-whatsapp-evening.sh
```

That probes Hub capture, runs `hermes whatsapp` if no session, then `hermes gateway`.

## 1. Pair WhatsApp (if helper not used)

```bash
hermes whatsapp
```

| Mode | When to use |
|---|---|
| **self-chat** | Fastest: message *yourself* (“Aunt asked me to get Dad’s things”). Configured default. |
| **bot** | Dedicated number; Aunt/Uncle message the bot. |

Scan QR: WhatsApp → Linked Devices → Link a device.

## 2. Hermes env (`~/.hermes/.env`)

Already written. To tighten after first success, set your number:

```bash
WHATSAPP_ALLOWED_USERS=353XXXXXXXXX   # country code, no +
```

Capture URL:

```bash
HUB_MESSAGING_CAPTURE_URL=https://dchat.mclellan.scot/api/messaging/capture
```

## 3. Bridge deps

Installed. Re-run only if missing:

```bash
cd ~/hermes/scripts/whatsapp-bridge && npm install
```

## 4. Capture hook (auto)

`~/.hermes/hooks/hub-whatsapp-capture/` — on WhatsApp `agent:start`, posts body to Hub. Failures never block the agent.

## 5. Start gateway

```bash
~/bin/hermes-whatsapp-evening.sh
# or:
hermes gateway
```

## 6. Smoke test (no Aunt required)

**A. Direct API**

```bash
curl -s -X POST https://dchat.mclellan.scot/api/messaging/capture \
  -H "Authorization: Bearer $HERMES_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "user": "douglas",
    "platform": "whatsapp",
    "external_message_id": "smoke-evening-1",
    "sender_name": "Aunt",
    "sender_id": "353870000000",
    "body": "Can you get Dad his shopping list when you go over this week?",
    "chat_id": "353870000000@s.whatsapp.net"
  }'
```

Expect: `{ "ok": true, "created": true, ... }`  
Repeat: `{ "duplicate": true }`.

**B. Self-chat**

Message yourself on WhatsApp with something like:

> Uncle asked me to get whisky at the airport for Dad

Hermes should process it; Hub `messaging_messages` should grow.

**C. Knowledge compile**

On Hub (admin jobs or wait for `crm_knowledge_engine` schedule), or trigger process-sources if available. Check:

- `/admin/knowledge` receipts for `messaging_message`
- Alister contact knowledge panel
- Tasks if confidence was high

## 7. Family allowlist (after smoke works)

Add Aunt and Uncle numbers to `WHATSAPP_ALLOWED_USERS` (comma-separated).  
Restart gateway. Prefer **no chatty replies** in family groups (`WHATSAPP_REQUIRE_MENTION=true` for groups).

## Failure visibility

| Symptom | Check |
|---|---|
| No QR / bridge crash | `hermes whatsapp` re-pair; Node version |
| Messages ignored | `WHATSAPP_ALLOWED_USERS` includes sender; `WHATSAPP_DEBUG=true` |
| Capture 401 | Secret mismatch Hub vs Hermes |
| Capture 503 | `HERMES_WEBHOOK_SECRET` unset on Hub |
| Evidence but no atoms | CRM engine job / OpenRouter key / `/admin/knowledge` |

## Architecture notes

- Raw table: `messaging_messages`
- Endpoint: `POST /api/messaging/capture` (Hermes bearer)
- Engine source kind: `messaging_message`
- Intentional notes still use `dchat-crm` skill → `/api/crm/webhook` when *you* dictate a CRM fact
