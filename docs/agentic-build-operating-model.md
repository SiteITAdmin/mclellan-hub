# Agentic Build Operating Model

## Purpose

This briefing captures the direction agreed after reviewing Nate Jones's Ringer article and guide on verified agent swarms. It exists so a future Codex, Claude, or human session can resume the work after context loss without re-deriving the strategy.

The goal is to make McLellan Hub builds, daily operations, and content workflows more reliable by assigning parts of the work to accountable agents with executable checks and visible receipts.

We are not doing this because "more agents" is inherently better. We are doing it because the Hub already contains multi-step, multi-model workflows where failure can be subtle:

- token burn data can look refreshed while totals are wrong or stale;
- daily jobs can run without producing useful knowledge;
- LinkedIn/content generation can produce drafts, PDFs, and research packs without a single accountable reviewer owning the whole artifact;
- PDF generation can succeed technically while shipping the wrong content, fallback text, or an unreadable artifact;
- synthesis jobs can create rows without creating source-backed knowledge.

The operating principle is:

```text
Do not trust the agent. Trust the check, the receipt, and the appeal path.
```

## Source Idea

The Ringer argument is that AI hallucination stops being a blocker when work is wrapped in institutions:

- an audit: what command proves this is done?
- an org chart: expensive models use judgment; cheaper workers do typed work;
- a constitution: the standard is written once and enforced repeatedly;
- an appeals process: checks can be wrong and must be reviewable.

For McLellan Hub, this maps neatly onto the existing knowledge-first architecture:

```text
raw source -> synthesis/review -> compiled knowledge or artifact -> executable check -> receipt -> visible surface
```

Agents should strengthen that path. They should not bypass it with direct table writes, hidden manual links, or one-off outputs that never become durable knowledge.

## What "Agent" Means Here

An agent is not a mascot, chat persona, or uncontrolled autonomous worker. An agent is an accountable workflow owner with:

- **Mandate:** the narrow outcome it owns.
- **Inputs:** the source evidence or artifact it is allowed to use.
- **Output:** the compiled knowledge, report, PDF, post, dashboard data, or decision it must produce.
- **Check:** the executable or inspectable proof that the output is valid.
- **Receipt:** a durable record of what happened, what passed, what failed, what was retried, and why.
- **Appeal path:** the way a bad check, false failure, or uncertain decision is escalated to the boss layer.

Codex and Claude remain the total bosses: they design standards, review exceptions, inspect receipts, and make architectural decisions. But boss work is also subject to checks. No rank is exempt.

## Family Model

Douglas's working analogy is useful: the Hub is not a loose crowd of helpers; it is an accountability family.

- **Consigliere:** the Hub's primary function for Douglas. It advises, remembers, challenges, and routes attention. It is the thing Douglas should experience.
- **Heads of the families:** Douglas, Codex, and Claude as the boss layer. This layer sets standards, decides exceptions, and authorises architecture.
- **Underboss agents:** agents that oversee other agents and challenge their receipts. The first is the Hub Consigliere agent.
- **Capo agents:** specialist workflow owners such as Token Burn Auditor, LinkedIn Managing Editor, PDF / Artifact Agent, and Knowledge Synthesis Agent.
- **Soldiers:** the actual functions, scripts, jobs, renderers, importers, checks, and model calls doing the work in the background.
- **Associates:** inputs such as emails, RSS feeds, documents, meetings, calendar items, and external APIs. They can bring value, but they are not trusted until processed.

The important lesson from the token burn incident is that old evidence is not automatically a problem. Old evidence is a problem when it is the freshest active evidence. If a stale CSV export is superseded by a fresh management-API pull, the stale CSV should be noted but not escalated as a failure.

Implementation status: the family roster lives in `lib/hub-agent-roster.js`. Capos and underbosses report through `lib/hub-family-agents.js` and can be run with `scripts/run-agent-family.js`. Reports are receipts in `knowledge_receipts`, not a parallel operational database.

## Why This Matters For The Hub

The Hub is a second brain. It already ingests email, AgentMail, meetings, documents, tasks, calendar events, content ideas, regulatory sources, and operational logs. The value comes from turning those raw sources into connected knowledge and useful action without Douglas having to remember to check everything manually.

The current risk is not only that a model might hallucinate. The deeper risk is silent success:

- a scheduled job reports "done" but produces no useful output;
- a model writes plausible synthesis without source support;
- a generated PDF exists but contains fallback/error language;
- content gets drafted but no one owns research quality;
- a cost dashboard updates but the totals are not reconciled.

Agents give each risk an owner. Checks make each owner prove the work. Receipts let future sessions inspect what happened.

## Knowledge-First Constraints

This agentic layer must follow the Hub input contract.

Do:

- preserve raw evidence with provenance;
- route work through existing synthesis and pipeline stages where they exist;
- write receipts for model decisions, checks, retries, and exceptions;
- surface failures in daily reports, admin views, or explicit handoff notes;
- prefer compiled knowledge artifacts, `knowledge_atoms`, `knowledge_receipts`, wiki notes, reports, and existing dashboard data.

Do not:

- add manual relationship columns as the long-term answer;
- let agents write direct CRM facts or task links without synthesis/review;
- create a second, parallel source of truth for content, token burn, or jobs;
- treat a worker's "done" message as evidence;
- hide failures in logs that Douglas will never see.

## Proposed Agent Roster

### 1. Token Burn Auditor Agent

**Mandate:** ensure token and cost data is accurate, fresh, reconciled, and visible.

**Existing paths:** `lib/token-burn.js`, `scripts/update-token-burn-data.sh`, `scripts/generate-daily-burn.mjs`, token burn dashboard deploy data, `request_logs`.

**Checks:**

- generated daily burn JSON parses and contains recent dates;
- imported totals equal component totals;
- OpenRouter exported totals and Hub live request logs reconcile within a documented tolerance;
- stale OpenRouter exports are flagged;
- dashboard deploy files changed only when data changed;
- failures appear in the daily system report.

**Receipt:** token burn audit summary with timestamp, source files, totals, freshness, warnings, and PASS/FAIL.

**Why first:** small blast radius, high confidence, easy to verify, and a good pilot for the receipt pattern.

### 1A. Hub Consigliere Agent

**Mandate:** challenge the boss layer and subordinate agents. It checks whether source families have fresher authoritative versions before treating old data as stale, and it reviews recent agent receipts for failures.

**Existing paths:** `knowledge_receipts`, token burn dashboard source files, agent-team receipts.

**Checks:**

- source families with multiple versions prefer the freshest authoritative version;
- stale legacy sources are reported as superseded, not failed, when fresher versions exist;
- stale-only source families are escalated;
- subordinate agent receipts with `fail` status are escalated.

**Receipt:** `source_kind='hub_governance'`, `source_id='boss_layer'`, `stage='agent:hub_consigliere'`.

**Why:** this is the agent that challenges Codex, Claude, and other agents instead of accepting their verdicts at face value.

### 1B. CRM Underboss

**Mandate:** supervise CRM-adjacent capos and challenge whether relationship intelligence is flowing from associates into useful compiled knowledge/actions.

**Capos reporting in:**

- Email Capo
- AgentMail Capo
- CRM Capo
- Tasks Capo
- Documents / Projects Capo
- Knowledge Layer Capo
- Mycelium Capo
- Reminders Capo

**Receipt:** `source_kind='hub_underboss'`, `source_id='crm_underboss'`, `stage='agent:crm_underboss'`.

### 1C. Capos

Every major Hub module has a capo in `lib/hub-agent-roster.js`. A capo owns the health of its soldiers and associates, but it does not replace those functions. The first version writes receipts for:

- Email
- AgentMail
- CRM
- Tasks
- Documents / Projects
- Knowledge Layer
- Mycelium
- Reminders
- Flight Tracker
- LinkedIn Content
- Briefings
- RSS / Watchlist
- Wiki / Synthadoc
- Model Governance
- Token Burn
- System Report
- Infrastructure

Each capo receipt uses `source_kind='hub_module'`, `source_id='<capo key>'`, and `stage='agent:capo:<capo key>'`.

### 2. Daily Operations Agent

**Mandate:** verify that daily background work actually produced useful outcomes.

**Existing paths:** `system_jobs`, `processing_failures`, `lib/system-report.js`, AgentMail processing, CRM knowledge engine, daily briefings, RSS ingest, content reminders.

**Checks:**

- expected daily jobs ran or have pending retry jobs;
- AgentMail and Gmail sources flowed into summaries/receipts where applicable;
- CRM knowledge synthesis created receipts/atoms or explicitly reported no eligible sources;
- daily briefings generated real artifacts rather than fallback notices;
- failures are included in the daily system report.

**Receipt:** daily ops audit section, ideally appended to the existing system report.

### 3. Knowledge Synthesis Agent

**Mandate:** ensure raw evidence becomes durable, source-backed knowledge or an explicit non-action decision.

**Existing paths:** `crm_knowledge_engine`, `knowledge_receipts`, `knowledge_atoms`, `synthesis_state`, source kinds in `docs/hub-input-contract.md`.

**Checks:**

- new eligible raw sources have synthesis state;
- source-backed decisions have receipts;
- actions are projected through the action projection path, not direct writes;
- stale/duplicate/superseded decisions are observable;
- unresolved or low-confidence items are queued for review.

**Receipt:** synthesis audit by source kind, with gaps and suggested repair/backfill.

### 4. LinkedIn Managing Editor Agent

**Mandate:** own the whole LinkedIn/content production workflow without replacing its specialist stages.

**Existing paths:** `lib/linkedin-pipeline.js`, `routes/hub-linkedin.js`, `linkedin_posts`, content dashboard, `captureLinkedInPost`.

**Checks:**

- topic and primary source are preserved;
- research ran and sources are attached;
- draft, score, refine, carousel, and publish/capture stages are complete as required;
- output status matches actual artifacts;
- published posts become knowledge artifacts.

**Receipt:** one editorial receipt per post with stage verdicts and links to generated artifacts.

### 5. LinkedIn Research Agent

**Mandate:** own source quality and claim traceability for LinkedIn posts.

**Checks:**

- source URLs are fetchable or explicitly marked unavailable;
- user-provided primary sources are preserved and not silently contradicted;
- numerical or named claims in the synthesis appear in source text or are marked as interpretation;
- source list has enough independent support for the post type.

**Receipt:** research pack verdict attached to the post.

### 6. LinkedIn Draft/Critic Agent

**Mandate:** own voice, professional positioning, and quality against Douglas's rubric.

**Existing path:** current scoring/refinement rubric in `lib/linkedin-pipeline.js`.

**Checks:**

- score rubric is complete;
- anti-patterns are identified;
- top fixes are specific;
- refined draft addresses the top fixes rather than merely rewriting;
- final draft has a clear expertise signal.

**Receipt:** scoring and refinement verdict.

### 7. PDF / Artifact Agent

**Mandate:** verify generated PDFs and rendered artifacts.

**Existing paths:** LinkedIn carousel PDF generation, Nakai daily briefing PDFs, project report PDFs.

**Checks:**

- file exists and starts as a valid PDF;
- page count is sensible;
- expected title/date/client text appears in extracted text;
- fallback/error text is absent unless the artifact is intentionally a failure notice;
- file size is within a sane range;
- optional rendered-page screenshot check for layout-critical outputs.

**Receipt:** artifact verification summary with file path, page count, extracted key strings, and verdict.

### 8. Publishing Archivist Agent

**Mandate:** ensure final content outputs become durable knowledge.

**Existing paths:** `captureLinkedInPost`, `knowledge-format`, wiki notes, public/private knowledge bundles.

**Checks:**

- source id is stable;
- public/private flags are correct;
- published LinkedIn posts, briefings, and reports are captured in the intended knowledge surface;
- no duplicate artifact was created for the same publication event.

**Receipt:** publishing capture receipt.

## First Implementation Sequence

Build this in thin slices. Do not start with a generic orchestration platform.

### Phase 1: Token Burn Auditor

Create a simple audit command or script that reads existing token burn inputs and emits a JSON/markdown receipt.

Implementation status: initial team is wired through `lib/token-burn-auditor.js` and `scripts/audit-token-burn.js`. The token burn refresh script runs the auditor after regenerating local data. Receipts are stored in `knowledge_receipts` as `source_kind='token_burn'`, `source_id='dashboard'`, `stage='agent:token_burn_auditor'`.

Correction after first run: the auditor now treats a fresh `openrouter-live.summary.json` from `OPENROUTER_MANAGEMENT_KEY` as superseding the stale legacy `openrouter-activity.summary.json` export.

Definition of done:

- can be run locally;
- produces PASS/FAIL and human-readable reasons;
- checks freshness, parseability, and reconciliation;
- is referenced from daily system reporting or an admin/manual command;
- has at least one synthetic or fixture-based test.

### Phase 2: PDF / Artifact Agent

Add a reusable artifact verification helper for generated PDFs.

Definition of done:

- verifies existing Nakai daily briefing or LinkedIn carousel output;
- detects missing, too-small, invalid, or fallback PDFs;
- can be reused by project reports and content PDFs;
- reports failures visibly.

### Phase 3: LinkedIn Managing Editor Receipt

Wrap the existing LinkedIn pipeline with explicit stage receipts.

Implementation status: initial LinkedIn teams are wired through `lib/linkedin-agent-team.js` and `lib/linkedin-pipeline.js`. Receipts are stored in `knowledge_receipts` as `source_kind='linkedin_post'` with stages:

- `agent:linkedin_research`
- `agent:linkedin_draft_critic`
- `agent:linkedin_artifact`
- `agent:linkedin_managing_editor`
- `agent:linkedin_publishing_archivist`

Definition of done:

- each generated post records stage verdicts;
- research, draft, score, refine, carousel, and publish capture can be audited;
- failure states are visible in the content dashboard or system report;
- existing tables are used unless a new compiled receipt cache is clearly justified.

### Phase 4: Daily Operations Agent

Extend the existing daily system report so it reads agent receipts and flags missing ones.

Definition of done:

- system report says which agents ran;
- missing expected receipts are warnings;
- repeated failures become loud enough to act on.

## Receipt Shape

Use a compact shape that can become markdown, JSON, or a `knowledge_receipts`-style row later.

```json
{
  "agent": "token_burn_auditor",
  "run_at": "2026-07-08T00:00:00Z",
  "subject": "token-burn-dashboard",
  "inputs": [
    "token-burn-dashboard/deploy-data/daily-burn.sample.json",
    "token-burn-dashboard/deploy-data/openrouter-activity.summary.json",
    "request_logs"
  ],
  "checks": [
    {
      "name": "daily_json_parses",
      "verdict": "PASS",
      "evidence": "42 rows parsed"
    },
    {
      "name": "openrouter_export_fresh",
      "verdict": "FAIL",
      "evidence": "last export is 5 days old"
    }
  ],
  "verdict": "FAIL",
  "retry_or_appeal": "refresh OpenRouter export, then rerun audit"
}
```

## Boss Layer Rules

Codex and Claude should behave as the boss layer:

- create standards and checks before expanding worker lanes;
- inspect receipts instead of rereading every artifact manually;
- route cheap/fast work to specialist stages when checks can prove it;
- keep judgment, taste, architecture, and exceptions at the top;
- never exempt boss-generated work from verification.

When uncertain, ask:

```text
What command or inspectable check proves this is done?
Where will the receipt live?
Who appeals if the check is wrong?
```

## Handoff Prompt For Future Sessions

Use this if context has been lost:

```text
Read docs/agentic-build-operating-model.md, docs/hub-input-contract.md, CLAUDE.md, and ARCHITECTURE.md.

We are adding accountable agents around existing McLellan Hub workflows. Do not build a generic agent platform first. Start with the Token Burn Auditor Agent unless Douglas says otherwise.

Follow the knowledge-first constraint: preserve source evidence, use existing synthesis/pipeline paths, create receipts, make failures visible, and avoid direct table writes or manual relationship columns as the long-term design.

For any agent you implement, define mandate, inputs, outputs, executable checks, receipt shape, and appeal path before writing code. Then implement the smallest useful slice and verify it end to end.
```
