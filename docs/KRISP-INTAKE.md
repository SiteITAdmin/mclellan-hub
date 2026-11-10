# Krisp transcript intake — Change Desk 4d7499a4

Implemented receiver; not deployed or verified against a real Krisp delivery.

## Supported automatic path

Krisp's official [Webhook API guide](https://help.krisp.ai/hc/en-us/articles/24514911804316-Webhook-API)
(accessed 10 November 2026) supports automatic Transcript created events on
Core/Advanced, custom Authorization headers, sample deliveries and delivery history.
Use the individual integration; team webhooks additionally require broader meeting
sharing. No calendar invitation or attendees are required. This receives existing
transcripts; it does not record calls or transcribe audio.

The guide does not publish an exact payload schema. Transcript string field aliases
are evidence from version-old:routes/hub-crm.js, not a verified current API contract.
The retired route accepted Bearer, x-krisp-token and x-api-key. This receiver retains
only the user-confirmed Bearer contract. It never accepts a user/space from the body.
Notes, outlines, arrays and URLs are not silently substituted for transcript text.

## Setup after review/deployment

1. Set KRISP_WEBHOOK_SECRET securely and KRISP_WEBHOOK_SPACE explicitly to work or
   personal. Neither has a default; missing configuration returns 503. Use a dedicated
   single-space integration. Mixed Work/Personal recordings must not automatically be
   sent to this integration until the user chooses how to separate them.
2. The receiver path is /api/krisp/webhook on douglas.mclellan.scot and, for compatibility,
   dchat.mclellan.scot. The latter existed in Version Old, but current nginx routing,
   certificate and which application owns it must be confirmed separately. A read-only
   public web fetch failed; that does not establish endpoint health. No production POST
   or configuration change was performed.
3. In Krisp Settings → Integrations → Webhook, select Transcript created and set
   Authorization to Bearer followed by the configured secret. Confirm account plan and
   that telephone recordings trigger this event.
4. With separate authorization for live testing, send a sample and one real telephone
   transcript; inspect Krisp delivery History and Hub Captured in the configured space.
   Compare the full transcript and timestamp to Krisp, then verify source-backed atoms
   through the existing subscription worker. Do not call synthetic tests proof of this.
5. If the real payload uses different fields, inspect Original Krisp delivery on the
   signed-in source page and adapt the parser using that evidence. Unsupported/empty
   payloads are saved as unreadable/skipped sources, never sent to the model. Re-send
   after parser repair; no automatic retry of unreadable evidence is claimed.

## Data flow and limits

No new table, scheduler or Mac program. Raw JSON (raw_ref), transcript parts, title,
origin and available start time enter existing sources via admitSource, then the normal
crm_atomise_tick subscription pipeline compiles atoms. Full JSON is retained on each
part and shown only on the authenticated source page. Unknown named speakers use the
existing same-space identity resolver; generic labels do not create people. No calendar
attendee matching or automatic participant identity is inferred here.

Exact transcript content plus meeting ID and configured space deduplicates redeliveries
independently of event IDs. Corrected text is separate evidence for existing synthesis;
semantic duplicate/supersession decisions remain with that pipeline. Without a meeting
ID, identical text in the same space deduplicates. Without a parseable start time,
receipt time is used. JSON request size remains the existing server limit (10 MB).
Unauthorized requests create no source. Invalid JSON/non-object requests return errors;
unsupported authenticated object payloads remain visible as skipped sources. Delivery
failures before admission are visible in Krisp History, not a new Hub health dashboard.

## Synthetic verification

HUB_DISABLE_JOBS=1 node --test test/crm-krisp.test.js exercises local HTTP Bearer
rejection, missing configuration, payload-space spoofing, telephone transcript intake,
raw provenance, repeated event delivery, corrected text, long transcript splitting,
empty/notes-only visibility and a synthetic model result applied through applyAtoms
with a source citation. No model was called; real subscription extraction remains to
be verified with a real Krisp recording after deployment is authorized.

Full suite on this Linux checkout: 149 tests, 148 pass, 1 failure in the existing
Hermes tap installer test (BSD-style sed -i invocation is incompatible with GNU
sed). The Krisp test passes. This change does not modify the Hermes installer.
