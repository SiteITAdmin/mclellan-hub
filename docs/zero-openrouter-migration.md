# Zero-OpenRouter Migration (August 2026)

## Outcome

Production Hub must make **zero** network calls to OpenRouter. All text reasoning
runs through the subscription CLI plane (Codex Luna/Terra, Claude Sonnet/Opus,
Grok). Specialists (embeddings, STT, TTS) use local engines when configured, or
degrade closed — never OpenRouter.

## Architecture

1. **Network guard** (`lib/openrouter-guard.js`) — process-level block of any
   `*.openrouter.ai` hostname. Installed at boot in `server.js`.
2. **Fetch wrapper** (`lib/fetch.js`) — rejects OpenRouter URLs; routes
   `hub-model://` to the in-process subscription transport.
3. **Feature → runner registry** (`lib/feature-runners.js`) — task family first,
   difficulty second.
4. **Transport** (`lib/model-transport.js`, `lib/model-request.js`,
   `lib/chat-completions.js`, `lib/hub-model-fetch.js`) — CLI or remote Mac worker.
5. **Worker queue** (`lib/subscription-agent-jobs.js`,
   `scripts/subscription-agent-worker.js`) — continuous pull, one job at a time.

## Task → runner mapping (summary)

| Family | Runner | Examples |
|--------|--------|----------|
| Luna (~55–65%) | codex / gpt-5.6-luna | email_classifier, atom_extractor, crm_parser, agentmail, newsletter extract, task extract, recall tagger |
| Terra (~20–25%) | codex / gpt-5.6-terra | crm_source_triage, duplicate_review, action_projection, meeting_intake, suggestions, digests |
| Grok (~10–15%) | grok CLI | content research, LinkedIn planning, multi-search research |
| Sonnet (~3–7%) | claude / sonnet | cross_entity_synthesis, wiki, newsletter briefing, LinkedIn synthesis, m365/us-block |
| Opus (&lt;2%) | claude / opus | nakai_daily_briefing, exceptional adjudication |
| Local | local | embeddings, STT, TTS (when configured) |

Full map: `lib/feature-runners.js`.

## Cross-entity synthesis fix

Previously assigned to Luna with up to 1,500 atoms. Now Sonnet with max 80
recent atoms, change-driven hash dedupe, fail-closed retention of prior insights.

## Degraded features (local specialist unavailable)

| Feature | Behaviour |
|---------|-----------|
| Embeddings / semantic retrieval | Throws `EMBEDDINGS_UNAVAILABLE`; backfill skips; historical vectors preserved |
| Debrief / workday STT | Error unless non-OpenRouter OpenAI key or future WHISPER_BIN |
| Debrief TTS | hub-model audio returns 503 |
| OpenRouter image gen | Hard error; Google AI image path unchanged if configured |
| Token-burn OpenRouter live sync | Script retired; historical JSON retained |

## Evidence / replay safety

- Jobs carry bounded packets (`maxInputChars`, `maxEvidenceRecords`).
- No automatic historical reprocess on model change.
- Retries reuse the same immutable packet.
- No OpenRouter fallback on CLI failure.

## Rollback (without re-enabling OpenRouter)

1. Redeploy the previous git commit via `scripts/deploy.sh` (or restore code backup).
2. Restore DB backup **only if** schema/data migration caused issues.
3. **Do not** re-add `OPENROUTER_API_KEY` / `OPENROUTER_MANAGEMENT_KEY`.
4. Keep `SUBSCRIPTION_AGENT_WORKER_ENABLED=1` and the Mac worker running.

## Secrets

Remove production OpenRouter keys only after deploy verification. Never print them.
Historical `request_logs` with `endpoint='openrouter'` stay forever for audit.
