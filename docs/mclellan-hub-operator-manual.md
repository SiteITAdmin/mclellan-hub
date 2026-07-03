# McLellan Hub Operator Manual

**Version:** 3.0
**Current as of:** 12 June 2026
**Repository:** `SiteITAdmin/mclellan-hub`  
**Production host:** `178.104.235.142` (`/app`, `hub.service`)

## Purpose

This is the system and operating manual for the complete McLellan tool set. It explains what each tool is for, where to find it, what information it consumes and produces, how the tools exchange information, what runs automatically, how agent assessments work, and how to deploy, back up, diagnose, and recover the system.

The Hub is a private operating environment rather than a collection of isolated apps. Chat, projects, CRM, email, meetings, tasks, the wiki, content, flights, intelligence, and the public portfolio share context through the Hub database, Google services, and the Obsidian/Synthadoc knowledge store.

### Status language used in this manual

- **Working:** real production data shows the end-to-end outcome.
- **Partial:** the feature works through at least one path, but a named or expected path is incomplete.
- **Configured:** code, credentials, or a schedule exists, but useful output has not been verified.
- **Manual:** the feature works only when someone deliberately starts it.
- **Advisory:** the feature recommends an action but does not act automatically.
- **Oddity:** a process is misplaced, duplicated, misleadingly named, ineffective, or silently failing.

## 1. Quick Start

### Main addresses

| Address | Purpose | Access |
|---|---|---|
| `https://dchat.mclellan.scot` | Douglas Hub and AI chat | Private Google sign-in |
| `https://nchat.mclellan.scot` | Nakai Hub and AI chat | Private Google sign-in |
| `https://wiki.mclellan.scot` | Searchable knowledge wiki | Private |
| `https://douglas.mclellan.scot` | Douglas public portfolio and CV | Public; admin is private |
| `https://nakai.mclellan.scot` | Nakai public portfolio | Public; admin is private |

### Hub home tools

| Tile | Route | Use it for |
|---|---|---|
| AI Chat | `/c` | General work, project conversations, research, document analysis |
| Wiki | `wiki.mclellan.scot` | Search, browse, create, and edit durable knowledge |
| CRM | `/crm` | People, companies, meetings, facts, decisions, and follow-ups |
| Daily Debrief | `/debrief` | Voice-led end-of-day reflection and action capture |
| Content | `/lin` | LinkedIn research, drafting, scoring, and assets |
| Tasks | `/crm/tasks` | Google Tasks linked to people, companies, and projects |
| Flights | `/flights` | Flight history, imports, airline data, and statistics |
| Intelligence | `/newsletter` | Weekly briefings generated from newsletters and interests |
| Token Burn | `/token-burn` | Imported model/token usage reporting |

### Normal daily rhythm

1. Read the morning CRM briefing in Google Chat.
2. Use AI Chat for active work and keep project-specific work in its project.
3. Review `/crm/tasks` and the relevant person or company before calls.
4. Let email processing classify messages and create context or tasks.
5. Use Meeting Capture for substantive calls.
6. Run Daily Debrief at the end of the day.
7. Use the wiki for durable retrieval rather than searching old chats manually.

## 2. How the System Fits Together

### Core architecture

- **Application:** Node.js, Express, EJS, and SQLite (`better-sqlite3`).
- **Production:** Nginx in front of `hub.service` on the VPS.
- **Identity:** Google OAuth for Hub users; separate protected admin/wiki routes.
- **AI:** OpenRouter plus configured OpenAI and Google capabilities.
- **Google Workspace:** Gmail, Calendar, Drive, Sheets, Tasks, and Google Chat.
- **Knowledge:** a derived knowledge layer (see below) compiled from all sources; the Obsidian/Synthadoc vault is one human-readable store feeding it.
- **Public output:** Portfolio pages, CV tools, RSS feeds, and `llms.txt`.

### The knowledge layer (the substrate, not a table)

The CRM, wiki, and project pages are no longer the knowledge — they are **views over a derived substrate** compiled continuously from the raw material:

- **Embeddings (`embeddings`):** documents, email summaries, CRM facts, meeting transcripts and atoms are embedded (OpenRouter; model set in admin) for semantic retrieval.
- **Atoms (`knowledge_atoms`):** derived `subject–predicate–value` claims, each with provenance (the source rows that justify it), confidence and status. Not authored by hand.
- **CRM prompt engine (`crm_knowledge_engine`):** reviews raw CRM-bound sources through `crm_source_triage`, `crm_duplicate_review`, synthesis/provenance merge, and `crm_action_projection` before knowledge or tasks are compiled.
- **Synthesis (nightly `synthesis_run`):** re-reads new sources *after* ingestion, extracts atoms and links them to the right contact/company/project from the whole corpus — so a care-plan address attaches to the person even though the email that first arrived knew nothing about them.
- **Live threads (`live_thread_synthesis`):** reads across Gmail summaries, meeting intakes, newsletter/RSS intelligence, opportunity signals, and atoms to compile cross-source themes as `subject_kind = 'thread'`. This is how a Masterclass email about managing change can connect with M365 material and hospital department meeting notes without being forced into one CRM bucket.
- **Routing & lint:** `task_route_run` attaches free-text tasks to the entity their knowledge points to; `knowledge_lint_run` decays stale claims and surfaces contradictions/duplicates at `/admin/knowledge`.

A contact or project page renders the atoms about that entity, each claim click-through to its source. The vault/wiki is a feeder and a human-facing view — not the master knowledge store.

### Shared context flow

| Source | What is captured | Where it becomes useful |
|---|---|---|
| Chat | Conversations, ratings, project messages, saved answers | Project context, recall, wiki |
| Gmail/AgentMail | Summaries, source records, labels | CRM knowledge engine, projects, Tasks, briefings |
| Calendar | Today’s events | Morning briefing, meeting preparation |
| Meetings | Transcript, summary, source evidence | CRM knowledge engine, vault, wiki |
| Daily Debrief | People, projects, decisions, actions | Vault, project notes, Google Tasks |
| Workday Interview | Structured journal and project document | Workday Journal, vault, Synthadoc |
| Newsletter mail | Topics and source material | Intelligence briefings, RSS, portfolio |
| Boox Drive | Imported notebook files | Vault and Synthadoc search |

### Source-of-truth rule

- SQLite is the operational store for the Hub.
- Google remains authoritative for Gmail, Calendar, Drive, Sheets, and Tasks.
- The Obsidian vault is the durable human-readable knowledge store.
- Git is the source of truth for application code and maintained documentation.
- Production data must not be overwritten by deployment; it is backed up separately.

## 3. AI Chat and Projects

### What it does

AI Chat is the general work surface. It supports model selection, web research, file uploads, document extraction, image generation where configured, conversation history, project context, and exports.

### Use a project when

- The work will continue over more than one conversation.
- The work depends on project documents, past decisions, or named people.
- The answer should become reusable context.
- You want the assistant to search a constrained body of material.

### Useful commands

| Command | Result |
|---|---|
| `/slug` | Works with the named project slug or shows project-command help |
| `/recall terms` | Finds relevant past conversations |
| `/recall terms` plus a question | Injects recalled context and answers the question |
| `/tasks` | Syncs and lists open Google Tasks |
| `/tasks add title` | Creates a Google Task |
| `/tasks done words` | Completes the first open title containing those words |

### Files, project documents, and exports

- Upload supported documents to a chat for extraction and analysis.
- A chat upload can be analysed immediately without becoming a project document.
- A project upload becomes reusable project context and is listed in the project document panel.
- Supported project uploads include PDF, DOCX, PPT/PPTX, XLS/XLSX, EPUB, HTML, TXT, Markdown, CSV, and common image formats. The upload limit is 10 MB.
- Use the **wiki** toggle during a project upload to create a durable Wiki page at the same time.
- Use **to wiki** beside an existing project document to create the Wiki page later.
- Images use the configured Wiki vision model to produce a factual description before the Wiki page writer structures the page.
- Save useful individual chat answers into a project, or save them directly to Wiki.
- Export suitable responses as Word, PDF, or Google Docs.
- Use ratings when an answer is notably good or poor; ratings help model evaluation.

Deleting a project document removes the database document record. It does not automatically delete a Wiki page already generated from that document.

### Model controls

Administrators can set model tiers, chat defaults, named pipeline slots, complete prompt overrides, custom provider keys, and quick-start cards. The model test arena compares candidate models on the same prompt. Use the lowest-cost tier that reliably completes the task; reserve stronger models for ambiguous analysis, long synthesis, vision, and high-stakes drafting.

The model selected in AI Chat controls that conversation only. Background features such as email classification, Wiki writing, debrief extraction, and LinkedIn drafting use their own named system-model slots.

## 4. CRM: People, Companies, and Context

### What the CRM stores

- Contacts and their notes.
- Companies and contact-company relationships.
- Meetings and linked contacts.
- Facts, decisions, actions, and notes.
- Statuses such as active, follow-up, completed, or superseded.
- Derived atoms and prompt receipts compiled from source evidence.
- Connections inferred from synthesis, duplicate review, shared meetings, and linked records.
- Google Tasks linked to people and companies.

### Before a meeting

1. Open the person at `/crm/contacts` or company at `/crm/companies`.
2. Review recent facts, open actions, meetings, colleagues, and tasks.
3. Check the morning briefing and Calendar context.
4. Open linked project material if the relationship belongs to a project.

### Capturing CRM context

Use the CRM note input or a natural-language CRM command in chat. For source-driven material such as email, AgentMail, meetings, and documents, the CRM knowledge engine should decide whether the source is knowledge, a duplicate, a supersession, or an action before it becomes a fact or task.

### Good CRM facts

- “Sent revised commercial proposal on 5 June.”
- “Decision: use a two-stage discovery process.”
- “Follow up with Maeve about the July workshop.”

Avoid vague entries such as “Good call” unless the useful detail is included.

### Connected views

The contact and company pages are designed as briefing pages, not address books. They bring together activity across meetings, facts, relationships, open actions, and tasks. Use **Show history** when you need completed or locally deleted task context.

## 5. Google Tasks

### Where tasks come from

- Manual entry on `/crm/tasks`.
- Quick entry on a contact or company page.
- `/tasks add` in AI Chat.
- Prompt-led CRM action projection from email, AgentMail, meetings, documents, completed tasks, and source evidence.
- Direct reminders or manual operational commands where the user explicitly asks for a task.

### Task fields

Tasks can carry a title, notes, due date, local due time, person, company, project, source, and source record. The Hub caches Tasks locally for fast CRM display while Google Tasks remains the external task service.

Select a task title to open its detail page. From there you can edit its fields, link or relink CRM/project context, inspect source and sync metadata, and add Google Tasks subtasks. Google Tasks stores a date but not a due time; the **Due time** field is therefore Hub-only.

### Completion and deletion

- **Done** completes the task in Google Tasks and in the Hub cache.
- **Delete** hides the task locally; it does not delete the Google Task.
- **Restore** removes the local deletion marker.
- Tasks removed or completed in Google are marked completed during the next sync.

### First use after the Tasks release

Google Tasks requires an additional OAuth permission. If the Tasks page reports an authorization or insufficient-scope error, sign out and complete Google sign-in again so the stored refresh token includes the Tasks scope.

## 6. Calendar and Morning Briefing

The Calendar integration reads today’s events. The automated CRM briefing combines Calendar events, relevant contacts and facts, follow-ups, wiki knowledge, and open Tasks, then sends the result to Google Chat.

### Morning briefing schedule

- Calendar sync: **06:45 Europe/Dublin**
- CRM briefing: **07:30 Europe/London**

### If the briefing is missing

1. Confirm `hub.service` is running.
2. Check the Google refresh token and Calendar permission.
3. Check the configured Google Chat destination.
4. Inspect service logs for `[crm]` or briefing errors.
5. Confirm a briefing was not already recorded for that date.

## 7. Email Intelligence

### Ingestion

- Gmail processing runs every 15 minutes.
- AgentMail processing runs every 15 minutes.
- A daily email digest is sent at 16:00 Europe/Dublin.

### What processing can do

- Summarize a message.
- Match a canonical Gmail taxonomy label.
- Store source evidence for the CRM knowledge engine.
- Feed `crm_source_triage`, duplicate/supersession review, synthesis, and action projection.
- Extract newsletters into intelligence topics.
- Import Ryanair itinerary details into Flights.
- Ignore passive notifications and automated messages when no action is required.

### Canonical taxonomy

The main roots are:

- Action
- People
- Organisations
- Projects
- Travel
- Finance
- Commerce
- Systems
- Resources

Rules are maintained in the email taxonomy configuration and admin page. Manual Gmail labeling is used as learning evidence: when a recent processed Gmail message has exactly one canonical Hub label, the email processor learns or updates a sender rule for future messages from that sender. Messages with zero or multiple canonical labels are ignored as ambiguous. Use the audit and migration scripts before broad taxonomy changes.

### Task-creation threshold

Email should project a task only after the CRM knowledge engine identifies a specific required action, such as replying, approving, paying, signing, deciding, or completing a form, and duplicate review does not find an existing open action. Newsletters, alerts, FYI messages, and routine automated mail should not create tasks.

## 8. Intelligence Briefings

### Workflow

1. Newsletter email is ingested.
2. Topics and sources are extracted.
3. Interests and preferred briefing formats guide selection.
4. Generate a briefing.
5. Review and edit it.
6. Send it, export it to the wiki, create a PDF, or publish it.

Topic selection updates immediately in the browser. The week can be selected explicitly, and date ranges can be applied when generating a briefing.

### Creator RSS reading

The **Creators** area is a separate source path for publications with RSS feeds:

1. Add a creator name, stable slug, and feed URL.
2. Select **Fetch now**, or wait for the daily 09:30 RSS ingestion.
3. Open the creator page to see stored articles and word counts.
4. Open an article in the private full-article reader, or open the combined **Reading list** before going offline.
5. Generate a creator-specific briefing from selected stored articles.

RSS articles are stored in the Hub database. They are not written automatically to the Obsidian vault or Wiki. This avoids filling durable knowledge with every article before it has been reviewed.

For Substack feeds, setting `SUBSTACK_SID` allows the fetcher to send the subscriber session cookie. Whether full paid text is returned still depends on what the publication exposes through its feed. Keep this credential private and refresh it when the Substack session expires.

### Publishing

Published briefings can appear through the Douglas portfolio’s RSS feed and `llms.txt`:

- `https://douglas.mclellan.scot/feed.xml`
- `https://douglas.mclellan.scot/llms.txt`

Unpublish material that should no longer be public. Publishing is a deliberate public action; generated drafts remain private until published.

### Reminder

A newsletter reminder runs on Saturday at 09:00.

## 9. Wiki, Synthadoc, Obsidian, and Boox

### Wiki

The Wiki is one human-facing view over the knowledge layer (see "The knowledge layer" in section 2) — not the master knowledge store. It indexes Markdown from Wiki pages, meetings, journals, daily notes, Workday interviews, people notes, project notes, nested project files, and loose vault notes. Search also includes matching email summaries from SQLite. The derived substrate (embeddings + atoms + nightly synthesis) is what links facts to people across the whole corpus.

For every search, the Wiki:

1. Runs local full-text retrieval across indexed vault files.
2. Adds matching email summaries.
3. Labels every excerpt with a source ID.
4. Optionally asks the configured model to produce a source-bounded JSON synthesis with a headline, summary, facts, gaps, and an evidence-completeness assessment.

The synthesis model is currently hardcoded in the Wiki route rather than selected through the named model-slot administration. If model governance should apply uniformly, this route needs to use the configured Wiki/search slot.

### Creating and editing pages

- Select **New page** in the Wiki to create a Markdown page with title, categories, and tags.
- Select **Edit** on a page to change its title metadata and Markdown body.
- Rename changes the page slug and therefore its URL.
- Delete removes the page file immediately and cannot be undone from the UI.
- Wiki links use `[[slug]]`; generated pages may add a Related section automatically.

Renaming a slug does not rewrite every inbound `[[wikilink]]`. After a rename, search for the old slug and repair references. Before deleting a page, check related pages and backlinks.

### Sending material to Wiki

Wiki pages can be generated from:

- A chat question and answer.
- A project document.
- A project image, using the vision slot first.
- An Intelligence briefing.
- Direct manual authoring in the Wiki editor.

The configured **Wiki page writer** controls document and Q&A conversion. The **Wiki image vision** slot describes image content. Generated output is stored as a Markdown file under the Wiki area of the vault, with categories, tags, confidence, creation date, and related links.

### Synthadoc

Synthadoc indexes raw sources into searchable knowledge. It runs as an HTTP sidecar, normally at the configured `SYNTHADOC_URL`, and supports status, list, ingest, jobs, and serve operations. The Hub submits URL, YouTube, Workday, and local-source ingestion through the API. If the sidecar is unavailable, Wiki browsing and the Hub's local full-text fallback still work, but semantic context building and new queued ingestion are unavailable.

As checked on 12 June 2026, production had 116 Markdown knowledge files, including 32 Wiki pages, but no service listening at `127.0.0.1:7091`. This means the durable files exist while the expected production sidecar is not running.

### Obsidian vault

The vault is the readable, editable knowledge layer. Trusted API operations support list, search, read, and write. Keep filenames and links stable because project pages, people notes, and meeting references depend on them.

### Workday vault sync

`scripts/sync-workday-vault.sh` synchronizes Workday material into the indexed knowledge workspace, rebuilds daily indexes, and can generate a digest. The installed macOS LaunchAgent runs every 30 minutes and invokes `/Users/dm_mini/bin/sync-workday-vault.sh`.

The repository plist describes a different five-minute schedule and a different script path. The installed LaunchAgent is authoritative for the current Mac. Its configured output logs were empty at the 12 June audit, so a successful run should be verified from output files and timestamps rather than assumed from the installed plist.

### Wiki graph and relationship repair

The graph is built from `[[wikilinks]]`, title/alias resolution, and manually confirmed relationships. It can:

- Show real pages and unresolved phantom nodes.
- Add a `same` or `related` relationship.
- Store manual relationships in `raw_sources/manual-links.json`.
- Write backlinks into writable Wiki pages.
- Remove both the relationship record and the corresponding links from writable pages.

Project and people notes are created automatically when graph data is requested so that CRM entities and the vault share stable nodes. The Orphans view identifies pages with no useful links, while the graph exposes broken or unresolved links.

### Wiki write and delete behavior

- New and edited Wiki pages are Markdown files under `wiki/`.
- Renaming changes the slug and URL but does not rewrite every inbound link.
- Deleting a page is immediate from the UI and writes a deletion tombstone for synchronization.
- Source files outside `wiki/` can be read and, through the source editor, deliberately edited.
- Manual graph links are durable because they are stored in the vault rather than only in the browser or database.

### Boox Drive import

The Boox importer reads configured Drive notebook sources and imports them into the knowledge workspace. The default operating posture is import-only: do not delete or rewrite Drive originals as part of ingestion.

## 10. Daily Debrief, Meetings, and Workday Interview

### Daily Debrief

Daily Debrief is a hands-free, phased voice interview. It is Calendar-aware and designed to surface events, observations, people, decisions, and unfinished work.

On completion it:

- Saves a timestamped note under `Debrief/`.
- Extracts people and project references.
- Saves an action note.
- Creates deduplicated Google Tasks for extracted actions.

### Meeting Capture

Use Meeting Capture for substantive calls or discussions. Provide audio or a transcript. The system transcribes when needed, writes a structured meeting note with wiki links, associates project context, and records suitable CRM facts.

### Workday Interview

Workday Interview creates a structured journal entry and project document from a guided interview. It can be used from the browser, through webhook/audio endpoints, or from a Siri Shortcut. Output is saved to the Workday Journal and the vault’s `raw_sources/workday` area, then queued for Synthadoc.

## 11. LinkedIn Content

The Content tool at `/lin` supports the full drafting pipeline:

1. Research a topic.
2. Produce a draft.
3. Score the draft.
4. Refine weak sections.
5. Generate a carousel or image asset when suitable.
6. Upload assets to Drive.
7. Record the item in the Sheets content calendar.
8. Track status, schedule, and publication.

Google Chat/Hermes also accepts `linkedin <topic>` for a fast drafting workflow.

Use the scoring stage as editorial feedback, not as an automatic publishing decision. Confirm facts, links, names, and public positioning before publication.

## 12. Flights

### Intended end-to-end behavior

The Flight Tracker is intended to follow a Ryanair journey from booking email through preparation, departure, arrival, and final historical statistics:

1. Gmail processing identifies a Ryanair itinerary and creates the flight record.
2. A scheduled flight immediately queues Mycelium task creation and a `flight_refresh` job.
3. Mycelium creates preparation and check-in tasks when the travel date approaches.
4. The live worker starts two hours before departure and checks AeroDataBox every 30 minutes.
5. The worker records revised departure/arrival times and resolves completed, cancelled, or diverted flights.
6. A nightly backfill repairs recently completed flights with missing actual times.
7. The Flights page calculates route, airline, delay, duration, and punctuality statistics.

### User-visible capabilities

- Manual create, update, and delete.
- XLSX import for historical records.
- Ryanair itinerary extraction from email.
- Single and bulk AeroDataBox lookups.
- Scheduled versus actual departure and arrival times.
- Route, airline, delay, and actual-duration statistics.

### What production showed on 12 June 2026

The 11 June flight `FR808 DUB-EDI` is present as completed with scheduled times `06:10-07:20` and actual times `06:11-06:58`. It was repaired by the backfill around 19:06 on 11 June rather than captured reliably by the live tracker. The system therefore contains the journey now, but the live-tracking promise was not met at travel time.

The return flight `FR815 EDI-DUB` for 13 June had `actual_arr=23:05` written before the flight occurred. This is not an actual arrival; the backfill treated a future revised/scheduled value as actual.

### Flight failure signals

- A completed flight has blank `actual_dep` or `actual_arr`.
- A future flight has an actual time.
- A scheduled flight has no pending `flight_refresh` job.
- Multiple pending `flight_backfill` jobs exist.
- The tracker logs “tracking complete” without storing actual times.
- Preparation/check-in tasks are created after the journey rather than before it.

Keep imported workbook formats stable. Do not manually invent actual times. Use the lookup/backfill path, inspect the raw provider fields, and confirm the database result.

## 13. Profile, Public Portfolio, and CV Tools

### What the Profile system is

The Profile system is both a public portfolio and a structured candidate knowledge base. It serves four different audiences:

- A human visitor reading the public page.
- A recruiter downloading the Executive Summary PDF.
- A visitor asking the public portfolio AI questions.
- A visitor submitting a role to Candidate Analysis.

These surfaces do not use the same context. A field being present in Admin does not mean it appears everywhere.

### Main data stores

- `profile`: identity, contact details, role preferences, working style, salary, availability, and values.
- `cv_context`: flexible public copy and broad AI context.
- `experiences`: employment timeline and evidence.
- `skills`: visible and AI-readable capability records.
- `skill_candidates`: topics detected from CV-tagged Hub projects.
- `gaps`: honest limitations and development areas.
- `faqs`: prepared public-chat answers.
- `ai_instructions`: behavioral instructions for portfolio chat.
- `jd_submissions`: submitted role descriptions and generated assessments.
- `portfolio_messages`: public AI-chat transcripts.
- Hub projects marked `is_cv_context=1`: private evidence made available to selected portfolio workflows.

Production contained 19 CV-context rows, 10 experiences, 41 skills, 24 detected skill candidates, 7 Candidate Analysis submissions, and 43 portfolio messages at the audit date.

### Public page

The public page combines selected database fields with some hardcoded sections:

- Hero: name, credentials, title, tagline, portrait, availability, notice period, and remote preference.
- Vision section: configurable CV-copy fields.
- AI-assisted builds: currently Douglas-specific content from `lib/aiBuilds.js`.
- Experience timeline: experiences marked as CV context.
- Capability: only the first three `strong` skills are data-driven; other cards contain static text.
- Governance essay and statistics: configured CV-copy fields plus two hardcoded visual tiles.
- Footer: role label, email, phone reveal, LinkedIn, and Executive Summary link.

### Executive Summary PDF

The PDF includes profile identity/contact basics, role label, summary, location, LinkedIn, the first five CV-context experiences, and Douglas's AI-assisted builds. It does not currently include salary, values, gaps, FAQs, management style, target roles, or the selected availability/remote fields, even though some of those are present elsewhere.

### Portfolio AI chat

This is the broadest Profile surface. It receives profile preferences, all CV copy, experiences, detailed skills, gaps, values, FAQs, AI instructions, chat-only detected topics, recent messages from CV-context Hub projects, and recent visitor conversation history. It speaks in first person as the candidate and is instructed not to fabricate.

Because salary, preferences, and other backend-only fields can be supplied to a public visitor through AI chat, every Profile field should be treated as potentially public unless the prompt explicitly excludes it.

### Candidate Analysis

Candidate Analysis is narrower than portfolio chat. It receives:

- All CV-context rows.
- CV-context experiences.
- Skills as name, level, and category.
- Douglas AI-assisted builds.
- The submitted role description.

It does not receive most profile preferences, detailed skill evidence, gaps, values, FAQs, AI instructions, or Hub project memories. Each submission and response is retained for Admin review.

### Profile Admin

The private Admin tabs control:

- **Profile:** identity, contact details, target roles, preferences, working style, salary, availability, remote preference, and values.
- **Experience:** public/AI/PDF roles and their ordering. Existing rows can currently be added or deleted but not fully edited inline.
- **Skills:** level, category, evidence, self-rating, years, recency, and honest notes.
- **Detected Topics:** repeated topics found in CV-tagged Hub projects; promote to a skill, expose to chat only, dismiss, or reset.
- **Gaps:** honest limitations supplied to portfolio chat.
- **Values & Culture:** working-environment preferences supplied to portfolio chat.
- **FAQ:** prepared answers supplied to portfolio chat.
- **AI Instructions:** honesty level and additional chat behavior.
- **Candidate Analysis Submissions:** read-only review of public submissions and responses.
- **CV Copy:** flexible key/value content; only known keys render visibly, but every key can influence AI.
- **Hub Projects:** controls which private projects feed portfolio chat and topic detection.

### Profile surfacing gaps

- Values, gaps, FAQs, management style, and detailed skill evidence influence portfolio chat but not Candidate Analysis.
- Salary is available to portfolio chat but not visibly printed.
- Availability and remote preference appear on the page but not in the current PDF.
- Hub project evidence reaches portfolio chat and topic detection, but not the PDF or Candidate Analysis except through promoted skills.
- Several visible capability/strategy blocks are hardcoded and cannot be maintained from Admin.
- New arbitrary CV-copy keys affect AI but do not create new public-page sections.

Treat Profile changes as public publishing. Preview the page, test both AI surfaces, and generate the PDF after factual edits.

## 14. Token Burn

Token Burn displays imported daily model usage plus OpenRouter summaries. It is a reporting view, not the billing source of truth.

Update data with:

```bash
./scripts/update-token-burn-data.sh
```

Install or repair the nightly 02:00 refresh with:

```bash
./scripts/install-token-burn-refresh.sh
```

The LaunchAgent runs once when installed and writes its log to
`data/logs/token-burn-refresh.log`.

The dashboard reads deployed JSON data and normally does not require an application restart after a data-only update.

## 15. Hermes and Google Chat

Hermes provides a conversational route into Hub capabilities from Google Chat or a protected webhook. It supports CRM capture and lookup, briefing delivery, and commands such as LinkedIn drafting.

### Operational rules

- Keep `HERMES_WEBHOOK_SECRET` private.
- Configure the correct Google Chat webhook or app identity for each user.
- Treat incoming commands as user actions and keep write endpoints authenticated.
- Inspect service logs when Google Chat receives no reply; delivery and command processing fail at different stages.

## 16. Admin and Model Operations

Open `/admin` on the appropriate Hub and sign in with the authorised Google Workspace account. Admin settings are operational controls: changes can affect live chat, background processing, public portfolio features, and scheduled pipelines immediately.

### Admin navigation

Admin tools cover:

- Projects, memory, and project documents.
- Knowledge and CRM Wiki tags.
- Email taxonomy, audits, and manual processing triggers.
- Chat request logs and answer ratings.
- Daily Debrief sessions.
- Model catalogue, tiers, defaults, named system slots, full prompt overrides, and custom API keys.
- Quick-start cards shown on the Chat welcome screen.
- Model test arena.
- LinkedIn content administration.
- RSS feed management.
- MCP-style project endpoints.

### Projects and memory

The Projects screen controls project name, slug, context depth, CV-context status, and Wiki tags. Opening a project shows:

- Stored chat messages in context order.
- Uploaded documents and extracted Markdown.
- Matched Wiki pages based on assigned tags.
- Controls to remove individual memories or documents.

Deleting a project can either detach its messages or delete them. Read the confirmation carefully. Project slug changes affect `/slug` commands and links.

### CRM and knowledge tags

Admin CRM assigns Wiki tags to contacts. Project and contact tags are matched against Wiki metadata to surface useful pages in briefing views. The unassigned-tag section highlights Wiki tags not currently connected to a project or contact.

### Models: catalogue versus slots

The **Current models** catalogue defines which models are available to chat and to system slots. Each record can contain:

- Internal key and display label.
- Provider model ID.
- Tier and category.
- Search mode: native, OpenRouter web plugin, or none.
- Input/output cost and context length for display and comparison.
- Optional custom provider base URL.
- Optional API key environment-variable name or stored API key.
- Enabled/disabled status.

The chat default is the model initially selected in the ordinary Chat picker. Disabling a model removes it from active selection. Delete is available only after disabling it.

### Search modes

- **Native:** the model itself performs search, such as a search-native provider model.
- **Web plugin:** OpenRouter supplies the configured web-search tool to a tool-capable model.
- **None:** the model has no provider search; Hub-side Exa or Brave context can still be used by workflows that support it.

Do not mark an ordinary model as native merely because it can reason about current events. Search mode describes an actual retrieval capability.

### Tiers

Tiers group models in the Chat picker and provide a default search mode for newly added models. A tier key is referenced by model records; changing or deleting a tier can leave existing models ungrouped. Prefer adding a replacement tier, moving models, and only then deleting the old tier.

### Named system-model slots

Pipeline slots separate background and specialist work from the interactive Chat model:

| Group | Slots |
|---|---|
| Chat infrastructure | Recall tagger, multi-search planner, multi-search synthesiser |
| Background processing | CRM intent parser, email classifier, regulatory synopsis, prompt improver, test synthesiser |
| CRM knowledge engine | Source triage, duplicate/supersession review, action projection |
| Knowledge layer | Embeddings model, atom extractor, completed task extractor, entity linker, cross-entity synthesis, live thread synthesis |
| Debrief | Interviewer, extractor |
| LinkedIn | Query planner, research synthesiser, post drafter, scorer, carousel generator, refiner/reviewer, image-prompt writer |
| Workday | Narrative writer |
| Public portfolio | Ask-me chat, job-description analyser |
| Wiki | Page writer, image vision |
| Newsletter intelligence | Topic extractor, briefing writer |

Slots marked **system** are shared across users. Slots marked **user** apply only to the current Hub account. Leaving a slot unset uses its built-in fallback.

When changing a slot:

1. Confirm whether the scope is system-wide or per-user.
2. Select an enabled model suited to the job and modality.
3. Save the slot.
4. Run a representative workflow or Test Arena prompt.
5. Check request logs, output quality, latency, and token cost.

Use inexpensive models for silent high-volume work such as recall tagging and newsletter extraction. Use a vision-capable model for Wiki image vision. Public portfolio slots can be triggered by visitors, so cost and abuse resistance matter.

### Prompt editing

Each supported slot has a **Prompt** control showing the complete default prompt. Saving it creates an override; **Restore default** clears the override and returns to the code-defined prompt.

Supported runtime placeholders include:

- `[DATE]` - current date.
- `[NAME]` - current user's display name.
- `[CALENDAR]` - current calendar context.
- `[CONTEXT]` - known CRM context.
- `[NOTE]` - raw CRM note.
- `[CATEGORIES]` - allowed newsletter categories.
- `[PEOPLE]` and `[PROJECTS]` - known entities for extraction.

Preserve required output contracts. Several slots require strict JSON, exact keys, a completion token, or a constrained word count. Removing those instructions can break the caller even when the prose looks better.

Prompt overrides live in the database, not in Git. A deployment does not erase them, and changing `lib/prompts.js` does not affect a slot that still has an override. Record important prompt changes outside the database and use Restore default before assessing a newly deployed default prompt.

### Safe prompt-change procedure

1. Copy the current prompt into a dated change note.
2. Make one purposeful change at a time.
3. Keep placeholders and output schema intact.
4. Test normal, edge, and malformed input.
5. Inspect the downstream UI or parser, not only raw model output.
6. Restore the default immediately if parsing, safety, or factual quality regresses.

### Model test arena

Use a representative prompt set. Compare correctness, instruction following, latency, and cost. Do not replace a default model based on one attractive answer. Record why a model changed and which workflows were tested.

The Test Arena can run one or several model/search combinations, improve a test prompt through the configured prompt-improver slot, accept uploaded source material, and retain test jobs. Use the same input and search context when comparing models.

### Quick-start cards

The Cards screen controls the prompts displayed on the Chat welcome screen. A card can define label, description, prompt, optional model, ordering, and enabled status. Cards start a workflow; they do not permanently change the account's default model.

### Email administration

The Email screen manages canonical labels and classification rules, reviews AgentMail items waiting for training, and can trigger controlled fetch/classification actions. Broad taxonomy changes affect automated Gmail labeling, CRM extraction, and task creation; test them on a small set first.

### RSS feed administration

`/admin/rss-feeds` lists feed state, article counts, last fetch time, and errors. It can add, enable/disable, fetch, fetch all, or delete a feed. Deleting a feed also deletes its stored articles. The user-facing Creators area is the safer place for normal reading and briefing work.

## 17. Automation Schedule

The system has three scheduling layers. A missed action must be diagnosed in the correct layer.

### Layer 1: Persistent SQLite job queue

The queue is checked every minute. Jobs survive a Node restart, are visible at `/admin/jobs`, and usually schedule their own next run.

| Job | Normal timing | What it does |
|---|---|---|
| `email_process` | Every 15 minutes | Fetches and classifies Gmail for configured users |
| `agentmail_process` | Every 15 minutes | Processes the AI-facing AgentMail inbox |
| `crm_knowledge_engine` | Recurring/background | Runs source triage, duplicate/supersession review, synthesis merge, and action projection for CRM-bound evidence |
| `synthesis_run` | Nightly about 03:00 Dublin, drains backlog every 5 minutes | Re-reads raw sources into compiled atoms and projects knowledge to the wiki |
| `cross_entity_synthesis` | Nightly about 04:15 Dublin | Creates insight atoms spanning entities |
| `live_thread_synthesis` | Nightly about 04:35 Dublin | Creates thread atoms spanning Gmail, meetings, newsletter/RSS intelligence, opportunities, and atoms |
| `interest_synthesis_run` | Daily about 05:45 Dublin | Maintains the morning brief interest radar |
| `mycelium_run` | Every 6 hours | Connects flights, documents, meetings, contacts, tasks, and projects |
| `mycelium_doc` | Event-driven | Extracts tasks and contact links after document upload |
| `mycelium_flights` | Event-driven | Creates preparation/check-in tasks after flight creation |
| `flight_refresh` | Starts 2 hours before departure, then every 30 minutes | Reads live flight status until resolved or attempt limit |
| `flight_backfill` | Startup and intended daily 23:00 | Repairs missing flight times |
| `reminder_sweep` | Every 15 minutes | Creates overdue reminders, cancels resolved reminders, repairs missing fire jobs |
| `reminder_fire` | Per reminder | Delivers and escalates one reminder |
| `crm_nudges` | Daily about 06:50 Dublin | Recomputes last-contacted dates and creates birthday reminders |
| `suggestion_run` | Daily about 07:00 Dublin | Runs LLM travel/content assessments and creates advisory suggestions |

### Layer 2: In-process wall-clock schedules

These are minute checks inside `server.js`. They do not create persistent job rows, so a stopped service or a restart at the scheduled minute can miss the run.

| Time | Time zone | Automation |
|---|---|---|
| 06:45 daily | Europe/Dublin | CRM Calendar sync |
| 07:00 daily | Europe/Dublin | RH website statistics |
| 07:30 daily | Europe/London | Morning CRM briefing |
| 08:00 daily | Europe/Dublin | Regulatory monitor |
| 09:30 daily | Europe/Dublin | Creator RSS feed ingestion |
| 16:00 daily | Europe/Dublin | Daily email digest |
| 09:00 Saturday | Europe/Dublin | Newsletter review reminder |
| 14:00 Sunday | Europe/Dublin | Weekly digest |
| 21:00 daily | Europe/Dublin | Daily system report |

### Layer 3: Operating-system schedules

| Host | Schedule | Process |
|---|---|---|
| Mac LaunchAgent | 02:00 daily and at load | Regenerates and publishes Token Burn data |
| Mac LaunchAgent | Every 30 minutes and at load | Runs the installed Workday/vault synchronization script |
| VPS systemd | Continuous, restart after failure | Runs `hub.service` |
| Mac crontab | Intended 07:00 daily when installed | Pulls VPS backups to offsite storage |

### Timed agent assessments

The main timed agent assessment is `suggestion_run`. It gathers calendar events, travel-related CRM facts, booked flights, Skyscanner price points, RSS articles, newsletter topics, opportunity signals from email, and recent LinkedIn posts. It asks an LLM to identify useful travel-booking, content, or short-lived opportunity observations.

The assessment is advisory:

- It creates no booking or publication.
- It stores evidence with each suggestion.
- Open suggestions appear in the morning briefing. The old Google Chat suggestion-card path is not currently an active delivery surface.
- `accept N` creates a task; `dismiss N` closes it; `why N` shows evidence.
- Suggestions expire after 14 days.

The work daily brief also surfaces compiled knowledge-layer signals. **Project Signals** compares recent project evidence from email summaries, meeting intakes, semantic retrieval, and compiled knowledge atoms against current radar/RSS/intelligence signals. **Live Threads** shows cross-source themes compiled by `live_thread_synthesis`, such as a change-management idea recurring across Gmail, newsletters, and meeting notes. Both sections are intentionally evidence-backed and quiet when the source material does not genuinely connect.

Other timed assessments are deterministic rather than LLM-led:

- Content cadence checks assess LinkedIn and newsletter pipeline health.
- CRM nudges assess birthdays, overdue follow-ups, and keep-warm cadence.
- The reminder sweep assesses overdue tasks and whether reminder jobs have become detached.
- The system report assesses module health each evening.

### Reminder escalation

Ordinary reminders fire at the requested time and then at approximately +30 minutes, +3 hours, and +24 hours, with quiet hours from 22:00 to 07:30 Dublin. Content cadence reminders do not escalate; they inspect real pipeline state, skip silently when healthy, and reschedule.

There were no separate Codex desktop recurring automations configured in `$CODEX_HOME/automations` during the audit. The schedules described above belong to the Hub and the operating system.

## 18. Operational Oddities and Effectiveness Audit

This register records processes that are misleading, duplicated, ineffective, or not producing the outcome their name implies. It is a dated operational snapshot, not a permanent claim.

### P1 - Production is not traceable to Git

Production reports Git HEAD `bf130b9` from 8 June 2026, while the running `/app` tree contains dozens of modified and untracked files implementing later features. Local `main` contains 12 June commits that are not represented by production HEAD.

**Why it matters:** rollback, comparison, incident diagnosis, and deployment confidence are compromised. The exact running system cannot be recreated from the recorded production commit.

**Required outcome:** commit and push the intended source, deploy from that clean revision, and confirm local, GitHub, and VPS hashes match.

### P1 - Flight live tracker uses the wrong provider fields

The live `flight_refresh` worker reads `actualTime`; the repaired backfill reads `revisedTime`. Production evidence shows the 11 June flight was populated by backfill after travel.

**Why it matters:** the live tracker can claim completion without recording actual departure/arrival times.

**Required outcome:** use the verified provider fields consistently in live and backfill paths, test against a real raw response, and assert the database fields after the worker runs.

### P1 - Flight backfill corrupts future-flight actual times

The backfill query includes future flights and treats revised values as actual values. The 13 June return flight had `actual_arr=23:05` on 12 June.

**Why it matters:** statistics and the UI can present scheduled/revised future values as completed historical facts.

**Required outcome:** restrict backfill to flights whose departure window has passed; only store an actual value when provider status/time semantics prove it is actual.

### P1 - Flight backfill jobs multiply

Every service startup adds a backfill job without checking for an existing pending job. Each completed backfill schedules another daily run. Production had six pending backfill jobs.

**Why it matters:** repeated API calls waste quota, create noisy logs, and increase the chance of bad writes.

**Required outcome:** seed only when no pending/running backfill exists and ensure exactly one self-scheduling chain.

### P1 - System report has a broken Nginx check

`lib/system-report.js` calls `fs.readFileSync` without importing `fs`. The exception is caught and converted into a warning, so the report does not compare Nginx files.

**Why it matters:** a check described as protection against configuration drift cannot perform that check.

**Required outcome:** import `fs`, test matching and mismatching configurations, and ensure the warning is specific.

### P1 - Synthadoc production sidecar is unavailable

No service was listening on `127.0.0.1:7091` during the 12 June production check.

**Why it matters:** the Wiki still browses files and can use local fallback search, but semantic context building and new sidecar ingestion are unavailable.

**Required outcome:** either run and monitor the sidecar or change the documentation/UI to state that local search is the intended production mode.

### P2 - Future flight is labelled with an actual arrival

This is the visible data consequence of the backfill bug. Correct the record after correcting the process so the false actual time does not remain.

### P2 - Document task extraction has 11 unexplained no-task documents

Production contained 11 non-image documents with extracted Markdown and no document-sourced task. Some may genuinely contain no actions, but the database cannot distinguish “assessed and no tasks found” from “never assessed.”

**Why it matters:** the process may repeatedly reassess no-action documents, or silently leave actionable documents untouched.

**Required outcome:** store an extraction assessment/result marker even when zero tasks are found.

### P2 - Workday LaunchAgent definition differs from the installed job

The repository plist says every five minutes and points into the repository. The installed job runs every 30 minutes and points to `/Users/dm_mini/bin/sync-workday-vault.sh`.

**Why it matters:** operators reading Git will diagnose the wrong schedule and script.

**Required outcome:** make the installer, repository plist, and installed job converge; document whether the installed copy or repo script is authoritative.

### P2 - Workday LaunchAgent logs are empty

The configured stdout/stderr files contained no evidence at audit time.

**Why it matters:** installation alone does not prove synchronization is occurring.

**Required outcome:** record start/end, source counts, files changed, digest outcome, and a non-zero failure exit.

### P2 - Wall-clock schedules are less resilient than queue jobs

Calendar sync, briefings, RSS, regulatory monitoring, digests, and the system report depend on the Node process being alive during one exact minute.

**Why it matters:** a restart or outage at that minute can skip a whole day without a retry record.

**Required outcome:** move critical schedules into the persistent queue or record daily run claims and retry missed runs.

### P2 - Wiki synthesis model bypasses model administration

The Wiki search route hardcodes `deepseek/deepseek-v3.2`.

**Why it matters:** changing the configured Wiki model slot may have no effect on search synthesis, creating governance and cost confusion.

**Required outcome:** route synthesis through the named system-model configuration.

### P2 - Profile surfaces expose inconsistent context

Portfolio chat sees sensitive preference fields that are absent from the visible page, while Candidate Analysis omits useful evidence available elsewhere.

**Why it matters:** administrators may assume a field is private because it is not printed, or assume an assessment uses evidence that it never receives.

**Required outcome:** add per-field surfacing controls or a clear Admin matrix showing Public Page, PDF, Chat, and Candidate Analysis exposure.

### P3 - Package has no aggregate test command

Synthetic tests exist and most passed individually, but `npm test` is not defined. The suggestion test also requires a real OpenRouter call and failed locally under restricted DNS.

**Required outcome:** add offline unit coverage, an explicit opt-in integration test, and a single test script.

### P3 - Repeated `punycode` deprecation warnings add noise

Production logs repeatedly emit the Node deprecation warning. It is not currently breaking behavior, but it dilutes the visibility of operational warnings.

### Verified working outcomes

- Gmail and AgentMail queue chains had pending jobs and recent successful runs.
- Reminder delivery, escalation, cancellation-on-resolution, CRM nudges, and content cadence synthetic tests passed.
- The daily suggestion run created two content suggestions and delivered them.
- The 11 June flight is now present with actual times after backfill.
- Token Burn regenerated and published successfully at 02:00 each day from 8-12 June.
- Production contained active data across projects, documents, contacts, CRM facts, tasks, RSS, meetings, profile content, Candidate Analysis, and portfolio chat.

## 19. Data and Storage Map

| Location | Contents | Backup treatment |
|---|---|---|
| Hub SQLite database | Users, projects, chat, CRM, tasks cache, model/prompt overrides, RSS articles, settings, operational records | Production backup and offsite pull |
| Obsidian vault | Meetings, debriefs, people, projects, Workday, raw sources | Filesystem/vault backup |
| Google Workspace | Email, Calendar, Drive, Sheets, Tasks | Google is authoritative |
| `data/synthadoc/` and Synthadoc sidecar | Indexed knowledge workspace and logs | Rebuildable from sources, but retain configuration |
| `token-burn-dashboard/deploy-data/` | Imported reporting JSON | Versioned/deployed data |
| GitHub repository | Application code and maintained docs | Remote source control |

Never put API keys, OAuth tokens, production databases, or private exports into Git.

## 20. Local Development

### Start

```bash
npm install
npm run dev
```

The normal development port is set by `PORT`; local work commonly uses port `3101`.

### Minimum checks before committing

```bash
git diff --check
node --check server.js
node --check routes/hub.js
node --check routes/hub-crm.js
```

Also check every changed JavaScript file, then exercise changed pages locally. For data migrations, open the app once against a disposable or backed-up database and confirm the resulting schema.

### Git discipline

- Keep `main` deployable.
- Commit coherent features separately.
- Do not mix generated data churn with unrelated code unless the deployment needs both.
- Confirm `git status --short` is empty after the final commit.
- Push before deployment so GitHub and production identify the same revision.

## 21. Production Deployment

### Standard command

```bash
./scripts/deploy.sh 178.104.235.142 --password
```

The script pushes Git, synchronizes code to `/app`, installs production dependencies, validates Nginx, restarts `hub.service`, and displays service status.

### Post-deployment verification

```bash
ssh root@178.104.235.142 "systemctl is-active hub.service"
curl -I https://dchat.mclellan.scot/
```

Then verify the changed route. A private route normally returns an authentication redirect when tested without a session; that confirms routing and the service are alive.

### Logs

```bash
ssh root@178.104.235.142 "journalctl -u hub.service -n 200 --no-pager"
```

Use `journalctl -f -u hub.service` during a controlled live test.

### Deployment warning

The deploy script synchronizes a broad application set. Review local Git status before running it. Do not deploy from a worktree containing unrelated or uncommitted experiments.

## 22. Backups and Recovery

### Production backup

The deployment process creates or preserves production backups as configured. Use:

```bash
./scripts/pull-backup.sh
```

to pull an offsite copy. Verify that a backup exists and is non-empty; a successful command is not enough by itself.

### Recovery order

1. Stop writes or stop `hub.service` if database integrity is at risk.
2. Copy the damaged database aside; do not overwrite the only evidence.
3. Restore the most recent known-good backup.
4. Start the service and check logs.
5. Verify login, chat, CRM, and one recent record.
6. Re-run safe external synchronizations such as Calendar or Google Tasks.
7. Record the incident and the lost time window.

### Code rollback

Prefer deploying a known-good Git commit. Do not use destructive Git commands on a dirty worktree. Database rollback and code rollback are separate decisions because a newer schema may have been created.

## 23. Security and Configuration

### Secret groups

- AI: `OPENAI_TRANSCRIPTION_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_AI_API_KEY`
- Search: `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`
- Google OAuth: `GOOGLE_OAUTH_*`, `GOOGLE_WORKSPACE_DOMAIN`
- Mail: `GMAIL_SMTP_*`, `AGENTMAIL_*`
- Chat/webhooks: `GOOGLE_CHAT_*`, `HERMES_WEBHOOK_SECRET`
- Storage/indexing: `HUB_DB_PATH`, `VAULT_PATH`, `SYNTHADOC_URL`, `SYNTHADOC_BIN`, `MARKITDOWN_BIN`
- Subscriber reading: `SUBSTACK_SID`
- Workday/Boox: `WORKDAY_*`, `BOOX_DRIVE_*`
- Monitoring and delivery: `BRIEFING_*`, `EMAIL_BRIEFING_*`, `REG_*`, `CONTACT_FROM_NAME`

Never print secret values into logs, chat, documentation, or issue trackers. When checking configuration, print only variable names and whether each is set.

API keys stored directly through Model Admin are database secrets and require the same backup and access protection as environment credentials. Prefer an environment-variable name when the provider supports it.

### Access controls

- Keep Hub, wiki, and admin routes private.
- Keep public portfolio routes intentionally separate.
- Use same-origin checks and rate limiting on write endpoints.
- Revoke and replace credentials after accidental disclosure.
- Google OAuth scopes may require users to re-authorize after a new integration is added.

## 24. Troubleshooting

### Site unavailable

1. Check DNS and HTTPS response.
2. Check `systemctl status hub.service`.
3. Read recent journal logs.
4. Validate Nginx configuration.
5. Confirm the application port is listening.

### Login loop or Google API errors

1. Confirm OAuth client ID, secret, callback URL, and allowed user.
2. Check whether the integration added a new scope.
3. Sign out and re-authorize to refresh the stored permission grant.
4. Inspect the specific Google API error in service logs.

### Tasks page is empty

1. Re-authorize Google access for the Tasks scope.
2. Open `/crm/tasks` to trigger a sync.
3. Confirm tasks exist in the default Google Tasks list.
4. Check for `[tasks]` errors.
5. Remember that local Delete hides an item without deleting it in Google.

### Email not classified

1. Confirm Gmail or AgentMail credentials.
2. Check the 15-minute processor logs.
3. Review canonical taxonomy rules.
4. Use the admin trigger for a controlled retry.
5. Confirm the message is not already marked processed.

### Knowledge missing from search

1. Confirm the source file exists in the vault/raw source area.
2. Confirm the page is visible through Wiki Browse; this distinguishes file indexing from Synthadoc search.
3. Check the vault sync log.
4. Check `SYNTHADOC_URL`, sidecar status, and jobs.
5. Re-ingest the specific source with force only when needed.
6. Confirm the Wiki and Synthadoc are pointed at the expected workspace.

### Document will not convert to Wiki

1. Confirm the upload completed and the project document is visible.
2. Confirm the Wiki page-writer slot points to an enabled model.
3. For images, confirm the Wiki image-vision slot is vision capable.
4. For an older image, confirm its raw file exists under the project's vault `raw_sources` path; re-upload if it does not.
5. Check OpenRouter credentials and service logs for `[to-wiki]` or vision errors.
6. Remember that deleting a document does not delete an already-created Wiki page.

### Creator feed has previews or stale articles

1. Select **Fetch now** and inspect the feed's last error.
2. Confirm the feed URL is correct and enabled.
3. If it is Substack, confirm `SUBSTACK_SID` is current.
4. Compare the stored word count with the source article.
5. A feed may expose only previews even to an authenticated request; use the source link when full text is absent.
6. RSS articles are database records, not Wiki pages, unless a separate curation workflow saves them.

### Model change had no effect

1. Confirm whether you changed the Chat default or the relevant named system slot.
2. Confirm the slot's scope: system or current user.
3. Confirm the selected model remains enabled.
4. Check whether a custom prompt override is masking a newly deployed default.
5. Run the workflow again and inspect request logs for the actual model key.

### Prompt override breaks a workflow

1. Open Admin, Models, then the affected slot.
2. Preserve the failing prompt in a change note if it needs investigation.
3. Select **Restore default** and save.
4. Re-run the workflow with representative input.
5. Check for required JSON keys, placeholders, or completion tokens removed by the override.

### Morning briefing missing

1. Check service uptime across 06:45-07:30.
2. Confirm Calendar authorization.
3. Confirm Google Chat delivery settings.
4. Check whether today’s briefing was already recorded.
5. Inspect `[crm]`, Calendar, Tasks, and Chat errors.

### Deployment succeeded but behavior is old

1. Compare local and production file hashes.
2. Confirm the service restart time.
3. Confirm the active Git commit.
4. Check Nginx is routing to the expected process.
5. Rule out browser cache for static CSS or JavaScript.

## 25. Change Checklist

### Before implementation

- Identify the source of truth and affected integrations.
- Check the current Git status.
- Back up production data before schema or migration work.

### Before deployment

- Review the diff and new files.
- Run syntax and whitespace checks.
- Test the changed workflow locally.
- Commit a coherent change.
- Push the commit.
- Confirm no unrelated local files will be synchronized.

### After deployment

- Confirm `hub.service` is active.
- Check the changed public/private route.
- Verify database migrations.
- Inspect logs for startup errors.
- Test the primary user workflow.
- Confirm `main`, `origin/main`, and production represent the same release.

## 26. Command Reference

```bash
# Development
npm run dev

# Git state
git status --short
git diff --check

# Deploy
./scripts/deploy.sh 178.104.235.142 --password

# Pull production backup
./scripts/pull-backup.sh

# Service status and logs
ssh root@178.104.235.142 "systemctl status hub.service --no-pager"
ssh root@178.104.235.142 "journalctl -u hub.service -n 200 --no-pager"

# Token Burn data
./scripts/update-token-burn-data.sh

# Workday/vault synchronization
scripts/sync-workday-vault.sh

# Boox ingestion
node scripts/ingest-boox-drive-notes.js

# Database initialization for a new environment
npm run init-db
```

## 27. Maintainer Notes

Update this manual whenever a tool, route, automation, data store, OAuth scope, deployment step, or recovery procedure changes. Keep operational facts dated. Do not embed live credentials. The Word edition is generated from this maintained source and should be rendered and visually checked before release.
