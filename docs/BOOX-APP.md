# Boox calendar and CRM app

The Android app (`boox-app/`, package `scot.mclellan.boox`, version 2) reads the
same calendar, tasks, promises and source-backed contact summaries as the Hub.
Calendar shows both spaces, with the last seven days and next fourteen days
saved on the tablet. It syncs on return to the app and every ten minutes while
open. Failed syncs keep the last successful snapshot and show its timestamp.

On Calendar, choose a day, then **New Work note** or **New Personal note**.
Boox Notes opens with the dated name already filled in. If it offers a template,
choose one and tap **Create**. Returning to that day's note reopens the existing
notebook. A failed or ambiguous native notebook lookup stops with an error
rather than creating another notebook. Keep the dated title intact:
`2026-11-12 Work` or `2026-11-12 Personal`.

Enable PDF sync from Boox Notes to Google Drive's `onyx/NoteMax/Notebooks`
folder. On leaving Notes, its native sync exports the notebook. Hub checks Drive
every fifteen minutes and reads changed pages through `crm_boox_read` on the
Mac subscription worker. Unclear handwriting waits at `/crm/notebooks`.
A Claude usage/capacity limit holds the page and retries every fifteen minutes
without consuming its malformed-page retry allowance. The waiting state appears
on the tablet, Today and the notebook screen. Confirmed writing enters the normal source → atoms → promises/tasks pipeline;
the note's date remains its source date even if exported the following day.
Notes more than seven days old are history. A changed day-note page can add new
writing; unchanged lines are context, with the existing atomiser deciding
semantic duplicates and supersession. Journals retain their no-task rule.

The Hub calendar links captured pages under **Boox notes**. Tablet and Hub show
whether pages are awaiting reading, need review, or failed. If an opened note
has not arrived in Drive after three hours, Today warns about it for seven days.
A receipt proves a notebook was opened, not that handwriting was saved or synced.

## Build and install from the Mac

Prerequisites: JDK 17, Android SDK 34, a USB-connected Boox with USB debugging
allowed for this Mac, and SSH key access to the Hub VPS. Run:

```sh
scripts/install-boox-app.sh
```

The script builds on local temporary disk (the source workspace can be an SMB
share), updates the existing app without clearing its data, and copies the
existing VPS `HUB_BOOX_TOKEN` directly into private app storage. The APK contains
no token. App backups/transfers are disabled. Settings also accepts a token
without displaying the existing value. The app only calls the fixed HTTPS Hub
host and refuses redirects. Notes and calendar data stay behind bearer auth.

Build without installing:

```sh
cd boox-app
JAVA_HOME=/opt/homebrew/opt/openjdk@17 \
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleDebug lintDebug
```

Deploy the Hub with `scripts/deploy.sh` after committing. The tablet endpoints
are `GET /api/crm/boox/sync` and `POST /api/crm/boox/note`. They do not poll mail
or invoke a model during sync. Opening a note works offline, and its receipt is
saved in a durable outbox until the Hub acknowledges it.

## Verification

`test/crm-boox-app.test.js` covers day-note discovery, explicit notebook filing,
changed-page ingestion, unchanged-export deduplication, blank/unclear pages,
late exports, historical notes, device auth, idempotent opening receipts,
calendar/CRM payloads, and migration of an existing notebook database.
Existing Boox tests cover journal safety and PDF reader failures. Use
`HUB_DISABLE_JOBS=1 npm test`; local tests must use Mac-native SQLite binaries.

The native Notes content provider and `OPEN_NOTE_BEAN` intent are private Onyx
interfaces, verified on the attached Note Max. Recheck opening, saving and
reopening a dated notebook after a Boox firmware update. Drive exports and the
subscription worker must both be available for handwriting to reach the CRM.

## Local worker installation

The running Mac LaunchAgent currently uses the separate local directory
`~/.local/share/proxmox-dev/hub-worker`, not this repository's SMB checkout.
When changing model transport, copy `scripts/subscription-agent-worker.js`,
`lib/subscription-agent.js` and `lib/feature-runners.js` into the corresponding
paths there. Preserve its `.env` and dependencies. Restart
`com.mclellan.hub.subscription-agent-worker` after its active CLI job ends.
The deployed VPS and that local copy must agree about PDF input support; a VPS
code deploy alone does not update this worker.

On 12 November 2026, version 2 was installed on the attached Note Max. Live
calendar/CRM sync and native creation/reopening were verified. Douglas's dated
Work PDF reached Drive and was captured as one day-note page. The updated Mac
worker received its PDF, but Claude returned a usage limit with a 22:30 Dublin
reset; transcription verification is pending that capacity reset.
