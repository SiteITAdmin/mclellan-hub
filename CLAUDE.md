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
| Job queue | `lib/jobs.js` — `ryanair_import` (30 min), `flight_refresh` (live, around departure), `flight_backfill` (23:00 Dublin) |
| Data | `data/hub.db` (flights, jobs, settings/tokens, published posts, sessions), `data/douglas.db`, `data/nakai.db` (portfolio content) |

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
