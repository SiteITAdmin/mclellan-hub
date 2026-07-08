# McLellan Hub — Architecture & Capability Registry

**Purpose of this file**: Before implementing anything, check here. If a capability is listed, use the existing implementation. Do not build a new one. The email incident (2026-06) is the canonical example of what this file prevents: `gmail.js:sendEmail()` and `agentmail.js:sendEmail()` both existed; a third was built anyway.

---

## How to use this file

1. Identify the capability you need (email, LLM call, notifications, etc.)
2. Find it below — entry point, function signature, env vars required
3. If the change adds or alters an input path, read `docs/hub-input-contract.md` and identify the raw store, synthesis path, compiled layer, and visible surface before touching code.
4. Call the existing capability. Do not wrap it, rewrite it, or proxy it unless you have a specific reason confirmed with Douglas.

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
Scheduled via job queue every 15 min. Classifies, labels, detects Ryanair bookings, stores source summaries, and keeps Gmail usable as a human navigation surface. It does **not** create CRM facts or Google Tasks directly in normal operation. CRM-facing interpretation is owned by the CRM knowledge engine below.

```js
// lib/agentmail-processor.js
processAgentMail()
```
Scheduled via job queue every 15 min. Stores AgentMail records and summaries as source evidence for the same CRM knowledge engine. Do not add a separate AgentMail-to-CRM write path.

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
- System slots: every LLM call in the system resolves through a named slot in `SYSTEM_MODEL_GROUPS` (`routes/hub-admin.js`) — 69 slots as of 4 Jul 2026, including prompt-only slots (spiciness modifiers, suggestion-engine prompts, work-brief prompts, task rule learner) whose model comes from a parent slot. Configured in the admin models UI (`/admin/models/system`, prompts at `/admin/models/prompts`).
- Every slot's default prompt lives in `lib/prompts.js` (`PROMPTS`), overridable per-slot via `crm_context` key `hub_sys_prompt_<feature>`. Do not write an inline prompt in feature code — add a `PROMPTS` entry, read it with `getSystemPrompt(feature, scope, PROMPTS.<feature>)`, and give it a slot so it is visible in admin.
- Never hardcode a model ID in feature code. Call `getSystemModelId()`.
- Boot-time migration in `lib/db.js` deletes `hub_sys_model_*` overrides whose model key no longer exists in `model_config` (they would otherwise silently fall back while the admin page shows the stale override).

### Current system model defaults
| Slot | Default model |
|---|---|
| embeddings | openai/text-embedding-3-small |
| atom_extractor | anthropic/claude-haiku-4-5 |
| entity_linker | anthropic/claude-haiku-4-5 |
| cross_entity_synthesis | anthropic/claude-haiku-4-5 |
| knowledge_query | google/gemini-2.5-pro-preview |
| project_report | google/gemini-2.5-pro-preview |
| crm_source_triage | anthropic/claude-haiku-4-5 |
| crm_duplicate_review | anthropic/claude-haiku-4-5 |
| crm_action_projection | anthropic/claude-haiku-4-5 |
| prompt_shaper | anthropic/claude-sonnet-4-6 |
| style_distiller | anthropic/claude-sonnet-4-6 |

### Model style profiles
`lib/model-style-profiles.js` holds per-family prompt style profiles (claude/gpt/gemini/grok/open), distilled monthly by the `style_profile_run` job from production system prompts in github.com/asgeirtj/system_prompts_leaks. Stored as compiled knowledge in `crm_context` (`hub_style_profile_<family>`, user `system`) with receipts in `knowledge_receipts`. Consumers: the prompt tool's target-model selector (adapt + Prompt Gym), and the admin "Shape for model" action (`POST /admin/system-models/_shape`), which proposes a restyled system prompt for the family of the slot's assigned model — proposal only, never auto-saved. `familyFromModelId()` maps any OpenRouter model id to a family. Module contract: MODULES.md → Model Style Profiles.

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

## CRM knowledge engine (prompt operating system)

The CRM is not a write target for every ingester. It is a view over compiled knowledge plus operational tasks. The canonical CRM path is:

```text
raw source -> crm_source_triage -> crm_duplicate_review -> synthesis/provenance merge -> crm_action_projection -> compiled atoms/events/tasks
```

Entry point:
```js
// lib/crm-knowledge-engine.js
runCrmKnowledgeEngine({ user, limit })
```

Scheduled via `crm_knowledge_engine` in `lib/job-queue.js`. The job reviews raw and intermediate source evidence, records prompt decisions in `knowledge_receipts`, merges provenance into existing atoms when the source confirms or supersedes known knowledge, and projects only high-confidence required actions into Google Tasks.

Current CRM source kinds:

| Source kind | Meaning |
|---|---|
| `email_summary` | Gmail and AgentMail summaries from email ingest |
| `meeting_intake` | Meeting recordings/transcripts/summaries |
| `document` | Uploaded or Drive-derived documents |
| `open_task` | Current Google Tasks, used as operational evidence and duplicate context |
| `completed_task` | Completed tasks, eligible for durable synthesis |
| `crm_fact` | Existing curated facts, mostly legacy or manually entered context |

Prompt/model slots are visible in `/admin/models`: `crm_source_triage`, `crm_duplicate_review`, and `crm_action_projection`. Receipts are visible in `/admin/knowledge`. These receipts are the audit trail for "what did the model decide, using what source, and why?"

Important rules:

- Ingest paths store faithful source evidence. They must not directly create `crm_facts`, `contact_projects`, `company_projects`, or Google Tasks as their normal output.
- `lib/email-processor.js`, `lib/agentmail-processor.js`, and `lib/meeting-intake.js` have a rollback switch only: `CRM_LEGACY_DIRECT_WRITES=1`. Do not use it as the normal architecture.
- Open tasks are operational state. They can inform triage and duplicate review, but durable knowledge should come from completed tasks or source evidence.
- If a new CRM feature needs to connect people, projects, companies, tasks, documents, or emails, add a source kind or synthesis/projection step. Do not add a direct table copy path.

### User feedback on atoms (6 Jul 2026)

Atoms can be disputed, marked stale, or restored from every surface that renders them (contact/company/project pages and the atom browser at `/crm/knowledge?browse=1`). The action sets `knowledge_atoms.status` and writes a `knowledge_receipts` row (`stage='user_feedback'`, payload carries the reason and previous status) — corrections enter the same evidence stream the engine already consumes. Engine run recency, per-stage failure counts, and data-health badges (duplicate emails, orphaned facts, stale/disputed atoms) are compiled live from `knowledge_receipts`/`knowledge_atoms` on `/crm/knowledge`; a manual "Process sources now" trigger calls `runCrmKnowledgeEngine` directly.

### Manual project declarations (6 Jul 2026)

Project status/deadline/scope/milestones are NOT columns — they are `knowledge_atoms` with `derived_by='manual'`, `subject_kind='project'` (predicates `status`, `deadline`, `scope`, `milestone`). Declared knowledge lives in the compiled layer with provenance like derived knowledge. Health falls back to activity-derived (active <30d, quiet <90d, stale beyond) when no status atom exists. Endpoints: `/api/crm/project/:slug/meta`, `/api/crm/project/:slug/milestones`, `/api/crm/project-milestones/:id/:action`.

### Task priority/effort tags (6 Jul 2026)

Task priority and effort are structured tags in the Google Tasks notes field (`[priority: high] [effort: 30m]`), not columns — they round-trip through the Google API and stay visible in any Google client. Helpers `parseTaskTags`/`stripTaskTags`/`withTaskTags` in `lib/google-tasks.js`; `getCachedTasks` returns parsed `priority`/`effort_minutes` plus a tag-free `notes_preview` on every row. Task-to-meeting traceability is parsed from `source_id` (`meeting:<id>:…`), never stored twice.

### Meeting intake preview (6 Jul 2026)

Drafts can run "Preview extraction" (`previewMeetingIntake` in `lib/meeting-intake.js`): the extraction is stored in `extraction.preview` keyed by a hash of (transcript, title, date, project); submit reuses it when inputs are unchanged, so review costs no second model call. The extraction schema includes attendee `engagement`, meeting-level `risk_flags`/`decision_quality`/`urgency`/`confidence`, and per-action `blocked_by`/`success_criteria`, all flowing into the meeting markdown the engine reads.

### Scheduled project reports (6 Jul 2026)

`project_report_schedules` (agreed config table — user preference, not derivable knowledge) holds one row per project: cadence `weekly:<day>`/`monthly:<1-28>`, window days, optional recipient. The hourly `project_report_schedules` job (`lib/job-queue.js`) calls `runDueProjectReportSchedules` (exported on the `hub-crm` router), which reuses the evidence-to-report-to-PDF-to-AgentMail path with a 20-hour double-send guard. Managed from the schedule card on `/crm/project-report`.

### Knowledge retention

Knowledge never disappears; it only leaves the default line of sight. The weekly lint (`lib/knowledge-lint.js`) decays unconfirmed mutable facts after 180 days and marks them `stale` after 365 — but immutable predicates (`isImmutablePredicate`: date of birth, kinship) are exempt, stale atoms stay searchable in Ask the Hub and visible on entity pages via "show history", and any new source mentioning the fact revives it. Lint decisions land in `crm_context` (`knowledge_lint_last`) and the daily system report's KNOWLEDGE section, so nothing goes stale silently.

### Interest radar

`lib/interest-synthesis.js` (job `interest_synthesis_run`, daily 05:45) is the pattern for "the system joined the dots": recent meeting intakes + upcoming meetings/calendar → model names the topics Douglas is actively engaged with → `interest` atoms with provenance + a compiled cache (`crm_context` key `interest_radar`) → the work daily brief pulls recent stories per topic into an "On your radar" section. To make another surface interest-aware, read `getInterestRadar(user)` — do not build a separate topic store.

### Agent team receipts

`lib/agent-receipts.js` writes accountable agent/team verdicts into `knowledge_receipts` instead of creating a parallel audit store. `lib/hub-agent-roster.js` defines the governance family: Consigliere, underbosses, capos, soldiers, and associates. `lib/hub-family-agents.js` writes capo receipts (`source_kind='hub_module'`, `stage='agent:capo:<key>'`) and underboss receipts (`source_kind='hub_underboss'`, e.g. `stage='agent:crm_underboss'`); `scripts/run-agent-family.js` runs capos, underbosses, then the Consigliere.

`lib/hub-consigliere-agent.js` is the boss-layer challenge agent (`source_kind='hub_governance'`, `source_id='boss_layer'`, `stage='agent:hub_consigliere'`): it checks source families for stale-only evidence and challenges subordinate agent receipts. Token burn uses `lib/token-burn-auditor.js` (`source_kind='token_burn'`, `source_id='dashboard'`, `stage='agent:token_burn_auditor'`) to check generated burn JSON, freshness, OpenRouter export/live summaries, and Hub request-log visibility. A fresh `openrouter-live.summary.json` from `OPENROUTER_MANAGEMENT_KEY` supersedes a stale legacy CSV export. LinkedIn uses `lib/linkedin-agent-team.js` with `source_kind='linkedin_post'` to record research, draft/critic, artifact/PDF, managing-editor, and publishing-archivist checks for each post. The daily system report includes a compact Agent Teams section from these receipts.

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

### Mobile bearer auth (native iOS element apps)
```js
// routes/hub-shared.js
mobileBearerBridge   // mounted in server.js BEFORE the hostname router
```
The per-element iPhone apps (Chat, Tasks, CRM, Content, Flights, Intelligence,
Wiki, Prompts, Token Burn — repos at `~/Documents/McLellan <X> iOS`) and the
Daily Debrief app authenticate with `Authorization: Bearer <token>` because a
raw URLSession holds no session cookie. Accepted tokens: `HUB_MOBILE_TOKEN`,
`DEBRIEF_MOBILE_TOKEN`, `WORKDAY_MOBILE_TOKEN`, `WORKDAY_WEBHOOK_SECRET`
(first set wins; no new prod secret needed). A valid token sets
`req.mobileAuth = true` and pins `req.hubUser = 'douglas'` on every host;
`requireAuth` (hub, wiki), `requirePromptAuth`, and `requireSameOrigin` all
early-exit on it, so the apps call the SAME endpoints as the web UI.

Mobile-only JSON read endpoints (each lives in its element's route file):
`/api/mobile/conversations[/:id]`, `/api/mobile/models`, `/api/mobile/token-burn`
(hub.js); `/api/mobile/tasks`, `/api/mobile/crm[/contact/:id|/company/:id|/project/:slug]`
(hub-crm.js); `/api/mobile/content` (hub-linkedin.js); `/api/mobile/flights`
(hub-flights.js); `/newsletter/api/mobile[/briefing/:id]` (hub-newsletter.js);
wiki `/api/mobile/pages`, `/api/mobile/page/:slug` (wiki.js); prompt
`/api/mobile/prompts[/:id]` (prompt.js). Writes reuse existing endpoints
(`/api/message` SSE chat, `/api/tasks*`, `/api/content/posts/:id/*`,
`/newsletter/topics/toggle`). Before adding a new mobile endpoint, check the
web endpoint can't simply be reused through the bridge.

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
| `knowledge_receipts` | Prompt decision receipts for CRM/source triage, duplicate review, and action projection |
| `synthesis_state` | Checkpoints for synthesis/knowledge jobs |
| `inbound_email_records` | AgentMail source messages and processing state |
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
