# Boox Drive Notebook Ingest

This is the **inbound** half of the Boox loop. The outbound half — the nightly
hyperlinked reference planner the Hub pushes to the tablet — is a separate file
in a separate folder (`onyx/NoteMax/Hub Planner`, see ARCHITECTURE.md → Boox
reference planner). They are deliberately kept apart: the planner is rebuilt
every night, so it can never be the file handwriting lives in.

Hermes can import Boox / Onyx handwritten note exports from Google Drive once per day. Handwritten notebooks should be treated as a raw inbox first, then renamed, OCR-reviewed, and deliberately approved for Synthadoc/Hermes ingestion.

The daily job:

1. Uses the Hub user's stored Google refresh token.
2. Lists the configured Drive folder recursively.
3. Downloads new or modified PDFs, images, text files, and Google Docs into `raw_sources/boox-notes`.
4. In import-only mode, stops there so weak handwriting and untitled notebooks do not enter the knowledge base automatically.
5. In queueing mode, writes `.path` files into `raw_sources/ingest-queue` so `scripts/sync-workday-vault.sh` can run Synthadoc ingest.

## Configuration

Set these in `.env` on the Mac Mini:

```bash
BOOX_DRIVE_ENABLED=1
BOOX_DRIVE_USER=douglas
BOOX_DRIVE_FOLDER_ID=
BOOX_DRIVE_FOLDER_PATH=onyx/NoteMax/Notebooks
BOOX_DRIVE_QUEUE=0
HUB_DB_PATH=
```

Prefer `BOOX_DRIVE_FOLDER_ID` if Google Drive's folder names differ from the default path. You can copy the folder ID from a Drive URL like:

```text
https://drive.google.com/drive/folders/FOLDER_ID
```

The script defaults to `data/synthadoc/mclellan-hub-knowledge` as the vault root. Override with `BOOX_DRIVE_VAULT_ROOT` only if the local Synthadoc vault moves.

The script reads the Google refresh token from `data/hub.db` when that database is initialized. If the local Hub database is only a placeholder, it falls back to `data/dchat-import/db/hub.db`. Set `HUB_DB_PATH` if the active Hub database lives somewhere else.

Keep `BOOX_DRIVE_QUEUE=0` while existing notebooks are being cleaned up. Set it to `1` only after the Boox inbox has a reliable title/OCR/review workflow.

## Review Workflow

Use this before a Boox notebook is allowed into Hermes:

1. Open the imported file in `raw_sources/boox-notes`.
2. Give it a useful title: date, topic, project/person, and short purpose.
3. Run or review OCR output, correcting names, dates, actions, and headings.
4. Split mixed notebooks into separate topic notes where needed.
5. Move the cleaned Markdown/PDF-derived note into an appropriate reviewed source folder.
6. Queue the reviewed file for Synthadoc ingestion.

## Google Auth

Folder listing requires `https://www.googleapis.com/auth/drive.readonly`. If the stored refresh token predates this setup, sign in again through Hub Google auth so the token is refreshed with Drive read access.

## Manual Run

```bash
node scripts/ingest-boox-drive-notes.js --user=douglas
```

Useful options:

```bash
node scripts/ingest-boox-drive-notes.js --folder-id=FOLDER_ID
node scripts/ingest-boox-drive-notes.js --folder-path="onyx/NoteMax/Notebooks"
node scripts/ingest-boox-drive-notes.js --force
```

State is stored in:

```text
data/synthadoc/mclellan-hub-knowledge/raw_sources/boox-notes/.boox-drive-state.json
```

Logs are written by the vault sync to:

```text
data/logs/workday-vault-sync.log
```
