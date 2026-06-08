# McLellan Hub Operator Manual

**Version:** 2.0
**Current as of:** 8 June 2026
**Repository:** `SiteITAdmin/mclellan-hub`  
**Production host:** `178.104.235.142` (`/app`, `hub.service`)

## Purpose

This is the operating manual for the complete McLellan tool set. It explains what each tool is for, where to find it, how the tools exchange information, how models and prompts are governed, what runs automatically, and how to deploy, back up, and recover the system.

The Hub is a private operating environment rather than a collection of isolated apps. Chat, projects, CRM, email, meetings, tasks, the wiki, content, flights, intelligence, and the public portfolio share context through the Hub database, Google services, and the Obsidian/Synthadoc knowledge store.

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
- **Knowledge:** Obsidian-compatible vault files indexed by Synthadoc.
- **Public output:** Portfolio pages, CV tools, RSS feeds, and `llms.txt`.

### Shared context flow

| Source | What is captured | Where it becomes useful |
|---|---|---|
| Chat | Conversations, ratings, project messages, saved answers | Project context, recall, wiki |
| Gmail/AgentMail | Summaries, contacts, facts, actions, labels | CRM, projects, Tasks, briefings |
| Calendar | Today’s events | Morning briefing, meeting preparation |
| Meetings | Transcript, summary, people, projects, facts | Vault, CRM, wiki |
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
- Connections inferred from shared meetings and linked records.
- Google Tasks linked to people and companies.

### Before a meeting

1. Open the person at `/crm/contacts` or company at `/crm/companies`.
2. Review recent facts, open actions, meetings, colleagues, and tasks.
3. Check the morning briefing and Calendar context.
4. Open linked project material if the relationship belongs to a project.

### Capturing CRM context

Use the CRM note input or a natural-language CRM command in chat. The CRM classifier can identify a person, fact, action, or follow-up. Follow-ups become both CRM facts and linked Google Tasks.

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
- CRM follow-ups.
- Email messages that clearly require an action.
- Actions extracted from Daily Debrief.

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
- Identify a contact and create a directly evidenced CRM fact.
- Associate the message with a project.
- Create a Google Task when the recipient clearly must act.
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

Rules are maintained in the email taxonomy configuration and admin page. Manual labeling can be used as learning evidence. Use the audit and migration scripts before broad taxonomy changes.

### Task-creation threshold

Email should create a task only for a specific required action, such as replying, approving, paying, signing, deciding, or completing a form. Newsletters, alerts, FYI messages, and routine automated mail should not create tasks.

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

The wiki searches and browses durable material across project pages, meetings, journals, Workday records, people notes, and selected email-derived context. Search combines the Wiki index with Synthadoc/BM25 retrieval when the sidecar is available. It also exposes sources, graph relationships, and orphaned-page information so disconnected knowledge can be repaired.

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

Synthadoc indexes raw sources into searchable knowledge. It runs as an HTTP sidecar, normally at the configured `SYNTHADOC_URL`, and supports status, list, ingest, jobs, and serve operations. The Hub submits URL, YouTube, Workday, and local-source ingestion through the API. If the sidecar is unavailable, Wiki file browsing still works but indexed search and new ingestion may be incomplete.

### Obsidian vault

The vault is the readable, editable knowledge layer. Trusted API operations support list, search, read, and write. Keep filenames and links stable because project pages, people notes, and meeting references depend on them.

### Workday vault sync

`scripts/sync-workday-vault.sh` synchronizes Workday material into the indexed knowledge workspace. A launchd job can run the installed copy automatically. Logs are stored under `data/logs/`.

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

The Flights tool stores and analyses flight history. It supports:

- Manual create, update, and delete.
- XLSX imports.
- Ryanair itinerary extraction from email.
- AeroDataBox lookup and bulk lookup.
- Route, airline, delay, and actual-duration statistics.

Keep imported workbook formats stable. When flight details are incomplete, use lookup before manually estimating arrival, departure, or duration data.

## 13. Public Portfolio and CV Tools

The public portfolio includes profile material, experience, skills, CV content, an AI assistant, a job-description analyser, executive-summary PDF generation, and a contact form.

The private portfolio admin controls:

- Profile and experience content.
- Skills, gaps, FAQs, and CV context.
- AI instructions.
- Skill candidates generated from evidence.
- Public intelligence publications.

Treat portfolio changes as public publishing. Preview factual edits and generated PDFs before relying on them. See `docs/portfolio-cv-admin-manual.md` for the detailed CV workflow.

## 14. Token Burn

Token Burn displays imported daily model usage plus OpenRouter summaries. It is a reporting view, not the billing source of truth.

Update data with:

```bash
./scripts/update-token-burn-data.sh
```

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

| Time | Time zone | Automation |
|---|---|---|
| Every 15 minutes | Server process | Gmail processing |
| Every 15 minutes | Server process | AgentMail processing |
| 06:45 | Europe/Dublin | CRM Calendar sync |
| 07:00 | Configured daily schedule | RH statistics |
| 07:30 | Europe/London | Morning CRM briefing |
| 08:00 | Configured daily schedule | Regulatory monitor |
| 09:30 | Europe/Dublin | Creator RSS feed ingestion |
| 16:00 | Europe/Dublin | Daily email digest |
| Saturday 09:00 | Configured schedule | Newsletter reminder |
| Sunday 14:00 | Configured schedule | Weekly digest |

In addition, launchd and systemd timers may run vault synchronization, backup, or Boox ingestion outside the Node scheduler. Check both the application service and OS schedulers when diagnosing a missed job.

## 18. Data and Storage Map

| Location | Contents | Backup treatment |
|---|---|---|
| Hub SQLite database | Users, projects, chat, CRM, tasks cache, model/prompt overrides, RSS articles, settings, operational records | Production backup and offsite pull |
| Obsidian vault | Meetings, debriefs, people, projects, Workday, raw sources | Filesystem/vault backup |
| Google Workspace | Email, Calendar, Drive, Sheets, Tasks | Google is authoritative |
| `data/synthadoc/` and Synthadoc sidecar | Indexed knowledge workspace and logs | Rebuildable from sources, but retain configuration |
| `token-burn-dashboard/deploy-data/` | Imported reporting JSON | Versioned/deployed data |
| GitHub repository | Application code and maintained docs | Remote source control |

Never put API keys, OAuth tokens, production databases, or private exports into Git.

## 19. Local Development

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

## 20. Production Deployment

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

## 21. Backups and Recovery

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

## 22. Security and Configuration

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

## 23. Troubleshooting

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

## 24. Change Checklist

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

## 25. Command Reference

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

## 26. Maintainer Notes

Update this manual whenever a tool, route, automation, data store, OAuth scope, deployment step, or recovery procedure changes. Keep operational facts dated. Do not embed live credentials. The Word edition is generated from this maintained source and should be rendered and visually checked before release.
