# ClawKeep — restic migration plan

This document describes the **device-side** rewrite required to switch ClawKeep
from the current git-bundle + custom AES-GCM (CK01/CK02) implementation to a
`restic`-backed implementation that talks to the new portal endpoints.

The portal-side endpoints already exist in `clawbox-website` (master):

- `POST /api/clawkeep/credentials` — mint scoped R2 creds (1h TTL)
- `POST /api/clawkeep/heartbeat`   — push status, bytes, snapshot count
- `GET  /api/portal/clawkeep/repo` — browser UI reads state
- `POST /api/portal/clawkeep/repo` — browser UI writes destination/schedule

Quotas: Pro 5 GB, Max 50 GB. Free tier locked.

---

## What to keep

The local UI (`src/components/ClawKeepApp.tsx`, `ClawKeepPathPicker.tsx`) and
the local route (`src/app/setup-api/clawkeep/route.ts`) keep their **shape**:
the same `init / configure / snap / sync` actions, the same status fields the
UI consumes (`initialized`, `backup.mode`, `backup.local`, `backup.cloud`,
`recent`, `headCommit`, etc.).

Only the implementation under `src/lib/clawkeep.ts` changes. The route file
calls into the same exports — `getClawKeepStatus`, `initClawKeep`,
`configureClawKeepTargets`, `snapClawKeep`, `syncClawKeep` — but they now
shell out to `restic` instead of running git/AES code in-process.

---

## What to delete from `src/lib/clawkeep.ts`

- The CK01/CK02 magic-byte format, all `crypto.createCipheriv` /
  `createDecipheriv` calls, scrypt KDF, manifest encryption helpers
- Git bundle helpers: `createBundle`, `countCommits`, `hasNewCommits`,
  `getHeadCommit`, `getTrackedFiles`, `getTotalSnaps`, `getRecentLog`,
  `runGit`, `isGitRepo`, `syncIgnore`, `parseStatus`
- The `.gitignore` synchronization (`GITIGNORE_MARKER_*`, `DEFAULT_IGNORE`)
- `createEncryptedChunkFile`, `syncToLocalTarget`, `syncToCloudTarget`,
  `readManifest`, `writeManifest`, `applyManifestChunk`, `buildManifest`
- `secretsFilePath` and `loadSecrets` / `saveSecrets` — restic owns the
  key file inside the repo

The `.clawkeep/config.json` schema collapses to:

```json
{
  "version": "1.0.0",
  "destination": "local" | "cloud" | "both",
  "schedule": "manual" | "daily" | "weekly",
  "localPath": "/home/clawbox/Backups/clawkeep" | null,
  "lastBackupAt": "2026-04-28T10:00:00Z"
}
```

The repo password is **never** stored in this file. For manual runs the user
re-enters it each time. For scheduled runs it's sealed in a separate root-only
file (see "Schedule daemon" below).

Source folder is **always** `~/.openclaw` (locked for v1; not configurable).

---

## What to add

### Bundled `restic` binary

Add to `install.sh`:

```bash
# Step: install_restic
RESTIC_VERSION="0.17.3"
ARCH="$(dpkg --print-architecture)"   # arm64 | amd64
curl -fsSL "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${ARCH}.bz2" \
  | bunzip2 > /usr/local/bin/restic
chmod +x /usr/local/bin/restic
```

### New `src/lib/clawkeep.ts` (sketch)

The module shells out to `restic` via `execFile`, never imports its source.
Export the same names the route + UI already call.

```typescript
const RESTIC = "/usr/local/bin/restic";
const SOURCE_DIR = path.join(process.env.HOME || "/home/clawbox", ".openclaw");
const LOCAL_REPO_DEFAULT = path.join(process.env.HOME || "/home/clawbox", "Backups/clawkeep");
const PORTAL_BASE = process.env.CLAWKEEP_PORTAL_BASE || "https://openclawhardware.dev";

async function fetchCloudCredentials(token: string) {
  const res = await fetch(`${PORTAL_BASE}/api/clawkeep/credentials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`credentials ${res.status}`);
  return await res.json() as {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string | null;
    endpoint: string;
    bucket: string;
    prefix: string;
    expiresAt: number;
  };
}

function resticEnv(creds: AwaitedCreds, password: string) {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
    RESTIC_REPOSITORY: `s3:${creds.endpoint}/${creds.bucket}/${creds.prefix.replace(/\/$/, "")}`,
    RESTIC_PASSWORD: password,
  };
}
```

The full file should expose:

| Export                       | Behavior                                                                                  |
|------------------------------|-------------------------------------------------------------------------------------------|
| `getClawKeepStatus()`        | run `restic snapshots --json` and `restic stats --json`; return UI-shaped object          |
| `initClawKeep(password)`     | run `restic init` against local + cloud repos depending on destination                    |
| `configureClawKeepTargets()` | write `.clawkeep/config.json`; if password supplied, run `restic init` for any new target |
| `snapClawKeep(message)`      | run `restic backup ~/.openclaw --tag="msg"`                                               |
| `syncClawKeep()`             | same as `snapClawKeep` (alias kept so old route handlers still work); push heartbeat      |

After every `restic backup`, push a heartbeat:

```typescript
await fetch(`${PORTAL_BASE}/api/clawkeep/heartbeat`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    status: "ok",
    cloudBytes: stats.total_size,
    snapshotCount: snapshots.length,
    lastBackupAt: Date.now(),
  }),
});
```

### Schedule daemon

Daily/weekly schedules require running `restic backup` without the user
present, so the password must be sealed locally:

- File: `/var/lib/clawbox/clawkeep.cred` (mode `0600`, owner `clawbox`)
- Format: AES-256-GCM, key derived from `/var/lib/clawbox/clawkeep.master`
  (32 random bytes generated on first config; root-only)
- Box reset wipes the master file → user re-enters password. Document this.

Trigger via systemd timer (no separate Go daemon needed; just a shell script
that calls into the Next.js setup service via its loopback API):

`config/clawbox-clawkeep.service`:

```ini
[Unit]
Description=ClawKeep scheduled backup
After=network-online.target clawbox-setup.service

[Service]
Type=oneshot
User=clawbox
ExecStart=/usr/local/bin/clawkeep-run
StandardOutput=journal
StandardError=journal
```

`config/clawbox-clawkeep.timer`:

```ini
[Unit]
Description=Run ClawKeep on schedule

[Timer]
OnCalendar=daily
Persistent=true
Unit=clawbox-clawkeep.service

[Install]
WantedBy=timers.target
```

The script `clawkeep-run` reads `.clawkeep/config.json`, decides daily vs
weekly (skips if `schedule=weekly` and `daysSinceLastBackup < 7`), pulls the
sealed password, and POSTs to `http://localhost:80/setup-api/clawkeep` with
action `sync`.

Add to `install.sh`:

```bash
cp config/clawbox-clawkeep.service /etc/systemd/system/
cp config/clawbox-clawkeep.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now clawbox-clawkeep.timer
```

### Restore flow

New action on the local route: `action: "restore"` with body
`{ snapshotId, targetPath }`. Implementation: `restic restore <snapshotId>
--target <targetPath>`.

UI work: add a snapshots list to `ClawKeepApp.tsx` that shows date + size
(returned by `getClawKeepStatus`) with a "Restore" button per row.

---

## Auth — which token does the device use?

Reuse the existing **ClawBox AI portal token** (`claw_*`) that the device
already holds for the gateway heartbeat. Both new endpoints
(`/api/clawkeep/credentials`, `/api/clawkeep/heartbeat`) accept it as a Bearer
token and resolve to the owning user. No new token issuance needed.

The token is read from the existing config-store key `clawai_token` (same one
the current `clawkeep.ts` already reads via `getCloudAuthState`).

---

## R2 setup (one-time, Cloudflare side)

These env vars must be set on the **portal** (not the device) before the
`/api/clawkeep/credentials` endpoint will work:

```
CLOUDFLARE_API_TOKEN          # token with "Workers R2 Storage: Edit" scope
CLOUDFLARE_ACCOUNT_ID
R2_BUCKET                     # e.g. clawkeep-prod
R2_PARENT_ACCESS_KEY_ID       # long-lived R2 access key (parent of temp creds)
R2_ENDPOINT                   # https://<accountid>.r2.cloudflarestorage.com
```

Create the bucket, generate a parent R2 access key in the dashboard, generate
a Cloudflare API token, set them as Vercel project env vars. Without these
the credentials endpoint returns `503 R2 not configured: missing ...`.

---

## Test plan (device side)

1. Wipe `~/.openclaw/.clawkeep/`.
2. Open ClawKeep UI → enter password → choose "Cloud" → save.
3. Confirm `restic init` ran against `s3:<endpoint>/<bucket>/users/<userId>/repo`.
4. Click "Back up now" → confirm new snapshot in `restic snapshots`.
5. Confirm heartbeat landed on portal: `GET /api/portal/clawkeep/repo` shows
   non-zero `cloudBytes` and `snapshotCount: 1`.
6. Restart the box → run a scheduled backup via timer → confirm sealed
   password unsealed correctly.
7. Restore: pick a snapshot, restore to a tmp dir, diff against `~/.openclaw`.
8. Free-tier user: confirm `/api/clawkeep/credentials` returns 403.
9. Quota full: pad `cloudBytes` past 5 GB (Pro), confirm 402 from
   `/api/clawkeep/credentials` and the device shows the quota-full state.
