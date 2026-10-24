# McLellan Hub — Version Old

**Retired 24 October 2026.** Last commit of Version Old: `9ec2fe7` (git tag `version-old`).

Douglas paused the Hub on 13 Oct 2026 because it was working through a month-long
catch-up backlog and had grown to do too much. On 24 Oct he decided to retool:
delete every tool except the flight tracker, keep the access framework (env, keys,
APIs, deploy script), and rebuild from fresh ideas. Old data is to be refined again
from the beginning rather than trusted as-is.

This document is the record of what Version Old was, so good ideas are not lost
and mistakes are not repeated. The code itself remains in git history at the tag.

---

## 1. What survives into the rebuild

**Access framework**
- `.env` on the VPS (key names in §5; values never written here)
- Google OAuth client and the stored refresh tokens (`crm_context` rows `google_refresh_token`, `_google_refresh_token`, `_google_token_scopes`)
- Login/session (Google sign-in plus hub/admin passwords per user)
- `scripts/deploy.sh`, `scripts/sync-check.sh`, `.rsync-exclude`, nginx config, systemd `hub.service`
- The VPS itself (`root@178.104.235.142`, app at `/app`), the nightly backup cron (`/usr/local/bin/mclellan-backup.sh`)
- Mac mini: subscription CLIs (Claude, Codex, Grok), Ollama (`qwen3-embedding`), the SSH tunnel pattern

**Flight tracker**
- Ryanair booking email → `flights` row (110 flights at retirement)
- AeroDataBox live tracking (`flight_refresh`), nightly `flight_backfill` of actual times (field is `revisedTime`, not `actualTime`)
- `/flights` year-by-year log (2023–2026) with scheduled vs actual times and delays
- Calendar flight import (must ignore Hub check-in/prep blocks)

---

## 2. Function catalogue (44 functions)

Status key: **Paused** = stopped since 13 Oct. **Off** = disabled earlier.

### A. Inputs — bringing information in

| # | Function | What it did | Main files | Stored in | Status |
|---|---|---|---|---|---|
| 1 | Gmail processing | Every 15 min fetched received and sent mail, matched sender to contacts, AI-classified it, wrote a Hub label back into Gmail, saved a summary, passed it to the CRM brain. Special-cased Ryanair (→ flights) and Skyscanner price alerts (→ price history). Learned from Douglas's label corrections. | `lib/gmail.js`, `lib/email-processor.js`, `lib/email-taxonomy.js` | `email_summaries`, `inbound_email_records`, `processing_failures`, `travel_price_points` | Paused. Review: drop labelling; keep Ryanair + Skyscanner |
| 2 | AgentMail inbox | `mclellanhub@agentmail.to`, the deliberate "hand it to the Hub" inbox. Readability check at capture, then CRM brain. Also the outbound sender for every Hub email. | `lib/agentmail.js`, `lib/agentmail-processor.js` | `agentmail_records`, `email_summaries` | Paused. Review: keep |
| 3 | WhatsApp + iMessage capture | Hermes (Baileys) on the Mac forwarded routed WhatsApp chats; a Mac LaunchAgent read new iMessage/SMS read-only with a private-contacts exclusion. 5-minute settle window, same-chat context, auto-completion of tasks answered later in the chat. Sealed historical archive released 10 bubbles/day. | `lib/messaging-capture.js`, `lib/apple-messages-capture.js`, `lib/messaging-archive.js`, `scripts/messages-capture-worker.js` | `messaging_messages` (4,943 rows) | Hermes still posting at retirement (724 bubbles during the pause). Review: keep |
| 4 | Meeting intake + debrief | Krisp/mobile transcripts and voice debriefs → previewed draft (attendees, outcomes, actions, risks) → CRM meeting. Transcript quality gate for unintelligible STT dumps. | `lib/meeting-intake.js`, `lib/meeting.js`, `lib/transcript-quality.js`, `routes/hub-debrief.js`, `lib/debrief-context.js` | `meeting_intakes`, `meetings`, debrief sessions | Paused |
| 5 | Documents / projects | Upload → Markdown + ingestion package → task review → contacts linked → optional wiki. | `routes/hub-documents.js`, `lib/document-tasks.js`, `lib/heavy-file-ingestion.js`, `lib/markitdown.js` | `documents`, `data/ingested/` | Paused |
| 6 | Workday interview ingest | Transcript/audio → project document under `/workday` and the Obsidian vault. | `routes/hub-workday.js`, `lib/workday-ingest.js` | `documents`, vault | Paused |
| 7 | Boox handwriting | Boox → Drive ingest, Apple Vision OCR on the Mac, corrections through `/crm/questions`. Native Kotlin Boox app in progress (`boox-app/`). | `lib/boox-notes.js`, `lib/boox-note-ocr.js`, `boox-app/` | Drive, documents | Off |
| 8 | Newsletter + RSS ingest | Topic extraction from newsletters (`douglasnewsletters@agentmail.to`) and RSS feeds (09:30). | `lib/newsletter-pipeline.js`, `lib/rss-ingest.js`, `routes/hub-newsletter.js` | newsletter tables | Paused |
| 9 | URL watchlist | Poll any URL on a schedule via Firecrawl → Exa → Brave → HTTP; auto-disable after 3 errors. | `lib/watchlist.js` | `watchlist_feeds`, `watchlist_stories` | Paused |
| 10 | YouTube/URL → wiki | Save a link into Synthadoc/Obsidian. | `routes/hub-external.js`, `lib/obsidian-vault.js`, `lib/vault.js` | vault | Paused |

### B. The brain — making sense of it

| # | Function | What it did | Main files | Status |
|---|---|---|---|---|
| 11 | CRM knowledge engine | Prompt-led pipeline: triage → duplicate review → synthesis → action projection. Wrote receipts for every decision. Projected only high-confidence actions to Google Tasks. | `lib/crm-knowledge-engine.js`, `lib/crm-knowledge-health.js`, `lib/source-evidence.js`, `lib/source-admission.js`, `lib/effect-gate.js` | Paused |
| 12 | Identity + attribution | Deterministic contact matching at capture (names, aliases, email/phone), meeting entity resolution, alias learning with collision guard, Terra attribution reconciliation over whole transcripts. | `lib/contact-identity.js`, `lib/entity-resolution.js`, `lib/attribution-reconciliation.js`, `lib/company-identity.js` | Paused |
| 13 | Cross-linking syntheses | Cross-entity synthesis (Sonnet, nightly), interest radar (05:45), live thread synthesis (04:35). | `lib/synthesis.js`, `lib/knowledge-synthesis.js`, `lib/interest-synthesis.js` | Paused |
| 14 | Mycelium | Every 6h: document tasks, flight prep/check-in tasks, meeting prep tasks, regulatory tagging. | `lib/mycelium.js` | Paused |
| 15 | Task routing | Daily: route free-text tasks to the right contact/project. | `lib/task-router.js`, `lib/task-learning.js` | Paused |
| 16 | Knowledge lint + dedup | Weekly decay/staleness of atoms; receipt-backed atom dedup; work-loop guard. | `lib/knowledge-lint.js`, `lib/atom-dedup.js`, `lib/atoms.js` | Paused |
| 17 | Wiki / Ask the Hub | Natural-language answers over compiled atoms then source evidence; Synthadoc/Obsidian browse fallback. | `routes/wiki.js`, `lib/wiki-engine.js`, `lib/wiki-knowledge-search.js`, `lib/retrieval.js` | Paused (synthadoc.service stopped) |
| 18 | Project chat | `/c` conversations and `/p/:slug` project chats with rolling `_Project Memory.md` compaction. | `routes/hub.js`, `lib/memory-compactor.js`, `lib/router.js` | Website on |

### C. Actions

| # | Function | What it did | Main files | Status |
|---|---|---|---|---|
| 19 | Google Tasks | Single task list; one door (`createTask`) with origin attribution; 15-min sync; "Later — Hub" list for start-dated tasks. | `lib/google-tasks.js` | Paused |
| 20 | Planner | `/crm/planner`: opt-in task blocks on Google Calendar, work/personal windows, 5-min conflict reflow, reshuffle, `[after:]`/`[start:]` floors, Print today. | `lib/task-calendar-planner.js`, `lib/task-planner-pdf.js` | Paused |
| 21 | Reminders | Overdue tasks, follow-ups, "remind me", birthdays on `/crm/reminders` (Google Chat delivery retired). | `lib/reminders.js` | Paused |
| 22 | CRM nudges | Keep-warm cadence, last-contacted, birthdays. | `lib/crm-nudges.js` | Paused |
| 23 | Suggestions | Daily action radar: travel timing, short-lived offers, outreach reasons; Create/Not this time/Dismiss/Wrong feedback learning. | `lib/suggestion-engine.js`, `lib/suggestion-learning.js`, `lib/opportunity-engine.js` | Paused |
| 24 | Flight tracker | See §1. | `routes/hub-flights.js`, `lib/flight-status.js`, `lib/flight-calendar-import.js` | **Running — kept** |
| 25 | Boox planner PDF | 04:50 daily: 90-day hyperlinked PDF per day to the Boox Drive folder. | `lib/boox-planner.js` | Paused |

### D. Briefings and emails out

| # | Function | What it did | Status |
|---|---|---|---|
| 26 | Morning CRM briefing | Day's meetings with contact context, flights, due tasks. `briefing_schedule_run`. | Paused |
| 27 | Nakai regulatory briefing | 07:00 EU/IE/UK regulator scan → Opus briefing to Nakai → audit and content confirmation to Douglas; hourly retry. `lib/regulatory-monitor.js`, `lib/nakai-intelligence-pipeline.js`. | Paused |
| 28 | US Block special edition | Mon/Wed/Fri US regulator scan; publishes only on a high-confidence Block story. | Paused |
| 29 | M365 Ops & Security brief | Weekdays 07:15, source-backed M365/Intune/SentinelOne etc. | Paused |
| 30 | Newsletter digest briefing | 05:30 PDF of previous day's newsletters. | Paused |
| 31 | Weekly digest | Sunday 14:00. | Off since 6 Aug |
| 32 | Project report schedules | Scheduled per-project reports. | Paused |
| 33 | rholdsworthconsulting.com stats | 07:00 visitor stats email for that site (also served from this VPS). `lib/rh-stats.js`. | Paused |

### E. Content and writing tools

| # | Function | What it did | Status |
|---|---|---|---|
| 34 | LinkedIn pipeline | `/lin` plan, cadence, queue, published; Grok + last30days research worker on the Mac; carousel PDFs via Puppeteer. `lib/linkedin-pipeline.js`, `lib/content-research*.js`. | Paused |
| 35 | AI text humanizer | `/humanizer`: surface + discourse rewrite with fabrication guard. | Website on |
| 36 | Prompt library / gym / builder | `prompt.mclellan.scot`: prompt library, optimiser, adaptations, agent packs. | Website on |
| 37 | Model style profiles | Monthly distillation of vendor prompt styles. | Paused |
| 38 | Public portfolio site | `douglas.mclellan.scot`: public site, executive summary, chat, JD analyser, `llms.txt`. | Website on |

### F. Self-monitoring

| # | Function | What it did | Status |
|---|---|---|---|
| 39 | Daily system report / Consigliere | 06:00 health and spend email with a model-written narrative. | Paused |
| 40 | Family agents + remediation | Deterministic "capo" health checks, auto-fix whitelist, quality boards → `/crm/questions`. | Paused |
| 41 | Self-repair venue | Mac-only nightly: mine errors → Grok fix in a worktree → gates → PR (optional auto-deploy). | Off |
| 42 | Model governance / effectiveness | Weekly governance review; monthly effectiveness board (retired 21 Aug). | Paused |
| 43 | Work-loop guard | Blocks repeated identical model work. | Paused |
| 44 | Token-burn dashboard | Spend dashboard (`token-burn-dashboard/`). | Unused |

---

## 3. Ideas worth carrying forward

- **One door in, one attributed path out.** Every capture is admitted with a readability verdict; every task records which module created it.
- **Derive, don't duplicate.** Raw source → synthesis → compiled knowledge → views. Relationships recognised from sources, not hand-entered rows.
- **Identity before models.** Match people deterministically before an AI sees the names; fail closed on ambiguity.
- **Task projection is one-shot** per action-bearing content; completed/deleted tasks are terminal.
- **Test completion markers, not counts.** A review that correctly made zero tasks is healthy.
- **Subscription model plane** (Mac mini CLIs, Ollama embeddings) instead of pay-per-call APIs.
- **Flights**: booking email → tracking job → actual times, verified against the real API response.

## 4. What went wrong

- Too many iterations layered on each other; contracts in `CLAUDE.md`, `ARCHITECTURE.md`, `MODULES.md` grew faster than the code could stay simple.
- Scheduled jobs piled up with no notion of "stale". When the Mac worker fell behind, ~7,300 model jobs queued (23 Sep–13 Oct), including weeks of briefings nobody would read.
- 44 functions for one person; several unused for a month before the pause.
- Storage sprawl: 1.4 GB `hub.db`, ad hoc DB copies inside `/app/data`, personal documents and CSVs in the repo root, VPS disk at ~95%.
- Many outputs went to email, competing for attention instead of reducing it.

## 5. Access framework inventory (names only)

**VPS `.env` keys:** PERPLEXITY_API_KEY, GOOGLE_AI_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, MISTRAL_API_KEY, EXA_API_KEY, BRAVE_SEARCH_API_KEY, AERODATABOX_KEY, AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID, AGENTMAIL_TO_DOUGLAS, AGENTMAIL_WORK_DOMAINS, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_WORKSPACE_DOMAIN, DOUGLAS_GOOGLE_EMAILS, NAKAI_GOOGLE_EMAILS, DOUGLAS_HUB_PASSWORD, NAKAI_HUB_PASSWORD, DOUGLAS_ADMIN_PASSWORD, NAKAI_ADMIN_PASSWORD, SESSION_SECRET, GMAIL_SMTP_USER, GMAIL_SMTP_APP_PASSWORD, CONTACT_FROM_NAME, HUB_URL, NODE_ENV, PORT, BRIEFING_USERS, HERMES_WEBHOOK_SECRET, KRISP_WEBHOOK_SECRET, WORKDAY_WEBHOOK_SECRET, SUBSTACK_SID, VAULT_PATH, VAULT_SYNC_KEY, SYNTHADOC_URL, REG_MONITOR_ENABLED, CONTENT_RESEARCH_DRIVER, CONTENT_RESEARCH_WORKER_SECRET, SUBSCRIPTION_AGENT_WORKER_SECRET, SUBSCRIPTION_AGENT_WORKER_ENABLED, LOCAL_EMBED_URL, LOCAL_EMBED_MODEL, SYSTEM_REPORT_HOUR, SYSTEM_REPORT_MINUTE, HUB_BOOX_TOKEN, BOOX_DRIVE_ENABLED, BOOX_DRIVE_USER, BOOX_DRIVE_QUEUE, CRM_KNOWLEDGE_AUTO_PROCESS_AFTER.

**Domains on the VPS nginx:** dchat, nchat, prompt, wiki, douglas, nakai `.mclellan.scot`; `rholdsworthconsulting.com`.

**Mac mini LaunchAgents:** `ai.hermes.gateway` (running), `com.mclellan.hub.{subscription-agent-worker, messages-capture, content-research-worker, ollama-tunnel, prod-snapshot, repair-venue}` (disabled), `com.mclellan.ollama-{env,start}`, `com.mclellan.workday-vault-sync` (running), `com.mclellan.dating-sync`.

**Users:** `douglas`, `nakai`.

## 6. Where Version Old is now

Code and design documents: git tag `version-old` on GitHub (`CLAUDE.md` "CRM prompt operating system", `ARCHITECTURE.md`, `MODULES.md`, `docs/hub-input-contract.md`, `lib/`).

Data: on 24 Oct 2026 Douglas chose to **delete** the knowledge layer and its raw sources rather than keep them, because some evidence had not been captured and much of it was stale. Deleted from every copy (VPS, Mac, Google Drive archive and backup folders): knowledge atoms (8,585), embeddings (18,222), decision receipts (39,421), email summaries (4,713), WhatsApp/iMessage messages (4,943), meeting intakes (39), documents (44), contacts (51), CRM facts (309), the Synthadoc/Obsidian wiki, and Hermes config/logs. Gmail and the AgentMail inbox still hold their own original mail.

What remains in Google Drive, `My Drive/Hub Version Old archive/`:

| File | Contents |
|---|---|
| `vps-app-data-briefings-portfolio-20261024.tar.gz` (105 MB) | Nakai, M365, newsletter and US Block briefing archives; portfolio DBs and their old backups |
| `mac-repo-code-only-20261024.tar.gz` (73 MB) | Mac repo working tree, without data or secrets |
| `mac-documents-hub-items-20261024.tar.gz` (21 MB) | The ten iOS companion app projects, Last30Days research, older repo bundle |
| `repo personal files/` | Beacon handover, resignation letters, flight CSVs that sat in the repo root |

Also removed: VPS daily backups (17 GB), VPS old DB copies, Mac prod snapshots (11 GB), Hermes, Ollama and its models, Obsidian app, Hub LaunchAgents, synthadoc/Boox services, prompt/wiki certificates. VPS disk 96% → 18%; Mac free space 28 GB → 60 GB.

## 7. State at retirement

- VPS on `9ec2fe7`, `hub.service` running with `HUB_JOBS_ONLY=flight_refresh,flight_backfill`.
- 7,296 stale subscription model jobs retired 24 Oct (marked failed, reason recorded).
- 19 unprocessed AgentMail messages tagged `hub-processed` + `hub-pause-skipped-20261024`.
- Full DB backup: `/root/hub-backups/hub-pre-resume-20261024.db.gz` (VPS, outside `/app`).
