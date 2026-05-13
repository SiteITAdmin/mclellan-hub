# Hermes Google Chat Bot

`config/gchat-crm-bot.js` is the Google Apps Script source for the Hermes Google Chat bot.

## What It Does

Hermes can receive Google Chat messages and:

- save ordinary messages as CRM notes in dchat
- push the CRM briefing with `briefing`
- read today’s Obsidian daily note with `today`
- search the Obsidian/Synthadoc vault with `search <query>`
- read a vault note with `read <path>`
- append to today’s note with `remember <text>`
- append a follow-up with `follow up <text>`

## Google Apps Script Properties

Set these in Apps Script:

```text
DCHAT_BASE=https://dchat.mclellan.scot
DCHAT_WEBHOOK=https://dchat.mclellan.scot/api/crm/webhook
DCHAT_SECRET=<HERMES_WEBHOOK_SECRET>
DCHAT_USER=douglas
GCHAT_REPLY_WEBHOOK=<optional Google Chat incoming webhook URL for async replies>
```

Secrets are intentionally kept out of the repo.

For normal inbound messages, the Apps Script returns a synchronous Google Chat
response from `onMessage`. `GCHAT_REPLY_WEBHOOK` is only needed if you call
`postReply()` for a delayed/asynchronous response.

If Google Chat messages are not reaching Hermes:

1. In Apps Script **Project Settings > Script Properties**, confirm
   `DCHAT_SECRET` exactly matches production `HERMES_WEBHOOK_SECRET`.
2. In Google Cloud Console **Google Chat API > Configuration**, confirm the app
   is connected to the current Apps Script deployment ID.
3. Send a direct message to the Chat app, then check Apps Script **Executions**.
   If there is no execution, Google Chat is not invoking the script. If there is
   an execution with a `dchat error`, the script reached Hermes and the HTTP
   response code in the log is the next clue.
4. On the server, a valid authenticated probe to `/api/crm/webhook` with an
   empty JSON body should return HTTP 400 with `text and user required`; 401
   means the secret is wrong.

## Example Commands

```text
briefing
today
search Dad sore back
read Daily/2026-05-09.md
remember The doctor follow-up should mention Dad's sore back.
follow up Call doctors on Monday about Dad's sore back.
Tom needs to know about Copilot
```

## Notes

The bot uses dchat’s authenticated APIs:

- `/api/crm/webhook`
- `/api/crm/briefing-push`
- `/api/obsidian/search`
- `/api/obsidian/note`

The Obsidian endpoints are constrained to the configured vault root on the server.

## Direct HTTP Endpoint Fallback

If Google Chat saves the Apps Script configuration but Apps Script shows no
executions, bypass Apps Script and point Google Chat straight at Hermes:

1. In **Google Chat API > Configuration**, set **Connection settings** to
   **HTTP endpoint URL**.
2. Use this endpoint:

   ```text
   https://dchat.mclellan.scot/api/google-chat/hermes
   ```

3. Set **Authentication audience** to **HTTP endpoint URL**.
4. Keep **Message**, **Added to space**, and **Removed from space** enabled.
5. Save, then start a new DM with the app.

Hermes verifies Google Chat's bearer token against
`GOOGLE_CHAT_AUTH_AUDIENCE`, which should usually be the endpoint URL above. If
the app is configured as a Google Workspace add-on, Google may instead send a
project-number JWT; set `GOOGLE_CHAT_PROJECT_NUMBER` to the Chat API project
number in that case.
