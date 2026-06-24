# McLellan Hub — Architecture & Capability Registry

**Purpose of this file**: Before implementing anything, check here. If a capability is listed, use the existing implementation. Do not build a new one. The email incident (2026-06) is the canonical example of what this file prevents: `gmail.js:sendEmail()` and `agentmail.js:sendEmail()` both existed; a third was built anyway.

---

## How to use this file

1. Identify the capability you need (email, LLM call, notifications, etc.)
2. Find it below — entry point, function signature, env vars required
3. Call it. Do not wrap it, rewrite it, or proxy it unless you have a specific reason confirmed with Douglas.

---

## Email

### Send email

Two senders exist. Both are production-ready. Use the one appropriate to context.

**Via user's Gmail account** (primary — use for all system-generated reports, digests, notifications):
```js
// lib/gmail.js
sendEmail(gmailClient, to, subject, htmlBody, attachments?)
// gmailClient from: getGmailClient(user)  →  lib/gmail.js
```
Called by: regulatory-monitor, rh-stats, newsletter-pipeline, weekly-digest.

**Via AgentMail** (external address, inbound polling, attachments):
```js
// lib/agentmail.js
sendEmail({ to, subject, html, attachments? })
```
Env: `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`

### Receive / process email
```js
// lib/email-processor.js
processNewEmails(user)
```
Scheduled via job queue every 15 min. Classifies, extracts tasks, detects Ryanair bookings, stores summaries. Do not duplicate this logic elsewhere.

### Silent-filter list
Subjects matching `SILENT_SUBJECT_RE` (email-processor.js:21) are dropped before processing. Add patterns there, not in calling code.

---

## Notifications

### Google Chat (interactive cards)
```js
// lib/google-chat.js
buildReminderCard(reminder)     // escalating reminder with action buttons
buildSuggestionCard(suggestion) // accept/dismiss/why buttons
```
Auth: service account at `config/google-service-account.json`. Posts to Douglas/Nakai's spaces via Hermes bot.

### Reminders (escalation ladder)
```js
// lib/reminders.js
// Creates a reminder row; the job queue fires it at T+0, T+30m, T+3h, T+24h
// Quiet hours: 22:00–07:30 Dublin (auto-deferred to 07:35)
```
Do not write a separate notification loop. Add reminder rows and let the ladder handle delivery.

---

## LLM / AI calls

**All model calls go through OpenRouter. No exceptions.** Direct Anthropic/OpenAI/Google API calls are not permitted.

### Making a model call
```js
// lib/fetch.js  (hub's fetch wrapper — validates attribution headers)
// lib/router.js  (getModels, chat completions, streaming)
// lib/settings.js  getSystemModelId(feature, userScope, fallbackModelId)
```

**Every call must pass through the attribution gate.** `fetch.js:79–100` validates that every OpenRouter request carries the correct headers and logs a violation if they are missing. A call that skips `openRouterHeaders()` will be flagged — it is not a soft convention.

```js
// lib/openrouter-attribution.js
openRouterHeaders(taskCode, options)
// taskCode: one of the 60+ codes defined in that file (AT-EmailClassification, etc.)
```
Adding a new feature → add a task code to `openrouter-attribution.js` first, then pass the result into every call.

### Model selection
- User default: `crm_context` key `hub_default_model`
- System slots: `embeddings`, `synthesis`, `linkage`, `briefing` — configured in admin models UI
- Never hardcode a model ID in feature code. Call `getSystemModelId()`.

### Current system model defaults
| Slot | Default model |
|---|---|
| embeddings | openai/text-embedding-3-small |
| synthesis | anthropic/claude-haiku-4-5 |
| linkage | anthropic/claude-haiku-4-5 |
| briefing | google/gemini-2.5-pro-preview |

---

## Embeddings & semantic search

```js
// lib/retrieval.js
embed(text, user)           // generate embedding via OpenRouter
searchSimilar(query, user, filters)  // cosine similarity against embeddings table
```
Chunks: max 1200 chars, 150-char overlap, sentence-boundary aware.  
Storage: `embeddings` table (`source_kind`, `source_id`, `user`, `vector`, `chunk_text`).  
Backfill: `embed_backfill` job — runs automatically. Do not call `embed()` in bulk inline; add source rows and let the job pick them up.

---

## Scheduling & background jobs

**Do not use `setInterval` or `setTimeout` for new recurring work.** The job queue is the mechanism.

### Add a job
```js
// lib/job-queue.js
// Insert a row into system_jobs: { type, payload, run_at, status: 'pending' }
// Job handler registered in job-queue.js processJobs() switch
```
The 60-second tick in `server.js:242` drives all jobs. Jobs self-enqueue on completion.

### Fixed daily schedules (already in server.js)
| Time (Dublin) | Job |
|---|---|
| 06:45 | CRM calendar sync |
| 07:00 | RH stats email |
| 07:30 | Nakai daily briefing |
| 08:00 | Regulatory monitor (if `REG_MONITOR_ENABLED=1`) |
| 09:30 | RSS feed ingest |
| 21:00 | Daily system report |
| 14:00 Sun | Weekly digest |
| 09:00 Sat | Newsletter reminder |

Check this list before adding a new schedule — the slot may already exist.

### Dublin timezone helper
```js
// lib/reminders.js  nowIn('Europe/Dublin')
// lib/reminders.js  epochAtNextDublin(hour, minute)
```

---

## Data access

**Database**: SQLite via `better-sqlite3`. Synchronous. One connection per DB file.

```js
// lib/db.js
const db = hub()          // main hub.db
db.prepare(sql).get(params)   // single row
db.prepare(sql).all(params)   // array
db.prepare(sql).run(params)   // insert/update/delete
db.transaction(fn)(args)      // ACID batch
```

All queries must include `user` column filter. No cross-user reads.

### Schema changes
Add columns via idempotent `ALTER TABLE` in `lib/db.js` migration block (see existing pattern at db.js:80–145). No new migration files. No down migrations.

**Before adding a table**: read CLAUDE.md — new tables are only justified for raw ingest or compiled knowledge cache output. Not for manually-maintained structured data.

---

## Auth

### Google OAuth2 (Gmail, Drive, Calendar, Tasks)
```js
// lib/google-auth.js
startGoogleAuth(user, scopes)    // redirect to consent screen
finishGoogleAuth(user, code)     // exchange code, store refresh token
// lib/gmail.js
getGmailClient(user)             // returns authenticated client using stored token
// lib/google-drive.js
getDriveClient(user)             // same pattern
```
Refresh tokens stored in `crm_context` table (key: `_google_refresh_token`).

### Session auth (web UI)
Express session, SQLite store, 30-day lifetime. Cookie: `mclellan.sid`.  
Admin check: `req.session.hubAdminUser`.  
MCP bearer fallback: `DCHAT_MCP_TOKEN` / `NCHAT_MCP_TOKEN`.

---

## File / document storage

### Google Drive → markdown
```js
// lib/google-drive.js
downloadDriveFile(user, urlOrId)  // handles sharing links, IDs, plain URLs
// returns markdown string
```
Supports: Google Docs (DOCX→mammoth→md), Sheets (CSV), Slides (PDF).

### Local file upload → markdown
```js
// lib/extract.js
fileToMarkdown(filePath, mimeType)
// Uses markitdown Python tool at .tools/markitdown-venv
```
Supported: PDF, DOCX, XLSX, PPTX, images (OCR), MD.

### Obsidian vault
Location: `/data/synthadoc/mclellan-hub-knowledge/`  
Write via: `POST /api/obsidian/note` with `HERMES_WEBHOOK_SECRET` bearer token.  
Read via: `GET /api/obsidian/notes` or `/api/obsidian/search`.

---

## External APIs — what exists

| Service | Purpose | Auth env var | Entry point |
|---|---|---|---|
| OpenRouter | All LLM + embeddings | `OPENROUTER_API_KEY` | lib/fetch.js + lib/router.js |
| Gmail API | Inbound/outbound email | OAuth2 refresh token | lib/gmail.js |
| AgentMail | External email address | `AGENTMAIL_API_KEY` | lib/agentmail.js |
| Google Drive | Document fetch | OAuth2 refresh token | lib/google-drive.js |
| Google Calendar | Events | OAuth2 refresh token | googleapis client |
| Google Tasks | Task creation | OAuth2 refresh token | lib/google-tasks.js |
| Google Chat | Notifications | Service account JSON | lib/google-chat.js |
| Exa | Neural web search | `EXA_API_KEY` | lib/router.js:60 |
| Brave/Tavily | Fallback web search | `BRAVE_SEARCH_API_KEY` | lib/router.js:96 |
| Synthadoc | YouTube/URL → notes | `SYNTHADOC_URL` (internal) | lib/hub-external.js:9 |

**Before integrating a new external service**, check whether an existing one covers the need.

---

## Admin UI — existing tools

Route prefix: `/admin` — see `routes/hub-admin.js`.

| Path | Purpose |
|---|---|
| `/admin` | Dashboard, job queue monitor |
| `/admin/models` | Model registry CRUD (enable/disable, cost config) |
| `/admin/email-labels` | Email taxonomy viewer/editor |
| `/admin/intelligence` | Ingestion audit history |
| `/admin/nakai-briefings` | Briefing list + resend |
| `/admin/reports` | System reports, request logs |
| `/admin/rss-feeds` | Feed management, manual ingest trigger |
| `/admin/jobs` | Job queue inspect + manual trigger |
| `/admin/documents` | Document upload |
| `/admin/knowledge` | Knowledge review queue |

**Before adding a new admin page**, check if the capability belongs in an existing page.

---

## Key database tables (quick reference)

| Table | What it stores |
|---|---|
| `crm_context` | Per-user key-value settings, OAuth tokens |
| `system_jobs` | Job queue (type, payload, run_at, status) |
| `model_config` | LLM model registry |
| `email_summaries` | Processed email metadata + summaries |
| `embeddings` | Vector chunks for semantic search |
| `knowledge_atoms` | Derived claims (subject, predicate, value, confidence) |
| `reminders` | Escalating reminders with fire count + status |
| `suggestions` | Action suggestions (domain, title, body, status) |
| `messages` | Chat history per user/project |
| `contacts` / `companies` | CRM entities |
| `crm_facts` | Curated facts (source for atom derivation) |
| `documents` | Uploaded files (markdown content) |
| `rss_articles` | Ingested feed articles |
| `flight_records` | Parsed flights from email |
| `nl_briefings` | Newsletter/Nakai briefing editions |
| `request_logs` | LLM usage per session |
