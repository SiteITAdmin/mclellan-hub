# McLellan Hub — Agent instructions (Grok, Codex, Claude)

This file is the shared entry for coding agents. **Full project rules live in
`CLAUDE.md`** (same content as `Claude.md` on case-insensitive volumes). Read
that file before structural changes. Module contracts: `MODULES.md`. Architecture:
`ARCHITECTURE.md`. Input contract: `docs/hub-input-contract.md`.

## What this system is

Personal second brain for Douglas McLellan: email, calendar, contacts, tasks,
flights, documents, regulatory intel. Prefer **synthesis of existing evidence**
over new tables and hand-maintained links. ADHD-friendly: surface work
automatically; when in doubt, do the work.

## Model plane — zero OpenRouter (done 3 August 2026)

**Production makes zero calls to OpenRouter.** Do not re-add keys, SDKs, or
fallbacks that hit `openrouter.ai`.

| Piece | Location |
|-------|----------|
| Network guard | `lib/openrouter-guard.js` |
| Fetch / `hub-model://` | `lib/fetch.js`, `lib/hub-model-fetch.js` |
| Feature → runner | `lib/feature-runners.js` |
| Transport | `lib/model-transport.js`, `lib/model-request.js` |
| Mac worker queue | `lib/subscription-agent-jobs.js`, `scripts/subscription-agent-worker.js` |
| Embeddings | Mac Ollama `qwen3-embedding` (not OpenRouter) |
| Migration notes | `docs/zero-openrouter-migration.md` |

**Runners:** Luna (bulk classify/extract) · Terra (CRM stages, digests) ·
Grok CLI (research) · Sonnet (cross-entity, wiki, briefs) · Opus (rare) ·
local specialists.

**Ops facts agents need:**

- VPS runs Hub; **Mac mini runs subscription CLIs** (single KeepAlive worker).
- Grok CLI headless flag for the worker path is `--single`.
- Mac pull-workers have a dedicated rate-limit ceiling — do not starve them.
- Cross-entity = Sonnet + small packet, not Luna over the full atom set.
- Chat/admin model UI is registry-led after migration.
- No OpenRouter fallback on CLI failure; degrade closed.
- `email_process` (~15m) retries `captured`/`retry` and unresolved gmail
  failures. “Pending training” unlabelled mail is not the same as a failed
  classify.

Never silent full-corpus CRM reprocess / pipeline version bumps without an
explicit yes on cost. See `CRM_KNOWLEDGE_AUTO_PROCESS_AFTER`.

## Two boundaries (3 August 2026)

1. **Ingest door** — `lib/source-admission.js` / `admitSource` after every raw
   capture. Completeness is the ingester’s problem, visible in daily INGEST.
2. **Effect gate** — task creation only via `google-tasks.js` `createTask` with
   declared `origin`. No second write path.

## CRM path

```text
raw source → crm_source_triage → crm_duplicate_review → synthesis/provenance
  → crm_action_projection → atoms/events/tasks
```

Engine: `lib/crm-knowledge-engine.js`. Operator surface: `/crm/knowledge`.
WhatsApp stays one source per bubble; same-chat neighbours are prompt context,
and a later turn may complete an earlier same-chat task (`crm_action_resolution`).
Do not reintroduce direct CRM write paths (`CRM_LEGACY_DIRECT_WRITES=1` is
rollback only).

## Deploy and production

- Sync triad: local · GitHub · VPS (`root@178.104.235.142`, app at `/app/`).
- Only deploy path: `scripts/deploy.sh`. Start sessions with
  `scripts/sync-check.sh`.
- Production data bugs: diagnostic snapshot loop
  (`pull-prod-snapshot` → reproduce → fix → deploy → repair bad rows).
- Backups, cron, env never inside `/app/`. Use `.rsync-exclude`.
- SSH ControlMaster for scripted VPS access; bare multi-SSH trips UFW.

## Rules that have burned us

1. Naming something is not building it.
2. Adding a key/job/column is not the same as it working — verify real data.
3. Test the full path with synthetic data before calling it done.
4. Diagnose the instance (fix missing rows today), then the process.

## Skills

- Codex: `~/.codex/skills/mclellan-hub-knowledge-first`
- Grok: `~/.grok/skills/mclellan-hub-knowledge-first`
- Claude project memory: `~/.claude/projects/-Users-dm-mini-Documents-mclellan-hub/memory/`
  and home-level `~/.claude/projects/-Users-dm-mini/memory/` (includes the
  retired “OpenRouter only” note — superseded by this file / CLAUDE.md)
