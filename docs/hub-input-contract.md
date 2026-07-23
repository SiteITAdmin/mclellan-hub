# McLellan Hub Input Contract

**Purpose:** Before adding or changing any ingest path, check this contract. Every input should have a faithful raw store, an explicit synthesis path, a compiled layer, and visible surfaces. If an input only writes a convenience row or manual relationship, the design is incomplete.

The default shape is:

```text
raw input -> source evidence -> synthesis/review -> compiled knowledge or action -> visible surface
```

For CRM-facing material, the canonical path is:

```text
raw source -> crm_source_triage -> crm_duplicate_review -> synthesis/provenance merge -> crm_action_projection -> compiled atoms/events/tasks
```

`CRM_LEGACY_DIRECT_WRITES=1` is rollback-only. Do not extend legacy direct writes to `crm_facts`, `contact_projects`, `company_projects`, or Google Tasks as the normal design.

## Contract Table

| Input | Raw store | Synthesis path | Compiled layer | Visible surfaces and outputs |
|---|---|---|---|---|
| Hub chat messages | `conversations`, `messages` | `tagConversation()` for recall; project context builder; optional save-to-project/wiki actions | `recall_entries`; saved project `documents`; wiki pages when promoted | Chat UI, project chat, `/recall`, exports, saved project notes, wiki |
| Project chat uploads | `documents`, `messages`, ingestion package under `data/ingested`, vault raw source mirror | `mycelium_doc`; `embed_backfill`; `synthesis_run`; optional wiki generation | `embeddings`, `knowledge_atoms`, project documents, wiki pages | Project pages, Ask/knowledge queries, wiki, tasks from document extraction |
| Non-project chat file uploads | `messages`; ingestion package for large single docs | Immediate chat analysis; background `mycelium_doc` for long docs | Conversation context; potentially embeddings/atoms if package is picked up | Chat response, conversation history, possible later knowledge ingestion |
| Gmail received email | `email_summaries`; Gmail label state; `processing_failures` on errors | `email_process`; classifier; label learning; `crm_knowledge_engine`; newsletter/opportunity extractors | `knowledge_receipts`, `knowledge_atoms`, `google_tasks` via action projection, `meetings`/calendar events via action projection when a specific date+time is stated, `intel_items`, `travel_price_points`, `opportunity_signals` | Gmail labels, CRM/contact/project pages, tasks, calendar, briefings, suggestions, system report |
| Gmail sent email | `email_summaries` with `direction='sent'`; possible new `contacts` | Sent-email classifier; `crm_knowledge_engine`; legacy direct writes only if rollback flag is on | Source-backed atoms/actions should be produced through CRM engine | CRM context, project context, tasks for commitments, contact history |
| AgentMail inbound | `inbound_email_records`; compatibility `email_summaries`; AgentMail labels; `processing_failures` | `agentmail_process`; work/newsletter classification; `crm_knowledge_engine`; newsletter extraction | `knowledge_receipts`, `knowledge_atoms`, `google_tasks` via action projection, `intel_items` | AgentMail labels, CRM/project surfaces, tasks, newsletters, system report |
| Manual email label corrections | Gmail label state; email taxonomy tables and pending classification rows | Label learning in `email_process` | Improved taxonomy/routing rules | Better future filing, fewer pending review items |
| Meeting transcript upload | `meeting_intakes`, `meetings`, `meeting_attendees`, project meeting `documents` | `processMeetingTranscript()`; speaker review; `crm_knowledge_engine`; `synthesis_run` | `knowledge_receipts`, `knowledge_atoms`; legacy `crm_facts`/tasks only under rollback | Meeting pages, CRM contact/project pages, project docs, tasks, briefings |
| Krisp webhook | `meeting_intakes` with source metadata and raw fallback payload | Krisp normalizer; speaker review; meeting intake processing; CRM engine | Same as meeting transcript path | Meeting intake review, CRM/project knowledge, tasks if projected |
| Daily debrief | Obsidian debrief note; `debrief_sessions`; `debrief_messages` | Debrief interviewer/extractor; currently some direct CRM/task writes | Should become source evidence for atoms/actions; existing tasks/facts are compatibility output | Debrief notes, actions note, Google Tasks, CRM facts, project notes |
| Direct `/meeting` note submission | Meeting note files via `lib/meeting.js` | Meeting note generator | Needs explicit relationship to meeting intake/knowledge engine | Meeting note output; should be documented or consolidated with meeting intake |
| Workday interview/audio | Workday project `documents`; vault raw source; project `messages` | `ingestWorkdayInterview()` narrative; `embed_backfill`; `synthesis_run` | Embeddings and atoms once synthesized | Workday Journal project, vault/Synthadoc, possible tasks/project state knowledge |
| Calendar events (inbound) | Google Calendar via OAuth; synced `meetings` where applicable | `syncCalendarMeetings`; debrief context; work brief; interest synthesis | Meeting records, interest atoms/cache | Morning/work brief, meeting prep, CRM meetings, interest radar |
| Calendar events (outbound, from `crm_action_projection`) | Any `ENGINE_SOURCE_KINDS` source (email, meeting_intake, etc.) whose action has both a specific date and time | `crm_action_projection`'s `event` field; `lib/google-calendar.js` `createCalendarEvent` writes via Calendar API and upserts `meetings` directly (same unique key as the inbound sync, so no duplication) | `meetings` row with `source='crm-engine'`, `knowledge_receipts` `event_projection` on the `crm_action_projected` stage | Real Google Calendar event same-day, Work Brief Today/Coming Up, CRM meetings, `/crm/knowledge` health panel, daily system report "Calendar events" count |
| Google Tasks and manual tasks | `google_tasks` local mirror; Google Tasks remote list | `google_tasks_sync`; `task_route_run`; `crm_knowledge_engine` uses open/completed tasks as source kinds | Routed task links; completed-task durable atoms; action projection receipts | `/crm/tasks`, reminders, briefings, CRM/project task panels |
| Manual CRM contacts/companies/facts/links | `contacts`, `companies`, `crm_facts`, link tables | `atoms_backfill`; `synthesis_run`; contact vault sync | `knowledge_atoms` derived from curated facts; vault profile projections | CRM pages, contact vault notes, knowledge queries, briefings |
| CRM note or Hermes CRM webhook | Request body; CRM mutation outputs from command processor | Should be parsed as source evidence, then synthesized/reviewed | Ideally receipts, atoms, projected tasks/reminders | CRM updates, tasks, reminders, Google Chat interactions |
| WhatsApp / messaging via Hermes | `messaging_messages` (raw chat evidence with platform, chat, sender, body, external id) | `POST /api/messaging/capture` stores evidence; `crm_knowledge_engine` source kind `messaging_message` | `knowledge_receipts`, `knowledge_atoms`, high-confidence `google_tasks` via action projection | Contact/project knowledge panels, tasks, Ask the Hub, briefings |
| Reminders | `reminders`; linked task/fact metadata | `reminder_sweep`, `reminder_fire`, CRM nudges, content checks | Reminder state and escalation history | Google Chat cards, CRM reminders page, morning brief |
| Document task extraction | Existing `documents`; generated task candidates | `task_extractor`; task-learning rules; should route through action projection for CRM-bearing docs | `google_tasks`; `task_extraction_lessons`/feedback | Tasks page, project tasks, wrong-task learning |
| Obsidian/vault API | Vault markdown files under Synthadoc/Obsidian root | Trusted read/search/write API; optional Synthadoc ingest | Wiki/source pages; search index; possible future embeddings/atoms | Wiki, vault search, graph, external agent access |
| Wiki page creation/editing | Wiki markdown files; graph links | Wiki route handlers; URL ingest; Synthadoc where configured | Human-readable knowledge pages; graph edges | `wiki.mclellan.scot`, search, graph, source editing |
| RSS/creator/watchlist feeds | `rss_feeds`, `rss_articles`, `intel_sources`, `intel_documents`, `intel_items` | `watchlist_poll`; `ingestAllFeeds`; article extraction; newsletter generation; live-thread synthesis | Intelligence items, topic categories, thread atoms where synthesized | Newsletter dashboard, creator pages, briefings, content ideas |
| Newsletter/briefing curation | `intel_items`, `nl_formats`, `nl_interests`, `briefing_schedules`, `nl_briefings` | `generateBriefing`; scheduled briefing jobs; publish/unpublish knowledge capture | Published briefing atoms via `knowledge-format`; briefing PDFs/wiki notes | Newsletter UI, email briefings, PDF download, wiki, NoteMax |
| Regulatory monitor sites | `nakai_reg_monitor_sites`, `reg_monitor_items`, `reg_monitor_runs` | `runRegulatoryMonitor`; Nakai intelligence pipeline | Assessed regulatory items; potential project/company risk atoms | Regulatory emails, Nakai daily briefing, system/panic alerts |
| Flights from email/manual/import | `flights`; `system_jobs` for refresh/backfill | Ryanair parser; manual/import route; AeroDataBox lookup; `flight_refresh`; `mycelium_flights` | Flight state; travel tasks; potential travel timeline atoms | Flights page, stats, Google Tasks, system report |
| LinkedIn/content generation | `linkedin_posts`, content research suggestions, cadence policy in `crm_context` | `linkedin-pipeline`; content research; publish capture; LinkedIn agent-team receipts for research, draft/critic, artifact, managing editor, and publishing archivist checks | Published-post knowledge via `knowledge-format`; wiki note on publish; `knowledge_receipts` for agent-team verdicts | Content dashboard, queue, published archive, portfolio/public knowledge bundle, daily system report |
| Content cadence controls | `crm_context`, `reminders`, `content_research_suggestions` | Content reminders; `content_research_run`; suggestion engine | Suggestions and reminders | Content plan, Google Chat reminders, morning brief |
| Prompt tool inputs | `prompt_library`, `prompt_adaptations`, `prompt_optimizations`, `prompt_agent_packs` | Prompt optimizer/adapter/classifier; style profile synthesis | Saved prompts, adapted prompts, model-family style profiles in `crm_context`, receipts | Prompt app, admin model shaping, reusable agent packs |
| Portfolio admin profile/CV/skills | Portfolio DB: `profile`, `cv_context`, `skills`, `experiences`, `gaps`, `faqs`, `ai_instructions` | Portfolio renderers; CV PDF builder; public chat/JD analyser | Public career context; skill candidates | Portfolio pages, executive summary PDF, portfolio chat, JD analysis |
| Portfolio public chat/JD analyser/contact form | `portfolio_messages`, `jd_submissions`, contact email body | `routeMessage`; JD analyser; skill candidate extraction | Candidate skill signals; stored chat/JD evidence | Public chat responses, JD fit analysis, contact email |
| Model/admin settings | `model_config`, `crm_context`, `request_logs`, `test_runs` | Admin model slots; prompt override system; style profile run; Token Burn Auditor reads generated burn files plus `request_logs`; Hub Consigliere challenges source-family freshness and subordinate agent receipts | Model/prompt configuration, usage evidence, token-burn audit receipts, boss-layer governance receipts | `/admin/models`, `/admin/reports`, prompt shaping, cost/quality review, token burn dashboard, daily system report |
| System jobs and failures | `system_jobs`, `processing_failures`, logs | `processJobs`; retry/refetch paths; system report; capo/underboss/Consigliere agent family receipts | Health state, failure counts, module capo verdicts, underboss verdicts | `/admin/jobs`, daily system report, diagnostic follow-up |

## Add-New-Input Checklist

Before implementing a new input, answer these questions in the PR, commit notes, or user update:

1. **Raw store:** Where is the source preserved faithfully with provenance?
2. **Source kind:** What source kind will synthesis use, if this can affect knowledge?
3. **Synthesis path:** Which job or prompt decides whether it is new, duplicate, stale, superseded, unrelated, or actionable?
4. **Compiled layer:** Does the result become `knowledge_atoms`, `knowledge_receipts`, `google_tasks`, `reminders`, wiki pages, briefings, or another compiled cache?
5. **Visible surface:** Where will Douglas see it without remembering to look manually?
6. **Failure visibility:** If it fails or produces no output, where is that visible?
7. **Backfill/repair:** If existing production rows are already missing the output, what backfill or repair is needed?

## Design Notes

- A raw store without synthesis is an archive, not a second brain.
- A task without provenance is easy to duplicate and hard to trust.
- A manual link is acceptable as containment or user confirmation, but it should not be the only long-term relationship mechanism.
- Direct writes to CRM tables from ingest paths are legacy/rollback behavior unless explicitly documented as containment.
- Every source that can change what the Hub knows should eventually leave receipts explaining what was decided and why.
