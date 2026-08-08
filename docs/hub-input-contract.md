# McLellan Hub Input Contract

This contract is the gate for every ingest path. The Hub keeps raw evidence
faithfully, derives meaning with the knowledge pipeline, and exposes compiled
knowledge or action outcomes. Operational tables (`crm_facts`, link tables,
`google_tasks`, `meetings`, labels, and similar rows) are projections or
compatibility surfaces; they are not a substitute for source evidence. SQLite
remains the store. No graph database is implied.

The canonical flow is:

```text
raw input -> source evidence -> triage/review -> knowledge atoms/events and/or action outcomes -> views/side effects
```

`CRM_LEGACY_DIRECT_WRITES=1` is rollback-only. It is not the normal way to
write CRM facts, relationship links, or source-backed tasks.

Historical scheduler names do not create parallel pipelines. `synthesis_run`
delegates to `crm_knowledge_engine`, and `atoms_backfill` queues CRM facts into
that same engine; only the rollback flag may invoke the old direct fact-to-atom
compiler. A scheduled job having run is therefore never, by itself, evidence
that semantic coverage exists.

## Source-evidence contract

CRM-bearing sources are normalised by `lib/source-evidence.js`. The envelope
contains `source_kind`, `source_id`, faithful text, source-specific provenance,
`complete`/`completeness`, a SHA-256 `revision_hash`, and deterministic
overlapping chunks with stable character offsets and `chunk_id`s. The current
CRM source kinds are `email_summary`, `meeting_intake`, `debrief_session`,
`document`, `open_task`, `completed_task`, `crm_fact`, and
`messaging_message`.

Gmail and AgentMail are raw-first: the provider body and source metadata are
captured before classifier, model, or label work. `email_summaries.ingestion_status`
and AgentMail's inbound status distinguish `captured`, `retry`, and terminal
`processed` rows (the promotion lane may use its own processed marker). A
captured or retry row remains eligible for refetch and processing.

- Email evidence uses the full provider-returned `body_text` (or the AgentMail
  inbound body) whenever it is present; there is no application acquisition cap.
  `summary` is a compatibility fallback and is marked
  `summary_only_missing_raw_body`, never complete evidence.
- Gmail non-text MIME leaves are fetched before cursor advancement and retained
  as immutable hashed attachment manifests in `raw_metadata`. PDF, DOCX, and
  supported text/office attachments are represented in the canonical body with
  explicit boundaries. Unsupported or failed extraction is marked
  `attachment_unextracted` for review; inline related resources are manifested
  without downgrading an otherwise complete HTML source. Missing attachment
  bytes fail closed and remain retryable; raw metadata never stores base64
  blobs.
  MIME alternatives contribute one preferred representation; distinct
  mixed/related siblings are preserved in order, including HTML/plain forwarded
  tails. Unavailable attachment-backed text fails closed for retry.
- Meeting evidence uses the transcript; a summary-only intake is explicitly
  incomplete. A complete transcript remains canonical when the preliminary
  meeting extractor errors, and a stale `processing` lease re-enters recovery;
  only a live processing lease is temporarily excluded. Debrief sessions use
  `debrief_sessions.transcript` as canonical evidence; a missing transcript is
  incomplete. Documents use stored Markdown, except derived meeting registers,
  `_Project Memory.md`, saved chat answers (`auto_generated: true`), and other
  generated outputs, which are searchable projections but never task-bearing
  source evidence. Workday interview documents retain their full, readable
  model narrative in the document UI, but their canonical adapter exposes only
  the terminal raw transcript section; changing the generated narrative alone
  cannot revise the source or produce atoms/tasks.
  Tasks, facts, and messages retain their text plus identifiers and links needed
  to explain provenance.
- A revision changes when text, completeness, or provenance changes. Processing
  identity is the current source revision plus the stage's pipeline version;
  receipts and action outcomes must carry both.
- Canonical evidence is split into deterministic overlapping chunks with stable
  offsets and IDs. Synthesis consumes every current chunk; any model-context
  bound is applied per chunk and must not discard the tail of the source.

Missing or incomplete evidence is a visible review state, not a successful
no-op. A later body/transcript backfill produces a new revision and is eligible
for processing again.

## Input contract

| Input | Raw/evidence store | Derivation and compiled result | Visible output and guardrails |
|---|---|---|---|
| Hub chat and project chat uploads | `conversations`, `messages`, project `documents`, ingestion packages, vault source | Chat recall/context; document embedding and synthesis jobs when ingested | Chat, project pages, Ask/knowledge, wiki. A chat adjacency is not CRM relationship truth. |
| Non-project chat files | `messages`; ingestion package for large files | Immediate response; background document synthesis when the package is admitted | Conversation history and later knowledge surfaces; no claim is canonical until source-backed synthesis. |
| Gmail received email | Raw provider body/headers/labels captured in `email_summaries` before model work; `ingestion_status` is `captured`, `retry`, or `processed`; `processing_failures` records acquisition/processing errors | Gmail list pages are exhausted and the received checkpoint advances only after every listed body is durably captured. Gmail classifier/label learning stores the source; `crm_knowledge_engine` runs source triage, duplicate/supersession review, synthesis, and action projection. Newsletter/opportunity/travel extractors remain separate source-backed lanes. Captured/retry rows are re-fetchable. | Gmail labels, knowledge/contact/project views, `knowledge_receipts`, `knowledge_atoms`, `crm_action_outcomes`, tasks/events only through action projection. A failed label move is a separately persisted, label-only retry and cannot replay semantic/provider work. Direct fact/task writes are legacy compatibility under `CRM_LEGACY_DIRECT_WRITES=1`. |
| Gmail label-filed mail | Gmail labels and the same `email_summaries` evidence row | `pollFiledLabels` is category-blind: `Resources/Newsletters` and `Resources/Research` feed intelligence extraction; other canonical labels enter classification with the filed label authoritative. | Filed mail is retrievable even when Gmail put it in Promotions/Social. Deduplicate by message ID; do not re-file a user-filed label. |
| Gmail Promotions/Commerce mail | Email body and `opportunity_signals`/travel price rows | Bounded appraisal extracts source signals; the suggestion pass decides whether current context makes one relevant | Suggestions are candidates, not actions or knowledge before acceptance. No automatic booking or scheduling. |
| Gmail sent email | Full provider body and recipient headers captured in `email_summaries` with `direction='sent'`; existing contact hints may be retained; captured/retry/processed state is retained | Sent mail has an independent paginated checkpoint which advances only after durable capture. Sent classifier plus CRM knowledge engine derives claims/actions. Model-inferred new contact creation is disabled in the normal path and only available behind `CRM_LEGACY_DIRECT_WRITES=1`; old direct facts/tasks are compatibility behaviour, not proof of a durable relationship. | Sent history, compiled knowledge, and source-backed action outcomes. |
| AgentMail inbound | Full provider body/raw metadata captured in `inbound_email_records` before model work; compatibility `email_summaries`; immutable downloaded attachment manifests; captured/retry/`attachment_unextracted`/processed status, labels, and `processing_failures` | `agentmail_process` materialises and hashes every real attachment first, extracts supported text/PDF/DOCX/office bytes with explicit attachment boundaries, then classifies work/newsletters and lets the CRM knowledge engine derive atoms/actions. Captured/retry rows are re-fetchable; unsupported/extraction-failed attachments stay `attachment_unextracted` review and never receive `hub-processed`; transient byte failures fail capture and remain in polling. Persisted review manifests are not hot-looped; an explicit retry/backfill can re-enter them. | AgentMail labels, knowledge/project views, receipts, tasks/events through action projection, intelligence surfaces. Legacy direct CRM writes remain flag-gated; base64 attachment bytes are never stored in metadata. |
| Meeting transcript/Krisp intake | `meeting_intakes.transcript`, source metadata, optional `meetings` row | Speaker review and intake extraction produce a reviewable extraction; CRM knowledge consumes the full transcript even when preliminary extraction errors, and resumes stale processing leases. Model-inferred attendee/update names only match existing contacts; model-inferred projects do not route documents or project notes. Only an explicitly selected project is an operational destination; any derived meeting document is excluded from canonical task evidence. Direct facts/tasks/project links remain legacy compatibility when the rollback flag is enabled. | Intake review/retry, meeting/project pages, knowledge atoms/events, action queue, and projected tasks/events. A summary without a transcript stays incomplete. |
| Daily debrief | `debrief_sessions` transcript/session metadata plus Obsidian `Debrief/*.md` note | `debrief_session` is canonical source evidence consumed by the CRM engine, synthesis, health, and replay. The extractor stores candidates and `outcome`/`task_outcomes.status = deferred_to_crm_knowledge`; it does not directly write facts, tasks, or project notes. | Debrief note, `/crm/knowledge` receipts/action queue, compiled atoms/actions, and projected tasks/events after engine decision. Session error/deferred state stays visible. |
| Direct `/meeting` note submission | Meeting note file written by `lib/meeting.js` | Treat the note/transcript as evidence and route it through meeting intake/knowledge synthesis when CRM meaning is required | Meeting note and later compiled knowledge; a generated note alone is not a relationship or task decision. |
| Documents and project uploads | `documents.markdown`, project id, MIME/name, ingestion package path | Embedding/synthesis jobs derive knowledge. Normal Mycelium does not run a shadow document-task model, write non-versioned task receipts, create document tasks, or mark extraction complete; it reports the document as deferred and queues/reuses one versioned `crm_knowledge_engine` job. The `/api/documents/:id/extract-tasks` endpoint follows the same queue/review path. Compatibility document-task extraction/projection is gated by `CRM_LEGACY_DIRECT_WRITES=1`; failed legacy projection leaves the marker unset for retry. Name mentions do not create `contact_projects`. | Project docs, knowledge atoms/events, tasks where a reviewed action is projected. Generated memory documents are not task candidates. |
| Google Tasks/manual tasks | Local `google_tasks` mirror and remote Google Tasks | Task sync preserves state. `task-router` queries compiled atoms and attaches only a high-score, clearly separated entity; ambiguous/low-confidence cases receive a review receipt and remain unlinked. `/crm/planner` derives unscheduled work from this same open-task mirror and existing task-planner event receipts/cache; it does not create a planner task copy. Completed tasks are evidence of state, not requests for replacement work. | `/crm/tasks`, `/crm/planner`, reminders, briefings, action/source views. Routing and calendar placement are operational hints, never relationship truth. |
| Regulatory monitor items | `reg_monitor_items`, run/source metadata | Monitor assessment remains source evidence. Keyword matching to a project and CRM-fact writes are prohibited; synthesis must decide whether a project/company risk atom is warranted. | Regulatory briefings/alerts and, when synthesized, source-backed knowledge. |
| Mycelium cross-node checks | Flights, calendar, documents, meetings, and task rows | Mycelium may request operational task projections for flight prep/check-in and meeting prep through source-keyed task paths; document task candidates are deferred to CRM knowledge in normal operation. Document-name matching and deterministic relationship writes are prohibited; relationship derivation is deferred to synthesis. | Connectivity report, tasks, flight notes, and error details; no relationship claim from adjacency or document-name matching. |
| Suggestions | `suggestions`, `suggestion_feedback`, `suggestion_lessons`, source signal rows | Daily LLM radar reads source-backed context. Stable source IDs and a separate semantic duplicate review keep open/completed/deleted/Wrong task history distinct from knowledge duplicate review. | Reviewable cards with Create task, Not this time, Dismiss, Why, Wrong. Suggestions expire after 14 days; only acceptance creates a task and may promote accepted rationale to a knowledge atom. |
| WhatsApp/Hermes messages | `messaging_messages` with the complete provider body, parseable provider envelope, platform/chat/sender, and full external id; capture does not impose a 20k/50k acquisition cap | CRM knowledge engine performs triage, synthesis, and action projection over deterministic chunks. Historical backfill is evidence-only and blocks current task projection. | Source-backed atoms/actions, tasks after projection, Ask/briefings, and receipts. |
| Calendar events | Google Calendar and local `meetings` cache | Inbound sync supplies context. A CRM action with a specific date and time may create an event through the stable action outbox; an ambiguous or unreconciled pending event fails closed and stays visible. Explicit task planning creates or patches one event carrying private `hubTaskId` provenance, reconciles before retry, and records `calendar_planner_effect`; unscheduling removes only that event. Provider exactly-once delivery is not assumed. | Calendar, `/crm/planner`, meeting pages, work brief, and action receipts. |
| RSS/newsletters/briefings | `rss_*`, `intel_*`, briefing tables | Feed/topic extraction and briefing synthesis produce intelligence outputs; they do not become CRM relationship facts by sender or label alone. | Intelligence dashboard, briefings, PDFs/wiki notes. |

## Action and processing invariants

Every stage writes a receipt keyed by source kind/id, current revision, and
pipeline version. `error`, `review`, and incomplete outcomes remain replayable;
retrying must not erase the earlier receipt.

Automatic OpenRouter CRM processing is **new evidence only**. A pipeline-version
bump must not re-queue the historical corpus: same-revision completion under any
prior pipeline version is grandfathered, and evidence older than
`CRM_KNOWLEDGE_AUTO_PROCESS_AFTER` is frozen for automatic selection (manual
source-scoped replay remains available). OpenRouter spend after a top-up should
be ordinary daily arrivals, not a full re-atomisation. For each triage action candidate,
`crm_action_outcomes` records the exact source span and a stable source-derived
`action_key`. The task/calendar outbox writes `pending_task` or
`pending_event` before an external call and uses stable `source`/`source_id`
values. On replay, if local/remote reconciliation is ambiguous or a pending
side effect cannot be proven, it fails closed into visible review/error rather
than issuing another external call; stable keys are not a remote exactly-once
guarantee and only support local reconciliation.

Incomplete/error recovery is stage-aware. A valid current-revision triage or
duplicate-review receipt is reused verbatim, covered action outcomes are not
projected again, and only missing/error stages resume. A crash after triage must
not trigger a fresh model interpretation with different candidate identities.
Automatic scheduler selection is a receipt-derived fair mix of newest
incomplete evidence, oldest incomplete recovery, and due errors. Error retry
backoff is derived from current-revision error receipts/outcomes (bounded
exponential delay), so persistent failures neither hot-loop nor starve recent
evidence; an explicit error retry bypasses that automatic due time. No separate
mutable scheduler-state table is used.
One durable, token-scoped source-processing lease encloses that whole pipeline
for each `(user, source kind/id, revision, pipeline version)`. It is heartbeated
while work runs, may be reclaimed only after expiry, and is checked again after
every model response before it can write a receipt, atom, or provider claim.
The stale worker's token cannot finish or overwrite the replacement's lease.
Ownership is asserted immediately after each task/calendar provider await and
again before publishing a success or error outcome. If it was lost mid-call,
the pending outbox row is deliberately left intact for reconciliation; a late
worker never publishes a terminal result or repeats the provider call.
Human approval acquires the same full-source lease, so it fails closed while a
source worker is active and follows the identical pending-outbox rule if its
lease is replaced during a Task or Calendar call.

Automatic projection and human approval have the same evidence gate: the action
must carry the supplied candidate's `candidate_key` and an exact quotation with
a valid `source_span` (`exact`, `chunk_id`, `start`, and `end`). Source-level outcomes,
malformed or unmatched actions, omitted candidates, and approximate spans are
visible non-creatable review outcomes; approval cannot turn them into a task or
event without fresh exact evidence.

Knowledge duplicate/supersession review applies to compiled claims/atoms and
may merge provenance or mark a claim stale/superseded. Open-task duplication is
a separate action concern: only an explicitly verified currently-open task can
be reused. Completed, deleted, or Wrong task history is terminal human state;
it is not a title-based duplicate detector and is not silently recreated.
Atom synthesis fails closed unless duplicate review reaches the configured
high-confidence decision. A source-wide duplicate/confirmation result does not
skip full-source synthesis or merge a full-source reference into one target:
the per-claim extractor must prove that target with current revision/chunk/span
provenance, and normal atom upsert then merges it without a duplicate. Novel
claims in the same source remain eligible. If that target is unproven, novel
atoms remain stored but the source has a visible
`duplicate_confirmation_unproven` review. Correction/supersession creates a
distinct replacement in the same subject/predicate claim slot before retiring a
mutable target. Uncertain, low-confidence, malformed, or failed duplicate
review creates no atom; its independently evidenced action candidates may still
be projected. Atom references retain legacy refs as well as revision, chunk,
and span coordinates through merges and deduplication.
Duplicate/supersession source-level reviews are not generic action dismissals.
The knowledge queue offers an audited choice to skip atom synthesis (current
duplicate and synthesis receipts become terminal `skipped`) or to re-run only
that source's duplicate review and then resume its gated synthesis. It retains
the existing gate until a fresh gate or terminal synthesis is safely recorded,
and it does not make unrelated human-review sources eligible for automatic
processing.

Action dispositions are visible and auditable. Terminal dispositions are
`task_created`, `event_created`, `task_and_event_created`, `existing_open_task`,
`fyi`, and `dismissed`; `review`, `error`, `pending_task`, and `pending_event`
stay in the review/error queue. `/crm/knowledge` exposes source coverage,
receipts, errors, and the action queue; accepting a review item reuses its
stable key and dismissing it records the reason.
An `action_projection_failed` outcome is retryable only when the projection
failed before a provider claim; retry atomically moves it back to the pending
task claim. Provider-call ambiguity remains permanently non-creatable pending
reconciliation and is never retried automatically.

Health means coverage, not activity. For the current revision, every eligible
source must have current triage and action-projection receipts; every emitted
action candidate must have a terminal outcome; and sources marked as requiring
knowledge synthesis must have a current synthesis receipt. Health accounts for
the latest receipt per source/stage and current revision, not stale attempts.
Terminal action outcomes are authoritative for external-effect coverage: when
all current candidates are terminal, a transient projection warning does not
downgrade the source (explicit errors, pending effects, and review outcomes
remain visible). The health panel must report eligible, complete, incomplete,
review, and error counts plus the outcome queue. Counts of atoms, receipts, or
recent activity alone do not prove the pipeline is healthy.

## Add-new-input checklist

1. Where is the source preserved faithfully, with provenance and revision?
2. Which source kind and synthesis/review stage decides new, duplicate,
   superseded, unrelated, or actionable?
3. Which compiled atoms/events/action outcomes or other cache will hold the
   result, and what receipt explains it?
4. Where is the result visible, including review and error states?
5. What dry-run-first, non-destructive backfill/replay repairs existing rows?

Backfills and replays are report-only first. Replay eligibility uses the same
canonical source enumeration and exclusions as the CRM engine/health layer,
recomputes each source's current revision, and accounts for the latest stage
receipt; stale revisions do not count as complete. Replays may append receipts
and re-derive compiled projections, but must not delete or overwrite raw
evidence. Live side effects must reuse the established stable action identity;
ambiguous pending effects fail closed for review/error rather than being
retried blindly. `scripts/replay-crm-knowledge.js` is read-only in dry-run mode;
`--apply` only queues the normal versioned engine job and does not create
external tasks or events itself. Never let a destructive repair be the default.
