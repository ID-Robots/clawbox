# ClawKeep — Backup Management Spec (named / lockable / auto-cleanup)

Author: Mike (architecture) for Krasi. Implement on a feature branch, open a PR. **Never push to `main`.**

## Goal
Add three capabilities to ClawKeep backups:
1. **Named backups** — a human label per snapshot (e.g. "Before v3 upgrade").
2. **Lock / protect flag** — a snapshot marked locked (🔒) cannot be deleted, manually or by auto-cleanup, until unlocked.
3. **Auto-cleanup (retention)** — after each successful backup, prune old snapshots. **Default: keep last 10.** Locked snapshots are ALWAYS kept and do NOT count against the "10".

## Current model (confirmed)
- Each backup = one encrypted `.tar.gz` object in the portal-issued R2 prefix, named `<ts>-openclaw-backup.tar.gz(.enc)`.
- `clawkeep/clawkeep/s3.py`: `upload`, `list_snapshots`, `download`, `stats`. **No delete, no metadata, no retention.**
- `clawkeep/clawkeep/runner.py::run_once` uploads (object_name = `encrypted_path.name`, ~line 291).
- `clawkeep/clawkeep/cli.py`: `snapshots` (JSON list) + `restore <name>` subcommands; the TS bridge spawns these.
- TS bridge: `src/lib/clawkeep.ts`; portal routes `src/app/setup-api/clawkeep/{snapshots,restore,backup,schedule,...}/route.ts`; UI `src/components/ClawKeepApp.tsx`; i18n `src/lib/clawkeep-translations.ts` (all locales).

## Storage design — sidecar manifest (DO THIS, not key-encoding)
Store a single `manifest.json` object in the SAME R2 prefix:
```json
{
  "version": 1,
  "snapshots": {
    "<objectName>": { "label": "Before v3 upgrade", "locked": true, "createdAt": 1733650000000 }
  }
}
```
Rationale: rename / lock / unlock = manifest rewrite, no expensive S3 object copy. Retention reads `locked` from it. The object list (`list_objects_v2`) stays the source of truth for *which* snapshots exist; the manifest only annotates them. An object with no manifest entry = unnamed, unlocked (back-compat for existing snapshots). On manifest read, drop entries whose object no longer exists (lazy GC). `manifest.json` itself must be excluded from `list_snapshots`/`stats` counting (skip key == "manifest.json").

## Python changes (`clawkeep/clawkeep/`)
### s3.py
- `read_manifest(creds) -> dict` / `write_manifest(creds, manifest) -> None` (GET/PUT `manifest.json` in prefix; tolerate missing → empty `{"version":1,"snapshots":{}}`).
- `delete_snapshot(creds, object_name) -> None` (delete_object; raise S3Error on failure).
- `list_snapshots`: merge manifest annotations into each `Snapshot` → add fields `label: str|None`, `locked: bool`. Exclude `manifest.json`. Keep newest-first.
- `stats`: exclude `manifest.json` from count/bytes.
### runner.py
- `run_once`: accept an optional label (from a new field in `state.json` or a one-shot file the TS bridge writes before triggering — mirror how `passphrase-file` is passed). After successful upload, write/merge the manifest entry `{label, locked:false, createdAt:now}` for the new object, THEN run retention.
- New `apply_retention(creds, keep_last:int)`: list snapshots newest-first; partition locked vs unlocked; keep all locked; from unlocked keep the newest `keep_last`; `delete_snapshot` the rest; update manifest (drop deleted entries). Log each deletion. Never delete locked. `keep_last<=0` disables.
### cli.py — new subcommands (JSON in/out, spawned by TS bridge)
- `clawkeep label <objectName> --text "<label>"` → set/clear label in manifest.
- `clawkeep lock <objectName>` / `clawkeep unlock <objectName>` → toggle locked.
- `clawkeep delete <objectName>` → refuse with `{"ok":false,"kind":"locked"}` exit code 2 if locked; else delete object + manifest entry.
- `clawkeep prune --keep-last N` → run `apply_retention` on demand.
- Extend `snapshots` JSON output: each item gains `label`, `locked`.
- Add retention config to backup flow: read `keepLast` from `schedule.json`/config (see TS below).

## Retention config (user-adjustable, default 10)
- Add `retentionKeepLast: number` (default `10`, `0` = disabled) to the schedule/config surface in `src/lib/clawkeep.ts` (`ClawKeepSchedule` + `DEFAULT_SCHEDULE` + `sanitiseSchedule`) and persist via the existing `schedule.json` mechanism + `schedule/route.ts`.
- The device runner reads it (passed through config or read from schedule.json) and calls `apply_retention(keep_last=retentionKeepLast)` after each successful backup. `0` → skip.

## TS bridge + portal routes (`src/`)
- `src/lib/clawkeep.ts`: add functions to spawn the new CLI subcommands: `setSnapshotLabel(name,text)`, `lockSnapshot(name)`, `unlockSnapshot(name)`, `deleteSnapshot(name)`, `pruneSnapshots(keepLast)`. Extend the snapshot type with `label?`, `locked?`. Add `retentionKeepLast` to schedule read/write.
- New/updated routes under `src/app/setup-api/clawkeep/`:
  - `snapshots/route.ts` — return label+locked (already will, via CLI).
  - `snapshots/label/route.ts` (POST `{name, label}`).
  - `snapshots/lock/route.ts` (POST `{name, locked:boolean}`).
  - `snapshots/delete/route.ts` (POST `{name}` — surface `kind:"locked"` 409).
  - `schedule/route.ts` — accept/return `retentionKeepLast`.
- Follow the existing route patterns (auth/guarding) in this folder exactly.

## UI (`src/components/ClawKeepApp.tsx`)
- Snapshot list rows: show **label** (fallback to formatted timestamp when no label), a 🔒 indicator when locked, and a row action menu: **Rename**, **Lock/Unlock**, **Delete**.
- Delete: confirm dialog; if the snapshot is locked, the Delete action is disabled with a tooltip "Unlock first".
- A "Name this backup" optional input when manually triggering a backup (passes label to the backup route → runner).
- Settings: a "Keep last N backups" number input (default 10) + helper text "Locked backups are always kept" + an "off" affordance (0/disabled).
- Wire all new strings through `src/lib/clawkeep-translations.ts` for **every locale present** (do not ship English-only — match existing keys across all languages).

## Tests
- Python unit tests for `apply_retention` (locked exemption, keep_last boundary, manifest GC), manifest read/write round-trip, delete refusing locked. Mirror the existing test style/location in the clawkeep package.
- Update/extend the Playwright e2e specs (`e2e/clawkeep-*.spec.ts`) for the new list actions if feasible; at minimum don't break existing ones.

## Constraints / acceptance
- Locked snapshot is never deleted by any path (manual delete refused, retention skips).
- Existing (pre-feature) snapshots with no manifest entry behave as unnamed + unlocked and are subject to retention.
- `manifest.json` never appears as a snapshot and never counts toward quota/snapshotCount.
- Default retention = keep last 10, user-adjustable, 0 disables.
- All new UI text translated across all locales.
- Feature branch + PR. Do not push to main/develop. Run the Python tests and `npm run build`/typecheck before opening the PR.
