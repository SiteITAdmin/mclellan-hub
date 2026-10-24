# McLellan Hub

Douglas McLellan's personal workspace, retooled on 24 Oct 2026. See
`docs/VERSION-OLD.md` for everything that came before.

## What runs

- **Flight tracker** — Ryanair booking emails are read from Gmail every 30
  minutes; each leg is tracked live via AeroDataBox from two hours before
  departure, and actual times are back-filled nightly. Page:
  https://douglas.mclellan.scot/flights (site admin sign-in).
- **Public sites** — douglas.mclellan.scot and nakai.mclellan.scot, with admin
  at `/admin`, chat and JD analyser answered by the Mac mini worker.

## Run locally

```sh
npm install
HUB_DISABLE_JOBS=1 npm run dev   # http://localhost:3000 (?portfolio=nakai to switch site)
npm test
```

## Deploy

```sh
scripts/sync-check.sh
scripts/deploy.sh
```
