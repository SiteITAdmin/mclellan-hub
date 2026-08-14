# WhatsApp → Hermes → Hub capture (evening setup)

Knowledge-first path:

```text
WhatsApp message (explicitly routed chat)
  → Hermes (Baileys bridge passive capture)
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

## Applied on this Mac (2026-07-22)

| Item | Location |
|---|---|
| WhatsApp + Hub env | `~/.hermes/.env` (capture URL/secret and Douglas-only conversational allowlist) |
| Gateway config | `~/.hermes/config.yaml` (ignore strangers, groups disabled) |
| Passive route config | `~/.hermes/whatsapp-routes.json` (Dad Information Group plus Catriona, Iain, and Liz DMs) |
| Passive capture helper | `~/hermes/scripts/whatsapp-bridge/hub-capture.mjs` |
| Capture hook | `~/.hermes/hooks/hub-whatsapp-capture/` |
| Capture skill | `~/.hermes/skills/hub-whatsapp-capture/` |
| SOUL guidance | `~/.hermes/SOUL.md` |
| Bridge npm deps | `~/hermes/scripts/whatsapp-bridge/node_modules` |
| Evening helper | `~/bin/hermes-whatsapp-evening.sh` |

WhatsApp is paired and the `ai.hermes.gateway` user LaunchAgent keeps the gateway
running. Use the helper below only to repair or re-pair the session:

```bash
~/bin/hermes-whatsapp-evening.sh
```

That probes Hub capture, runs `hermes whatsapp` if no session, then starts the gateway.

## 1. Re-pair WhatsApp (only if the saved session expires)

```bash
hermes whatsapp
```

| Mode | When to use |
|---|---|
| **self-chat** | Fastest: message *yourself* (“Aunt asked me to get Dad’s things”). Configured default. |
| **bot** | Dedicated number; Aunt/Uncle message the bot. |

Scan QR: WhatsApp → Linked Devices → Link a device. The current session has
already completed this step.

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

## 4. Passive incoming-message capture

The Baileys bridge records incoming messages before Hermes decides whether the
agent should reply. This keeps WhatsApp capture passive: messages can become Hub
evidence while the conversational allowlist and `group_policy: disabled` prevent
unwanted agent responses.

Current routes:

- `Dad Information Group` → Dad project; Catriona, Iain Clark, Liz Walker,
  Nakai McLellan, and Liz Smith (`Wee Lizzie`) are resolved as their own
  contacts when their sender names match.
- `Catriona` / `Catriona McLellan` DM → Catriona contact + Dad project.
- `Iain` / `Iain Clark` DM → Iain Clark contact + Dad project.
- `Liz`, `Liz Walker`, `Aunt Liz`, or `Aunt Liz Walker` DM → Liz Walker
  contact + Dad project.
- Every other new inbound DM or group message → raw Hub evidence without a
  predetermined contact or project. The knowledge engine must infer meaning from
  the message and existing CRM knowledge.

The catch-all is inbound-only. Outbound messages in unrelated chats are not
captured; the explicitly routed family chats continue to capture both directions.

Capture begins with messages delivered after the gateway is connected. Existing
history requires an explicit WhatsApp chat export/backfill; the bridge does not
silently scrape the full archive.

Historical exports are imported with `scripts/import-whatsapp-export.js`. The
importer preserves each text message as raw evidence, excludes WhatsApp system
events and omitted-media placeholders, uses stable IDs for idempotency, and marks
the evidence as historical so old action language cannot create current tasks.

## 5. Capture hook (intentional self-chat notes)

`~/.hermes/hooks/hub-whatsapp-capture/` — on WhatsApp `agent:start`, posts body to Hub. Failures never block the agent.

## 6. Start gateway

```bash


# or:
hermes gateway
```

## 7. Verification

**A. Automated route and capture tests**

```bash
node --test test/hermes-whatsapp-capture.test.js test/messaging-capture.test.js
```

**B. Live routed-chat check**

Send a fresh message in `Dad Information Group`, or receive a message in another
chat. Family evidence should include the Dad route; other incoming messages
should use route `all-incoming-whatsapp` with no forced contact or project.

**C. Knowledge compile**

The scheduled `crm_knowledge_engine` compiles new evidence. A new bubble is held for five minutes so a reply can be captured first; triage/projection then see same-chat neighbours as context. A later turn can complete an earlier same-chat task (`crm_action_resolution`) when it clearly answers the ask. Check:

- `/admin/knowledge` receipts for `messaging_message`
- Dad project report and Alister contact knowledge panel
- Tasks if confidence was high

## 8. Family identity mapping

Do not add senders to Hermes' conversational allowlist merely for capture. The
passive route layer ingests all incoming messages, while
`WHATSAPP_ALLOWED_USERS` remains scoped to Douglas's own number so Hermes does
not answer them automatically.

## Failure visibility

| Symptom | Check |
|---|---|
| No QR / bridge crash | `hermes whatsapp` re-pair; Node version |
| Routed messages absent | Exact chat name in `~/.hermes/whatsapp-routes.json`; gateway process; bridge logs |
| Capture 401 | Secret mismatch Hub vs Hermes |
| Capture 503 | `HERMES_WEBHOOK_SECRET` unset on Hub |
| Evidence but no atoms | CRM engine job / Mac subscription worker / `/crm/knowledge` receipts for `messaging_message` |
| DM routed as `all-incoming` not family contact | Bridge cached Douglas's own name as chat_name (fixed Aug 2026: peer name only for DMs); restart WhatsApp bridge |
| Stuck `OpenRouter 402` / `action_outcome_error` after cutover | Superseded source-level stage errors + reclaim of `action_projection_failed` from triage candidates (CRM engine Aug 2026); run knowledge retry if still incomplete |

## Architecture notes

- Raw table: `messaging_messages`
- Endpoint: `POST /api/messaging/capture` (Hermes bearer)
- Engine source kind: `messaging_message`
- Capture limit: 2,000 authenticated messages per 15 minutes, separate from
  the generic Hub write limiter
- Intentional notes still use `dchat-crm` skill → `/api/crm/webhook` when *you* dictate a CRM fact
