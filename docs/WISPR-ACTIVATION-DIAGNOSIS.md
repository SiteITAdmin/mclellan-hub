# Wispr activation denial investigation — 10 November 2026

The user reports Wispr's device/denied page saying “Activation denied” after
account sign-in. This establishes a failure after sign-in, but does not establish
which server-side check rejected activation. No authenticated browser or
production connection was available during this investigation.

## Public evidence

- Official setup guidance: https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server
  Sign-in must return to authorization; Notetaker, MCP and account policies have
  separate controls. These are possible checks, not a diagnosis of this account.
- Live discovery: https://mcp-auth.wisprflow.com/.well-known/oauth-authorization-server
  Advertises the device grant, the endpoints used by the Hub, all four requested
  scopes (openid, offline_access, email, profile), and token authentication none.
- A single disposable public registration using the Hub's exact payload returned
  HTTP 201, echoing its requested device/refresh grants, code response type,
  scopes and token authentication none.
- Device authorization with that newly registered public client and the Hub's
  exact scope/resource returned HTTP 200, device and user codes, a complete
  verification URI, base URI https://mcp-auth.wisprflow.com/device, expiry 299
  seconds and interval 5 seconds. No codes or credentials were logged or saved;
  no sign-in/approval was attempted.

No demonstrable registration, request or verification-link defect was found.
Acceptance of these unauthenticated steps does not prove authenticated activation
works, nor does it validate the production client's stored registration.

## Proven local defects corrected

RFC 8628 section 3.5 distinguishes access_denied from expired_token:
https://www.rfc-editor.org/rfc/rfc8628.html#section-3.5

The Hub previously returned expired for all terminal responses and the Meetings
route replaced them with a code-expiry message. It also returned connected after
a failed MCP initialize/tools/account check. Tests reproduced both before edits.

Terminal responses now stop polling and retain a safe protocol reason. Failed
connection checks mark the saved authorization unverified, clear cached account
and tools, and offer another connection check without claiming success. Existing
tokens remain available for that retry. Existing saved connections without the
new verification flag retain their previous status until checked. Expired local
codes are now processed by the route as well. Remote error descriptions and
response bodies are excluded from displayed diagnostics to avoid token leakage.

## Remaining verification

A coordinator/user-authorized authenticated retry must correlate the denied
browser step with the Hub token endpoint's safe error code and HTTP status.
Compare the production client's registration and issued verification link with
discovery, without sharing codes/tokens. If the provider gives only access_denied,
Wispr support may need the attempt time and account/client context privately;
the screenshot alone cannot identify a policy, account, session or provider bug.

Activation is not claimed fixed. There is no meeting capture, new table/job,
model call, billing, deployment or production edit in this change.

Independent review found no blocker. Follow-up fixes add a direct Connect again
button after a failed check, hide irrelevant first-time instructions, distinguish
local timeout from provider-confirmed expiry, and sanitize tool-call errors.
Transient failures still require a manual retry; this change does not add
background polling or identify the provider's activation-denial cause.

## Shared sign-in correction

Douglas confirmed that Work and Personal use one Wispr account. The Hub now
shares one authorization attempt and credential set between both spaces, reuses
an unexpired code and serializes starts, polling and refreshes. Legacy sign-ins
are migrated once as documented in WISPR-CONNECTION.md. This corrects duplicate
Hub state; it is not evidence that the provider-side activation denial is fixed.

Wispr operations have a 20-second deadline. Disconnect cancels the active operation so a fresh attempt can start immediately. Late replies cannot restore discarded state.
