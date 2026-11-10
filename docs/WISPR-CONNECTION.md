# Wispr Flow connection

The Hub currently connects an account and checks its available tools. It does
not capture meetings yet. No API key is needed.

1. Open Meetings in either Work or Personal and choose **Connect
   Wispr Flow**. The browser goes to Wispr.
2. Sign in with the Wispr account if asked and choose **Allow access**. Wispr
   sends the browser back to the Hub's Meetings page, which says whether it
   connected. There is no code to type and no page to keep open.
3. **Check the connection** re-tests it at any time. Report any displayed error
   with the failing step if it does not work.

## How sign-in works

The Hub uses the authorization-code flow with PKCE, the same browser sign-in
Wispr's named clients use. It registers one public client (setting
`wispr_browser_client_id`) with the return address
`https://douglas.mclellan.scot/crm/wispr/callback` (override with
`WISPR_REDIRECT_URI`). An attempt lasts 10 minutes; starting again replaces it,
and a reply that does not match the current attempt is ignored.

The Hub first used the device-code flow. Wispr advertises it, but its device
page ends at "Activation denied". On 10 November 2026, on the Mac mini:

- A fresh device-code client went from "Confirm Device" to
  `/device/denied` with nobody clicking; the token endpoint only ever said
  `authorization_pending`. Without cookies the device page redirects to
  `api.wisprflow.ai/connect/login`, which answers "Missing external_auth_id".
- A fresh authorization-code client reached Wispr's consent screen, Douglas
  chose Allow access, the token exchange returned HTTP 200 with a refresh
  token (access token valid 3 days), `initialize` and `tools/list` returned
  HTTP 200 with 16 tools (`wispr-meetings`), and one refresh returned a new
  refresh token. That test used a loopback return address and kept nothing.
- With the Hub's own return address, registration returned HTTP 201 and the
  authorize request redirected to Wispr's login with an `external_auth_id`;
  a different return address was refused (`invalid_redirect_uri`).

Not yet seen: the Hub itself completing a sign-in on the live site. That needs
this change deployed and one Connect by Douglas.

Wispr authorization covers the account's existing meetings as well as new ones.
Douglas uses one Wispr account: both spaces share the same sign-in, code, account, tools and errors. Disconnect affects both spaces; it does not revoke Wispr-side access. Meeting classification and capture are not implemented. Notetaker and MCP access
must be available; organization policy, cloud access restrictions, or a HIPAA
agreement can block access. Follow [Wispr's official setup and recovery guide](https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server).

## Why the server URL shows “Method Not Allowed”

`https://api.wisprflow.ai/connect/mcp` is an MCP server address, not a browser
sign-in page. On 10 November 2026, a public GET returned HTTP 405 with
`Allow: POST`. An unauthenticated MCP initialize POST returned HTTP 401
`invalid_token`, with a bearer challenge pointing to
`https://api.wisprflow.ai/.well-known/oauth-protected-resource`.
That metadata identifies the same server and `https://mcp-auth.wisprflow.com`
as its authorization server. Its public authorization metadata advertises the
registration, device authorization and token endpoints used by the Hub,
including the device-code and refresh-token grants.

The [MCP transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
permits HTTP 405 for GET when the server does not offer a listening event
stream. The browser message alone is therefore not evidence of broken sign-in.

These public checks verify the endpoint and advertised protocol, not a real
account's authorization or meeting access. Meetings are still not ingested.

## Shared state and migration

The first read migrates legacy credentials once into `wispr_shared_*` settings.
Verified credentials take priority, then the most recent connected timestamp,
then Work on a tie. Account/tools/error follow the selected credentials.
Migration copies the chosen connection and clears all legacy credentials and device codes in one transaction. A non-secret `wispr_shared_migration` marker prevents resurrection after disconnect. Existing errors are preserved. Legacy pending
codes are invalidated locally; connect again from either space.
Starts, returns from Wispr, checks and token refreshes
are serialized within the Hub process; disconnect invalidates in-flight writes
and queued operations. This assumes the existing single Hub Node process.

Wispr operations have a 20-second deadline. Disconnect cancels the active operation so a fresh attempt can start immediately. Late replies cannot restore discarded state.
