# McLellan Hub — Module Contracts

Each module has a defined purpose. Before adding to a module, read its contract.
If what you're adding changes the purpose, update this file first.

"Healthy" means: if you checked the DB and the logs right now, you would see evidence of this.

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

**Does not own:** Tasks (those go to Google Tasks), document storage (that's Projects/Documents)

**Health check:** `crm_facts` with `status='active'` created in the last 7 days > 0. Contacts with 0 facts are flagged in the connectivity report.

---

## Google Tasks
**Purpose:** Be the single task list for Douglas. Every actionable item from every source ends up here. Douglas should never need to manually create tasks from information the system already has.

**Healthy looks like:**
- Tasks exist from all active sources: `email`, `agentmail`, `document`, `mycelium`, `crm`
- No duplicate tasks for the same source event (enforced by `source_id` uniqueness)
- Flight prep and check-in tasks exist for upcoming flights

**Does not own:** Deciding what is a task (that's each source module's job), completing tasks (that's Douglas)

**Health check:** Open tasks with no `project_slug` and no `contact_id` should be reviewed — they're orphaned from the network.

---

## Documents / Projects
**Purpose:** Store project documents uploaded by Douglas, extract intelligence from them (tasks, contacts, wiki pages), and make them available to the rest of the system.

**Healthy looks like:**
- Uploaded documents trigger task extraction automatically within one job queue cycle
- Contact names found in documents are linked to the document's project
- Documents can be sent to the wiki

**Does not own:** Running projects (that's CRM), task management (that's Google Tasks)

**Health check:** Documents uploaded in the last 7 days with no associated tasks should be flagged unless they're images or have no actionable content.

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
**Purpose:** Scan specified websites daily for regulatory updates relevant to Douglas's work and surface them as CRM notes tagged to relevant projects.

**Healthy looks like:**
- `reg_monitor_items` has entries from the last 24h
- Items matching project keywords have CRM facts with `source='reg-monitor'`

**Health check:** `reg_monitor_items` created today > 0.

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
**Purpose:** A daily LLM pass (07:00 Dublin) that looks across calendar, CRM notes, flights, price alerts, RSS, and newsletter topics and *suggests* — never acts. Flagship: travel booking timing (unbooked travel windows × Skyscanner price history). Also: LinkedIn post topics from converging signals.

**Interaction:** Max 2 new suggestions pushed to Google Chat per run; all open ones appear in the morning briefing. Replies: "accept 2" (creates a task), "dismiss 2", "why 2" (shows the stored evidence). Suggestions expire after 14 days.

**Owns:** `suggestions` and `travel_price_points` tables. Skyscanner price-alert emails are LLM-extracted into price points by the email processor before generic skip rules.

**Healthy looks like:**
- `suggestion_run` always has a pending job
- Re-runs never duplicate (dedup keys)
- Every suggestion's evidence is inspectable via "why N"

---

## System Report
**Purpose:** Email Douglas at 21:00 every day with a plain-text summary of what the system did and whether it's healthy.

**Must include:**
- Email and AgentMail processing counts
- CRM facts created today
- Tasks created today by source
- Any completed flights (with actual times)
- Module health checks — flag any module that shows signs of silent failure

**Healthy looks like:** Douglas reads it and can tell from one glance whether the system is working or needs attention.

---

## Briefing (Morning CRM)
**Purpose:** Email Douglas at 07:30 with context for the day — meetings, relevant contact facts, upcoming flights, open tasks.

**Healthy looks like:**
- Includes today's calendar events with attendee context from CRM
- Includes any flights today or tomorrow
- Includes open tasks due today or overdue

---

## Newsletter / Briefing (Afternoon)
**Purpose:** Email Douglas at 16:00 with a digest of email received that day, newsletter content of interest, and RSS feed updates.

**Does not own:** Processing email (that's the email module)

---

## Wiki (Synthadoc)
**Purpose:** Index project documents and chat outputs for retrieval. Should feed back into the system as context for email classification, briefing enrichment, and regulatory matching.

**Current limitation:** Synthadoc indexes documents but the hub does not yet query it as a retrieval source during email processing or briefings. This is a known gap — the path from wiki → other modules does not yet exist.
