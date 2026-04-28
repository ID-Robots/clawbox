# ClawKeep Device-Side Client — Development Plan

> **Audience:** the engineer building the on-device daemon that runs on user-owned ClawBox hardware (Pi-class / Jetson / VPS) and backs up local files to Cloudflare R2 via the OpenClaw portal.
>
> **Server side is already shipped** (commits b6f99a2 + 064cac7 on `clawbox-website` `main`). This document describes everything the device must do to integrate cleanly.

---

## 1. Goal

A small, boring daemon that:

1. Holds a user-issued `claw_*` API token after a one-time pairing flow.
2. On schedule, asks the portal for short-lived R2 credentials.
3. Runs a `restic` backup of configured paths to the user's R2 prefix.
4. Reports status back to the portal so the user sees "Last backup: 2 min ago, 1.4 GB / 5 GB used."

**It is not** a custom backup engine. It is a thin wrapper around the existing `restic` binary plus two HTTP calls.

---

## 2. Architecture

```
   ┌───────────────── ClawBox device ─────────────────┐
   │                                                  │
   │   /etc/clawkeep/config.toml                      │
   │   /var/lib/clawkeep/token        (mode 0600)     │
   │   /var/lib/clawkeep/repo-pass    (mode 0600)     │
   │                                                  │
   │   ┌──────────────────────────────┐               │
   │   │  clawkeepd  (Python daemon)  │               │
   │   │                              │               │
   │   │   1. POST /credentials  ────────────────►   portal API
   │   │   2. spawn `restic backup`  ──────────────►  Cloudflare R2
   │   │   3. read `restic stats`                    │
   │   │   4. POST /heartbeat  ──────────────────►   portal API
   │   └──────────────────────────────┘               │
   │              ▲                                    │
   │      systemd timer (daily/weekly)                 │
   └───────────────────────────────────────────────────┘
```

**Language:** Python 3.11+. Reasons: ships on every Linux distro, easy systemd packaging, `requests` is enough for HTTP, `subprocess` is enough for restic. No need for a compiled binary — `restic` is the only "binary" piece and it's already mature and statically linked.

---

## 3. Server contract (authoritative)

Base URL: `https://openclawhardware.dev` (will become `clawbox.io` once domain migration completes — make this configurable in `config.toml`).

### 3.1 Auth

All device-facing endpoints require an `Authorization: Bearer claw_*` header. The token is a 32-char opaque string with `claw_` prefix; the server validates it against Redis. Tokens are minted at `/portal/dashboard` (API Tokens section) by the user.

Pro/Max tier required. Free tier returns **403** with `{"error": "ClawKeep cloud backup requires a Pro or Max plan"}`.

### 3.2 `POST /api/clawkeep/credentials`

Request body: none.

**200 OK** response:
```json
{
  "accessKeyId": "...",
  "secretAccessKey": "...",
  "sessionToken": "...",       // present, must be used as AWS_SESSION_TOKEN
  "endpoint": "https://<acct>.r2.cloudflarestorage.com",
  "bucket": "clawkeep",
  "prefix": "users/<userId>/repo/",
  "expiresAt": 1730000000000,  // unix ms; ~1 hour from issue
  "quotaBytes": 5368709120,    // tier limit (5 GB Pro, 50+ GB Max)
  "cloudBytes": 1234567890     // currently used
}
```

Other responses:

| Status | Meaning | Device action |
| --- | --- | --- |
| 401 `Missing Bearer token` | Header missing | Bug; log and abort |
| 401 `Invalid token format` | Doesn't match `claw_*` | Re-pair |
| 401 `Token not found` / `Token revoked` | User deleted token | Surface "re-pair", clear local token |
| 402 `Cloud backup quota reached` | `cloudBytes >= quotaBytes` | Surface "quota full, upgrade or prune" — **do not retry on schedule** |
| 403 | Free tier | Surface "upgrade required" |
| 503 `R2 not configured: missing …` | Operator (Yanko) issue | Retry with backoff, log loudly |
| 503 `Cloudflare API …` | Upstream Cloudflare hiccup | Retry once after 30s |

Server caches creds for ~1h per user; calling this twice in 5 min returns the same creds. Don't cache them on the device — let the server be the source of truth.

### 3.3 `POST /api/clawkeep/heartbeat`

Request body:
```json
{
  "status": "ok" | "error" | "running" | "idle",
  "error": "string (optional, only on status=error, max 500 chars)",
  "cloudBytes": 1234567890,         // optional, from `restic stats --json`
  "snapshotCount": 47,              // optional
  "lastBackupAt": 1730000000000     // optional, unix ms; only when status=ok
}
```

**200** with no body on success. 400 if status is missing/invalid.

**When to send:**
- `running` — at start of backup run
- `ok` — after successful `restic backup`, including `cloudBytes` + `snapshotCount` + `lastBackupAt`
- `error` — on any failure, with a one-line `error` describing what broke
- `idle` — once daily even if no backup runs (so portal "last seen" stays fresh)

### 3.4 Endpoints the device does NOT call

- `GET /api/portal/clawkeep/repo` — portal-cookie-authed, browser-only. Device gets schedule from local config, not from server.
- `/api/portal/connect/*` — these are user-facing OAuth pages, used during pairing only.

---

## 4. Pairing flow (one-shot CLI)

Goal: get a `claw_*` token onto the device without making the user copy-paste anything.

The portal already implements an OAuth2 authorization-code flow at `/portal/connect`. Device uses it like this:

1. User runs `clawkeep pair` on the device.
2. CLI starts a local HTTP listener on `127.0.0.1:8765`.
3. CLI generates a random `state` (CSRF guard) and prints/opens:
   ```
   https://openclawhardware.dev/portal/connect
       ?state=<state>
       &redirect_uri=http://127.0.0.1:8765/auth
       &device_name=<hostname>
   ```
4. User logs into the portal in their browser (laptop or phone), reviews the consent screen, clicks "Authorize."
5. Portal redirects to `http://127.0.0.1:8765/auth?code=<code>&state=<state>`.
6. CLI verifies `state` matches, then `POST /api/portal/connect/exchange` with `{code, state, device_id: <hostname>}`.
7. Response: `{access_token: "claw_...", token_type: "Bearer"}`.
8. CLI writes token to `/var/lib/clawkeep/token` (mode `0600`, owned by `clawkeep` user), then exits.

**Headless devices:** if the user is SSH'd into the Pi from a laptop and there's no browser, print the URL and let the user open it on the laptop. The redirect goes to `127.0.0.1:8765` on the device — the user must SSH-tunnel `-L 8765:127.0.0.1:8765` for it to work. Document this. Alternative for v2: device-code grant (RFC 8628) — but requires server work, not in v1.

**Token storage:**
- File: `/var/lib/clawkeep/token`
- Permissions: `0600`, owner `clawkeep:clawkeep`
- Contents: just the token string, no JSON wrapping
- Optional v2: encrypt with TPM if present

---

## 5. Module breakdown

```
clawkeep/
├── pyproject.toml
├── README.md
├── clawkeep/
│   ├── __init__.py
│   ├── config.py          # parse /etc/clawkeep/config.toml
│   ├── token.py           # read/write /var/lib/clawkeep/token
│   ├── pair.py            # `clawkeep pair` CLI
│   ├── api.py             # HTTP client for /credentials + /heartbeat
│   ├── restic.py          # subprocess wrapper for restic
│   ├── runner.py          # one backup run: mint creds → backup → stats → heartbeat
│   └── daemon.py          # `clawkeepd` entrypoint, runs once and exits (cron-style)
├── systemd/
│   ├── clawkeepd.service
│   └── clawkeepd.timer    # OnCalendar=daily or weekly
└── debian/                # debhelper packaging for .deb
```

**Don't write a long-running event loop.** The daemon runs to completion on each timer fire, exits with appropriate status. Systemd handles scheduling. This avoids memory leaks, restic-hung-process babysitting, and means you can debug a single run with `clawkeepd --once`.

---

## 6. Storage layout on device

| Path | Mode | Contents |
| --- | --- | --- |
| `/etc/clawkeep/config.toml` | `0644` | User-editable config |
| `/var/lib/clawkeep/token` | `0600` | The `claw_*` token |
| `/var/lib/clawkeep/repo-pass` | `0600` | Restic repo password (random, 32 bytes hex) |
| `/var/lib/clawkeep/state.json` | `0600` | Last run result, last cloudBytes seen |
| `/var/log/clawkeep/clawkeepd.log` | `0640` | Run logs (or just journald) |

The **restic repo password** is the single most important secret on the device. If lost, the user loses access to their backup permanently. Strategy:

- Generate on first run, write locally.
- On every successful backup, also store an **encrypted copy in the user's portal account** via a new `POST /api/portal/clawkeep/repo-password-backup` endpoint (server does not exist yet — flag this as a follow-up server task).
- v1 can ship without portal backup — print the password during `clawkeep pair` and tell the user to save it.

---

## 7. Config schema

`/etc/clawkeep/config.toml`:

```toml
# Portal endpoint. Will change after domain migration; keep configurable.
server = "https://openclawhardware.dev"

# What to back up. Globs supported.
paths = [
  "/home",
  "/etc/clawbox",
]

# What to skip.
exclude = [
  "**/node_modules",
  "**/.cache",
  "*.tmp",
  "*.log",
]

# How often the systemd timer fires. Keep in sync with the timer unit.
schedule = "daily"  # daily | weekly | manual

# Restic tuning.
[restic]
binary = "/usr/bin/restic"
compression = "auto"   # auto | off | max
read_concurrency = 2

# Heartbeat behaviour.
[heartbeat]
idle_interval_hours = 24  # send "idle" heartbeat at least this often
```

Loaded once at daemon start. Reload requires `systemctl restart clawkeepd.timer` (no live reload).

---

## 8. Daily backup loop

Pseudocode for `clawkeep/runner.py`:

```python
def run_once(cfg, token):
    # 1. Mint creds
    creds = api.mint_credentials(cfg.server, token)
    if creds.error == "quota_full":
        api.heartbeat(cfg.server, token, status="error", error="quota full")
        return EXIT_QUOTA
    if creds.error:
        return retry_or_fail(creds)

    # 2. Tell server we're starting
    api.heartbeat(cfg.server, token, status="running")

    # 3. Init repo if needed (idempotent — restic returns specific error if already init'd)
    repo_url = f"s3:{creds.endpoint}/{creds.bucket}/{creds.prefix}"
    env = restic_env(creds, cfg.repo_password)
    restic.init(repo_url, env)  # noop if already exists

    # 4. Backup
    result = restic.backup(repo_url, env, paths=cfg.paths, excludes=cfg.exclude)
    if result.failed:
        api.heartbeat(cfg.server, token, status="error", error=result.last_line)
        return EXIT_BACKUP_FAILED

    # 5. Stats
    stats = restic.stats(repo_url, env)

    # 6. Report success
    api.heartbeat(
        cfg.server, token,
        status="ok",
        cloudBytes=stats.total_size,
        snapshotCount=stats.snapshot_count,
        lastBackupAt=now_ms(),
    )
    return EXIT_OK


def restic_env(creds, repo_password):
    return {
        "AWS_ACCESS_KEY_ID":     creds.accessKeyId,
        "AWS_SECRET_ACCESS_KEY": creds.secretAccessKey,
        "AWS_SESSION_TOKEN":     creds.sessionToken,  # CRITICAL — temp creds need this
        "RESTIC_PASSWORD":       repo_password,
    }
```

**Critical detail:** Cloudflare's temp creds are STS-style — they include a `sessionToken` and **require** `AWS_SESSION_TOKEN` to be set in the environment. Forgetting this is the #1 source of "AccessDenied" errors with R2 temp creds.

---

## 9. Heartbeat protocol details

- Send `running` at start of every backup run.
- Send `ok` (with stats) on success.
- Send `error` on any non-zero exit from restic. Include first 500 chars of stderr in `error`.
- Send `idle` at least every `idle_interval_hours` (default 24h) — even if no backup is configured to run today, this keeps the portal's "last seen" fresh so the user knows the device is alive.
- A separate systemd timer `clawkeep-idle.timer` (`OnCalendar=hourly`) checks state.json and sends `idle` if no other heartbeat in the last 24h.

**Don't retry heartbeat aggressively.** If it fails, log and move on. The next run will catch up. Backups are the work; heartbeats are bookkeeping.

---

## 10. Error handling matrix

| Failure | Response |
| --- | --- |
| Network down at `/credentials` | Retry 3x with exponential backoff (1, 5, 30s). If all fail, exit non-zero, systemd will retry next interval. |
| 401 `Token revoked` | Delete `/var/lib/clawkeep/token`. Send no heartbeat (no auth). Log loudly. User must re-pair. |
| 402 quota full | Heartbeat error, exit. Do not retry until next scheduled run (user has to free space or upgrade). |
| 503 R2 not configured | Operator issue. Heartbeat error, exit. Systemd will retry. |
| Restic exits non-zero | Heartbeat error with stderr tail, exit. |
| Restic hangs > 4h | systemd `TimeoutStartSec=4h` → SIGTERM → SIGKILL. Next run cleans up. |
| Disk full on device | Restic will fail with EIO; surface in heartbeat. |
| Cred refresh inside long backup | Don't try. v1 backups must complete inside 1h. If a user has more data, document the limit and address in v2 with a longer-TTL cred or split runs. |

---

## 11. Distribution / packaging

**v1 target:** Debian package (`.deb`) for ARM64 + amd64.

```
$ apt install ./clawkeep_0.1.0_arm64.deb
$ clawkeep pair
$ systemctl enable --now clawkeepd.timer
```

The package:
- Drops `clawkeep` + `clawkeepd` binaries (Python entrypoints) in `/usr/bin/`
- Installs systemd units in `/lib/systemd/system/`
- Creates `clawkeep` system user
- Drops example `/etc/clawkeep/config.toml.example`
- Depends on `python3 (>= 3.11)`, `restic (>= 0.16)`, `python3-requests`, `python3-tomli`

**Build with `dh-virtualenv`** to bundle Python deps so we don't fight host Python versions on Raspberry Pi OS / Ubuntu / Debian.

**v2:** consider `clawkeep-firmware` OCI image for users running Docker on a NAS.

---

## 12. Testing strategy

### Unit tests
- `api.py` — mock `requests`, assert request shapes match server contract above
- `restic.py` — mock `subprocess.run`, assert correct CLI args
- `config.py` — bad TOML, missing fields

### Integration tests (against a local mock server)
- Spin up a tiny `aiohttp` server that returns canned responses for `/credentials` and `/heartbeat`
- Run real `restic` against MinIO (S3-compatible, runs in Docker) using the mock creds
- Verify: init → backup → stats → snapshot count = 1

### End-to-end (against staging)
- Yanko provisions a Pro test account on `openclawhardware.dev`
- Issues a `claw_*` token via `/portal/dashboard`
- Runs `clawkeep pair` + `clawkeepd --once` on a Pi
- Verifies: backup completes, files appear in R2 under `users/<userId>/repo/`, heartbeat updates portal

### CI
- GitHub Actions on `clawkeep-device` repo (new)
- Lint (`ruff`), type-check (`mypy`), test (`pytest`), build `.deb` artifact on tag

---

## 13. Open questions / decisions to settle before coding

1. **Repo password backup.** Ship v1 without portal backup (user prints + saves)? Or block v1 on adding `POST /api/portal/clawkeep/repo-password-backup` server endpoint? **Suggest: v1 prints + warns, v1.1 adds server backup.**
2. **Headless pairing UX.** Document the SSH `-L` tunnel approach for v1, or invest in RFC 8628 device-code grant on the server now? **Suggest: SSH tunnel for v1, device-code in v2 once we have ≥1 customer hitting the friction.**
3. **Backup window > 1h.** What does the device do when the first full backup of a fresh 4 GB home directory takes 90 min and creds expire mid-stream? **Suggest: catch the AWS expired-creds error, mint fresh creds, restic resume.** Needs prototyping.
4. **Restoring backups.** v1 = "user runs `restic restore` manually with creds from the portal." v2 = `clawkeep restore <snapshot-id> <path>` CLI. Document v1 path in user docs.
5. **Telemetry / metrics.** Log only to journald? Or aggregate cloudBytes/snapshotCount/error rate into the heartbeat for a future portal dashboard? **Already covered by heartbeat; no extra work.**
6. **Multi-device per user.** v1 = one repo per user. If user pairs a 2nd device with same account, they'll both write to the same restic repo (which restic supports — multiple clients, same repo). Acceptable for v1; document. v2 might want per-device prefixes.
7. **Where does the device repo live?** **Suggest: new public repo `ID-Robots/clawkeep-device` under MIT. Serves as marketing artifact too — "open-source backup client for ClawBox."**

---

## 14. Milestones

| M | Deliverable | Days |
| --- | --- | --- |
| M1 | Token pairing CLI + token storage | 2 |
| M2 | API client + heartbeat (real server) | 1 |
| M3 | Restic wrapper + one full backup run on Pi | 2 |
| M4 | systemd integration + `.deb` packaging | 2 |
| M5 | Integration tests against MinIO | 2 |
| M6 | End-to-end on staging + docs | 1 |
| **Total** | for a competent Python dev | **~10 working days** |

---

## 15. References (where to look in the website repo)

All on `clawbox-website` `main`:

- `src/app/api/clawkeep/credentials/route.ts` — full cred-mint contract
- `src/app/api/clawkeep/heartbeat/route.ts` — full heartbeat contract
- `src/app/api/portal/clawkeep/repo/route.ts` — portal-side admin (read for context; device doesn't call it)
- `src/lib/portal/r2-credentials.ts` — Cloudflare temp-cred mint helper, shows exact request shape
- `src/lib/portal/clawkeep-kv.ts` — Redis schema (`clawkeep:repo:*`, `clawkeep:cred:*`)
- `src/lib/portal/tiers.ts` — tier quotas (Pro = 5 GB)
- `src/lib/portal/tokens.ts` — `validateToken()` — the function the device's bearer token is checked against
- `src/app/portal/connect/` — pairing flow UI, useful when wiring step 4 of section 4

---

## TL;DR for the implementer

**Build:** a Python systemd-driven daemon that, on each fire, calls one API for creds, runs `restic backup` to R2, calls another API to report.

**Don't build:** a custom backup engine, a long-running daemon, anything stateful beyond a token + repo password on disk.

**Match:** the exact request/response shapes in section 3.

**Ship:** as a `.deb` + the public `clawkeep-device` GitHub repo.