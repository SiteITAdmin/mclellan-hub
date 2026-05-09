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
GCHAT_REPLY_WEBHOOK=<Google Chat incoming webhook URL for replies>
```

Secrets are intentionally kept out of the repo.

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
