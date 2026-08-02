# McLellan Hub — Module Contracts

Each module has a defined purpose. Before adding to a module, read its contract.
If what you're adding changes the purpose, update this file first.

"Healthy" means: if you checked the DB and the logs right now, you would see evidence of this.

---

## Infrastructure Dependencies

These are the tools the system runs on. They are not features — they are the foundation everything else requires. Run `scripts/health-check.sh` after any of the following events:

- `npm install` or `npm audit fix` that updates packages
- Node.js version change on the VPS
- Any deploy that touches `package.json` or `package-lock.json`
- VPS restart or OS update

### Puppeteer + Chrome
- Renders LinkedIn carousel PDFs via headless Chrome.
- Chrome binary is installed separately from the npm package via `npx puppeteer browsers install chrome`.
- **After a puppeteer npm update**: the expected Chrome version changes. The cached binary at `/home/hub/.cache/puppeteer` will be wrong. Re-run the install command.
- **Return type hazard**: `page.pdf()` returns `Uint8Array` in v21+, not `Buffer`. Code that calls `.toString('base64')` must wrap the result in `Buffer.from()` first.
- **VPS flags required**: `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu`
- Health check: `scripts/health-check.sh` verifies the Chrome binary exists at the path puppeteer expects.

### better-sqlite3
- Native Node.js addon. Recompiles against the Node.js version it is installed with.
- **After a Node.js version change**: run `npm rebuild` — the compiled binary will be wrong and the DB will fail to open with a cryptic ABI error.
- Health check: `scripts/health-check.sh` opens the live DB with better-sqlite3 and confirms it works.

### Google APIs (Drive, Sheets, Tasks, Calendar, Gmail)
- OAuth2 tokens stored in the DB (`crm_context` table, key `google_tokens_{user}`).
- Tokens auto-refresh while in use. If the Hub is down for an extended period, the refresh token may expire and require re-authorisation via `/auth/google`.
- Health check: check the system report email — any Google API auth failure will surface as a module error there.

### OpenRouter
- All LLM and embedding calls go through OpenRouter. No direct Anthropic/Google/DeepSeek calls.
- API key is `OPENROUTER_API_KEY` in `/app/.env`.
- Health check: a successful email processing run (visible in `/admin/jobs`) confirms OpenRouter is reachable.

### Synthadoc Python venv
- Lives at `/app/.tools/synthadoc-venv/`. Used for vault ingest and wiki indexing.
- Built once during setup. Does not rebuild automatically.
- Health check: `scripts/health-check.sh` checks the Python binary exists.

### Nginx
- Reverse proxy for all Hub routes and subdomains.
- Config at `/app/nginx/mclellan.conf`, deployed on every `scripts/deploy.sh` run.
- Health check: `scripts/health-check.sh` checks `systemctl is-active nginx`.

### Mac Cron Jobs
- `pull-backup.sh` runs daily at 07:00 to pull VPS backups to Google Drive.
- `sync-workday-vault.sh` runs on schedule to sync the Obsidian/Synthadoc vault.
- Health check: `scripts/health-check.sh` verifies crontab entries are present.

### SSH Access
- All scripts that touch the VPS use SSH ControlMaster (`-o ControlMaster=auto`) so only one connection is opened per script run. **Never add a bare `ssh` or `rsync` call to a script without routing it through the shared ControlMaster socket** — multiple rapid connections trigger UFW rate limiting and lock out the Mac.
- Mac IP `176.61.123.104` is whitelisted in UFW (`ufw allow from 176.61.123.104 to any port 22`) to prevent accidental lockout.
- If locked out: connect via VPS provider console, then run `echo -<your-ip> > /proc/net/xt_recent/DEFAULT` to clear the rate limit table.

---

## Email (Gmail)
**Purpose:** Process incoming Gmail for Douglas, extract actions, and route intelligence into CRM, tasks, and contacts.

**Healthy looks like:**
- `inbound_email_records` has entries from the last 24h
- Emails from known work senders have produced CRM facts
- Emails with clear action items have produced Google Tasks with `source='email'`
- Ryanair booking emails have produced entries in the `flights` table

**Does not own:** Sending email (that's AgentMail), calendar events (that's CRM), flight tracking after import (that's the Job Queue)

**Health check:** Completed flights from Ryanair emails have `status='scheduled'` at import time and a `flight_refresh` job in `system_jobs`

---

## AgentMail
**Purpose:** Process emails sent to `mclellanhub@agentmail.to` — Douglas's AI-facing inbox. Extract work intelligence, facts about people, and actions from trusted senders.

**Healthy looks like:**
- `agentmail_records` has entries from the last 24h
- Emails from `AGENTMAIL_WORK_DOMAINS` have produced CRM facts when people are mentioned
- Action items have produced Google Tasks with `source='agentmail'`

**Does not own:** Sending email, Gmail processing

**Health check:** `agentmail_records` in last 24h > 0. CRM facts with `source='agentmail'` exist from this week.

---

## Flight Tracker
**Purpose:** Track every Ryanair flight Douglas takes from booking email through to actual departure and arrival times.

**Healthy looks like:**
- Every Ryanair booking email has produced a row in `flights` with `status='scheduled'`
- Every scheduled flight within 48h has a prep task in Google Tasks
- Every scheduled flight within 24h has a check-in task in Google Tasks
- Every flight within 2h of departure has an active `flight_refresh` job in `system_jobs`
- Every completed flight has non-empty `actual_dep` and `actual_arr`

**Does not own:** General travel tasks (those are the job queue's job to create), calendar events

**Health check:** `SELECT COUNT(*) FROM flights WHERE status='completed' AND (actual_dep='' OR actual_arr='')` should return 0 for flights in the last 30 days. Any non-zero result means AeroDataBox parsing is broken.

**Known limitations:** AeroDataBox field is `revisedTime` not `actualTime` — this was a silent failure for months. If actual times stop appearing on completed flights, check the field name first.

---

## CRM
**Purpose:** Build and maintain a picture of Douglas's professional relationships — contacts, companies, projects, facts, and meetings.

**Healthy looks like:**
- Contacts mentioned in emails are being created or updated automatically
- CRM facts are accumulating from agentmail, email, and meetings
- The morning briefing includes upcoming meetings and relevant contact context
- Projects have contacts linked to them
- Keep-warm-overdue contacts surface at the top of the People page with badges
- Manual capture is one pass: Add Person takes phone/company/role/how-we-met; touchpoints, milestones, and project status are recorded where they're seen (facts and manual atoms, not columns)
- Meeting intake drafts are previewed (attendees/outcomes/actions/risk flags) before anything is committed; debriefs create CRM meeting rows with date/time/duration/channel
- Every question the nightly quality boards raise is answerable at `/crm/questions`, and answering one writes knowledge instead of only clearing a flag: a meeting question becomes a `decision` atom on its project, an unowned action becomes an `open_commitment` atom on a real person (with the transcript's name kept as an alias), an alias clash becomes a `distinct_from`/`same_person_as` atom. A board that asks something Douglas cannot answer anywhere is an incomplete feature
- Placeholder speakers block new intake before processing; the quality board must not reopen speaker mapping on already-processed legacy transcripts that no longer have an editable mapping step

**Does not own:** Tasks (those go to Google Tasks), calendar events (that's Calendar), document storage (that's Projects/Documents)

**Health check:** `crm_facts` with `status='active'` created in the last 7 days > 0. Contacts with 0 facts are flagged in the connectivity report.

---

## Calendar
**Purpose:** Be the source of truth for scheduled meetings, interviews, and appointments Douglas must personally attend, so he never has to add them to his calendar by hand after an email confirms a specific date and time.

**Healthy looks like:**
- A calendar event exists for every source (email, meeting_intake, etc.) that states both a specific date and a specific time Douglas must attend — not for plain due-by deadlines with no attendance component
- No duplicate events for the same source event (enforced by `meetings.source` + `source_id`, mirroring Google Tasks' dedup pattern)
- Created events appear in the Work Brief's Today/Coming Up sections the same day they're created, not only after the next 06:45 calendar sync — the create path (`lib/google-calendar.js`) upserts `meetings` directly rather than waiting on `syncCalendarMeetings`

**Does not own:** The task list (that's Google Tasks — the same source event typically produces both a task and, when it has a specific time, an event), meeting debriefs/notes (that's CRM meeting intake)

**Health check:** `/crm/knowledge`'s `crm_action_projected` stage receipts include an `event_projection` count; the daily system report's "Calendar events" line should be non-zero on days when time-specific meetings were confirmed by email.

---

## Google Tasks
**Purpose:** Be the single task list for Douglas. Every actionable item from every source ends up here. Douglas should never need to manually create tasks from information the system already has.

**Healthy looks like:**
- Tasks exist from all active sources: `email`, `agentmail`, `document`, `mycelium`, `crm`
- No duplicate tasks for the same source event (enforced by `source_id` uniqueness)
- Flight prep and check-in tasks exist for upcoming flights
- CRM edits that Google can store (title, notes, due, complete) land on the remote task immediately — not only in the local cache
- Changing a task's project moves it to that project's Google Tasks list; deleting in the CRM removes the open item from Google (restore re-creates it)

**Does not own:** Deciding what is a task (that's each source module's job), completing tasks (that's Douglas). Contact/company links and Hub reminder times (`deadline`) are Hub-local metadata — Google has no fields for them.

**Health check:** Open tasks with no `project_slug` and no `contact_id` should be reviewed — they're orphaned from the network. Open Hub tasks whose `task_list_id` does not match their project's `google_task_list_id` are out of sync — save the task or run `repairTaskGoogleSync`.

---

## Documents / Projects
**Purpose:** Store project documents uploaded by Douglas, extract intelligence from them (tasks, contacts, wiki pages), and make them available to the rest of the system.

**Healthy looks like:**
- Uploaded documents trigger task extraction automatically within one job queue cycle
- Contact names found in documents are linked to the document's project
- Documents can be sent to the wiki

**Does not own:** Running projects (that's CRM), task management (that's Google Tasks)

**Health check:** Recent non-image, non-meeting documents with no `task_extracted_at` review marker should be flagged. A reviewed document that produced zero tasks is healthy, and generated `_Project Memory.md` documents are outside task extraction.

---

## Knowledge Layer
**Purpose:** The derived substrate the CRM/wiki/project pages are *views* over — not another table of hand-entered records. Compiled continuously from raw sources so connections are made from the whole corpus after ingestion, not from the thin context available at capture time. Files: `lib/retrieval.js` (embeddings), `lib/atoms.js` (atoms), `lib/synthesis.js` (the compiler called only after canonical CRM gates), `lib/task-router.js`, `lib/knowledge-lint.js`. Jobs: `embed_backfill`, `atoms_backfill` (historical name; normally queues canonical review for CRM facts), `synthesis_run` (nightly compatibility scheduler delegating to `crm_knowledge_engine`), `task_route_run` (daily), `knowledge_lint_run` (weekly). All model calls go through OpenRouter; `embeddings`, `atom_extractor`, `entity_linker` are admin model slots.

**Healthy looks like:**
- `embeddings` count tracks the corpus; changing the embeddings model in admin causes a gradual re-index (isIndexed is model-aware)
- A care-plan/email mentioning a known person produces atoms on that contact with `lives_at`/`needs`/etc., each carrying provenance back to the source
- A free-text task ("get dad's medicine") gets routed to the right contact by `task_route_run`
- `/admin/knowledge` review queue stays small (proposed atoms approved/rejected; contradictions and duplicate contacts surfaced)

**Does not own:** The raw sources (documents, emails, meetings, crm_facts) — those remain the source of truth; atoms are derived and re-derivable. Does not write to the public portfolio (private knowledge stays private).

**Retention contract:** Knowledge never disappears; it only leaves the default line of sight. Immutable predicates (date of birth, kinship — see `isImmutablePredicate` in `lib/knowledge-lint.js`) are exempt from decay and staleness. Mutable facts decay after 180 days unconfirmed and go `stale` after 365 — but stale atoms remain searchable in Ask the Hub (ranked below active, flagged to the model as possibly outdated), appear on entity pages behind the existing "show history" toggle, and are revived automatically if the fact reappears in any new source. Each weekly lint writes its decisions to `crm_context` (`knowledge_lint_last`) and the daily system report renders them under KNOWLEDGE, so nothing leaves view silently.

**Interest radar:** `lib/interest-synthesis.js`, job `interest_synthesis_run` (daily 05:45, before the work brief). Joins recent meeting intakes with the upcoming meetings/calendar and asks the model which work topics Douglas is actively engaged with; writes `interest`-kind atoms (predicate `active_interest`) with provenance to the signals, plus a compiled radar cache in `crm_context` (`interest_radar`). The work daily brief reads the radar and pulls recent stories per topic (Exa search) into an "On your radar" section, each with the "why" naming the meeting or calendar entry that earned it. Interests fade from the brief 45 days after their last reconfirmation; the atoms live on.

**WhatsApp / messaging capture:** Hermes (Baileys) passively posts only explicitly routed chat evidence to `POST /api/messaging/capture` (`lib/messaging-capture.js` → `messaging_messages`). The complete source envelope preserves chat/sender/message provenance plus operator-supplied contact/project routing hints. Source kind `messaging_message` is consumed by `crm_knowledge_engine` like email/meetings — triage, duplicate review, atoms, high-confidence task projection. Setup: `docs/whatsapp-hermes-capture.md`. Intentional `/crm` notes still use the Hermes `dchat-crm` skill → `/api/crm/webhook`; family chat bulk path must not.

**Health check:** `knowledge_atoms` and `embeddings` counts are non-zero and growing; open a contact page and confirm the Knowledge panel shows claims with click-through sources; `/admin/knowledge` shows the review queue; the daily system report's KNOWLEDGE section shows atom counts and the last lint run.

---

## Core Infrastructure Primitives
**Purpose:** Shared capabilities other modules call instead of reimplementing ingestion, current-information research, or durable report rendering. These are primitives, not user-facing modules.

**Files:**
- `lib/heavy-file-ingestion.js` creates a standard ingestion package (`index.json`, canonical Markdown, readable chunks) before synthesis/retrieval reason over heavy files.
- `lib/current-info-search.js` routes stale-risk research through Exa/Brave/Tavily with checked-at timestamps and source metadata.
- `lib/html-artifact-builder.js` turns dense Markdown reports into single-file offline HTML artifacts.

**Healthy looks like:**
- Project document upload stores `documents.markdown` for existing views and an `ingestion_package_path` pointing at the reusable artifact package.
- Multi-search uses the current-info primitive for live source gathering, and synthesis receives checked-at source context.
- Daily system reports still send plain text but also generate a local HTML artifact and include HTML email content when AgentMail accepts it.

**Does not own:** Relationship extraction, task routing, or durable claims. Those remain Knowledge Layer/Mycelium responsibilities. These primitives only prepare inputs and presentation artifacts.

**Health check:** Run `node --test test/infrastructure-primitives.test.js`; spot-check a recent uploaded document has a readable package under `data/ingested/`.

---

## Mycelium
**Purpose:** Grow connections between isolated data nodes. Runs every 6 hours and on-demand to ensure that information in one module is reflected appropriately in others.

**Healthy looks like:**
- New documents produce tasks and contact links automatically
- New scheduled flights produce tasks automatically
- Regulatory items relevant to projects are tagged to them
- Meetings in the next 48–72h with attendees have prep tasks

**Does not own:** The data in other modules — mycelium only creates links and tasks, never primary records

**Health check:** The connectivity report at `/admin/connectivity` shows orphaned nodes. If it's clean, mycelium is working.

---

## Regulatory Monitor
**Purpose:** Scan EU, Irish, UK, and relevant international authority websites daily for regulatory updates, compile source-backed intelligence, and send Nakai a private briefing. US federal and state regulation is explicitly out of scope and will be handled by a separate future briefing.

**Healthy looks like:**
- Nakai receives the scheduled regulatory email.
- The briefing leads with current EU/Irish/UK developments and contains no US regulatory section or US regulator follow-ups.
- The audit email lists sources checked, new links found, relevant items, priority, affected firms, evidence, confidence, and source URLs.
- If the daily briefing step fails (e.g. OpenRouter out of credits), Douglas gets a PANIC audit email and the Hub retries the briefing hourly (`NAKAI_BRIEFING_RETRY_MINUTES`, default 60) until it sends or Dublin midnight passes; a successful retry emails Douglas a RECOVERED confirmation.

**Does not own:** US regulatory monitoring, Hub CRM notes, Google Chat alerts, weekly digest content, or Douglas-facing regulatory surfaces.

**Health check:** Check process logs for `[reg-monitor]`, `[intelligence-pipeline] briefing retry` lines, zero-link warnings, and Firecrawl fetch warnings.

---

## Job Queue
**Purpose:** Replace dumb polling intervals with self-scheduling, data-driven jobs. The system schedules its own future work based on what it knows — a flight booking creates a tracking job, not a timer.

**Healthy looks like:**
- `system_jobs` always has pending `email_process` and `agentmail_process` jobs
- `mycelium_run` has a pending job for the next 6h window
- Every scheduled flight has a pending `flight_refresh` job
- `flight_backfill` runs nightly and completed flights have actual times

**Health check:** If `email_process` has no pending job, email processing has silently stopped. This is the most critical health check in the system.

**Visible at:** `/admin/jobs`

---

## Reminders
**Purpose:** Escalate things that need Douglas's attention via Google Chat until he responds. A reminder fires at its set time, then again at +30min, +3h, +24h (4 pings max, never during 22:00–07:30 Dublin), then goes stale and lives in the morning briefing. Replies to the hermes bot ("done 3", "snooze 3 2h", "ok 3") resolve, defer, or silence it — "done" also completes the underlying task or closes the CRM follow-up.

**Sources of reminders:**
- "remind me to X at Y" via hermes chat or any CRM input (LLM-parsed)
- Overdue Google Tasks (auto, one reminder per task, via the 15-min sweep)
- CRM follow-ups past their `due_date` (auto)
- Contact birthdays (auto, morning of, one per contact per year)
- Content cadence checks (LinkedIn posting gap, thin newsletter weeks) — these consult real pipeline state and skip silently when healthy; one ping per occurrence, no escalation
- Manual via `/crm/reminders` or the "Remind me" button on a task

**Healthy looks like:**
- `reminder_sweep` always has a pending job
- No reminder sits past its fire time with no pending `reminder_fire` job
- A reminder whose task/fact was completed elsewhere gets cancelled by the next sweep — escalation never outlives the work

**Owns:** `reminders` table, delivery via hermes space (`_hermes_space` in crm_context, captured from inbound bot messages) with webhook fallback.

**Visible at:** `/crm/reminders`

---

## Suggestions
**Purpose:** A daily LLM action radar (07:00 Dublin) that proposes reviewable next actions from source-backed Hub context but never acts on its own. Current streams: travel booking timing (unbooked travel windows × Skyscanner price history), short-lived opportunities, and one experimental outreach reason for every CRM person who has no open contact-linked task. LinkedIn topic ideas belong to the dedicated LinkedIn Plan/research pipeline, not this module.

**Interaction:** `/crm/suggestions` puts Create task, Not this time, Dismiss, Why, and Wrong on every open card. Create task creates a linked Google Task; Not this time says the idea was sound but its timing or scope missed; Dismiss closes a weaker candidate; Why shows its stored evidence; Wrong records Douglas's explanation and learns a reusable rule for that stream. Suggestions expire after 14 days.

**Feedback calibration:** Every deliberate outcome is stored in `suggestion_feedback` as an implicit quality signal: task created 100, Not this time 60, Dismiss 25, Wrong 0. Per-stream outcome statistics and recent scored titles are supplied to later synthesis runs. These implicit choices calibrate selection but do not become facts or hard rules. Only Wrong invokes the LLM rule learner and requires an explanation.

**Duplicate boundary:** A scored example is terminal history, not a template to repeat. Opportunity signals are admitted only once using their stable source IDs, regardless of title wording or relevance-window formatting. New proposals then pass a separate semantic duplicate review against open/completed/deleted/Wrong task history and prior suggestion decisions; if that review fails or is uncertain, the proposal does not surface.

**Knowledge boundary:** A generated suggestion is a candidate cache, not knowledge. It may contain a clearly labelled model hypothesis when the Hub evidence is thin. No suggestion-derived atom is active before Douglas accepts. Acceptance may compile the accepted rationale as `accepted_outreach_reason`/`relevant_offer` with provenance back to the suggestion; Wrong retires any legacy compiled suggestion atom.

**Owns:** `suggestions`, `suggestion_feedback`, `suggestion_lessons`, and `travel_price_points` tables. Skyscanner price-alert emails are LLM-extracted into price points by the email processor before generic skip rules.

**Healthy looks like:**
- `suggestion_run` always has a pending job
- Re-runs never duplicate (dedup keys)
- Every eligible non-self contact without an open task gets at most one open outreach candidate per month
- Contact suggestions cite Hub source keys or explicitly say that the angle is exploratory
- Every suggestion's evidence is inspectable via Why
- Every deliberate review outcome has exactly one scored feedback event
- No opportunity source signal appears in more than one open suggestion, and no suggestion repeats an existing task action
- No active atom with `derived_by='suggestion_opportunity'` or `suggestion_contact_accepted` exists for an unaccepted suggestion

---

## System Report
**Purpose:** Email Douglas at 21:00 every day with a plain-text summary of what the system did and whether it's healthy.

**Must include:**
- Email and AgentMail processing counts
- CRM facts created today
- Tasks created today by source
- Any completed flights (with actual times)
- Module health checks — flag any module that shows signs of silent failure
- AI spend: COST BY MODEL (grouped by the actual `request_logs.model_id`, canonicalised and joined to `model_config` for list rates), COST BY FEATURE (grouped by `model_key`), and a "WHAT EACH FEATURE DOES" glossary sourced from `lib/feature-descriptions.js` — so the report explains its own spend. Model↔feature is a many-to-one: features name the *task*, models name the *engine*.

**Healthy looks like:** Douglas reads it and can tell from one glance whether the system is working or needs attention.

---

## Briefing (Morning CRM)
**Purpose:** Email Douglas at 07:30 with context for the day — meetings, relevant contact facts, upcoming flights, open tasks.

**Healthy looks like:**
- Includes today's calendar events with attendee context from CRM
- Includes any flights today or tomorrow
- Includes open tasks due today or overdue

## M365 Operations & Security Briefing
**Purpose:** Email Douglas at 07:15 on weekdays with source-backed Microsoft 365, hybrid identity, Intune, Endpoint Central, SentinelOne, PAM360, CloudWave, and Artemis operational intelligence. It uses the Nakai-style VPS evidence/package/archive/delivery flow and the Mac subscription worker for final writing.

**Healthy looks like:**
- A private Markdown, HTML, PDF, source-pack, prompt, and manifest edition is stored under `data/m365-briefings/<edition>/`.
- Every material claim cites a marker present in that edition's stored source pack.
- Missing tenant/vendor adapters appear as `not connected`, never as evidence of safety.
- The Mac worker receives only a bounded source package and returns Markdown; the VPS validates, renders, archives, and sends it.

**Does not own:** Regulatory analysis, Microsoft Defender monitoring, raw vendor-console records, or endpoint remediation.

## US Block Special Edition
**Purpose:** Scan the configured US financial-regulator and attorney-general sources on Monday, Wednesday, and Friday, then publish/email Nakai only when source-backed synthesis finds a high-confidence direct Block/product story.

**Healthy looks like:**
- Every run stores its raw search evidence and gate decision under `data/us-block-briefings/checks/`.
- Generic crypto, unrelated-company, homepage, keyword-only, and speculative items are suppressed.
- A qualifying run stores Markdown, HTML, PDF, source pack, decision, manifest, and private knowledge capture, then sends the edition to the configured Nakai recipient.
- A no-story run records `no-candidates` or `suppressed` and sends nothing.

**Does not own:** Nakai's EU/UK/Irish daily regulatory briefing or Microsoft 365 operations/security monitoring.

---

## Newsletter / Briefing (Afternoon)
**Purpose:** Email Douglas at 16:00 with a digest of email received that day, newsletter content of interest, and RSS feed updates.

**Does not own:** Processing email (that's the email module)

---

## Wiki (Synthadoc)
**Purpose:** Index project documents and chat outputs for retrieval. Should feed back into the system as context for email classification, briefing enrichment, and regulatory matching.

**Current limitation:** Synthadoc indexes documents but the hub does not yet query it as a retrieval source during email processing or briefings. This is a known gap — the path from wiki → other modules does not yet exist.

---

## URL Watchlist
**Purpose:** Monitor any URL for new content on a user-specified schedule. Fetches pages using a provider cascade (Firecrawl → Exa → Brave → direct HTTP), extracts new stories/links, and displays them in a tab-based admin view.

**Healthy looks like:**
- `watchlist_feeds` has enabled feeds with recent `last_fetched_at` values
- `watchlist_stories` has entries from the last 24h for active feeds
- Feeds with 3+ consecutive errors are auto-disabled and visible in the UI with error badges
- `watchlist_poll` always has a pending job in `system_jobs`

**Does not own:** RSS feed processing (that's the RSS module), regulatory monitoring (that's the Regulatory Monitor), newsletter content

**Health check:** `watchlist_poll` has a pending job. No enabled feed has `error_count >= 3` — if it does, the auto-disable trigger failed.

---

## AI Text Humanizer
**Purpose:** Take AI-generated prose and redraft it so it reads as if a person in the field wrote it, by editing two layers of machine-writing "tells". SURFACE (manual method after Andy Stapleton): rule of three, low burstiness (uniform sentence length), predictable transitions ("However/Therefore/In conclusion"), flat/absolute tone, thesaurus-level vocabulary, surface-level generality. DISCOURSE (after StoryScope, arXiv:2604.03136 — the signal that survives surface edits): over-explanation, moralising/stated-lesson sentences, emotion rendered as bodily sensation, sensory over-writing, rigid chronological ordering, and writing as if no reader is present. An editing tool, not a paraphraser and not a fabricator.

**Core capability (must be present):** Given pasted text, it returns a full rewritten draft plus a layer-tagged report of what changed and before/after scans of BOTH layers — surface (`scan_before`/`scan_after`: burstiness, triad count, transition openers, wordy terms) and discourse (`scan_discourse_before`/`scan_discourse_after`: moralising count, over-explanation count, sequence markers, somatic-emotion ratio, audience address, `flags_raised`). Discourse edits are why the tool is more than a de-cliché pass: surface polish alone barely moves a narrative-level detector (paper: ~1.6 points). If it only reworded the surface, it is not doing the whole thing its name says.

**Honesty constraint:** It must never invent statistics, figures, dates, citations, names, sources, or storylines to add "depth." Where a specific number would strengthen the text it inserts an `[ADD SPECIFIC FIGURE: ...]` marker; where a specific named reference would, it inserts an `[ADD SPECIFIC SOURCE: ...]` marker — both for the author to fill in. Every discourse edit rearranges or removes editorialising only; it must not change a fact. Fabricated data is a bug, not a feature.

**Healthy looks like:**
- `POST /api/humanize` returns `humanized_text`, layer-tagged `changes[]` (each with `layer: surface|discourse`), `scan_before`/`scan_after`, `scan_discourse_before`/`scan_discourse_after`, and honest risk estimates.
- On genuinely AI text the discourse scan shows movement (e.g. `flags_raised`, `moralising_count`, or `over_explanation_count` falling) — not just surface burstiness/transition changes.
- Any `[ADD SPECIFIC FIGURE: ...]` / `[ADD SPECIFIC SOURCE: ...]` markers are surfaced in `added_data_markers` / `added_source_markers` and highlighted in the UI.
- No digit appears in the output that was not in the source (fabrication guard).
- Usage is logged to `request_logs` under task code `UT-Humanizer`.

**Does not own:** Content drafting (that's the Content/LinkedIn pipeline), chat, or document ingestion. It edits text the user pastes in; it does not read from the knowledge layer.

**Deliberately not built:** No automated AI-detector API integration. Detector scores are unreliable and paid; the tool shows its own heuristic surface + discourse scans and an honest caveat instead of a false "100% human" guarantee.

**Known limitation:** The discourse scan (`lib/humanizer-discourse.js`) is a conservative cue-based heuristic, not a detector, and its payoff scales with text length — it does more on long-form (debriefs, knowledge synthesis) than on a short email, where the surface pass already carries most of the visible change. It is a moveable feast: expect to tune the cue lists as models and human writing drift.

**Health check:** An AI paragraph that states its own moral (e.g. ends "Ultimately, this shows the importance of…") run through `/api/humanize` returns a draft where `scan_discourse_after.moralising_count < scan_discourse_before.moralising_count`, and no digit in the output is absent from the input.

## Model Style Profiles
**Purpose:** Compiled knowledge of how each frontier vendor writes production prompts for its own model family (Claude, GPT, Gemini, Grok, open-weights), distilled monthly from github.com/asgeirtj/system_prompts_leaks. Used to shape prompts for the model they will actually run on: the prompt tool's target-model selector (adapt + Prompt Gym) and the admin "Shape for model" button on every system prompt slot.

**Core capability (must be present):** Selecting a target model family in the prompt builder measurably changes the output style (e.g. XML tags for Claude, markdown headers and terse MUST-rules for GPT). "Shape for model" returns a restyled proposal that preserves every rule and placeholder of the original — it restyles, it does not rewrite content.

**Knowledge over tables:** Profiles are the compiled output of the `style_profile_run` synthesis job, stored in `crm_context` under `hub_style_profile_<family>` (user `system`) — no dedicated tables. Evidence files are selected dynamically from the repo by name pattern and size, so new model releases are picked up without code changes. Each run writes `knowledge_receipts` rows (`source_kind='style_profile'`).

**Healthy looks like:**
- All five family badges on `/admin/models` show as present, with a distilled date within ~35 days.
- `system_jobs` always has a pending `style_profile_run` (monthly self-reschedule; first run ~10 min after boot when no profiles exist).
- A family failure keeps the previous profile (stale beats absent) and writes an `error` receipt — it must not silently blank a profile.
- `prompt_library` / `prompt_adaptations` / `prompt_optimizations` rows record `target_model_family` when one was selected; the sense check flags family mismatches when reusing examples.

**Does not own:** The prompts themselves (prompt library module), model slot assignment (`lib/settings.js`), or the improver used in the admin test panel. Shaping proposals are never auto-saved — Douglas reviews and saves.

**Health check:** `node -e "require('./lib/model-style-profiles').listStyleProfiles().forEach(p => console.log(p.key, p.present, p.distilled_at))"` shows five `true` rows with recent timestamps.

## Self-Repair Venue (Mac mini only)
**Purpose:** Turns narrow, reproduced runtime failures (mined nightly from the prod snapshot's `system_jobs.error`, `processing_failures`, and `hub.service.log`) into verified, human-gated code fixes. The locally authenticated Grok CLI writes the fix inside a throwaway git worktree; a four-gate check harness verifies it; the result is a `repair/<id>` branch, a GitHub PR, and a summary email — never a deploy. Runs ONLY on the Mac mini (launchd, 04:30, after the 04:00 snapshot refresh); the VPS nightly flow is untouched.

**Core capability (must be present):** `node scripts/run-repair.js --reproducer <id>` on a fixable-narrow reproducer produces a pushed branch with ≤3 changed files including a regression test, all gates green, a PR, and an email — or an honest escalation email saying why not.

**Pipeline:** `lib/repair-reproducer.js` (Phase 0: mine + package + synthetic mock test) → `lib/repair-triage.js` (Phase 1: fixable-narrow / config_fix / escalate / skip; a model may only downgrade verdicts) → `lib/repair-venue.js` + `lib/repair-check-harness.js` + `scripts/repair/grok-runner.mjs` (Phase 2: worktree → Grok CLI → gates → PR → email).

**Bounded like remediation:** MAX_REPAIR_ATTEMPTS=3, 5-minute session timeout (kill), 12-turn Grok CLI cap, ≤3 files changed, 7-day re-attempt window, recurrence of a "fixed" error escalates instead of looping. Grok runs through the Mac's authenticated subscription and reports final token cost, which receipts preserve; it does not provide the prior real-time $2 brake. Kill switch: venue is OFF unless `REPAIR_VENUE_ENABLED=1` or prod `crm_context` key `repair_venue_enabled`='1' (carried over in the snapshot).

**Healthy looks like:**
- Receipts (JSON files in `data/repair-receipts/`, same shape as `writeAgentReceipt` payloads — deliberately NOT prod `knowledge_receipts`, which the venue cannot reach from a snapshot) exist for every stage: reproducer, triage, reproduce, fix, run.
- Model garbage (`was not valid JSON`) goes to config_fix email, never to a code guard; schema errors escalate; a fix without a regression test is rejected by Gate 2.
- Grok CLI repair receipts record the fixed local `grok-4.5` model, turns, and final cost; triage remains attributed through `AT-RepairTriage` and selectable through its `/admin/models` slot.
- Worktrees under `.repair-worktrees/` contain no `.env*` (except the tracked `.env.example`), no `data/` from the repo, and are cleaned after each run / after 7 days.

**Does not own:** Deploys (`scripts/deploy.sh`, human-run after PR review), the VPS nightly flow (`lib/system-report.js` untouched), remediation (`lib/hub-remediation.js` — the venue mines error tables directly, not remediation escalations), and the Consigliere brief (repairs surface via PR + email, and the next nightly cycle stops escalating once the fix is deployed).

**Health check:** `node scripts/run-repair.js --dry-run` mines and triages against the latest snapshot without repairing, emailing, or spending.

## LinkedIn Content Research (Mac pull-worker for production)
**Purpose:** Generates daily LinkedIn content-topic suggestions (`content_research_suggestions` table, read by the content cadence UI). Default path (`lib/content-research.js` → web search) is one flat Exa/Brave query per topic — thin, no engagement signal. Richer path: Grok (OpenRouter `content_research_driver`, fallback `x-ai/grok-4.5`) plans research, shells out to the last30days multi-source engine (Reddit/HN/GitHub/Digg/TikTok/Instagram/YouTube), and writes 3 evidence-grounded angle suggestions.

**Core capability (must be present):** a successful research run produces suggestions that cite specific, real, checkable evidence (URL, stat, quote) — not generic "AI is changing X" filler. At least one suggestion per run should typically cite a source last30days reaches that plain web search cannot.

**User switch:** the Plan tab (`/lin/plan`) has a "Use last30days" toggle (`topicPlan.useLast30Days`, default on). Off = plain web search for that user regardless of the host driver below. The Plan and Cadence (`/lin/cadence`) pages save through `mergeContentCadencePolicy()` key-level merges - a cadence save can never wipe day topics and vice versa (the old whole-object save silently destroyed `dayPrefs` on every cadence submit).

**Drivers (`CONTENT_RESEARCH_DRIVER`):**
- *(empty)* — web search on the Hub host (safe default everywhere).
- `grok` — run Grok+last30days **on this host** (needs Python 3.12+ engine at `LAST30DAYS_ENGINE_PATH`, default `~/.claude/skills/last30days`). Use on the Mac mini for local Hub, or anywhere the engine is installed.
- `mac` — **production VPS path.** Hub only enqueues rows in `content_research_jobs`; the always-on Mac mini runs `scripts/content-research-worker.js` (launchd every 180s), claims jobs via `POST /api/content-research/worker/*` with `CONTENT_RESEARCH_WORKER_SECRET`, runs the locally authenticated Grok CLI plus last30days, and POSTs suggestions back. It does not use OpenRouter for this flow. Stale claims re-queue; jobs older than `CONTENT_RESEARCH_FALLBACK_AFTER_SEC` (default 2h) get deliberate web-search fallback.

**Files:** `lib/content-research.js`, `lib/content-research-core.js`, `lib/content-research-jobs.js`, `lib/grok-research-driver.js`, `scripts/content-research-worker.js`, `scripts/install-content-research-worker.sh`, `scripts/launchd/com.mclellan.hub.content-research-worker.plist`.

**Hard dependency (engine still Mac-local):** last30days is not vendored into this repo. The pull-worker keeps it on the Mac mini so the VPS does not need Python 3.12+ or the skill tree. Alternative later: vendor engine onto VPS and set `CONTENT_RESEARCH_DRIVER=grok` there instead.

**Known upstream bug (workaround in place):** last30days' `--json-profile=agent` returns an empty `candidates` array on real (non-mock) runs — only `--json-profile=raw`'s `results`/`clusters` keys are actually populated. `runLast30DaysEngine()` reads whichever key has data; full engine JSON still goes to Grok.

**Does not own:** Full post drafting (`lib/linkedin-pipeline.js` slots — later stage once a suggestion is picked).

**Health check:** when `CONTENT_RESEARCH_DRIVER=mac`, the daily system report flags missing worker secret, no/stale Mac heartbeat (>30m), and jobs stuck past the fallback window. Worker heartbeats write `crm_context` key `content_research_worker_heartbeat` (user `system`).
