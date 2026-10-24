# McLellan Hub — Agent instructions (Claude, Codex, Grok)

Full project rules: `CLAUDE.md`. Record of the retired system: `docs/VERSION-OLD.md`.

The Hub was cut back on 24 Oct 2026 to the flight tracker, the public portfolio
sites (with their chat/JD analyser on the Mac subscription worker), and the
deploy/access framework. Douglas is rebuilding new functions one at a time —
build only what he has agreed to.

- Run `scripts/sync-check.sh` first; deploy only with `scripts/deploy.sh`.
- Tests: `npm test`. Run locally with `HUB_DISABLE_JOBS=1` (never poll Gmail from the Mac).
- No OpenRouter, no API-key model fallback: model work goes through `lib/model.js`
  and the Mac pull worker.
