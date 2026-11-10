# Krisp transcript intake

Implemented locally; not deployed or verified with a real Krisp delivery.

## Setup and flow

Set KRISP_WEBHOOK_SECRET securely. POST /api/krisp/webhook with Authorization:
Bearer <secret>. No global space configuration exists. Body space fields are
rejected; each transcript must be assigned Work or Personal on /crm/work/meetings or /crm/personal/meetings behind
Douglas's existing sign-in. Ignore keeps an unwanted delivery out of knowledge.
Home has a Meetings shortcut in each space; the old /crm/krisp link redirects to Work Meetings. Pending recordings appear in both spaces, while classified source links appear only in their current space; Today shows only the pending count.

Raw JSON is stored once in krisp_intake, outside sources, FTS and model processing.
Classification atomically admits transcript parts through the existing source
pipeline and records their IDs. Each source references the intake record; its
signed-in page resolves raw provenance only for a matching current source, space and source ID, including moved sources.
Repeated delivery does not reopen classified or ignored records. Conflicting
classification returns 409. Failed classification rolls back admission and choice.
No new scheduler, Mac program or model transport was added.

Use Krisp's individual Transcript created integration with a custom Authorization
header. Account plan and telephone event support still need live confirmation.
Both douglas.mclellan.scot and legacy dchat.mclellan.scot are handled by server
routing, with optional trailing slash. Legacy DNS/nginx/certificate ownership is
unverified. Missing secret returns 503; bad/missing Bearer returns 401. Non-JSON content types return 415. Invalid JSON
returns 400 and oversized JSON returns 413 at the webhook path (10 MB limit).
Failures before capture remain in Krisp delivery history; credentials and payloads
are not logged by this receiver.

## Parsing and recovery

Supported transcript string aliases: transcript_text, transcriptText, transcript,
in the existing supported envelope locations. These aliases came from the retired
receiver; current Krisp payload schema has not been verified. Notes, arrays and
URLs are not substitutes. Any nonempty transcript is readable, including short
calls. Empty/unsupported deliveries stay visible with their original JSON; if
classified they produce skipped sources. Seconds, milliseconds and date strings
are accepted for supported timestamp fields; missing dates use receipt time.

Dedupe uses meeting ID and transcript content, independent of event ID and chosen
space. Corrections with different text are separate evidence for existing synthesis.
Without a meeting ID, identical content deduplicates. Unsupported JSON uses its raw
hash, so event-only changes can produce separate unsupported items.

There is no reparse button in this revision. For an unsupported delivery, leave it
pending or Ignore it, inspect the raw JSON, repair the parser using that evidence,
then resend the original delivery. Once the parser extracts text it has a new
content identity and can be classified normally; the old item remains as the audit
record. Resending unchanged unsupported JSON alone does not retry extraction or
reopen a skipped source. Do not delete records to bypass deduplication.

## Remaining live verification

With separate live authorization, verify only the single recording dated today,
10 November 2026. Its exact title/ID and payload remain unconfirmed. Do not bulk
backfill historical recordings. This is an initial verification target, not a
permanent today-only filter. Compare full transcript/date and classification,
then verify source-backed atoms through the existing subscription worker.
No live data, supplied credential, production POST, deployment or import was used.

## Local evidence

HUB_DISABLE_JOBS=1 node --test test/crm-krisp.test.js uses dummy Bearer credentials,
local HTTP intake and owner-session route/render patterns. It covers missing
configuration/auth, spoofed space, no pre-choice sources/FTS, escaped holding UI,
auth/origin/choice guards, conflicts, dedupe after choice/ignore, source provenance,
short text, numeric dates, split reference storage and synthetic atom application.
Full-suite results are recorded in the revision commit and implementation report.

Actual server.js with isolated temporary Hub/CRM databases passed 16 local HTTP
checks across both host headers and both path variants: 400 malformed JSON,
413 oversized JSON, 401 missing Bearer, 200 authenticated intake. Full npm test:
149 tests, 148 pass; the pre-existing Hermes installer GNU/BSD sed failure remains.
