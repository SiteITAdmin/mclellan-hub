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

## 1. Action-projection / full-corpus reprocess — FIXED (Grok, 3 Aug 2026)

**Was:** pipeline version `crm-evidence-actions-v2` re-queued the whole corpus;
action projection pasted full task history into every call.

**Now:**
- `CRM_KNOWLEDGE_AUTO_PROCESS_AFTER` freezes automatic OpenRouter CRM work for
  evidence older than 2026-08-03T00:00:00Z (new evidence only).
- Same-revision completion under a prior pipeline version is grandfathered —
  a version bump must not re-bill the historical corpus.
- Task history for projection keeps completed/deleted/wrong (anti-recreation)
  but closed tasks are title-only; open tasks keep fuller detail.
- Oversized embeddings are marked `unembeddable` instead of retrying forever.

When OpenRouter is topped up, only ordinary daily incomplete/error sources
inside the auto-process window should run.

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
