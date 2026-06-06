# Email Intelligence Architecture

## Goal

Make Gmail, People/CRM, Calendar, the knowledge base, and Hermes use one
consistent information model while retaining every email as reusable evidence.

Gmail is not the database. It is the human navigation surface and source archive.
McLellan Hub is the canonical relationship, classification, and automation layer.

## Filing Model

Each filed email gets one stable primary Gmail label:

- `Action/*` for work requiring a human decision.
- `People/*` only for real CRM people.
- `Organisations/*` for companies, communities, and institutions.
- `Projects/*` for bounded outcomes already represented in Hub.
- `Travel/*`, `Finance/*`, and `Commerce/*` for durable life domains.
- `Systems/*` for account, security, agent, and service operations.
- `Resources/*` for newsletters, research, and reference material.

Hub may attach many dimensions to the same message:

- people and aliases
- organisations
- projects
- topics
- journeys or calendar events
- products and services
- signal type
- action state
- source and provenance

This avoids a folder per sender while preserving sender-level retrieval in Hub.

## Identity Rules

Canonical identity belongs in CRM, not in Gmail labels.

Example:

```json
{
  "canonical_name": "Alister McLellan",
  "aliases": ["Dad"],
  "gmail_label": "People/Alister McLellan"
}
```

Old labels remain recorded as migration provenance. Messages under `Dad` and
`Alister McLellan` can therefore be consolidated without losing either search
term or the fact that both labels existed.

A named newsletter author is not automatically a CRM person. `Nate`, for
example, should remain a resource publisher unless there is a genuine personal
relationship to represent.

## Proposed Hub Records

The next schema phase should introduce:

### `email_records`

One row per Gmail message with immutable Gmail ID, thread ID, headers, received
time, current primary label, original labels, retention status, and processing
version. This replaces `email_summaries` as the durable source index; summaries
become derived data.

### `entities`

Canonical people, organisations, projects, services, places, journeys, and
topics. Existing `contacts` and `projects` can remain compatibility views or
foreign-key targets during migration.

### `entity_aliases`

Aliases such as `Dad -> Alister McLellan`, sender addresses, former organisation
names, and alternate spellings.

### `email_entity_links`

Many-to-many links from an email to entities, with relation type, confidence,
classifier version, and whether the link was user-confirmed.

### `signals`

Structured observations extracted from messages:

```json
{
  "type": "travel.price_observation",
  "source": "skyscanner-price-alert",
  "observed_at": "2026-06-06T12:59:08Z",
  "subject": {
    "origin": "DUB",
    "destination": "EDI",
    "travel_window_start": "2026-11-01",
    "travel_window_end": "2026-11-30"
  },
  "measurement": {
    "currency": "EUR",
    "amount": 74.0
  },
  "evidence_gmail_message_id": "..."
}
```

### `automation_rules` and `automation_runs`

Versioned rules, schedules, checkpoints, output, and audit history. A run must be
idempotent and retain links to every email and calendar event used as evidence.

## Skyscanner Reference Automation

1. Gmail ingestion identifies a Skyscanner price-alert email.
2. The extractor stores route, travel dates, observed price, currency, and alert
   URL as a `travel.price_observation`.
3. Calendar ingestion looks ahead for likely trips. Explicit event metadata is
   preferred, but title/location parsing can provide suggestions for confirmation.
4. Hermes links observations to the journey by route and travel window.
5. A daily job calculates trend, recent low, volatility, and days until travel.
6. Hermes alerts only when a decision threshold is crossed, for example:
   "Prices for your November Dublin-Edinburgh trip are 18% below the 30-day
   median; this coming week is currently the strongest buying window."
7. The message includes confidence and evidence. It does not claim to predict a
   guaranteed future price.

The same pattern supports parcel tracking, renewal warnings, event preparation,
financial price changes, software incidents, and relationship follow-ups.

## Migration Sequence

1. Export Gmail labels, counts, and message IDs to a timestamped manifest.
2. Populate canonical entities and aliases in Hub.
3. Run classification in report-only mode and resolve ambiguous labels.
4. Add canonical labels without removing old labels.
5. Verify counts and spot-check messages.
6. Remove obsolete labels from messages, retaining the manifest indefinitely.
7. Delete only empty label definitions after explicit approval. Never delete mail.

Legacy labels that contain unrelated senders must be migrated per message rather
than renamed wholesale. The current `Kai` and `Personal` labels are known mixed
buckets and must always take this slower path.

The taxonomy in `config/email-taxonomy.json` is versioned so every migration and
future classifier run can state which rules produced its result.
