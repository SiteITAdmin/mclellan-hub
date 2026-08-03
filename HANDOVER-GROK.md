# Handover to Grok 4.5 (Mac mini, headless)

All outstanding work below is handed to the local Grok 4.5 self-repair venue.
It runs on the Mac mini through the locally authenticated Grok subscription —
**no OpenRouter key, no API billing path**. Nightly 04:30 via launchd
(`com.mclellan.hub.repair-venue`, already loaded), or on demand:

```sh
node scripts/run-repair.js                    # full pass
node scripts/run-repair.js --dry-run          # mine + triage only
node scripts/run-repair.js --reproducer <id>  # one item
```

Venue is now enabled (`REPAIR_VENUE_ENABLED=1` in `.env`, Mac mini only —
`.env` is never deployed). Output is a `repair/<id>` branch + PR + summary
email. **Deploys stay human.**

---

## 1. Action-projection prompt is burning the OpenRouter balance — DO THIS FIRST

**The problem.** `taskHistoryForActionProjection()` in `lib/crm-knowledge-engine.js`
pastes ~17,000 tokens (240 tasks, 68,000 chars) into **every**
`crm_action_projection` call. Average request is 27,000 tokens, so this block is
~63% of every call.

**Cost.** 3 Aug: 182 calls, $5.55. 2 Aug: 108 calls, $2.84. Baseline before the
replay was 1–17 calls/day at $0.01–0.17. That is ~$8.20 above normal in two days,
essentially all one line item, on `anthropic/claude-haiku-4.5`.

**Still running.** 2,987 eligible sources, 1,819 still incomplete — roughly 40%
through. At current rate and prompt size that is ~980 more projection calls and
~$30 more.

**Root cause of the replay.** Commit `cfd0d61` shipped pipeline version
`crm-evidence-actions-v2`. Processing identity is (source, revision, pipeline
version), so bumping the version made the entire corpus re-eligible. This has
happened before. **A pipeline-version bump must not silently re-queue the whole
corpus** — that is the real fix and it is the most important item in this file.

**Do not** simply drop completed/deleted tasks from the block. The prompt
deliberately relies on them (`lib/prompts.js`, `crm_action_projection`):
*"Treat completed, deleted, and wrong task states as authoritative human
decisions. Do not recreate or paraphrase those tasks."* Composition of the 240:
125 completed, 51 deleted, 64 open. Stripping them will start recreating
finished tasks.

**Suggested direction:** prompt-cache the stable task-history prefix (it is
near-identical across calls), and stop re-paying it per batch — `candidateBatches`
splits a dense source into several calls that each re-send the whole block.

---

## 2. Three emails stuck in a retry loop — `OpenRouter 402`

`processing_failures`, unresolved:

| source | message | attempts | first failed |
|---|---|---|---|
| gmail | `19fc6eb9ef911b4f` | 8 | 03 Aug 09:51 |
| gmail_promotion | `19fc6eb9ef911b4f` | 8 | 03 Aug 09:51 |
| gmail | `19fc7170c0f79bb9` | 7 | 03 Aug 10:07 |
| gmail | `19fc7536ad24dcb0` | 3 | 03 Aug 11:17 |

Balance is low, not zero — small calls still succeed (199 in the same window),
large classification calls get 402. **The venue already triaged this as
`skip — transient or upstream error`, which is correct: it is a billing state,
not a code bug.** It resolves when the balance recovers. Listed here only so it
is not mistaken for a code fault. Item 1 is what stops it recurring.

---

## 3. Two documents can never be embedded

`embed_backfill` retries these forever:

- `1e1721e2-b0f9-4b7a-b068-19061281c047`
- `8e3bf436-1a1e-4480-99e4-dd5cca5d1ea2`

`OpenRouter embeddings 400: maximum request size is 300000 tokens per request`.
They exceed the limit and will never succeed as currently chunked. Needs a size
guard in `lib/retrieval.js` so an oversized document is split or marked
unembeddable instead of retrying indefinitely.

---

## 4. CRM engine four-stage split (not urgent)

`lib/crm-knowledge-engine.js` is 2,769 lines. It is documented as four stages
and implemented as one file, which is how `bcf1ea3` hardcoded
`{decision:'new'}` and deleted an entire pipeline stage unnoticed.

Shared infrastructure is already extracted (`lib/crm-receipts.js`,
`lib/crm-source-lease.js`). What remains: `processSourceClaimed` orchestrates
all four stages in one function, and the action-outcome/outbox layer is shared
between automatic projection and human approval. That is an untangling, not a
code move.

Contract tests exist to protect it: `test/hub-promises.test.js`.

---

## 5. Flaky test

`test/content-research-jobs.test.js` fails intermittently under parallel
execution (~2 in 8 full runs), passes in isolation every time. It uses its own
runner rather than `node:test` assertions. Cause not diagnosed.

---

## Venue guards (unchanged)

3 attempts, 5-minute timeout, 12-turn CLI cap, **≤3 changed files**, files must
be under `lib/`, 7-day re-attempt window, recurrence escalates. Four-gate
harness: reproduce before, Grok's own regression test after, full suite,
snapshot flow where deterministic. Items 1 and 4 span more than 3 files and have
no reproducer, so the venue will escalate rather than attempt them — they need
scoping into narrower pieces or doing by hand.
