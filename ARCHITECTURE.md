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

### Project routing is content-first
An inbound email's project is decided by what the email is **about**, never by who sent it. `resolveProjectSlug()` (agentmail-processor.js) takes the model's content-derived `project_slug`, then the classifier's, and only then — as a last-resort tie-breaker — the sender-domain→company map. The sender domain establishes *whose world* the mail is (e.g. any `@beaconhospital.ie` address is Beacon work), it must not pick the specific project. Routing targets are filtered to **live** project slugs (`liveSlugs`), so mail can never be filed into an ended project; when content or the domain map points at a dead project the mail falls back to the live `beacon` default. Do not reintroduce a `companyProjectSlug`-first chain: that once buried nine live M365 emails in the closed Cybersecurity project (commit `bbd39761`).

### Project lifecycle vocabulary is unified
"This project is dead" is one concept with one source of truth: `TERMINAL_PROJECT_STATUSES` in `lib/project-lifecycle.js` (`closed`, `completed`, `ended`, `done`, `archived`, `cancelled`, …). Every surface that hides or excludes projects — CRM lists, the task-add guard, AgentMail routing — routes through `closedProjectIds`/`closedProjectSlugs`/`isProjectClosed`, so a project marked with **any** terminal word behaves identically. Do not add a new filter that keys off a single literal like `'closed'`; that split once left a `completed` project live enough to keep receiving mail.

### Ingest door — every capture is judged where it lands
```js
// lib/source-admission.js
admitSource(user, sourceKind, rowOrId, { ingester })
```
Called by `gmail.js` `captureFetchedRawGmailEmail`, `agentmail-processor.js` `captureRawAgentMail`, `meeting-intake.js`, and `messaging-capture.js` immediately after the raw row is written. Writes a `knowledge_receipts` row at stage `source_admitted` (`done` / `review` / `error` / `skipped`), idempotent per source revision. **A new ingest path must call this.** Completeness is judged where the capture happened, so "AgentMail isn't reading emails" is something the Hub reports in the daily INGEST section rather than something Douglas has to infer from a task that never appeared. Admission never gates capture, and it decides nothing about meaning. See MODULES.md → Ingest Door.

### Silent-filter list
Subjects matching `SILENT_SUBJECT_RE` (email-processor.js:21) are dropped before processing. Add patterns there, not in calling code.

---

## Notifications

Google Chat delivery is retired. It never posted. Reminders live on `/crm/reminders`. Suggestions live on `/crm/suggestions` (and may email a high-salience opportunity). Do not add a Chat bot or `lib/google-chat.js` back.

Opportunity suggestions follow `source signal → salience synthesis → stable source-ID gate → semantic duplicate review against authoritative task/suggestion history → candidate/email`. Scored outcomes teach transferable relevance qualities; they are terminal history and never permission to repeat the accepted action.

### Google Tasks — one attributed write path
```js
// lib/google-tasks.js
createTask(user, { title, notes, due, source, sourceId, origin, ... })
// lib/effect-gate.js  (called from inside createTask; not a wrapper to remember)
recordEffect(user, { origin, source, sourceId, title, outcome })
```
Reading fans out across modules; writing must not. Every task creation is recorded at stage `external_effect` against a named `origin`, so "why did this task appear?" has one place to look. **Pass `origin` when adding a call site** — undeclared callers fall back to `source` and are reported as unattributed. The gate observes and escalates rather than blocking; a burst from one origin surfaces as a `NEEDS YOU` line in the daily EFFECTS section. See MODULES.md → External Effect Gate.

### Task calendar planner — Tasks remain tasks, placements become events

`/crm/planner` is the Motion-style operational view over the existing Google Tasks mirror and live primary Google Calendar. `lib/task-calendar-planner.js` never copies tasks into a planner table. The per-task Planner checkbox writes a Google-visible `[planner: work]` or `[planner: personal]` notes tag; only opted-in open tasks enter the planner inbox. A task tagged `[assignee: <name>]` is excluded from the planner entirely — it is someone else's to do, tracked in the "Tasks assigned to others" section of `/crm/tasks` rather than scheduled on Douglas's calendar. An unscheduled task is derived by subtracting `meetings.source='task_planner'` task IDs from those selected tasks; effort and priority come from the same notes tags parsed by `lib/google-tasks.js`. Every task created through the central `createTask` effect gate receives `[effort: 30m]` unless it already has an explicit estimate.

Drag-to-move and duration-resize both run on Pointer Events (mouse + touch + pen in one path); native HTML5 drag-and-drop is not used because the blocks live inside an `overflow:auto` scroller where it fails. Tapping/clicking a task block (without dragging) opens it in `/crm/tasks/<id>`, which is the path to change its due date and clear the late marker on the next planner load (the marker is derived live from `event.date > task.due`). Dragging a task creates one ordinary Google Calendar event through `createCalendarEvent`, with private `hubSource=task_planner` / `hubTaskId=<local task id>` properties, and mirrors it into the existing `meetings` cache. Dragging it again patches that event. Unscheduling or clearing the Planner checkbox deletes only the event/cache row. Scheduling windows are saved as JSON at `crm_context.task_planner_preferences`: work tasks are constrained to Monday–Friday work hours, and personal tasks to weekday evenings or configured weekend hours. The Auto-plan button is an explicit user effect: it orders selected unscheduled work by due date then priority, uses effort, skips opaque calendar events and past time, and writes only after confirmation. A due date is a target, not a hard stop: when no eligible slot remains on or before it, the planner continues into the next permitted free time and visibly marks the block late. Transparent events remain visible without consuming focus time; an opaque all-day event blocks the applicable window.

Existing task blocks are reconciled automatically every five minutes across a rolling 28-day window. Genuine opaque Calendar appointments are fixed; a colliding task block is patched forward into the next permitted free slot, and later task blocks cascade only when the moved block consumes their time. This automatic path never opts in or places a previously unscheduled task. It preserves the existing Calendar event ID and `hubTaskId`, records `reason='calendar_conflict'` in the normal `calendar_planner_effect` receipt, retains the late marker beyond the due date, and exposes the latest movement or failure on `/crm/planner` for 24 hours. The same five-minute pass calls `cleanupCompletedPlannerBlocks`, which deletes the calendar block of any task that is no longer open (`status!='needsAction'` or soft-deleted) so a finished task's time reopens on its own rather than lingering as an orphan block.

A task can depend on a meeting: set "Only after" on `/crm/tasks/<id>` (a picker of the next 14 days' timed calendar events) and the task carries `[after: cal:<eventId>]`. `resolveTaskFloor` turns that into an earliest-start floor from the linked event's live end time; `computeAutoPlan` and `computeReshuffle` never schedule or pull a block before its floor, the planner blocks/inbox cards carry `data-not-before` and a 🔒 marker, a manual drag before the floor is refused client-side and again server-side in `scheduleTask` (`resolveTaskFloorRemote` via `calendar.events.get`). The floor follows the meeting if it is rescheduled and lapses once the meeting falls out of the loaded window (dependency satisfied).

The Reshuffle button (`POST /api/planner/reshuffle` → `reshufflePlannerTasks`) is a second explicit user effect, distinct from Auto-plan. It first clears finished blocks, then **rescues any open task block whose slot has already passed** — a block on an earlier day, or on today but already ended — moving it *forward* into the earliest free permitted slot at or after the moment reshuffle runs; higher-priority overdue work claims the earliest slot first. Blocks still sitting in the future are left untouched — reshuffle rescues the past, it does not re-pack the future. The call is self-anchoring: it reaches back ~14 days to collect stranded blocks and forward ~14 days to re-home them regardless of the week being viewed, so the route must **not** forward the visible page range (a window starting at today never fetched past-day blocks — the original bug). It touches only scheduled blocks (the inbox stays with Auto-plan), respects appointments, windows and `[after:]` floors, and patches through the same `scheduleTask` path with `reason='reshuffle_fill_free_time'`. (Until 18 Aug 2026 reshuffle instead pulled future blocks *earlier* to compact gaps; that was dropped — the 5-minute reconcile still fills conflict gaps forward.)

Provider exactly-once delivery is not assumed. Before inserting, the planner reconciles by the private task ID; after an ambiguous insert error it performs the same lookup and adopts the remote event if present. Each schedule/move/remove attempt writes a `calendar_planner_effect` receipt. These placements are operational state, not relationship evidence or a new task-creation path.

`GET /api/planner/print-today` is a read-only, on-demand PDF projection of today’s live planner snapshot. It does not archive a document or create calendar/task state: genuine appointments render in the calendar column, while task-backed Calendar mirrors render once in the scheduled-task checklist, with late blocks marked in red.

### Boox reference planner — the Hub as a navigable e-ink book (20 August 2026)

`lib/boox-planner.js` renders the next 90 days as one hyperlinked PDF sized to the Onyx Note Max 4:3 panel: today, month grids, week spreads, a page per day, the task inbox (overdue / unplanned / assigned to others), live projects with their compiled `knowledge_atoms`, and open actions grouped by person. It is a derived view — no planner table, no new storage, nothing created. Every row links back to the Hub record it came from, so the device is a reading surface with a way home rather than a copy of the data.

It is **read-only by design**. Boox keeps handwriting in an annotation layer keyed to the file it was drawn on, so a document rebuilt every night cannot also be the page Douglas writes on. Writing stays in an ordinary Boox notebook, which already returns through the Boox → Drive ingest path (`docs/boox-drive-ingest.md`). Do not add form fields, blank writing pages, or a "save my notes" path to this artifact — the outbound book and the inbound notebook are deliberately different files.

The window is assembled from consecutive 28-day planner snapshots because `getPlannerSnapshot` is capped at 31 days (it backs a week view and a live Calendar read); events are merged by ID and a task blocked out in a later chunk counts as scheduled. Every page has a hard content box and every list a row cap with a visible "+n more", so a busy day can never spill into an unstyled overflow page.

Layout is HTML rendered by Chrome (`page.pdf`), which preserves `#anchor` links as named PDF destinations and absolute URLs as URI actions — that is what makes the tab rail, month cells and day pages tappable in NeoReader. Verified against the generated file's annotations before the module was written; keep hrefs as plain anchors, never JS handlers.

Delivery is a push, because the device pulls: `boox_planner_publish` runs nightly at 04:50 Dublin (after the synthesis jobs refresh project knowledge) and updates **the same Drive file in place** in `onyx/NoteMax/Hub Planner` — a new file per day would leave the tablet holding a folder of stale planners. The file id lives in `crm_context.boox_planner_drive_file` with the last publish time and last error; `/crm/planner` shows both, and offers "Download PDF" (`GET /api/planner/boox-planner.pdf`) and "Send to Drive now" (`POST /api/planner/boox-planner/publish`). `BOOX_PLANNER_DRIVE_FOLDER_PATH`, `BOOX_PLANNER_FILENAME` and `BOOX_PLANNER_PUBLISH=0` configure/disable it.

### CRM layout — fluid shared surface

All CRM views inherit their layout from `views/hub/partials/crm-head.ejs` and `public/crm.css`. The CRM canvas is viewport-fluid with clamped gutters and spacing rather than a fixed centred width. Card collections add columns as room appears; detail views keep a weighted primary/sidebar split until the tablet breakpoint; forms gain a third column only on wide screens. The Planner uses the same fluid canvas, keeps a wider task inbox on large displays, and stacks the inbox above the calendar before the seven-day grid becomes cramped. Narrow screens may scroll the calendar itself, but must never make the document horizontally overflow. Keep readable caps on prose/source views locally; do not reintroduce a global fixed-width CRM wrapper or page-specific copies of these breakpoints.

### Reminders (escalation ladder)
```js
// lib/reminders.js
// Creates a reminder row; the job queue fires it at T+0, T+30m, T+3h, T+24h
// Quiet hours: 22:00–07:30 Dublin (auto-deferred to 07:35)
```
Do not write a separate notification loop. Add reminder rows and let the ladder handle delivery.

---

## LLM / AI calls

**As of 3 August 2026: production makes zero network calls to OpenRouter.**
All text reasoning runs on the **subscription CLI plane** (Codex Luna/Terra,
Claude Sonnet/Opus, Grok) via `hub-model://`. VPS enqueues; Mac mini
`subscription-agent-worker` runs the CLIs. Process guard:
`lib/openrouter-guard.js` rejects `*.openrouter.ai`. Spec:
`docs/zero-openrouter-migration.md`. Agent entry: `AGENTS.md`, `CLAUDE.md`.

Do not re-add OpenRouter keys or use OpenRouter as a fallback when a CLI fails
— degrade closed. Do not call Anthropic/OpenAI/Google model APIs directly for
Hub text features.

### Making a model call
```js
// lib/feature-runners.js   feature → runner (luna/terra/grok/sonnet/opus/local)
// lib/model-request.js     requestModelObject / requestModelText
// lib/model-transport.js   CLI or remote Mac worker
// lib/fetch.js             hub-model:// + residual HTTP (never openrouter.ai)
// lib/settings.js          getSystemModelId(feature, userScope, fallbackModelId)
```

Attribution / task codes still live in `lib/openrouter-attribution.js` for
receipts and historical `request_logs` (`endpoint` may still say `openrouter`
for old rows). New work goes through the feature registry and model transport,
not a raw OpenRouter URL.

```js
// lib/openrouter-attribution.js — task codes for logging / governance
openRouterHeaders(taskCode, options)  // legacy name; subscription path still tags work
```
Adding a new feature → register in `feature-runners.js`, add a prompt/slot, and
pass a stable task code for receipts.

### Model selection
- User default: `crm_context` key `hub_default_model` (chat); background work is registry-led.
- System slots: every LLM call resolves through a named feature/slot (`SYSTEM_MODEL_GROUPS` in `routes/hub-admin.js`, prompts at `/admin/models/prompts`). Completeness is gated by `test/system-model-slots-complete.test.js`.
- Every slot's default prompt lives in `lib/prompts.js` (`PROMPTS`), overridable per-slot via `crm_context` key `hub_sys_prompt_<feature>`.
- Never hardcode a provider path around the subscription plane. Prefer `requestModelObject` + feature name.
- Runner map summary: Luna (classify/extract) · Terra (CRM stages) · Grok (research) · Sonnet (cross-entity, wiki) · Opus (rare briefs) · local (embeddings).

### Current runner orientation (not OpenRouter model ids)
| Family | Typical features |
|---|---|
| Luna | email_classifier, atom_extractor, crm_parser, agentmail, task extract |
| Terra | crm_source_triage, crm_duplicate_review, crm_action_projection, digests |
| Grok | content research, multi-search planning |
| Sonnet | cross_entity_synthesis, wiki, newsletter briefing, m365/us-block |
| Opus | nakai_daily_briefing, exceptional adjudication |
| Local | embeddings (Ollama qwen3-embedding), STT/TTS when configured |

Full map: `lib/feature-runners.js`. Admin UI is registry-aligned post-migration.

### Model style profiles
`lib/model-style-profiles.js` holds per-family prompt style profiles (claude/gpt/gemini/grok/open), distilled monthly by the `style_profile_run` job from production system prompts in github.com/asgeirtj/system_prompts_leaks. Stored as compiled knowledge in `crm_context` with receipts in `knowledge_receipts`. Consumers: the prompt tool's target-model selector and admin "Shape for model". Module contract: MODULES.md → Model Style Profiles.

---

## Embeddings & semantic search

```js
// lib/retrieval.js
embed(text, user)           // generate embedding via Mac Ollama (qwen3-embedding)
searchSimilar(query, user, filters)  // cosine similarity against embeddings table
```
If the local embedder is unavailable, calls fail closed (`EMBEDDINGS_UNAVAILABLE`);
do not fall back to OpenRouter. Historical vectors are preserved; backfill skips.
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

Shared infrastructure the stages all use now lives outside the engine file:
`lib/crm-receipts.js` (stage receipts; `currentSourceReceipt` finds the newest
receipt *for this exact revision*, which is not the same question as the newest
row) and `lib/crm-source-lease.js` (the token-scoped source-processing lease —
a stale worker's token can never finish or overwrite its replacement's lease).
Use these rather than reimplementing either inside a stage.

Scheduled via `crm_knowledge_engine` in `lib/job-queue.js`. The job reviews raw and intermediate source evidence, records prompt decisions in `knowledge_receipts`, merges provenance into existing atoms when the source confirms or supersedes known knowledge, and projects only high-confidence required actions into Google Tasks.

The engine does not consume the Hub's own governance/status report emails as evidence. The Daily Consigliere Report and Hub Daily Report are emailed to Douglas, land back in the inbox, and get summarised into `email_summaries`; feeding them back in is a loop where the Hub's own report about a low-confidence hunch becomes a projected task. `isCanonicalEvidenceExcluded` excludes mail from the Hub's own AgentMail address (`AGENTMAIL_INBOX_ID`) and mail whose subject, after repeated standard `Re:`/`Fw:`/`Fwd:` transport prefixes are removed, matches a Hub report prefix. This keeps forwarded M365 Operations & Security Briefs and Work Briefs (`work brief` is a retired Hub digest whose sender is Douglas's own address, not `AGENTMAIL_INBOX_ID`, so only the subject prefix catches it) stored/searchable without allowing their derived Watchlist language to create tasks; ordinary self-sent and forwarded commitments remain eligible. Admission receipts record the exclusion reason. (This boundary also closed the Alan Garland / Alec Hirst false-duplicate loop: a nightly near-name clarification from the CRM People Quality Board was reported by the Consigliere, re-ingested, and projected into an "investigate possible duplicate contact" task.)

This subject exclusion is a **provenance boundary, not the duplicate guard** — it says a Hub-generated report is not fresh evidence, and a per-subject deny-list will always miss the next un-listed source. Duplicate *suppression* is source-agnostic and lives at projection time: `openTaskDuplicateMatch` mirrors `closedTaskDuplicateMatch` but sweeps the whole **live-open** corpus (normalised-title exact match, then `open_task` embeddings), so the same action arriving from any second source — a forwarded briefing, a handover doc, a re-forwarded Work Brief, a later meeting — links to the task that already exists (`disposition existing_open_task`) instead of getting a fresh `stableActionKey` and a duplicate task. The embedding score cannot decide this on its own: the live path compares a bare candidate (title + evidence) against a stored task vector (title + notes), and measured on production this single-topic corpus's true duplicates land at ~0.52–0.62 while genuinely novel actions reach ~0.48 — overlapping bands. So the embedding is used only for **recall** (shortlist the most-similar live-open candidates above a low floor) and a `crm_duplicate_review` model call makes the precision decision "same concrete action?", keeping different people, sub-steps, and deliverables distinct (Alan must never merge with Alec). Adjudication is bounded to the top couple of candidates, and an action with nothing above the floor is treated as novel with no model call. It fails open at every layer — a wrongly-dropped task costs Douglas the thing he needed.

Historical message exports use a separate sealed raw store: `messaging_archive_buckets` plus `messaging_archive_messages`. A database trigger prevents additions after sealing. Project reports may read this immutable evidence by each message's original timestamp and selected report window. The `messaging_archive_release` job releases at most ten messages per Dublin day into `messaging_messages`; those releases follow the ordinary CRM prompt pipeline and retain `historical_backfill=true`, so old requests cannot create current tasks without newer evidence.

`/crm/knowledge` reports the latest receipt per source for these four stages, separating processed, skipped, warning, and error outcomes. It does not treat governance-agent receipts or historical superseded errors as current CRM failures. The operator can retry genuine current errors in bounded batches; retries re-enter the same prompt pipeline, retain the old receipts as audit evidence, avoid duplicating compiled synthesis, and write a newer outcome receipt.

Current CRM source kinds:

| Source kind | Meaning |
|---|---|
| `email_summary` | Gmail and AgentMail summaries from email ingest |
| `meeting_intake` | Meeting recordings/transcripts/summaries |
| `document` | Uploaded or Drive-derived documents |
| `open_task` | Current Google Tasks, used as operational evidence and duplicate context |
| `completed_task` | Completed tasks, eligible for durable synthesis |
| `crm_fact` | Existing curated facts, mostly legacy or manually entered context |
| `messaging_message` | Live messages plus bounded releases from sealed historical archives |

Prompt/model slots are visible in `/admin/models`: `crm_source_triage`, `crm_duplicate_review`, `crm_action_projection`, and `crm_action_resolution`. Receipts are visible in `/admin/knowledge`. These receipts are the audit trail for "what did the model decide, using what source, and why?"

WhatsApp/messaging sources stay one bubble each. Automatic selection holds a new `messaging_message` for five minutes so a reply can be captured first. Triage, duplicate review, and action projection then receive same-`chat_id` neighbours as prompt context only — never as the source text, so a later reply cannot change the revision hash. After projection, `crm_action_resolution` may complete an open task created from an earlier message in that chat when this turn clearly answers it. Uncertain resolutions stay in the action queue and do not mark the answering source incomplete. Historical backfill still cannot create or resolve live tasks.

Important rules:

- Ingest paths store faithful source evidence. They must not directly create `crm_facts`, `contact_projects`, `company_projects`, or Google Tasks as their normal output.
- `lib/email-processor.js`, `lib/agentmail-processor.js`, and `lib/meeting-intake.js` have a rollback switch only: `CRM_LEGACY_DIRECT_WRITES=1`. Do not use it as the normal architecture.
- Entity type is enforced at the database boundary: a normalized company name cannot be inserted or renamed into `contacts`. Company-shaped evidence must resolve to the existing `companies` identity. Explicit messaging routes may name a `subject_contact_name` separately from the sender so pronoun-heavy group evidence links to the intended compiled contact without conflating participants.
- Open tasks are operational state. They can inform triage and duplicate review, but durable knowledge should come from completed tasks or source evidence.
- If a new CRM feature needs to connect people, projects, companies, tasks, documents, or emails, add a source kind or synthesis/projection step. Do not add a direct table copy path.

### User feedback on atoms (6 Jul 2026)

Atoms can be disputed, marked stale, or restored from every surface that renders them (contact/company/project pages and the atom browser at `/crm/knowledge?browse=1`). The action sets `knowledge_atoms.status` and writes a `knowledge_receipts` row (`stage='user_feedback'`, payload carries the reason and previous status) — corrections enter the same evidence stream the engine already consumes. Engine run recency, latest per-source stage outcomes, and data-health badges (duplicate emails, orphaned facts, stale/disputed atoms) are compiled live from `knowledge_receipts`/`knowledge_atoms` on `/crm/knowledge`; manual controls process new sources or retry a bounded batch of current errors through the same engine.

### Manual project declarations (6 Jul 2026)

Project status/deadline/scope/milestones are NOT columns — they are `knowledge_atoms` with `derived_by='manual'`, `subject_kind='project'` (predicates `status`, `deadline`, `scope`, `milestone`). Declared knowledge lives in the compiled layer with provenance like derived knowledge. Health falls back to activity-derived (active <30d, quiet <90d, stale beyond) when no status atom exists. Endpoints: `/api/crm/project/:slug/meta`, `/api/crm/project/:slug/milestones`, `/api/crm/project-milestones/:id/:action`.

### Task priority/effort/planner tags (updated 9 Aug 2026)

Task priority, effort, planner lane, an optional after-dependency, and an optional assignee are structured tags in the Google Tasks notes field (`[priority: high] [effort: 30m] [planner: work] [after: cal:<eventId>] [assignee: Sarah Doyle]`), not columns — they round-trip through the Google API and stay visible in any Google client. `[planner: personal]` routes the task to evening/weekend windows; no planner tag means the task is excluded. `[after: cal:<eventId>]` (or a bare `[after: YYYY-MM-DDTHH:MM]`) is a planner dependency: an earliest-start floor resolved live from the linked calendar event's end time, so the constraint follows the meeting if it moves and lapses once the meeting is past. `[assignee: <name>]` marks a task whose doer is someone other than Douglas — set by hand on the task page or attributed by the CRM engine from an action's `owner`; it takes the task out of Douglas's planner (never scheduled, `getPlannerSnapshot` and `scheduleTask` both refuse it) and into the "Tasks assigned to others" section of `/crm/tasks`, kept raw (case + spaces) like `after`. Helpers `parseTaskTags`/`stripTaskTags`/`withTaskTags`/`withPlannerTag` in `lib/google-tasks.js`; `getCachedTasks` returns parsed `priority`/`effort_minutes`/`planner_lane`/`after`/`assignee` plus a tag-free `notes_preview` on every row. Task-to-meeting traceability is parsed from `source_id` (`meeting:<id>:…`), never stored twice.

### Meeting intake preview (6 Jul 2026)

Drafts can run "Preview extraction" (`previewMeetingIntake` in `lib/meeting-intake.js`): the extraction is stored in `extraction.preview` keyed by a hash of (transcript, title, date, project); submit reuses it when inputs are unchanged, so review costs no second model call. The extraction schema includes attendee `engagement`, meeting-level `risk_flags`/`decision_quality`/`urgency`/`confidence`, and per-action `blocked_by`/`success_criteria`, all flowing into the meeting markdown the engine reads.

### Scheduled project reports (6 Jul 2026)

`project_report_schedules` (agreed config table — user preference, not derivable knowledge) holds one row per project: cadence `weekly:<day>`/`monthly:<1-28>`, window days, optional recipient. The hourly `project_report_schedules` job (`lib/job-queue.js`) calls `runDueProjectReportSchedules` (exported on the `hub-crm` router), which reuses the evidence-to-report-to-PDF-to-AgentMail path with a 20-hour double-send guard. Managed from the schedule card on `/crm/project-report`.

### Knowledge retention

Knowledge never disappears; it only leaves the default line of sight. The weekly lint (`lib/knowledge-lint.js`) decays unconfirmed mutable facts after 180 days and marks them `stale` after 365 — but immutable predicates (`isImmutablePredicate`: date of birth, kinship) are exempt, stale atoms stay searchable in Ask the Hub and visible on entity pages via "show history", and any new source mentioning the fact revives it. Lint decisions land in `crm_context` (`knowledge_lint_last`) and the daily system report's KNOWLEDGE section, so nothing goes stale silently.

### Interest radar

`lib/interest-synthesis.js` (job `interest_synthesis_run`, daily 05:45) is the pattern for "the system joined the dots": recent meeting intakes + upcoming meetings/calendar → model names the topics Douglas is actively engaged with → `interest` atoms with provenance + a compiled cache (`crm_context` key `interest_radar`). To make a surface interest-aware, read `getInterestRadar(user)` — do not build a separate topic store.

### Agent team receipts

`lib/agent-receipts.js` writes accountable agent/team verdicts into `knowledge_receipts` instead of creating a parallel audit store. `lib/hub-agent-roster.js` defines the governance family: Consigliere, underbosses, capos, soldiers, and associates. `lib/hub-family-agents.js` writes capo receipts (`source_kind='hub_module'`, `stage='agent:capo:<key>'`) and underboss receipts (`source_kind='hub_underboss'`, e.g. `stage='agent:crm_underboss'`); `scripts/run-agent-family.js` runs capos, underbosses, then the Consigliere.

`lib/hub-consigliere-agent.js` is the boss-layer challenge agent (`source_kind='hub_governance'`, `source_id='boss_layer'`, `stage='agent:hub_consigliere'`): it checks source families for stale-only evidence and challenges subordinate agent receipts. `lib/daily-consigliere-report.js` is the daily human-intervention router (`source_kind='hub_governance'`, `source_id='daily_consigliere'`, `stage='agent:daily_consigliere_report'`): it turns unresolved failures, quality vetoes, and clarification requests into direct questions for Douglas, and records agent corrections when a later PASS resolves a prior WARN/FAIL. The scheduled 06:00 email is now Consigliere-led; ordinary Hub health is supporting detail underneath. `lib/consigliere-brief.js` is the consigliere's voice: the checks are deterministic, but the report *to Douglas* is judgment and writing, so a model pass (`consigliere_brief` admin slot, OpenRouter) reads the structured escalations and writes the plain-English "YOUR BRIEF" section at the top of the email — bucketed Needs you / I handled / Worth a glance / Running fine, with a recommended fix per problem tagged `you_decide | hub_action | needs_code` and a "Go here" line of clickable Hub links under each one. `lib/consigliere-links.js` resolves those links deterministically from the escalation payload — intake ids to `/crm/meeting-intake?intake=…`, contact ids to `/crm/contact/:id`, dangling project rows to the row that needs re-tagging — with the owning area page as the always-present fallback; the model is shown ref codes (`A1`, `A2`) and never a URL, so it cannot invent a link, and a slug the checks flagged as dangling is never linked. Refs are combined with the record names the model actually wrote in the prose, so a mis-assigned ref still lands on the right record. It promotes recurring runtime errors to needs-you even when they were absent from the formal ask list, suppresses circular governance self-references (`boss_layer` / `daily_consigliere` FAIL), and emits no UUIDs, raw JSON, or internal identifiers. A deterministic fallback renders a still-readable brief if the model is unavailable, so the email never breaks; the raw receipts stay in `knowledge_receipts` for drill-down. `lib/hub-quality-board.js` adds persona-style review boards with veto semantics: LinkedIn posts get `agent:linkedin_quality_board` receipts and active vetoes block scheduling/publishing — but the board is a checkpoint, not a wall: the score bar is per content type (each topic in the `content_topic_taxonomy` carries a `minScorePct`, default 70% == 3.5/5, set in `/admin/linkedin`; `getMinScoreForType()` resolves it), a vetoed post can be **regenerated in place** (`POST /api/content/posts/:id/regenerate` re-runs the pipeline on the same post so it can improve and be re-reviewed), and Douglas can **override** a veto to publish anyway (`POST .../override`, recorded on the post as `quality_override` + reason and in an `agent:linkedin_quality_override` receipt). `qualityVetoBlocks(user, postId)` is the single override-aware enforcement point used by every schedule/publish/PDF path in both the content UI and admin. Hub capos and underbosses get `agent:quality_board:*` receipts after the family audit. CRM also has subordinate boards for `crm:people`, `crm:meeting_intake`, `crm:tasks`, and `crm:project_context`; these surface clarification requests such as project-scoped Rob/Robert duplicate candidates, Trina/Triona-style audio ambiguities, unknown meeting-action owners, and unresolved project references without automatically merging or rewriting source data. `lib/crm-clarifications.js` is the answer side of those boards, and `/crm/questions` is its surface: until it existed the boards could only ask, so the same question was re-asked every night forever and the daily brief could only link at the transcript that raised it. Each flagged item gets a stable `clarificationKey` (a hash of the intake/owner/contact pair it came from, so it survives nightly re-runs); answering writes the raw declaration to `crm_clarification_answers` and projects it into `knowledge_atoms` (`derived_by='manual'`, confidence 1.0, `source_refs` back to the flagged row) — a meeting question becomes a `decision` atom on its project, an unowned action becomes an `open_commitment` atom on a contact that is created or linked on the spot (the transcript's name is kept as an alias so the next transcript resolves it), and an alias clash becomes `distinct_from`/`same_person_as` with the option to drop the colliding alias. The boards then skip answered keys, and `taskActionIssues` also skips any action whose spoken owner now resolves to a known contact name or alias, so naming a speaker once clears every action that speaker owns. Merging two contact records is deliberately not automated; the UI says so rather than implying it happened. Nakai's daily briefing is explicitly excluded from this quality-board scope because that workflow is currently finely tuned. `lib/hub-remediation.js` is the catch-and-correct layer that closes the loop between detection and escalation: after a failure is detected it tries to FIX it before anything reaches Douglas. Fixers are restricted to a whitelist of reversible, idempotent actions (re-enqueue an existing job type or a backfill via `scheduleJob`) keyed by check name; they never run shell, delete, or write domain data. Each attempt writes a receipt (`source_kind='hub_remediation'`, `stage='agent:remediation:<capo>'`) with status `pass` (fixed and re-verified this cycle), `warn` (retry dispatched, verifies next cycle), or `fail` (no safe fix / escalating). Sync fixers (a missing pending job) are re-verified immediately; deferred fixers (backfills, retries of a failed job) verify on the next audit cycle. A repeat-dispatch guard (`MAX_DISPATCHES=2` over three days) escalates to Douglas once a retry has been dispatched to the limit without clearing, so a stuck failure is never masked as "retrying" forever. For a failing check with no deterministic fixer, an optional model advisor (`remediation_advisor` slot, OpenRouter, admin-selectable) may pick a job from the same whitelist or decline — it can never widen the blast radius. The nightly flow is remediate-then-audit-once (`lib/system-report.js`): self-heal first so capo receipts reflect post-fix reality, then only the irreducible becomes an Ask-Douglas item; a SELF-HEALING report section records what the agents did. Run manually with `scripts/run-remediation.js` (`--no-model` to skip the advisor). Token burn uses `lib/token-burn-auditor.js` (`source_kind='token_burn'`, `source_id='dashboard'`, `stage='agent:token_burn_auditor'`) to check generated burn JSON, freshness, OpenRouter export/live summaries, and Hub request-log visibility. A fresh `openrouter-live.summary.json` from `OPENROUTER_MANAGEMENT_KEY` supersedes a stale legacy CSV export. LinkedIn uses `lib/linkedin-agent-team.js` with `source_kind='linkedin_post'` to record research, draft/critic, artifact/PDF, managing-editor, and publishing-archivist checks for each post. The daily report includes a compact Agent Teams section from these receipts.

The daily email's shape (`lib/system-report.js` → `sendSystemReport()`) is: header, **TODAY** (`lib/daily-narrative.js`, `daily_narrative` admin slot — a short plain-English account of what actually came in that day, grounded in `email_summaries`/`knowledge_atoms`/`meeting_intakes`/`documents` since the last run, not a row count; falls back to a grouped-counts sentence if the model is unavailable), **NEEDS YOU** (the Consigliere brief above), **MODULE HEALTH** (short pulse-check), **HARD TO PLACE** (`hardToPlaceSection` — content the Hub captured but could not confidently file: unlinked emails, unfiled documents, CRM knowledge rows stuck in review/error, AgentMail needing review; distinct from Needs You, which is a decision, and from Module Health, which is a broken check), **SELF-REPAIRS** (`selfRepairsSection` — remediation's automatic VPS-side fixes plus the self-repair venue's activity, bridged in from the Mac mini via a rollup file described below), **USAGE WATCH** (`usageWatchSection` — now that model work runs on subscriptions rather than metered OpenRouter spend, this is an anomaly-only line, "NEEDS YOU — codex failed 97%" or "Usage normal", with the full per-runner breakdown one link away at `/token-burn` rather than a table in every email), ACTIVITY SUMMARY (the raw counts, kept below the fold as a sanity check against TODAY's prose rather than the headline), and MORE DETAIL (one link per raw section — ingest, effects, knowledge coverage, error log — since anything in them that needed Douglas is already promoted into NEEDS YOU or HARD TO PLACE). The self-repair venue runs on the Mac mini against a snapshot and cannot write to this DB's `knowledge_receipts`, so `run-repair.js` pushes a small `{generated_at, entries}` JSON rollup to the VPS (`scp` to `/app/data/repair-rollup.json`, independent of whether a deploy also happened) after every run; `selfRepairRollup()` reads it back and treats anything older than 48h as no activity rather than stale news.

Quality-board completion checks read the stage marker rather than infer success from output volume: document task review is complete when `documents.task_extracted_at` is set, including a valid zero-task result, and generated project-memory documents are excluded. Placeholder-speaker mapping remains a pre-processing gate for new meeting intake; the board does not reopen already-processed legacy transcripts that no longer have an editable mapping step. When a current check passes after its latest remediation receipt was WARN/FAIL, remediation writes one explicit PASS recovery receipt so the daily router stops carrying the old failure forward.

One rung above remediation sits the **self-repair venue** — a Mac-mini-only standalone process (never imported by `server.js`, never run on the VPS) that handles the `needs_code` tier remediation cannot touch. Nightly at 04:30 (launchd, after the 04:00 prod-snapshot refresh) `scripts/run-repair.js` mines the snapshot's `system_jobs.error`, `processing_failures`, and `hub.service.log` into reproducer packages (`lib/repair-reproducer.js`), triages them (`lib/repair-triage.js`: fixable-narrow / config_fix / escalate / skip — model garbage is a model-slot email, never a code guard), and for fixable-narrow errors runs the locally authenticated Grok CLI (`scripts/repair/grok-runner.mjs`) in a throwaway git worktree with file tools only. A four-gate harness (`lib/repair-check-harness.js`) accepts a fix only when it proves correct behaviour — reproduction before, Grok's own regression test after, full suite, snapshot flow where deterministic. Output is a `repair/<id>` branch + GitHub PR + summary email to Douglas; by default deploys stay human (`scripts/deploy.sh` after PR review). Guards mirror remediation: 3 attempts, 5-minute timeout, 12-turn CLI cap, ≤3 changed files, 7-day re-attempt window, recurrence escalates. The subscription CLI returns final token cost only after a session ends, so receipts preserve that measurement but cannot use the prior real-time $2 brake; triage remains attributed through `AT-RepairTriage`. Kill switch: off unless `REPAIR_VENUE_ENABLED=1` or prod `crm_context` `repair_venue_enabled`='1'. See MODULES.md → Self-Repair Venue.

A separate flag (`REPAIR_VENUE_AUTODEPLOY=1` or prod `crm_context` `repair_venue_autodeploy_enabled`='1') turns on unattended deploy for the same fixable-narrow reproducers: once all four gates pass, `autoDeployAndVerify()` (`lib/repair-venue.js`) merges the PR itself (`gh pr merge --squash`), brings the Mac mini's own `main` checkout up to date, and runs `scripts/deploy.sh` — the same script and the same path a human would use, just invoked automatically. It captures the VPS's `/app/.deployed-revision` before deploying, then polls `systemctl is-active hub` after (`HEALTH_CHECK_DELAY_MS` + up to `HEALTH_CHECK_RETRIES` checks); if the service doesn't come back healthy it `git revert`s the merge commit, pushes, and redeploys the prior state automatically. Every step (no previous revision available, merge failure, deploy failure, unhealthy-and-reverted, unhealthy-and-revert-failed) sends its own distinct email and receipt — nothing here is allowed to fail silently or read as routine when it isn't. The judgment filter stays triage + the verification gates, exactly as for the PR-only path; auto-deploy only removes the wait for a human to click merge on a fix that was never a judgment call. There is deliberately no separate daily deploy cap — the guardrail is the existing per-bug attempt/time budget. This flag applies only to this venue's own mined-and-verified reproducers, never to a fix from an ad hoc review/conversation (those still go through a normal human-reviewed PR).

Underneath all of this sits the **agent-level self-check** for model JSON calls (`lib/model-request.js`): every background feature that expects a JSON object from a model goes through `requestModelObject()` — one shared path that validates shape via `parseModelObject`, retries once with a corrective instruction and backoff (the email classifier gets three attempts), and records the truth of each attempt in `request_logs.status`: `ok`, `retried` (rescued by the retry), or `shape_failure`. This closes the operating model's silent-success gap at the soldier level: before it, a retry that rescued a bad response logged `ok` and a degrading model slot was invisible until jobs crashed. The `model_governance` capo's `model_response_shape_health` check reads these statuses and FAILS any slot over a 10% bad-shape rate (min 10 calls/24h), which remediation escalates as a config ask — change the slot in `/admin/models/system` — before anything breaks. `lib/linkedin-pipeline.js` keeps its own transport (different-model fallback, reasoning-content handling) but logs the same statuses after its parse.

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
| 06:40 | Release up to 10 messages from sealed historical archive |
| 06:45 | CRM calendar sync |
| 07:00 | RH stats email |
| 07:30 | Nakai daily briefing |
| 08:00 | Regulatory monitor (if `REG_MONITOR_ENABLED=1`) |
| 09:30 | RSS feed ingest |
| 06:00 | Daily Consigliere / system report |
| 14:00 Sun | Weekly digest |


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
| Subscription CLIs (Mac worker) | All text LLM (Luna/Terra/Grok/Sonnet/Opus) | Mac CLI logins + worker secret | lib/feature-runners.js + lib/subscription-agent-jobs.js |
| Ollama (Mac) | Embeddings | local Ollama | lib/retrieval.js |
| OpenRouter | **Retired in production (3 Aug 2026)** — do not re-enable | — | lib/openrouter-guard.js blocks |
| Gmail API | Inbound/outbound email | OAuth2 refresh token | lib/gmail.js |
| AgentMail | External email address | `AGENTMAIL_API_KEY` | lib/agentmail.js |
| Google Drive | Document fetch | OAuth2 refresh token | lib/google-drive.js |
| Google Calendar | Events | OAuth2 refresh token | googleapis client |
| Google Tasks | Task creation | OAuth2 refresh token | lib/google-tasks.js |
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
| `suggestions` | Compiled action-suggestion candidates (domain, title, body, status) |
| `suggestion_feedback` | Scored human outcomes used to calibrate later suggestion synthesis |
| `suggestion_lessons` | Explicit reusable rules derived only from explained Wrong outcomes |
| `messages` | Chat history per user/project |
| `contacts` / `companies` | CRM entities |
| `crm_facts` | Curated facts (source for atom derivation) |
| `documents` | Uploaded files (markdown content) |
| `rss_articles` | Ingested feed articles |
| `flight_records` | Parsed flights from email |
| `nl_briefings` | Newsletter/Nakai briefing editions |
| `request_logs` | LLM usage per session |
