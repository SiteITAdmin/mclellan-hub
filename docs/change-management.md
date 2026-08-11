# McLellan Hub — Change Management SOP

You are the product owner. T3 Code is your developer. Git is your safety net.
GitHub is your change record.

This SOP is how you make any change to McLellan Hub — from a typo fix to a
major new integration. Follow it every time.

---

## The tool

```
node scripts/hub-change.js <command> [args]
npm run change -- <command> [args]
```

Every change gets a ticket (stored in `.hub-changes/`). The ticket logs
findings, plans, evidence, and the workflow stage. It lives in git with the
code.

---

## Quick reference

```
hub-change.js new                     # interactive: pick type, area, title
hub-change.js preflight               # current state: branch, dirty, snapshot age
hub-change.js investigate <id>        # incident: live prod evidence
hub-change.js plan <id>               # what you'll change and why
hub-change.js branch <id>             # create git branch
hub-change.js context <id>            # agent handoff bundle (paste into T3)
hub-change.js commit <id>             # stage + commit
hub-change.js push <id>               # push to origin
hub-change.js pr <id>                 # open GitHub PR
hub-change.js merged <id>             # mark PR merged
hub-change.js deploy <id>             # deploy.sh (requires clean main + merged)
hub-change.js close <id>              # settle
hub-change.js status                  # all open changes
hub-change.js show <id>               # full ticket JSON
hub-change.js log <id>                # event log
hub-change.js note <id> "text"        # add a note
```

---

## The ten rules

### 1. Never develop directly on main

Main is production. Before writing any code, create a branch.

```
hub-change.js new --type fix --area CRM --title "Task planner shows completed projects"
```

The tool picks the branch: `fix/task-planner-shows-completed-projects`.

### 2. Investigate before changing (production-first)

For live incidents: don't look at snapshots. Look at production.

```
hub-change.js investigate <id>
```

This runs live: current HEAD on the VPS, deployed revision, recent journalctl
errors, database state, and compares the snapshot age against when you reported
the problem.

Never fix a production bug based on a stale snapshot.

### 3. Plan before coding

The tool refuses to create a branch until you have a plan.

```
hub-change.js plan <id>
```

Answer three questions:
- What will you change and why?
- What tests will you add or run?
- What could break?

If you don't plan, you don't branch.

### 4. Give T3 the context bundle

```
hub-change.js context <id>
```

This writes a file `.hub-changes/<id>.md` containing everything T3 needs:
the ticket details, live evidence, your plan, the hub rules, and which docs to
read. Paste it into T3 and say "implement this plan."

### 5. Ask T3 to investigate, not to code

Instead of: "Fix the CRM calendar."

Say: "Investigate the CRM calendar. Don't change anything yet. Tell me what
you think is happening, which files are involved, and what you propose
changing."

Then: "Implement that approach."

Then: "Run the relevant tests."

Then: "Review your own changes for regressions and architectural violations."

### 6. Commit with meaningful messages

```
hub-change.js commit <id>
```

The tool writes `type(area): title` as the commit subject with a reference to
the change ID. Six months from now you can look at `git log` and understand
what happened and why.

### 7. Use PRs as your approval gate

```
hub-change.js pr <id>
```

This is your review point. The PR contains the context bundle, your plan, and
the full diff. You can ask T3 to review it:

"Review this PR as a senior developer. Explain what changed, why each change is
necessary, what could break, and whether you think it is safe to merge."

Then ask me: "Here's PR #N. Explain it to me."

AI writes → AI reviews → you approve.

### 8. Only deploy from main

```
hub-change.js deploy <id>
```

The tool refuses if:
- You're not on main
- The working tree is dirty
- The change isn't marked merged

The branch → PR → merge → deploy flow is the only path to production.

### 9. Three levels of process

Not every change needs the full workflow.

**Tiny (chore)** — typo, CSS tweak, wording:
```
hub-change.js new --type chore ...
→ branch → commit → merge → deploy
```

**Normal (fix/feature)** — most bugs and features:
```
new → plan → branch → implement → commit → push → PR → review → merge → deploy → close
```

**Dangerous (incident/emergency)** — production down, data loss, auth, DB schema:
```
new → investigate (live evidence) → plan → branch → implement → test → PR → AI review → your review → merge → deploy → live verification → close
```

The tool tracks which level you picked and enforces the required steps.

### 10. Close when you verify

```
hub-change.js close <id>
```

After deploying, check that production actually works. Then close the ticket.
The close is logged in the change record with a timestamp.

---

## How to report a live bug

Use this prompt for T3 or for creating a ticket:

> Live production bug: [what is wrong]
>
> This is happening now. Do not start by modifying code or looking at a
> snapshot.
>
> First establish:
> - What commit is currently deployed
> - When it was deployed
> - Current logs/errors relevant to this behaviour
> - Whether you can reproduce the problem
>
> Stop and report findings before implementing a fix.

---

## How to ask for a feature

> I want [what you want].
>
> Before building, search the Hub for existing implementations. Check
> ARCHITECTURE.md and MODULES.md. If this capability exists, extend it.
> If it doesn't, propose the smallest change using existing Hub architecture.
>
> Don't implement yet. Tell me what you plan to do.

---

## How to handle an emergency

When production is down and you need a fix NOW:

```
hub-change.js new --type emergency --area "Infrastructure / Deploy" --title "Production down: [what]"
hub-change.js investigate <id> --reported "just now"
hub-change.js plan <id>
hub-change.js branch <id>
```

Emergency skips some gates. The tool logs that you overrode them. This is
intentional — sometimes you need to move fast. The ticket records what happened.

---

## Pre-flight check

At the start of any session, before writing code:

```
hub-change.js preflight
```

This tells you:
- Current branch and HEAD
- Whether the working tree is dirty
- Snapshot age (is the latest snapshot fresh?)
- GitHub vs local sync

If `main` is dirty with uncommitted work, deal with that first.

---

## What the tool enforces

| Rule | Enforced by |
|------|-------------|
| No code on main | `branch` refuses if dirty; requires branch |
| No branch without plan | `branch` refuses if no plan (except chore) |
| No incident fix without evidence | `plan` refuses if incident with no investigation |
| No deploy without merge | `deploy` refuses if not merged |
| No deploy on dirty tree | `deploy` refuses if dirty |
| Snapshot staleness warning | `investigate` compares snapshot age to incident time |

---

## File locations

- Tickets: `.hub-changes/<id>.json` (committed to git)
- Context bundles: `.hub-changes/<id>.md` (committed to git)
- Tool: `scripts/hub-change.js`
- Tests: `test/hub-change.test.js`
- This doc: `docs/change-management.md`

---

## Current state note

The Hub currently has uncommitted planner changes on main, including duplicate
files (`task-calendar-planner 2.js`, etc.). Before using the change tool for
new work, deal with these:

1. Delete the duplicate `* 2.js` / `* 2.css` / `* 2.ejs` files
2. Decide if the planner changes are ready to commit or should be stashed
3. Commit or stash to get a clean main
4. Then: `hub-change.js new` for your next change

---

## Workflow diagram

```
                    YOU
                     │
             "I want X changed"
                     │
                     ▼
              hub-change.js new
                     │
                     ▼
               T3 investigates
                     │
                     ▼
              GIT BRANCH (auto)
                     │
                     ▼
            T3 implements plan
                     │
              ┌──────┴──────┐
              ▼             ▼
           COMMIT          TEST
              │             │
              └──────┬──────┘
                     ▼
                   PUSH
                     │
                     ▼
                    PR
                     │
              ┌──────┴──────┐
              ▼             ▼
          AI REVIEW      YOU REVIEW
              │             │
              └──────┬──────┘
                     ▼
                   MERGE
                     │
                     ▼
                deploy.sh
                     │
                     ▼
                PRODUCTION
                     │
                     ▼
             YOU VERIFY IT WORKS
                     │
                     ▼
                  CLOSE
```
