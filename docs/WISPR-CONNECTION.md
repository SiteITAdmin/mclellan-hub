# Wispr Flow connection

The Hub currently connects an account and checks its available tools. It does
not capture meetings yet. No API key is needed.

1. Open Meetings in either Work or Personal and choose **Connect
   Wispr Flow**.
2. Open **Wispr's sign-in page**, sign in with the intended Wispr
   account, and follow the approval prompts. Use the displayed code if asked. Keep the Hub page open while it checks.
3. Once connected, choose **Check the connection**. Report any displayed error
   with the failing step if it does not work.

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
account's authorization or meeting access. A real Hub sign-in and authenticated
connection check remain necessary; no authenticated account was available during verification. Meetings are still not ingested.

## Shared state and migration

The first read migrates legacy credentials once into `wispr_shared_*` settings.
Verified credentials take priority, then the most recent connected timestamp,
then Work on a tie. Account/tools/error follow the selected credentials.
Migration copies the chosen connection and clears all legacy credentials and device codes in one transaction. A non-secret `wispr_shared_migration` marker prevents resurrection after disconnect. Existing errors are preserved. Legacy pending
codes are invalidated locally; reconnect from either space for a shared code.
Unexpired shared attempts are reused. Starts, polls, checks and token refreshes
are serialized within the Hub process; disconnect invalidates in-flight writes
and queued operations. This assumes the existing single Hub Node process.

This removes duplicate Hub sign-ins; it does not establish or fix the cause of
Wispr's provider-side “Activation denied”. Real account approval and MCP access
still need verification. Existing denial and failed-check diagnostics remain.

Wispr operations have a 20-second deadline. Disconnect cancels the active operation so a fresh attempt can start immediately. Late replies cannot restore discarded state.
