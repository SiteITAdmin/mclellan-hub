# Synthadoc Adaptation Review

Date: 2026-05-08

## Executive Recommendation

Synthadoc is a good conceptual fit for McLellan Hub, but it should be adapted as a sidecar knowledge engine for Hub Projects rather than copied wholesale into the Node/Express app.

The strongest overlap is with Projects: Hub already stores uploaded documents, project-scoped chat history, source-linked answers, URL reading, exports, and recall. Synthadoc adds the missing layer above that: ingest-time knowledge compilation into durable Markdown pages, contradiction detection, wiki graph maintenance, linting, audit trails, and context packs.

The practical path is:

1. Keep Hub as the authenticated chat UI, model router, CRM, portfolio/admin surface, and audit dashboard.
2. Run Synthadoc per Hub project as a local-only sidecar service or CLI-managed wiki.
3. Add a thin Hub integration layer that mirrors project uploads/URLs into a Synthadoc wiki, polls job state, and injects Synthadoc query/context results into Hub chat.

Do not port Synthadoc's Python agents into JavaScript at first. The Python codebase is built around async agents, FastAPI, Typer CLI, provider plugins, a skill registry, and per-wiki SQLite stores. Rewriting that would be slower and risk losing the part that makes Synthadoc valuable.

## What Synthadoc Provides

Synthadoc is an open-source Python 3.11+ "LLM knowledge compilation engine". It reads raw sources such as PDFs, spreadsheets, PPTs, web pages, images, videos, Word files, text, and Markdown, then compiles them into a local Markdown wiki.

Important capabilities for Hub:

- Ingest-time synthesis instead of query-time-only RAG.
- Plain Markdown wiki output with YAML frontmatter and `[[wikilinks]]`.
- Contradiction detection with `status: contradicted`.
- Orphan page linting.
- Per-wiki `audit.db`, `jobs.db`, `cache.db`, and optional `embeddings.db`.
- CLI and HTTP API surfaces.
- Built-in skills for PDF, URL, Markdown/TXT, DOCX, PPTX, XLSX/CSV, image, web search, and YouTube transcript ingest.
- BM25 search by default with optional vector re-ranking via `fastembed`.
- Query decomposition, web-search decomposition, knowledge gap suggestions, routing, candidates staging, and context packs.
- Local-first server binding to `127.0.0.1`.

## Current Hub Overlap

Hub already has several foundations that should stay:

- Node/Express + EJS app with hostname routing in `server.js`.
- Per-user Projects in `projects`.
- Uploaded project documents in `documents`, extracted to Markdown by `lib/extract.js`.
- Chat messages linked to `project_id`.
- Project chat context injection in `routes/hub.js`.
- Model routing, web search, streaming, request logs, ratings, export, and Google Workspace integration.
- `recall_entries` for long-term conversation recall.

The weakness today is that project context is essentially a linear blob of uploaded documents plus recent messages. That is simple and useful, but it does not scale gracefully as documents accumulate. Synthadoc's wiki artifact would let Hub promote raw project material into a durable, browsable knowledge layer.

## Recommended Architecture

### 1. Per-project wiki root

Create a deterministic wiki folder per Hub project:

```text
data/synthadoc/
  douglas/
    tino/
      wiki/
      raw_sources/
      .synthadoc/
  nakai/
    example-project/
```

Each Hub project maps to one Synthadoc wiki. The Hub project remains the source of identity and permissions; Synthadoc remains localhost-only and never exposed directly to the public internet.

### 2. Hub integration module

Add `lib/synthadoc.js` with responsibilities:

- Resolve the wiki root for `{ user, projectSlug }`.
- Install/scaffold the wiki if missing.
- Ingest a local file, URL, or search intent.
- Query the wiki.
- Build a context pack.
- List jobs and map Synthadoc job status into Hub UI status.
- Read lint/audit summaries for display.

Use the CLI first because it is stable and avoids coupling to internal Python modules. Prefer HTTP later for smoother job polling once the sidecar service is managed.

### 3. Database links

Add columns or a small join table so Hub can map document records to Synthadoc jobs/pages:

```sql
CREATE TABLE IF NOT EXISTS project_wikis (
  project_id TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  wiki_root TEXT NOT NULL,
  port INTEGER,
  status TEXT DEFAULT 'inactive',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS synthadoc_ingests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  document_id TEXT,
  source TEXT NOT NULL,
  job_id TEXT,
  status TEXT DEFAULT 'pending',
  result_page TEXT,
  error TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
```

Keep Hub's existing `documents` table. It is still useful for display, downloads, and immediate chat context.

### 4. Project chat behavior

Add a Project Knowledge mode beside the current document-context behavior:

- Current behavior: inject all project documents and recent messages.
- Synthadoc behavior: query or context-build against the compiled wiki, then inject the returned cited context into `routeMessage`.

For early implementation, use a command form:

```text
/wiki What are the key risks in the Tino project?
/context Draft a project status update for Tino
/lint
```

This keeps the first slice small and avoids redesigning the full chat UI.

### 5. UI additions

Add a small Project Knowledge panel to `views/hub/chat.ejs`:

- Wiki status: not initialized, initializing, ready, error.
- Ingest queue: pending/running/completed/dead.
- Buttons: Initialize Wiki, Ingest Existing Docs, Lint, Scaffold, Build Context.
- Links to generated Markdown pages once available.

This can be kept utilitarian and consistent with the Hub dark UI.

## Adaptation Options

### Option A: Sidecar CLI integration

Best first move.

Pros:

- Smallest code change in Hub.
- Keeps Synthadoc isolated behind a wrapper.
- Avoids AGPL source mixing as much as possible.
- Easy to disable per project.
- Lets us evaluate value before bigger integration.

Cons:

- Job polling is clunkier.
- Shelling out needs careful timeout/error handling.
- Local Python environment/dependencies must be provisioned on the VPS.

### Option B: Sidecar HTTP service

Best medium-term move.

Pros:

- Cleaner status polling.
- Natural fit for long-running ingest jobs.
- Better UX for progress and retries.

Cons:

- Need process supervision per wiki or shared service routing.
- Need port allocation and health checks.
- More operational surface on the VPS.

### Option C: Port selected ideas into Hub

Only do this after proving the workflow.

Pros:

- Single runtime and deployment stack.
- Full UI/control integration.

Cons:

- Reimplementing agents, skills, caching, job queue, provider handling, and wiki storage is a large project.
- Higher chance of building a weaker copy of Synthadoc.

## Licensing Note

Synthadoc is AGPL-3.0. If we copy or modify its source code directly inside Hub, that may create distribution and source-availability obligations. A sidecar/CLI integration that treats Synthadoc as a separate program is cleaner, but this is still worth checking before production deployment or redistribution.

## First Implementation Slice

The lowest-risk slice:

1. Add configuration:
   - `SYNTHADOC_BIN`
   - `SYNTHADOC_ROOT`
   - optional `SYNTHADOC_PROVIDER`
2. Add `lib/synthadoc.js` wrapper around `synthadoc status`, `install`, `ingest`, `jobs list`, `query`, and `context build`.
3. Add a Project admin route:
   - initialize wiki for project
   - ingest existing Hub documents by writing their Markdown to `raw_sources/`
4. Add chat commands:
   - `/wiki <question>` calls `synthadoc query`
   - `/context <goal>` calls `synthadoc context build`
5. Add a basic status panel in the project view.

## Main Risks

- Python dependency footprint on the VPS.
- LLM API duplication: Hub uses OpenRouter/custom providers; Synthadoc has its own provider configuration.
- Cost and token tracking split across Hub `request_logs` and Synthadoc `audit.db`.
- Long-running job UX: uploads should return quickly while ingest continues.
- Permissions: wiki files must be scoped per Hub user and not exposed by static serving.
- Source duplication: Hub stores Markdown in SQLite; Synthadoc stores raw sources and compiled pages on disk.
- AGPL obligations if source is copied or modified directly.

## Verdict

Yes, we can adapt Synthadoc for this project. The best fit is to let it become the Project Knowledge compiler behind McLellan Hub while Hub remains the front door, chat workspace, model router, and admin interface.

The first useful milestone is not a full "Synthadoc inside Hub" merge. It is a thin, reversible integration where one Hub project can be initialized as a Synthadoc wiki, ingest its existing documents, and answer `/wiki` questions from the compiled Markdown knowledge base.
