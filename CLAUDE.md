# McLellan Hub — Project Instructions for Claude

## What this project is

A personal AI workspace for Douglas McLellan. It connects email, calendar, contacts, tasks, flights, documents, and regulatory monitoring into a single system that surfaces actions and intelligence without Douglas having to remember to look. The design principle is that the system should grow paths between its own data nodes — like a fungal network — so that information added in one place is automatically useful in others.

Douglas has ADHD. The system should surface everything it can automatically, without requiring Douglas to trigger it manually. When in doubt, do the work.

## Knowledge-first development constraint

Before implementing anything, the default question is not "what table do I add this to?" The default question is: **what does the system already know, and how does this connect to it?**

The Hub's ambition is a second brain: ingested content such as emails, documents, care plans, debrief recordings, notes, and photos should produce emergent knowledge, not just rows. The CRM is a label for the relationship layer, not an instruction to build an Access database.

Before writing code, answer:

- Does this require new storage, or better synthesis of existing storage? A contact address mentioned in three care plan documents does not need a new addresses table; it needs a process that reads those documents and surfaces the connection.
- Is this a fact to store, or a relationship to recognise? Facts go stale. Relationships derived from existing sources stay current as the sources update. Prefer derivation over duplication.
- If this is built as a database row, what happens when context changes? A row written today about "Dad's address" is frozen. A wiki page or synthesis job that re-reads the care plans every night is alive.
- What is the ingest-to-knowledge cycle? Raw content enters, an LLM synthesises it into a structured knowledge layer, and queries run against the knowledge layer. Storing raw content and querying it directly skips the middle step.
- Are tasks, people, facts, and documents being treated as the same underlying reality, differently labelled? A task called "get Dad's medicine" is about Alister McLellan, which connects to his care plans, which mention his GP, which is a contact. The system should traverse these connections because a synthesis pass compiled the knowledge into something the query layer can read.

Implementation rules:

- If you find yourself creating a new column to link two things that are already mentioned in ingested documents, stop. Write a synthesis job instead.
- If you find yourself hardcoding a relationship, such as contact A is related to contact B, stop. Write a rule the LLM can apply to find that relationship from first principles.
- New database tables are justified only for raw ingestion the system has not seen before, or for a compiled knowledge cache that is the output of a synthesis job. They are not justified for manually-maintained structured data the LLM could derive.
- When Douglas says "I want X connected to Y," the implementation is a synthesis or review job, not a schema change.
- The daily/nightly review job is the mechanism for emergence. If a feature requires a human to manually maintain a link, the feature is incomplete.

The Hub ingests raw life. A synthesis layer, with LLM jobs running on schedule, compiles that raw life into a knowledge base. The CRM, wiki, task list, and project notes are all views into that knowledge base. The work is to build better synthesis, not better storage.

### Input contract

Before adding or changing any input path, read `docs/hub-input-contract.md`. Every input must name its raw store, synthesis path, compiled layer, and visible surface. A raw capture path without synthesis is only an archive; a direct table write without receipts or provenance is not the long-term architecture.

### Two boundaries that must stay boundaries

As of 3 August 2026 the Hub has one door in and one attributed path out. Both
exist because of failures where a module reported success and the loss only
became visible when Douglas noticed it himself.

**The ingest door** (`lib/source-admission.js`). Every capture path calls
`admitSource` immediately after writing its raw row, and the completeness
verdict is recorded against the ingester that captured it. A source that cannot
be read is a visible failure belonging to a named module, reported in the daily
INGEST section — not something to be inferred three stages later from a task
that never appeared. Adding an ingest path means calling this. Admission never
gates capture and never decides meaning.

**The effect gate** (`lib/effect-gate.js`, inside `google-tasks.js`
`createTask`). Reading fans out; writing does not. Every task carries a declared
`origin`, so "why did this task appear?" has one answer in one place. Pass
`origin` when you add a call site. Do not add a second task-creation path that
bypasses `createTask`, and do not turn the gate into a blocker — a wrong
refusal costs Douglas a task he needed.

When a module misbehaves, the goal is that it can be named and fixed on its
own. If fixing one reader requires editing the engine, the ingesters and the
task layer together, that is the bug, not the fix.

### Model plane — zero OpenRouter (as of 3 August 2026)

**Production Hub makes zero network calls to OpenRouter.** Do not reintroduce
`OPENROUTER_API_KEY`, direct `openrouter.ai` fetches, or OpenRouter as a
fallback when a subscription CLI fails. Full write-up:
`docs/zero-openrouter-migration.md`.

What shipped (commits through `4fbb397` / related follow-ups):

| Layer | Role |
|-------|------|
| `lib/openrouter-guard.js` | Process-level block of `*.openrouter.ai` (installed at boot) |
| `lib/fetch.js` + `hub-model://` | Routes model work to the subscription transport |
| `lib/feature-runners.js` | Feature → runner registry (task family first, difficulty second) |
| `lib/model-transport.js` / `model-request.js` / `chat-completions.js` | CLI or remote Mac worker |
| `lib/subscription-agent-jobs.js` + `scripts/subscription-agent-worker.js` | VPS enqueues; Mac mini pulls one job at a time (KeepAlive worker) |
| Ollama on Mac (`qwen3-embedding`) | Embeddings / semantic retrieval — not OpenRouter |

**Runner map (summary):** Luna (email classifier, CRM parse/extract, atoms) ·
Terra (CRM triage / duplicate / action projection, meetings, digests) ·
Grok CLI (content research, multi-search) · Sonnet (cross-entity, wiki,
LinkedIn synthesis, m365/us-block) · Opus (nakai briefing, rare adjudication) ·
local (embeddings; STT/TTS when configured).

**Operational rules for agents:**

- Route new model work through the feature registry and `requestModelObject` /
  subscription plane — never invent a second billing path.
- VPS is the app; **Mac mini runs the CLIs**. If classification or CRM jobs
  stall, check the Mac subscription worker health before assuming code is dead.
- Grok headless invoke uses `--single` (not `--print`) in the subscription
  agent path (`lib/subscription-agent.js`).
- Mac pull-workers have their own rate-limit ceiling; do not tighten the generic
  limiter in a way that starves them.
- Cross-entity synthesis is **Sonnet**, bounded (~80 recent atoms), change-
  driven, fail-closed — not Luna over the full corpus.
- Admin models / chat routing is **registry-led** post-migration; keep UI and
  `feature-runners` aligned.
- When embeddings are unavailable, fail closed (`EMBEDDINGS_UNAVAILABLE`); do
  not fall back to OpenRouter. Historical vectors stay; backfill skips.
- Email: `email_process` every ~15 minutes re-fetches `processing_failures`
  and rows with `ingestion_status` in (`captured`, `retry`). Unlabelled
  “pending training” mail is different — it waits for a Gmail label, not a
  re-classify.

**Do not** bump CRM pipeline versions or re-queue the historical corpus without
Douglas explicitly accepting the cost. Auto-process window:
`CRM_KNOWLEDGE_AUTO_PROCESS_AFTER` (new evidence only after the 3 Aug freeze).

### CRM prompt operating system

As of 27 June 2026, the CRM-bound ingest path is explicitly prompt-led:

```text
raw source -> crm_source_triage -> crm_duplicate_review -> synthesis/provenance merge -> crm_action_projection -> compiled atoms/events/tasks
```

WhatsApp/messaging is still one source per bubble. Automatic selection holds a new message for five minutes; triage and projection then see same-chat neighbours as context so an already-answered question is not an outstanding action. After projection, `crm_action_resolution` may complete an earlier same-chat task when this turn clearly answers it. Do not add a message-link table.

The implementation lives in `lib/crm-knowledge-engine.js` and runs through the `crm_knowledge_engine` job. It reads evidence from email summaries, AgentMail records, meeting intake, documents, CRM facts, and Google Tasks; it writes model decision receipts to `knowledge_receipts`; it projects only high-confidence actions into Google Tasks.

Hub-generated briefings and governance reports are derived views, not fresh CRM evidence. `isCanonicalEvidenceExcluded` keeps them stored and searchable but outside triage and action projection. It strips repeated standard `Re:`/`Fw:`/`Fwd:` transport prefixes before matching known Hub report subjects (M365 Operations & Security Brief, Work Brief, …), so forwarding one between Douglas's accounts cannot turn its Watchlist back into tasks. Do not broaden this into a blanket self-mail exclusion: ordinary sent or forwarded commitments remain canonical evidence. Admission receipts record the exclusion reason. **This subject list is a provenance boundary, not the duplicate guard** — never treat "add another subject prefix" as the way to stop duplicates. Deduplication is source-agnostic and enforced at projection: `openTaskDuplicateMatch` (the mirror of `closedTaskDuplicateMatch`) sweeps the whole live-open task corpus by normalised title, then uses `open_task` embeddings only as a recall shortlist (real query-vs-stored scores overlap between true dups ~0.52–0.62 and novel ~0.48, so the score cannot decide) and lets a bounded `crm_duplicate_review` model call make the precision decision, keeping distinct people/steps/deliverables apart (Alan ≠ Alec) and failing open. So the same action from any second source links to the existing task rather than creating a duplicate — no per-source list required. An exact `crm-action:<actionKey>` task is not part of that cross-source decision: it is reconciled through the action outbox first so pending calendar work and ambiguity state can advance safely.

Suggestion review is also evidence: Create task, Not this time, Dismiss, and Wrong are stored as descending implicit quality signals for later suggestion synthesis. Only Wrong is a hard correction and invokes the explained rule learner. A positive score teaches transferable qualities; it never authorises repeating or paraphrasing the same concrete action. Opportunity source IDs and semantic review against authoritative task history must block those repeats. Do not turn the outcomes into manual relationship rows or title-only blocklists.

`/crm/knowledge` is the operator surface for this pipeline. Its health panel must derive current state from the latest receipt per source and CRM stage, classify skipped/warning/error outcomes separately, and exclude unrelated governance-agent receipts. Historical errors remain immutable audit evidence. Retry actions must be bounded and must send the original raw source back through the prompt-led pipeline; never delete receipts or write replacement atoms directly.

Do not reintroduce old direct CRM write paths. Gmail, AgentMail, and meeting intake should store source evidence and let the CRM knowledge engine decide whether something is knowledge, a duplicate, a supersession, or an action. `CRM_LEGACY_DIRECT_WRITES=1` exists only as a temporary rollback switch, not as a design pattern.

Person identity at meeting ingest is resolved, not exact-matched. `lib/entity-resolution.js` (`resolveMeetingEntities`, feature `entity_resolution`) links spoken/transcribed names to existing contacts as the transcript comes in — deterministic exact/alias pass, then a bounded fail-closed model adjudication scoped to the meeting's people. A confident match rewrites `matched_contact` and is learned as a durable **alias** (the store is `contacts.aliases`, not a new table), so corrections stick and the next transcript is a free match; auto-learned aliases are receipted (`stage='entity_resolution'`) for a future correction pass. A bare first name is only persisted as an alias when unique across the CRM (two possible "Nick"s resolve per-meeting, never freeze). Human answers on `/crm/questions` also learn aliases (`learnAliasFromMeetingAnswer`). **Alias invariant (`aliasCollidesWithOtherContact`, enforced in `learnAlias` for every caller):** an alias is an alternate name for the *same* person (Dad = Alister); a name that already denotes a *different* contact can never be an alias of someone else — "Nick" is not an alias of Duncan Sackfield while Nick Chin exists (that is a CRM failure from a narrow read of one sentence, not a nickname). A transcript error between two known people (Alec/Alan) stays a per-transcript resolution, never a frozen alias. `scripts/repair-bad-aliases.js` removes existing colliding aliases and reverts the links they froze. Do not reintroduce exact-string-only linking, add a person-alias table, or surface a model's "not in the known CRM" warning as an answerable question once the name resolves. `scripts/repair-entity-resolution.js` re-links frozen extractions deterministically (no model calls, no corpus re-queue).

Meeting attribution is corrected after projection as well as resolved at ingest. `lib/attribution-reconciliation.js` (job/feature `attribution_reconciliation`) gives the **complete transcript** plus its extracted attendees/actions/facts, compiled atoms, action outcomes, and linked task assignees to the explicit `gpt-5.6-terra` runner. The scheduler scans regularly but its semantic state hash excludes routine sync timestamps, so Terra runs only for a new meeting revision or a meaningful attribution/link change; a pass that changes anything gets one stabilization reread so related compiled copies the first response omitted are not silently left behind. Exact-quote-backed missing links may apply at ≥0.97; quote-backed unlinks of a compiled fact that is not about the linked person may apply at ≥0.97; changes to an existing person or participant status require ≥0.995. `/crm/questions` only gets person-decidable leftovers (scheduled-attendee conflicts, person-vs-person owner changes below the auto threshold, action/attendee ambiguity, task-owner conflicts). Organisational facts wrongly hanging off a speaker are corrected or dropped, not dumped as questions. Human confirmations are source-specific attribution precedent and never aliases. Corrections rewrite the frozen extraction and affected meeting provenance/atoms; open Google Task assignees move only through the existing `crm_action_outcomes` action outbox and `updateTask` effect gate. Do not add a correction-link table, a second task writer, or let recurring scans spend a model call on unchanged state.

Company identity is a hard database invariant: a normalized name already present in `companies` cannot be created or renamed as a `contacts` row. Resolve that evidence to the company identity. For explicitly routed group messages, keep the message sender (`contact_name`) distinct from the person the group is about (`subject_contact_name`).

Project routing is content-first: an email's project is decided by what it is about, not by who sent it. The sender domain only establishes whose world the mail belongs to; it must never pick the specific project, and mail is only ever filed into a live project (see `resolveProjectSlug` and `TERMINAL_PROJECT_STATUSES` in ARCHITECTURE.md). "Project is dead" is one concept — any terminal status word (closed, completed, ended, …) must behave identically everywhere; never add a filter that keys off a single literal like `'closed'`.

Quality checks must test completion markers, not output counts: document task review is proven by `documents.task_extracted_at`, even when the review correctly creates zero tasks. Generated project-memory documents are not task inputs. Placeholder speakers block new meeting intake before processing; do not reopen speaker mapping on processed legacy transcripts that no longer have an editable mapping step.

When changing CRM behavior, update `ARCHITECTURE.md`, this file, and any affected docs so future agents see the prompt operating system before they see the tables.

## The most important rules

**Rule 1: Naming something is not building it.**

The flight tracker was built, given an API key, and declared complete. It was not a tracker — it was a flight log with a manual backfill button. Live tracking (booking → departure → arrival with real times) was the obvious core purpose implied by the name. It was never built. When Douglas asked how tracking worked, the honest answer was "it doesn't." Instead, live tracking was suggested as if it were a new idea, when it was the missing piece that should have been there from day one.

Before naming a module and calling it done, ask: **does it actually do the thing the name says?** If a module is called a tracker, it must track. If it is called a processor, it must process. If the core capability isn't there, say so — don't declare completion and wait for Douglas to discover the gap by asking a direct question.

**Rule 2: Adding something is not the same as it working.**

When you add an API key, a new job, a column, or a connection between modules — verify real data is flowing through it. Not just that the code runs. That the output is correct.

Examples of this going wrong:
- The AeroDataBox API key was configured. The field name `actualTime` was wrong — it should have been `revisedTime`. Every flight appeared tracked. No actual times were ever stored. Silent until Douglas looked at the UI and noticed the gap.
- The `shouldExtract` flag for agentmail trusted senders was wrong. The processor ran successfully every 15 minutes. Nothing useful happened.

Before marking any integration complete, answer: **what does working actually look like, and have I seen it?**

**Rule 3: Test with fake data at build time, not real data weeks later.**

Every feature must be exercised with a synthetic test before it is called done — a fake Ryanair booking email, a fake document upload, a fake flight record, a direct API call with the actual response inspected. This is the only way to know the full path works at the moment it is built, not two weeks later when Douglas notices something is missing. The test does not need to be automated or kept. It just needs to happen before the session ends. Log what was tested and what the result was in the commit message or in a comment to Douglas.

## Rules for adding new features

**1. Define the core capability before writing code.**
One sentence: what does this feature actually do, end to end, when working? If the name implies a capability (tracker, processor, monitor), that capability must be present on day one. If it isn't, name it accurately or be explicit about what's missing.

**2. Verify the full path, not just the node.**
If you add a job that polls an API and stores data, check the DB actually has the data after it runs. If you add a connection between two modules, check that a real input produces a real output end-to-end. Don't stop at "the code looks right."

**3. When adding an API key or external service, immediately test it.**
Run a real call. Look at the raw response. Verify your field names match what the API actually returns. AeroDataBox returns `revisedTime`, not `actualTime`. You only know this by looking at the response.

**4. Connections between nodes matter more than the nodes themselves.**
The system has good individual modules. What makes it valuable is the paths between them. When adding to any module, ask: does this connect to anything else? Should it? A flight booking arriving by email should become a task, a calendar check, and a live tracking job automatically — not three separate features added months apart.

**5. Don't leave silent failures.**
If a job fails or produces no output when it should have, that must be visible somewhere. Log it. Put it in the daily system report. Add a health check. Silent success that is actually failure is the most dangerous state the system can be in.

**6. Check MODULES.md before touching a module.**
Each module has a defined purpose and a definition of healthy. Read it before adding to the module. If what you're adding changes the purpose, update the contract first and confirm with Douglas.

## Deployment rules

- Local, VPS (`root@178.104.235.142`, app at `/app/`), and GitHub must all be in sync after every agreed change.
- Backups, cron, and env files must never live inside `/app/`. rsync always uses `.rsync-exclude`.
- DB is SQLite at `/app/data/hub.db`. Never modify production DB directly unless diagnosing — use migrations in `lib/db.js`.
- **The only permitted deploy path is `scripts/deploy.sh`.** Never rsync to the VPS manually or edit files on the VPS directly. The deploy script pushes to GitHub first, then rsyncs — this is the only way to guarantee all three stay in sync. The one exception is the self-repair venue's auto-deploy path (`lib/repair-venue.js`, `autoDeployAndVerify`, gated behind `REPAIR_VENUE_AUTODEPLOY`/`repair_venue_autodeploy_enabled` — see ARCHITECTURE.md → self-repair venue, or the module's own header comment): it still calls `scripts/deploy.sh` itself, never bypasses it, and only ever runs against a reproducer that already passed triage (no judgment needed) and every verification gate. An agent working outside that venue must never invoke `scripts/deploy.sh` unattended.
- **Start every session by running `scripts/sync-check.sh`** to confirm local, GitHub, and VPS are all on the same commit. If they are not, resolve the drift before writing any code.
- Production-only data bugs must use the diagnostic snapshot loop before code changes — not "when feasible", always. The steps are: (1) run `scripts/pull-prod-snapshot.sh` to pull the live DB and recent logs locally, (2) run `scripts/run-with-prod-snapshot.sh` to start Hub against the real data, (3) reproduce the actual error with the actual bad rows, (4) fix the code, (5) verify the fix against the snapshot, (6) commit, push, deploy, (7) repair the already-bad production rows that the fix does not retroactively correct. Do not guess at what the data looks like. Do not declare a bug fixed until step 7 is done — fixing the process without fixing the existing bad data has not helped Douglas today.

## What not to do

- Do not add features without Douglas agreeing to them first.
- Do not substitute a safer or simpler version of what was asked. Flag risk in one sentence, then build what was asked.
- Do not add comments explaining what the code does — only comments explaining why something non-obvious is done.
- Do not write code that looks like it works without verifying it does.

**Rule 4: Diagnose the instance, not just the process.**

When Douglas reports that something didn't happen — tasks not created, times not populated, data missing — fix the actual missing data first, then fix the process that caused it. "The 24-hour window excluded your document" is a diagnosis. It is not a fix. The document still has no tasks. Check the DB, run the backfill, and confirm the data is there before declaring the problem resolved. A fix that only prevents the issue next time has not helped Douglas today.

If the missing or bad data only exists in production, first pull a controlled production diagnostic snapshot, reproduce locally, fix locally, commit, push, deploy, then run any deliberate production repair if needed. A backup in Google Drive is not the same thing as a local diagnostic snapshot the app can run against.

## Task calendar planner (8 August 2026)

`/crm/planner` is a derived operational view over the existing Google Tasks mirror and live Google Calendar. Do not add a planner task table or turn a calendar placement into relationship knowledge. A task opts in through its Google-visible notes tag (`[planner: work]` or `[planner: personal]`); absence of the tag means it is not in the planner. New tasks created through `createTask` default to `[effort: 30m]`. A task whose doer is someone other than Douglas carries a Google-visible `[assignee: <name>]` notes tag — set by hand via "Assign to someone else" on the task page, or attributed by the CRM action projection from an action's `owner` (a named non-Douglas owner lands directly in the assigned list; do not re-drop those actions upstream). An assigned task is captured and tracked in the "Tasks assigned to others" section at the bottom of `/crm/tasks` but is never scheduled: `getPlannerSnapshot` and `scheduleTask` both refuse it, and assigning a task clears any existing planner lane and removes its calendar block. Keep this a derived notes tag — do not add an assignee column or a task-owner table. User scheduling windows are JSON preferences in `crm_context.task_planner_preferences`: work is Monday–Friday inside work hours, while personal tasks use weekday evening or weekend hours. `lib/task-calendar-planner.js` creates one Google Calendar event per scheduled task with private `hubTaskId` provenance and mirrors it into `meetings` with `source='task_planner'`; moves patch it, deselecting/unscheduling removes only the event. Auto-plan is always an explicit user action for previously unscheduled tasks. Reshuffle (`reshufflePlannerTasks`) is a second explicit action for already-scheduled tasks only: it clears finished blocks, then `computeReshuffle` **rescues any block whose slot has already passed** — a block sitting on an earlier day, or on today but already ended — moving it *forward* into the earliest free permitted slot at or after the moment reshuffle runs (higher-priority overdue work claims the earliest slot first). Blocks that still sit in the future are left exactly where they are; reshuffle only rescues the past, it never re-packs future blocks earlier. Reshuffle is self-anchoring — it always reaches back ~14 days to collect stranded blocks and forward ~14 days to re-home them, regardless of the week the user is viewing; do **not** pass the visible page range into it (a range starting at today never fetched past-day blocks — that was the original bug). Do not make it place inbox tasks (that is Auto-plan). (Earlier design pulled future blocks *earlier* to compact gaps; that was removed 18 Aug 2026 — the 5-minute reconcile still fills conflict gaps forward, but reshuffle no longer compacts future blocks.) Existing scheduled blocks are the narrow exception for automation: every five minutes, live Calendar reconciliation keeps genuine appointments fixed, patches conflicting tasks forward through the next 28 days (cascading later blocks only as needed), and removes the block of any task that is no longer open (`cleanupCompletedPlannerBlocks`) so finished time reopens on its own. It never auto-selects, initially places, or pulls a task earlier. Clicking/tapping a task block opens `/crm/tasks/<id>`; the late `!` marker is derived live, so changing the due date there clears it on the next load. Drag-to-move and resize use Pointer Events (not native HTML5 drag-and-drop, which fails inside the calendar's `overflow:auto` scroller). A task can depend on a meeting via an `[after: cal:<eventId>]` notes tag (set through the "Only after" picker on the task page): `resolveTaskFloor` derives an earliest-start floor from the linked event's live end time, and auto-plan, reshuffle, and both client- and server-side drag validation refuse to place the task before it. Keep this a derived floor tied to the live event — do not freeze the meeting time into the task or add a dependency table. Due date and priority order work, but the due date is not a hard scheduling limit. If no permitted slot remains by that date, carry the task into the next free permitted slot and render it with the late `!` marker. Preserve reconciliation by private task ID before insert and after ambiguous provider errors so retry cannot duplicate a time block.

A task can carry a **start date** ("not before") as a Google-visible `[start: YYYY-MM-DD]` notes tag, set from the "Start date" picker on the task page or the quick-add form — a derived tag in the same family as `[after:]`, never a column or table. It does two things. (1) It is an earliest-start floor: `resolveTaskFloor` returns the later of the `[after:]` dependency and the start date, so auto-plan, reshuffle, and both client- and server-side drag validation refuse to place the block before it. (2) When the start date is more than `START_DEFER_LEAD_DAYS` (14) away, the task is parked on a dedicated **"Later — Hub"** Google Tasks list (`ensureLaterList`, id cached in `crm_context.later_task_list_id`) so it stays out of Douglas's working Google list and out of the planner inbox (`getPlannerSnapshot` filters `isStartDeferred`); on `/crm/tasks` it sits in a "Starts later" section. This is not a second store: the task is a normal Google task the whole time — created through the single-door `createTask`, kept in the CRM dedup corpus, keeping its `project_slug` (sync uses `COALESCE`, never overwrites). Routing to/from the Later list is by start date in `createTask`/`updateTask` (`desiredListForTask`); `promoteDueStartTasks` — run off `google_tasks_sync` every 15 min — moves any parked task back to its home list (project list, or default) with the ID-stable `moveTaskToList` once its start comes within the window, so it reappears ~2 weeks before it starts. Do not add a start-date column, a planner/waiting table, or a second promotion path; the lead time is a module constant, easily made a `task_planner_preferences` field later.

Overdue status is dependency-aware everywhere it is surfaced. `applyTaskDependencyTiming` derives an effective due date and effective local reminder deadline from the later of the stored value and the live `[after:]`/`[start:]` floor; it never rewrites the Google due date or Hub deadline. Task lists, briefings, the Boox planner, Planner late markers, and `sweepReminders` use that derived timing. If a due date or meeting moves forward, an existing automatic `task-overdue` reminder is parked as `task-overdue-deferred` and removed from active/stale views; it is reactivated only when the derived deadline genuinely passes. `fireReminder` rechecks the floor before every ping so a queued job cannot race a moved dependency.

“Print today” is a read-only PDF generated from the same live Calendar/Planner snapshot. It contains genuine appointments in the day’s calendar and each Planner task block once in the task checklist; task-backed Calendar mirrors are not repeated as appointments. It never persists a document, duplicates tasks, or writes to Google Calendar.

The Boox reference planner (`lib/boox-planner.js`, `boox_planner_publish` nightly at 04:50 Dublin) renders the next 90 days as one hyperlinked PDF for the 13.3" Note Max and pushes it into the Drive folder the device syncs. It is a derived view — no planner table, no new storage, no task or calendar writes — built from consecutive 28-day planner snapshots because the snapshot API is capped at 31 days. It is a **writing surface**, so **each day is its own file** (`Hub Planner <YYYY-MM-DD>.pdf`), created once and never rewritten: e-ink handwriting is keyed to the file it was drawn on, and rebuilding a day in place would destroy notes. An existing day is skipped, not replaced, unless a user explicitly forces it; nothing is ever auto-deleted. Note pages exist for genuine appointments and as numbered blanks — never for task blocks, which already have records. Handwritten pages return through the Boox → Drive ingest path (`docs/boox-drive-ingest.md`). Every dashboard count must link to a page listing exactly what it counts, and every page must be reachable. See ARCHITECTURE.md → Boox reference planner.

## CRM responsive layout (9 August 2026)

Every native CRM page uses the shared fluid layout in `public/crm.css`: viewport-relative gutters, scalable card spacing, auto-filling card grids, a weighted detail/sidebar grid, and common tablet/mobile breakpoints. Do not put a fixed global max-width back on `.crm-page`, duplicate responsive breakpoints inside individual CRM templates, or force the Planner inbox and seven-day grid into cramped side-by-side columns. A prose-heavy source view may retain its own readable line-length cap. Verify representative list, detail, form, task, and Planner layouts at 1920, 1280, tablet, and phone widths; document-level horizontal overflow is a regression, while the calendar's own narrow-screen scroller is intentional.

## Before ending any session

Ask yourself:
- Is anything I added silently broken?
- Are there connections I said would work that I haven't verified?
- Does the daily system report or the health checks surface any new failure modes I've introduced?
