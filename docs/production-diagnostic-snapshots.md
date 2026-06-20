# Production Diagnostic Snapshots

Production-only bugs usually come from the shape of live data, not from code
alone. Do not fix those by editing code directly on the VPS unless it is an
emergency hotfix.

Use this loop instead:

1. Pull a snapshot:

   ```bash
   scripts/pull-prod-snapshot.sh
   ```

2. Run locally against the pulled production database:

   ```bash
   scripts/run-with-prod-snapshot.sh
   ```

   Or for a one-off command:

   ```bash
   scripts/run-with-prod-snapshot.sh data/prod-snapshots/latest node scripts/some-debug.js
   ```

3. Reproduce the issue locally, fix code locally, run tests, commit, push, and
   deploy.

4. If production data itself needs repair, write a small repeatable repair script
   and run it intentionally against production. Do not hand-edit SQLite rows.

What the snapshot contains:

- `hub.db`: a consistent SQLite backup of `/app/data/hub.db`
- `hub.service.log`: recent production service logs
- `jobs.json`: recent job queue state
- `git-status.txt`, `deployed-head.txt`, `deployed-revision.txt`: code state
- `env.sh`: exports `HUB_DB_PATH` for local debugging

The snapshot is live private data. It is ignored by git under `data/` and should
not be copied into public artifacts or prompts.
