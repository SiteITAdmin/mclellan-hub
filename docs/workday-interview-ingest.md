# Workday Interview Ingest

This workflow captures a spoken workday debrief, turns it into a searchable Markdown note, stores it in dchat project memory, and mirrors it into the Synthadoc/Obsidian vault.

## What Gets Created

- A dchat project named `Workday Journal` at `/workday` if it does not already exist.
- A project document containing the cleaned narrative and raw transcript.
- A vault source file under:

```text
data/synthadoc/mclellan-hub-knowledge/raw_sources/workday/
```

Synthadoc ingest is queued automatically after the source file is written. If the Synthadoc sidecar is not running, the dchat/vault capture still succeeds and the response reports the ingest error.

## Interview Shape

Good commute questions:

```text
What happened today?
What decisions did I make?
Who did I speak with, and what matters about it?
What needs follow-up tomorrow?
What did I learn?
What is bothering me or still unresolved?
```

The transcript is converted into sections:

- Narrative
- Decisions
- People
- Projects
- Actions
- Open Questions
- Raw Transcript

## Browser/API Ingest

Authenticated users can post text or audio to:

```text
POST /api/workday/interview
```

Fields:

- `transcript`: transcript text, optional if an audio file is supplied.
- `file`: audio file field, optional if transcript text is supplied.
- `title`: note title.
- `model`: optional dchat model key for the narrative cleanup.
- `projectSlug`: optional, defaults to `workday`.
- `synthadoc`: set to `0` to skip queueing Synthadoc ingest.

Audio transcription uses `OPENAI_API_KEY` or `OPENAI_TRANSCRIPTION_API_KEY` if set. If not, it falls back to `OPENROUTER_API_KEY` using `WORKDAY_TRANSCRIPTION_MODEL`, defaulting to `openai/whisper-large-v3`.

## Shortcut/Webhook Ingest

Trusted external tools can post to:

```text
POST /api/workday/webhook
Authorization: Bearer <WORKDAY_WEBHOOK_SECRET>
```

If `WORKDAY_WEBHOOK_SECRET` is not set, the endpoint falls back to `HERMES_WEBHOOK_SECRET`.

Fields:

- `user`: defaults to `douglas`.
- `transcript` or `text`: dictated transcript.
- `file`: optional audio file.
- `title`: note title.
- `source`: optional source label.
- `synthadoc`: set to `0` to skip queueing Synthadoc ingest.

## CLI Ingest

Transcript:

```bash
node scripts/ingest-workday.js --transcript ~/Desktop/transcript.txt --title "Drive home debrief"
```

Audio:

```bash
node scripts/ingest-workday.js --audio ~/Desktop/drive-home.m4a --title "Drive home debrief"
```

Add `--no-synthadoc` if you only want the dchat document and raw vault source.

## iPhone Shortcut Pattern

The simplest driving-safe version is:

1. Start a Shortcut from Siri: "Start workday debrief."
2. Use "Dictate Text" or "Record Audio."
3. Ask the six interview prompts one at a time.
4. Combine the answers into one transcript.
5. Send a `POST` request to `https://dchat.mclellan.scot/api/workday/webhook` with the bearer token.

Use transcript text where possible. It avoids uploading large audio while driving and lets iOS do speech recognition locally or through Apple's dictation path.

## Synthadoc Follow-up

If automatic queueing failed because the sidecar was offline, start Synthadoc and retry the generated source file:

```bash
.tools/synthadoc-venv/bin/synthadoc ingest data/synthadoc/mclellan-hub-knowledge/raw_sources/workday/<file>.md -w mclellan-hub-knowledge
```

If the background Synthadoc service is running, the same source can also be queued through its local jobs API.
