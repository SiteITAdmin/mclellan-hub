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
- **The only permitted deploy path is `scripts/deploy.sh`.** Never rsync to the VPS manually or edit files on the VPS directly. The deploy script pushes to GitHub first, then rsyncs — this is the only way to guarantee all three stay in sync.
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

## Before ending any session

Ask yourself:
- Is anything I added silently broken?
- Are there connections I said would work that I haven't verified?
- Does the daily system report or the health checks surface any new failure modes I've introduced?
