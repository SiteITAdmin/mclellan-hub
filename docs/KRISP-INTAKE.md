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
header. A real mobile-recording transcript delivery has now been observed.
Both douglas.mclellan.scot and legacy dchat.mclellan.scot are handled by server
routing, with optional trailing slash. The old dchat hostname currently fails certificate validation, so configure the douglas hostname above. Missing secret returns 503; bad/missing Bearer returns 401. Non-JSON content types return 415. Invalid JSON
returns 400 and oversized JSON returns 413 at the webhook path (10 MB limit).
Failures before capture remain in Krisp delivery history; credentials and payloads
are not logged by this receiver.

## Event handling

Live inspection on 10 November found one `transcript_created` and three identical
empty `note_generated` payloads for the same meeting, differing only in delivery
IDs. Known `note_generated` events receive HTTP 200 with `ignored: true` and are
not stored or queued for a Work/Personal choice. This receiver imports transcripts,
not Krisp-generated notes. Repeating those events creates no cards or knowledge.
Authentication still runs first. Empty `transcript_created` and unknown events
remain visible as unreadable deliveries, so genuine failures are not hidden.
Legacy payloads without an event continue to work. No new table or job is needed.
Existing note cards are not deleted by this code; the user-requested cleanup is
performed separately after deployment, with source/dependency checks.

## Parsing and recovery

The observed `transcript_created` delivery has an event `id`, `data.meeting`
metadata (`id`, `title`, `start_date`, `end_date`, `duration`, owner, participants,
speakers, URL), and `data.content` in chronological order. Each content item has
`text`, `speaker`, and `speakerIndex`. This contract is evidenced by the user's
real-delivery screenshot; no real transcript, identifiers or screenshot is committed.
Tests use synthetic values only.

Content segments render as `speaker: text`, separated by two newlines. Words,
whitespace inside each text, and segment order are retained exactly in the held
transcript. Released sources use confirmed names, indent continuation lines, and
repeat attribution when a long turn needs another source part. Missing names
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

### Speaker release gate

Pending Krisp evidence stays in `krisp_intake`, outside sources, Search, facts
and tasks. Name every speaker in the transcript previews, then explicitly
choose **Work** or **Personal** and press **Release meeting**. Names start blank even when Krisp
supplies a name: this requires confirmation. Ignore remains available independently.
The original JSON and original transcript are retained unchanged. The existing
intake row's `speaker_review` is a raw attribution receipt (revision + confirmed
mapping), not a CRM relationship. Released sources contain attributed turns and
point back to that original delivery; the existing subscription reader alone
synthesizes facts and actions.

Structured `data.content` uses `speakerIndex` as identity when present, otherwise
speaker strings. Every turn must be valid. Plain transcripts support explicit
`Name: text` lines and continuation lines, with no unlabelled preamble. At most
50 speakers are reviewable. Unsupported/unlabelled evidence stays held and may
be ignored; there is no unreadable-source admission bypass. Forms must match the
current raw revision and contain exactly one nonblank name per speaker. Release
is transactional and repeated submissions return the existing sources.

Wispr remains connection-only. Future capture must first retain raw evidence,
use the reusable `lib/crm/speaker-review.js` gate, persist a confirmed attribution
receipt, and require explicit space release before calling source admission.
No capture, polling, new model path, or Wispr admission has been added here.

### Correcting a processed meeting

A meeting that has already been read can still have a speaker corrected. The
signed-in source page for any part of a classified Krisp delivery shows
**Speaker names** with the labels found at the start of released turns. Typing a
confirmed name over a placeholder and saving applies the change to every part of
that delivery in the same space. A part Douglas moved to the other space is left
alone and the receipt counts it (`otherSpaceParts`).

A name may use letters, numbers, spaces, full stops, apostrophes and hyphens, up
to 80 characters: exactly what a transcript label can be, so a saved name is
always offered again and a typo in it can be corrected. The save is refused while
any part of the delivery is queued for reading, or while one of its facts is in
the promise-sorting batch, because those replies were asked with the old text and
would bring the placeholder back.

Giving a speaker a name another speaker already has (or will have after the same
save, ignoring case) would make them one speaker in the transcript for good, so
it is refused unless Douglas ticks **Some of these are the same person**. A swap
or chain in one save (Speaker 1 → Karen, Karen → Margaret) is not a merge, since
every line is renamed in one pass. The receipt lists any merge under `merged`.
A box left empty, or holding its own label with stray spaces, means "leave this
speaker as it is"; the rest of the save goes ahead and the message says so.

This is **containment**, not re-synthesis: `lib/crm/speaker-correction.js`
patches the rows that already carry the placeholder. It rewrites column-zero
`Label:` prefixes in the released source text, the `Speaker N` placeholder inside
statements, promise `who` and `action` fields, the matching `atom_mentions` rows
(then re-runs the existing deterministic matcher), and the title of any task
already made from those atoms, together with the title line and statement
prefix of that task's own snapshot sources (so search no longer finds the
placeholder there). Quotes, the original `raw_json`, the original
transcript and existing task/atom/source IDs are left untouched. A promise task's
notes keep their verbatim quote; only the statement prefix is replaced. Indented
`Label:` lines are quoted speech and are not rewritten, and `Speaker 1` never
matches `Speaker 10`.

Only the reader's own `Speaker N` form is rewritten inside prose. A real name
such as `Karen` is corrected in the transcript, but not inside statements or task
text, where the same first name could belong to someone else. An atom shared with
evidence outside this delivery (the reader merges an identical statement) is
reported and left unchanged, along with any task made from it, so another
meeting's facts are never altered. A mention Douglas decided himself (`how` `you`
or `decided`) keeps that decision. A task typed by hand and merely linked to the
source has its title corrected, but not its notes, which are Douglas's own words.

Facts are re-indexed in FTS and the correction is recorded as a receipt in
`settings` and in the intake's `speaker_review.corrections`, so it can be audited.
Sources are not read again, so no fact or task is duplicated. A corrected task
gets a new revision, which the existing Google Tasks sync pushes; nothing is sent
to anyone. Derived text that regenerates on its own — standings, meeting
preparation, promise action wording — may keep the old label until it is rebuilt.
