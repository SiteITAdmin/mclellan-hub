# Wispr Flow connection

The Hub currently connects an account and checks its available tools. It does
not capture meetings yet. No API key is needed.

1. Open Meetings in the intended Work or Personal space and choose **Connect
   Wispr Flow**.
2. Open **Wispr's sign-in page**, sign in with the intended Wispr
   account, and follow the approval prompts. Use the displayed code if asked. Keep the Hub page open while it checks.
3. Once connected, choose **Check the connection**. Report any displayed error
   with the failing step if it does not work.

Wispr authorization covers the account's existing meetings as well as new ones.
Work and personal Wispr accounts hold separate content. Notetaker and MCP access
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
