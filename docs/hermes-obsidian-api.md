# Hermes Obsidian API

Hermes can use the dchat-hosted Obsidian/Synthadoc vault through trusted JSON endpoints.

Base URL:

```text
https://dchat.mclellan.scot
```

Auth:

```text
Authorization: Bearer <HERMES_WEBHOOK_SECRET>
```

The API is constrained to the configured vault root and rejects paths outside it.

## List Notes

```http
GET /api/obsidian/notes?prefix=Daily/&limit=50
```

Returns note paths, sizes, and modification times.

## Search Notes

```http
GET /api/obsidian/search?q=Dad%20sore%20back&limit=10
```

Returns matching note paths and short excerpts.

## Read A Note

```http
GET /api/obsidian/note?path=Daily/2026-05-09.md
```

Returns the Markdown content.

## Create Or Update A Note

```http
POST /api/obsidian/note
Content-Type: application/json

{
  "path": "Hermes/2026-05-09.md",
  "mode": "create",
  "content": "# Hermes note\n\nA trusted note from Hermes.\n"
}
```

Modes:

- `create`: fails if the note already exists.
- `append`: appends Markdown to an existing note or creates it.
- `overwrite`: replaces the note content.

Recommended Hermes write location:

```text
Hermes/
```

Recommended daily append path:

```text
Daily/YYYY-MM-DD.md
```
