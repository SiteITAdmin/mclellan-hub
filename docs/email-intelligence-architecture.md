# Email Intelligence Architecture

## Goal

Gmail and AgentMail are source archives and navigation surfaces. McLellan Hub
uses their messages as evidence for one knowledge-first pipeline; it does not
treat an email summary, Gmail label, or sender adjacency as a relationship
fact. SQLite remains the operational store and `knowledge_atoms`, receipts, and
action outcomes are compiled, re-derivable projections.

The same source-evidence and receipt contract also covers `debrief_session`:
debrief extraction stores candidates for CRM knowledge and does not directly
write CRM facts, tasks, or project notes.

The historical `synthesis_run` and `atoms_backfill` scheduler names are
compatibility entry points into this same canonical engine, not independent
raw-to-atom writers. In normal operation neither may bypass triage,
duplicate/supersession review, current-version receipts, or source leases.

Meeting intake follows the same boundary: model-inferred project matches remain
evidence and do not route project documents or notes; only an explicitly
selected project is an operational destination.

The CRM-bound path is:

```text
Gmail/AgentMail raw message
  -> faithful source evidence
  -> crm_source_triage
  -> crm_duplicate_reviewed (knowledge duplicate/supersession only)
  -> crm_knowledge_synthesised and/or crm_action_projected
  -> atoms/events and stable task/calendar side effects
```

Email classification and label learning happen at ingestion. They help retrieve
and route a message; they do not replace source triage or synthesis.

## Canonical email evidence

The current raw index is `email_summaries`, with the full provider-returned
`body_text` retained for Gmail and sent mail. AgentMail also stores the full
provider body in `inbound_email_records`; the CRM source adapter joins that body
into the compatibility `email_summaries` row. Capture happens before
classifier/model/label work. `ingestion_status` (Gmail) and inbound `status`
(AgentMail) distinguish `captured`, `retry`, and terminal `processed` states;
captured/retry rows remain eligible for refetch. There is no application
acquisition cap; model-context limits apply only after raw capture. The summary
is useful for list views and digests, but is not promoted to canonical body text
when a body exists.

All Gmail list lanes paginate to exhaustion. Received, Promotions, label-filed,
and sent mail advance their own durable checkpoints only after every listed
message body has been materialised and captured. A fetch/capture error leaves
the prior checkpoint in place; already captured rows are idempotently skipped or
resumed on the next poll. Failed label moves are persisted separately and retried
as label-only side effects, without rerunning semantic classification.

MIME capture is structure-aware. `multipart/alternative` contributes one
human-readable representation (plain text when available), while distinct
siblings in mixed/related containers are retained in order. This prevents an
HTML body from hiding a plain forwarded tail, or the inverse. Attachment-backed
text still has to materialise successfully before the source is complete.

Every non-text MIME leaf is fetched before the Gmail cursor advances and leaves
an immutable manifest in `raw_metadata` containing filename, MIME type,
disposition/content ID, provider attachment ID, byte size, and SHA-256. PDF,
DOCX, and supported text/office formats are extracted into the canonical email
body with explicit attachment boundaries. Unsupported or failed extraction is
retained as a hashed manifest and marks the source `attachment_unextracted`
for review; inline related resources are hashed and retained but do not make an
otherwise complete HTML message incomplete. Attachment bytes are never stored
as giant base64 metadata blobs, and unavailable bytes fail closed/retry.

Each `email_summary` evidence envelope carries:

- immutable source identity (`gmail_message_id`, or `agentmail:<external id>`),
  direction, thread/sender/received metadata, and any ingestion hints;
- the full faithful body with subject/from/received headers for model context;
- `complete` and a reason such as `summary_only_missing_raw_body` when only a
  legacy summary was captured;
- a revision hash over the canonical text, completeness, and provenance; and
- deterministic overlapping chunks with preserved character offsets and stable
  chunk IDs. Synthesis consumes every current chunk; per-chunk model limits must
  not discard the tail of a long provider message.

A body arriving later changes the revision and reopens the message for the
current pipeline version. Missing body evidence is a review item, never a
successful skip.

## Processing, receipts, and replay

The processing identity is `(source_kind, source_id, source_revision,
pipeline_version)`. `knowledge_receipts` record each stage's model/version,
status, summary, and payload. `done`, `skipped`, `review`, and `error` are audit
states; only current-revision completion satisfies health. Errors and incomplete
sources remain eligible for retry, and a retry appends a receipt rather than
erasing the failed attempt.

Recovery resumes from the last valid current-revision stage. In particular, a
source interrupted after triage reuses the stored triage candidates and their
stable identities rather than asking a model to reinterpret the source. Covered
action outcomes are not projected again; the engine continues with the missing
projection or synthesis stage. Human-review sources remain paused for a human
decision rather than being automatically reprocessed.

Automatic recovery does not slice one global oldest-first backlog. Each pass
round-robins newest incomplete evidence, oldest incomplete evidence, and errors
whose receipt-derived bounded exponential backoff is due. Persistent failures
therefore cannot hot-loop or starve new mail; the explicit error-retry action
still bypasses the automatic due time. The delay is derived from existing
current-revision receipts/outcomes rather than a separate scheduler-state table.

The whole source run is protected by a durable, token-scoped processing lease
on `(user, source kind/id, revision, pipeline version)`. A heartbeat renews
only its token; expiry permits a replacement worker to reclaim the row, and the
old token cannot finish it. The engine asserts ownership again after each model
await before persisting a result or claiming a provider side effect, so a late
response from a stale worker is discarded rather than becoming a second triage
or atom decision.
The same ownership assertion runs immediately after a Task or Calendar provider
await and before a success/error outcome is written. A lease loss during that
window leaves `pending_task`/`pending_event` untouched for reconciliation;
neither the late worker nor an automatic replay may publish or repeat the call.
Human approval uses that same full-source lease rather than bypassing the
engine: it fails closed while another source worker owns the revision, and a
lost approval lease likewise leaves its pending task/event claim for
reconciliation.

Replay eligibility is the canonical source enumeration used by the CRM engine
and health layer, including the same source exclusions. It recomputes the
current source revision and evaluates the latest receipt for each source/stage;
older revisions or superseded attempts do not count as current completion. The
replay report uses the same coverage state as health: a source is current only
when triage and action projection are present, every triage candidate has a
terminal action outcome, and requested knowledge synthesis has completed.

Document task review follows this same path. Normal Mycelium runs and the
`/api/documents/:id/extract-tasks` endpoint do not invoke a second task model or
call Google Tasks directly; they report the document as deferred and queue or
reuse one versioned `crm_knowledge_engine` job. The canonical engine owns exact
source-span validation, review, and any eventual task projection. The historical
direct extractor remains available only behind
`CRM_LEGACY_DIRECT_WRITES=1` for rollback.

The action projection stage compiles one outcome per source-derived candidate.
The `crm_action_outcomes` unique key includes the exact source span/action key,
not the model's title. It persists `pending_task` or `pending_event` before a
side-effect call and records stable `source`/`source_id` values. Replays first
try to reconcile a locally or externally visible effect; if a pending effect
is ambiguous or unreconciled, replay fails closed into visible review/error
instead of issuing another external call. Stable keys make local reconciliation
possible; they do not provide remote exactly-once delivery. Calendar projection
requires a specific date and time; an undated or date-only due-by action remains
a task decision.

An `action_projection_failed` error means the projection stage failed before a
provider request. A later valid retry may atomically transition that error to a
pending task claim. This does not relax the provider safety rule: a failed or
stale provider claim remains an ambiguity/reconciliation review and cannot be
automatically retried.

Automatic projection and human approval share one evidence gate: an action must
carry the supplied candidate's `candidate_key` and an exact quotation with an
exact `source_span` (`exact`, `chunk_id`, `start`, and `end`). Source-level outcomes, malformed
or unmatched actions, omitted candidates, and approximate spans remain visible
non-creatable review outcomes; approval cannot bypass that gate.

Terminal action dispositions are `task_created`, `event_created`,
`task_and_event_created`, `existing_open_task`, `fyi`, and `dismissed`.
`review`, `error`, `pending_task`, and `pending_event` are non-terminal and
remain visible in the `/crm/knowledge` review/error queue. An operator can
accept a current review item (reusing its action key) or dismiss it with a
reason.

Knowledge duplicate/supersession is a separate decision from open-task
duplication. `crm_duplicate_reviewed` may merge source provenance into an
existing atom or classify a claim as duplicate/superseded; it must not suppress
an otherwise valid action. Action projection may reuse only a verified,
currently-open task (or the source task itself). Completed, deleted, and Wrong
tasks are terminal human history, not title-based duplicate matches and not
permission to recreate paraphrased work.

Atom synthesis is deliberately fail-closed on duplicate review. Only a
high-confidence `new`, duplicate/confirmation, correction, or supersession
decision may proceed. A source-wide duplicate/confirmation result never skips
the rest of that source or merges a full-source reference into its target: the
per-claim extractor must first emit the target with current
revision/chunk/span provenance, at which point normal atom upsert merges it
without a duplicate. Novel claims in the same source remain eligible for new
atoms. If that target is not proven, any novel atoms are retained but synthesis
stays in a visible `duplicate_confirmation_unproven` review. Correction/
supersession must first create a distinct replacement in the same
subject/predicate claim slot and only then retire a mutable target. Review
errors, uncertainty, low confidence, missing targets, and unrelated atoms from
the same source leave the existing claim intact. Provenance retains legacy refs
plus every revision/chunk/span identity across atom merges and deduplication.
These source-level gates have their own audited resolution controls: a human
can record a terminal skip of atom synthesis, or re-run duplicate review for
that exact source/revision only. A retry keeps the prior gate visible until it
has a new gate or terminal synthesis receipt. Generic task-action dismissal
cannot hide a blocked synthesis review, and a targeted re-review never sweeps
unrelated human-review sources into automatic processing.

Health is eligible-source coverage plus outcomes: every current eligible message
needs current triage and action-projection receipts; every emitted action needs
a terminal outcome; and a message marked for durable knowledge needs a current
synthesis receipt. Health uses the latest receipt per source/stage and current
revision, not stale attempts. Terminal action outcomes are authoritative for
external-effect coverage: when all current candidates are terminal, a transient
projection warning does not downgrade the source (explicit errors, pending
effects, and review outcomes remain visible). Receipt, atom, or recent-activity
counts alone are not health.

## Filing model

Each filed message has one stable primary Gmail label:

- `Action/*` — a human decision or explicit work item;
- `People/*` — an actual CRM person;
- `Organisations/*` — a company, community, or institution;
- `Projects/*` — a bounded Hub project;
- `Travel/*`, `Finance/*`, `Commerce/*` — durable life domains;
- `Systems/*` — account, security, agent, or service operations; and
- `Resources/*` — newsletters, research, or reference material.

Label poll is category-blind. `Resources/Newsletters` and `Resources/Research`
feed intelligence extraction; other canonical filed labels enter the normal
classifier carrying the filed label as authoritative. A filed label is a
retrieval/routing decision, not proof that every statement in the message is
about that person or project.

## Identity rules

Canonical people, organisations, projects, services, places, journeys, and
topics are resolved by synthesis against Hub entities and source evidence.
Gmail labels and sender names are aliases and retrieval hints only. For example,
`Dad` may be an alias for a canonical contact, but a newsletter author named
“Nate” remains a resource publisher unless the evidence supports a personal
entity. A project label or sender-domain map cannot, by itself, create a
durable contact-project relationship.

## Gmail lanes

### Received and sent mail

The Gmail processor captures the full provider message before classifier/model
work, maintains the taxonomy, and records unresolved fetch/classification
errors in `processing_failures`. Received and sent rows are then eligible for
the CRM knowledge engine; `captured` and `retry` rows are re-fetchable, while
`processed` is terminal for the intake run. Existing contact hints may be
retained, but model-inferred new recipient contact creation is disabled in
normal operation and only rollback-gated behind
`CRM_LEGACY_DIRECT_WRITES=1`; old direct CRM fact/task paths are compatibility
behaviour. A durable claim or commitment still needs a source-backed receipt
and compiled atom/action outcome.

Routine automated mail may be retained as evidence but excluded from CRM
synthesis when the source is explicitly `__skip`/`__system` or a Hub-generated
report. This exclusion is recorded by the health logic rather than silently
counted as processed.

### Promotions and intelligence labels

Promotions are appraised in a bounded opportunity lane rather than dumped into
the CRM. Newsletter/research labels feed topic and intelligence extraction even
when Gmail's category tabs would have hidden them from the normal fetch. All
such extraction remains source-backed and deduplicated by message ID.

## AgentMail lane

AgentMail stores the full inbound body and raw provider metadata before writing
the compatibility summary row. Its `captured`/`retry` rows remain re-fetchable;
`processed` is recorded only after downstream work completes. Work/newsletter
classification and project hints are useful intake metadata; they are not
durable relationship truth. The CRM knowledge engine reads the body, performs
triage and synthesis, and projects actions using the same revision/action
identity contract as Gmail. Legacy direct facts, project links, and tasks are
disabled by default and exist only behind `CRM_LEGACY_DIRECT_WRITES=1` for
rollback.

AgentMail attachments follow the same fail-closed raw boundary. Every real
attachment is downloaded through the message attachment endpoint before raw
capture, hashed locally, and retained as an immutable manifest (filename, MIME,
disposition/content ID, provider attachment ID, byte size, SHA-256, and
extraction status). Supported text, PDF, DOCX, and office files contribute text
between `[Attachment: ...]` and `[End attachment: ...]` boundaries. Unsupported
or failed extraction is captured as `attachment_unextracted` review state and
never receives the remote `hub-processed` label; transient byte acquisition
failures do not capture or label the message and remain in polling/retry.
Inline/CID resources are manifested when the provider identifies them without
making an otherwise complete message incomplete. Attachment bytes and base64
content are never copied into raw metadata. A persisted unsupported manifest
stays visible for review without a hot-loop; a retry/backfill can re-enter it
when extraction support or provider material changes.

## Source-backed automations

Skyscanner messages are parsed into `travel_price_points` keyed by message ID.
Calendar flight details and booked-flight rows provide context; the suggestion
engine may describe a trend or buying window with evidence and confidence, but
it does not promise a future price.

Commerce/offer messages become `opportunity_signals` only when their usable
details and validity window are captured. A daily salience pass retrieves
nearby atoms, emails, meetings, and documents before deciding whether to show a
suggestion. Suggestions are candidate cache rows: the same signal cannot be
re-admitted as a new open card, and a separate semantic review compares open,
completed, deleted, and Wrong task history. Acceptance requests a source-keyed
suggestion task projection and may promote the accepted rationale to a clearly
source-referenced knowledge atom; if side-effect reconciliation is ambiguous,
it remains visible rather than blindly duplicating work. No suggestion books
or schedules anything automatically.

## Migration and backfill safety

Taxonomy migration is manifest-first: export labels/message IDs, classify in
report-only mode, add canonical labels, spot-check, and retain migration
provenance. Never delete mail as part of label cleanup.

Any body backfill, reprocessing, or replay is dry-run/report-only first and
non-destructive. It may append receipts and re-derive compiled rows, but must
not overwrite raw evidence or create external tasks/events during dry-run. A
live run reuses the source revision and stable action key/outbox IDs; an
ambiguous pending external effect fails closed into visible review/error rather
than being retried blindly. The replay utility's `--apply` mode only queues the
normal versioned engine job; it does not create external tasks or events itself.
The earlier receipt, error, or legacy compatibility row remains auditable.
