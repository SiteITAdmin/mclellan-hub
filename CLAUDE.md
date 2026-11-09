# McLellan Hub — Project Instructions for Claude

## State of the project (24 October 2026)

Version Old (44 functions: CRM, knowledge engine, briefings, planner, LinkedIn,
wiki, …) was retired on 24 Oct 2026. Its record is `docs/VERSION-OLD.md`; its
code is at git tag `version-old`; its data is archived in Google Drive
(`Hub Version Old archive/`). Read `docs/VERSION-OLD.md` before rebuilding any
old function — it lists what worked and what went wrong.

What runs now is deliberately small:

| Piece | Where |
|-------|-------|
| Flight tracker | `lib/flights.js`, `routes/flights.js`, `views/flights.ejs` — https://douglas.mclellan.scot/flights behind the site admin's Google sign-in |
| Public sites | `routes/portfolio.js`, `routes/admin.js` — douglas.mclellan.scot, nakai.mclellan.scot |
| Site chat + JD analyser | `lib/model.js` → `lib/subscription-agent-jobs.js` → Mac worker (`scripts/subscription-agent-worker.js`) |
| Personal CRM (Phase 1) | `lib/crm/*`, `routes/crm.js`, `views/crm/` — https://douglas.mclellan.scot/crm behind the same sign-in. Plan: `docs/CRM-PLAN.md`; design mockup: `design/crm/` |
| Job queue | `lib/jobs.js` — `ryanair_import` (30 min), `flight_refresh` (live, around departure), `flight_backfill` (23:00 Dublin), `crm_gmail_capture` + `crm_outlook_capture` (15 min, 7-day window), `crm_atomise_tick` (1 min, one Mac job at a time), `crm_tasks_sync` (15 min, current Work/Personal task state), `crm_calendar_sync` (5 min, current 14 days only), `crm_morning_digest` (07:30 Dublin), `crm_gmail_bootstrap` (once per mailbox), `crm_whatsapp_settle` (1 min), `crm_imessage_settle` (1 min), `crm_self_chat` (1 min), `crm_push_notifications` (1 min), `crm_boox_capture` (15 min), `crm_contacts_sync` (daily) |
| Calendar | `lib/crm/planner.js` (pure scheduling), `lib/crm/calendar.js` (Google read/write, views), `lib/crm/task-length.js`, `views/crm/calendar.ejs` at /crm/:space/calendar, "Your day" on Today. The Calendar screen shows both spaces' appointments and task blocks in full, by Douglas's choice (9 Nov); Today still shows the other space only as "Busy". `crm_calendar_sync` (5 min) reads the Google calendars in `config.calendars` for the next 14 days, plans every open task into free time in its space's hours (setting `plan_hours`), and writes each block to Google as an event tagged `hubBlock`. The plan (`plan_blocks`) is rebuilt every run. A block dragged in Google is pinned; an appointment moves only if Douglas marked it flexible and nobody else is invited. Task lengths are guessed through the `crm_atomise_tick` queue unless Douglas sets one. No Work diary is connected yet: work tasks are planned around personal appointments only |
| Knowledge intake | `lib/crm/documents.js`, `agentmail.js`, `ask.js`: uploads on Add a note, read-only AgentMail capture every 15 minutes (7-day window), source-cited questions on Search through the Mac queue. `questions` is a disposable answer cache. Boox discovery and page review are at `/crm/notebooks`; notebooks must be classified once. `crm_boox_read` sends one PDF page through the existing Claude worker, with no API fallback |
| Meeting prep | `lib/crm/meetings.js`, `meeting_preps` cache: today’s calendar purpose + exact attendees → same-space facts → cited prep on Today, Meetings and morning email. Calendar snapshots become historical sources. Model verification is pending Claude capacity (9 Nov) |
| Remembering | `lib/crm/keepintouch.js` (cadence per person in `people.cadence_days`, suggested from real contact gaps, "Drifting" on Today), `lib/crm/dates.js` (dates in the next 7 days, from date atoms; `atoms.yearly` for birthdays), `lib/crm/digest.js` (`crm_morning_digest`, 07:30 Dublin, one email per space to douglas@mclellan.scot, Work on weekdays only, nothing sent after 10:00) |
| Promise ledger | `lib/crm/promises.js`, `views/crm/_promises.ejs`: You owe / Owed to you on Today. Runs just before each `crm_tasks_sync`; sorting older promises shares the `crm_atomise_tick` queue |
| Where things stand | `lib/crm/standings.js`, `views/crm/_standing.ejs`: a summary per person, project and organisation. Written through the `crm_atomise_tick` queue after all sources are read, at most once a day when facts change |
| Second Gmail | `lib/crm/gmail.js` (accounts), `lib/crm/gmail-connect.js`: douglas@wicklowdementiasupport.ie, Personal, read-only. Connected from Personal Today; own token in `crm.db` setting `google_token:<email>`, never the main Google token. Google returns to the already-registered `/admin/auth/google/callback`, which hands off by session purpose. Captured by `crm_gmail_capture` alongside the main mailbox, origin `gmail:<email>`. The Hub's Google app is Internal to mclellan.scot, so WDS signs in through its own Google app in the WDS Workspace: `GMAIL_OAUTH_WICKLOWDEMENTIASUPPORT_IE_CLIENT_ID` / `_CLIENT_SECRET` in the VPS `.env` (redirect URI `https://douglas.mclellan.scot/admin/auth/google/callback`). The token records which app issued it; a mismatch shows as "isn't connected" on Today |
| WhatsApp (Hermes) | Capture only towards other people. Mac: Hermes Agent (`~/.hermes/hermes-agent`), gateway LaunchAgent `ai.hermes.gateway`, WhatsApp bridge in bot mode with nothing let through to the agent, so Hermes never replies. Our tap `integrations/hermes-whatsapp/hub-tap.mjs` is patched into the bridge by `scripts/install-hermes-tap.sh`: **re-run it after every `hermes update`**; it upgrades an older tap in place so reminders can use the same socket. Linked 4 Nov 2026 (session `~/.hermes/whatsapp/session`; re-link with `node bridge.js --pair-only --session ~/.hermes/whatsapp/session` in the bridge folder, not `hermes whatsapp`, whose wizard overwrites the capture-only settings). If `hermes gateway install` says launchd bootstrap error 5, the label was disabled at the Version Old retirement: `launchctl enable gui/501/ai.hermes.gateway`, then `hermes gateway start`. Hub: `lib/crm/whatsapp.js`, `routes/whatsapp-capture.js` (`/api/crm/whatsapp/*`, bearer `HERMES_WEBHOOK_SECRET`), `views/crm/whatsapp.ejs` at /crm/whatsapp. Tables `whatsapp_chats` (approve per chat, with space), `whatsapp_messages` (raw), `whatsapp_outbox` (reminders and answers for Douglas's own chat); `crm_whatsapp_settle` (1 min) turns a chat quiet for 5 min into one source. Douglas's own chat saves notes and asks questions (`Work:` / `Personal:` prefix), and the Hub replies only there. Private-contacts list never reaches the Hub. Today warns when Hermes is silent 30 min |
| iMessage | `lib/crm/imessage.js`, `scripts/imessage-capture-worker.js`, `scripts/imessage-text.swift`, installed by `scripts/install-imessage-reader.sh` (launchd `com.mclellan.hub.imessage-reader`, every minute; the Mac needs Full Disk Access). Reads `~/Library/Messages/chat.db` read-only for a 7-day window, keeps only chats whose participants are all known people in one space, and never sends private contacts to the Hub. Messages settle for 5 minutes into one source; attachments without text become unreadable sources. `/crm/messages` shows the reader's heartbeat and pause switch |
| Wider identity | `lib/crm/imports.js` (Google Contacts daily via `crm_contacts_sync`, LinkedIn `Connections.csv` upload), `lib/crm/contacts-connect.js` (one-time Contacts consent on the already-registered Google callback), `lib/crm/connections.js` (weekly synthesis of relationships between pairs of people). An import never creates a contact source; it only adds exact identifiers after Douglas links or adds the person. `/crm/imports` is the review queue; relationships appear on each person's page |
| Reminders | `lib/crm/notifications.js` + `public/crm-worker.js` / `crm-notifications.js`: web push (VAPID keys in `crm.db` setting `push_vapid`) for meeting prep 30 minutes before and promises due today, per device and space. `lib/crm/self-chat.js` queues the same reminders, plus drift and answers, to Douglas's approved self chat; the Hermes tap claims each once and never sends to anyone else. `/crm/notifications` enables a device; Today shows delivery failures |
| Channel projects | `lib/crm/channels.js`, table `channel_projects`: a mailbox (`gmail:<email>`) or WhatsApp chat (`whatsapp:<chat_id>`) Douglas has said belongs to a project. The reader is told and still decides per fact. Seeded once: WDS mailbox → Personal project "Wicklow Dementia Support"; the "WDS Board 2026" group is approved into it on first sight (`config.whatsappPreapproved`). Chat projects are set on /crm/whatsapp |
| Meetings (Wispr Flow) | `lib/crm/wispr.js`, `views/crm/meetings.ejs`: device-flow sign-in to Wispr's MCP server (`api.wisprflow.ai/connect/mcp`), one connection per space, token in `crm.db` settings `wispr_<space>_auth`. Connection only so far: meetings are not captured yet |
| Data | `data/hub.db` (flights, jobs, settings/tokens, published posts, sessions), `data/crm.db` (CRM sources, people, atoms, calendar events, plan), `data/douglas.db`, `data/nakai.db` (portfolio content) |

rholdsworthconsulting.com is static, served by nginx from `/var/www/rholdsworth`.

Douglas has ADHD. The system should surface everything it can automatically,
without requiring Douglas to trigger it manually. When in doubt, do the work.

## Rebuilding

Douglas is choosing new functions one at a time. **Do not add a feature he has
not agreed to**, and do not restore Version Old code wholesale: lift only the
specific idea, re-implemented small. If a new function needs a table, a job, or
a Mac program, say so before building it.

The design ideas from Version Old that still stand (details in `docs/VERSION-OLD.md`):

- **Derive, don't duplicate.** Raw source → synthesis → compiled knowledge →
  views. A relationship mentioned in ingested documents is recognised by a
  synthesis job, not hand-entered as a row or column.
- **One door in, one attributed path out.** Every capture records whether it was
  readable; every external effect (task, email, calendar event) records which
  module caused it.
- **Identity before models.** Match people deterministically before a model sees
  their names; fail closed on ambiguity.
- **Nothing scheduled without a notion of stale.** A job that falls behind must
  skip or retire old work, not catch up on weeks of it.

## Model plane

Model work runs on the Mac mini's subscription CLIs (Claude, Codex) through the
pull queue: the VPS enqueues, the Mac worker claims one job at a time. There is
no API-key or OpenRouter path; `lib/openrouter-guard.js` blocks
`*.openrouter.ai` at boot. If the site chat stops answering, check the Mac
worker (`com.mclellan.hub.subscription-agent-worker`) before the code.

## The most important rules

**Rule 1: Naming something is not building it.** If a module is called a
tracker, it must track. If the core capability isn't there, say so.

**Rule 2: Adding something is not the same as it working.** When you add an API
key, a job, or a connection, verify real data flows through it and the output is
correct. (AeroDataBox returns `revisedTime`, not `actualTime` — that was a silent
failure for months.)

**Rule 3: Test with fake data at build time.** Exercise every feature with a
synthetic input before calling it done, and log what was tested in the commit
message.

**Rule 4: Diagnose the instance, not just the process.** When something didn't
happen, fix the missing data first, then the process.

**Rule 5: Don't leave silent failures.** A job that fails or produces nothing
when it should have must be visible somewhere.

## Deployment rules

- Local, VPS (`root@178.104.235.142`, app at `/app/`), and GitHub must stay in
  sync. Start every session with `scripts/sync-check.sh`.
- **The only permitted deploy path is `scripts/deploy.sh`** (push to GitHub,
  then rsync). Never edit files on the VPS directly. The rsync does not delete,
  so a removed file must also be removed from `/app` deliberately.
- Backups, cron, and env files never live inside `/app/`. The VPS backs up
  `data/*.db` nightly (`/usr/local/bin/mclellan-backup.sh`); the Mac copies
  them to Google Drive at 07:00 (`scripts/pull-backup.sh`).
- DB is SQLite at `/app/data/hub.db`. Schema lives in `lib/db.js`
  (`CREATE TABLE IF NOT EXISTS`). Do not modify production data directly unless
  diagnosing.
- Never run Gmail jobs from the Mac against the production refresh token
  (Google rotates it). Run locally with `HUB_DISABLE_JOBS=1`.

## What not to do

- Do not add features without Douglas agreeing to them first.
- Do not substitute a safer or simpler version of what was asked. Flag risk in
  one sentence, then build what was asked.
- Do not add comments explaining what the code does — only why something
  non-obvious is done.
- Do not write code that looks like it works without verifying it does.

## Before ending any session

- Is anything I added silently broken?
- Are there connections I said would work that I haven't verified?
