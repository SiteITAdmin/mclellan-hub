# Krisp transcript intake

A real delivery on 10 November 2026 exposed the segment contract below; this parser fix is locally verified with synthetic data. Production recovery and downstream model output remain for deployment verification.

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

The observed `transcript_created` delivery has an event `id`, `data.meeting`
metadata (`id`, `title`, `start_date`, `end_date`, `duration`, owner, participants,
speakers, URL), and `data.content` in chronological order. Each content item has
`text`, `speaker`, and `speakerIndex`. This contract is evidenced by the user's
real-delivery screenshot; no real transcript, identifiers or screenshot is committed.
Tests use synthetic values only.

Content segments render as `speaker: text`, separated by two newlines. Words,
whitespace inside each text, and segment order are retained exactly, including
across source parts (concatenate parts without adding separators). Missing names
use only the supplied numeric index (`Speaker 7`); metadata never invents a name.
Speaker metadata is not admitted as contact identity, including placeholder
`@noemail.krisp.ai` addresses. Any malformed/empty segment, missing label and
index, or non-array content makes the entire delivery unreadable, rather than
silently losing part of the evidence. Raw JSON stays available for inspection.
When content is present it takes precedence over legacy transcript aliases.

Legacy string aliases `transcript_text`, `transcriptText`, `transcript` remain
supported in the existing envelope locations. Seconds, milliseconds and date
strings are accepted; `data.meeting.start_date` supplies the observed meeting date.
Missing/invalid dates fall back to receipt time on classification.

Reading the intake list (including either Meetings page), receiving a webhook,
or classifying lazily reparses only unreadable pending intake rows. Successful
recovery updates transcript/readability in place, retaining ID, original JSON,
title, dates, status and provenance. It creates no sources, FTS entries, contacts
or model jobs. Unsupported pending rows remain inspectable; ignored/classified
rows are never reparsed or reopened. No historical source backfill occurs.

Dedupe uses meeting ID and rendered transcript, independent of event ID and space.
Resends of previously unreadable ignored/classified records also preserve the existing decision when their stored payload parses to the same meeting and transcript, without changing the archived row.

Recovered records keep their original raw-based ID: resends match their stored
transcript and meeting ID, even after classification or Ignore. Changed transcript
content remains separate evidence. Without a meeting ID identical text deduplicates.
Unsupported JSON retains raw-based identity, so event-only changes can still
produce separate unsupported items. This revision does not consolidate duplicates
that already existed before deployment.

## Remaining live verification

With separate live authorization, verify only the single recording dated today,
10 November 2026. The screenshot established the segment payload contract; exact content must be compared only in the authorised live environment. Do not bulk
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
