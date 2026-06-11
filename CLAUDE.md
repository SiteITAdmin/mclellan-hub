# McLellan Hub — Project Instructions for Claude

## What this project is

A personal AI workspace for Douglas McLellan. It connects email, calendar, contacts, tasks, flights, documents, and regulatory monitoring into a single system that surfaces actions and intelligence without Douglas having to remember to look. The design principle is that the system should grow paths between its own data nodes — like a fungal network — so that information added in one place is automatically useful in others.

Douglas has ADHD. The system should surface everything it can automatically, without requiring Douglas to trigger it manually. When in doubt, do the work.

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

## What not to do

- Do not add features without Douglas agreeing to them first.
- Do not substitute a safer or simpler version of what was asked. Flag risk in one sentence, then build what was asked.
- Do not add comments explaining what the code does — only comments explaining why something non-obvious is done.
- Do not write code that looks like it works without verifying it does.

## Before ending any session

Ask yourself:
- Is anything I added silently broken?
- Are there connections I said would work that I haven't verified?
- Does the daily system report or the health checks surface any new failure modes I've introduced?
