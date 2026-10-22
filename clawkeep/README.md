# clawkeep-device

On-device backup client for [ClawBox hardware](https://clawbox.com/) and any
Linux box (Pi, Jetson, x86 server, VPS) that wants to back up to Cloudflare R2 through
the OpenClaw portal.

It:

1. Pairs the device with a portal account (one-time OAuth2 flow).
2. On a daily systemd timer, mints short-lived R2 credentials from the portal.
3. Builds a timestamped `.tar.gz` of the agent's state, encrypts it with the
   device passphrase, and PUTs it to the user's R2 prefix.
4. Reports status (size + snapshot count from `list-objects-v2`) back to the portal.

## Two editions, two archivers

Which agent gets archived is decided by `clawkeep/agent.py` from the root-owned
`/etc/clawbox/edition.env`, and both backends emit the **same** archive layout
(`<root>/manifest.json` + `<root>/payload/posix/<abs-path>/…`), so restore is
edition-agnostic:

| Edition | Archiver | Captures |
|---|---|---|
| `openclaw` | shells out to [`openclaw backup create`](https://docs.openclaw.ai/cli/backup) | OpenClaw state, config, credentials, sessions, workspaces |
| `hermes` | built in — `clawkeep/hermes.py`, no second CLI to install | `~/.hermes`: `config.yaml`, `.env`, `state.db` (via sqlite's online-backup API), `memories/`, `skills/`, `plugins/`, `hooks/`, `cron/`, `pairing/`, `pets/`, plus the shared identity at `~/.clawbox/agent-identity/` |

The Hermes archiver works from an explicit **allowlist**, so the ~1.5 GB
`hermes-agent/` checkout, the `bin/` virtualenv, and every cache and log stay
out. `clawkeep/hermes.py`'s module docstring is the authoritative list, with the
reasoning for each inclusion and exclusion.

On OpenClaw the core takes the whole state directory as one asset and has no
exclude flag or config key. What a snapshot leaves out, and who leaves it out:

| Left out | How |
|---|---|
| `~/.openclaw/upgrades/`, `~/.openclaw/backups/` | the core itself: `regenerable` `backupResources` of the `clawbox-backup-scope` plugin (`scripts/openclaw-plugins/clawbox-backup-scope`), installed and enabled by the gateway pre-start on a 2026.10+ core |
| Codex caches: `codex-home/.cache`, `codex-home/cache`, `codex-home/log` of every agent | the same plugin, `agent` scope (`codex-home/sessions/` and the rest of `codex-home/` stay in) |
| `tmp/`, `npm/`, `tools/`, agent `tmp`/`.tmp`, plugin `node_modules` | the core, by default |
| archive files in `~/.openclaw/backups/` (any depth) and OpenClaw's own `…-openclaw-backup.tar.gz[.enc]` anywhere | ClawKeep (`own_backups.py`): set aside by a same-filesystem rename |
| `*_tmp_*` trees in the state dir, outside every workspace, unchanged for an hour (an install the core or a package manager did not finish) | ClawKeep (`own_backups.py`): set aside whole, by one rename |

What ClawKeep sets aside goes into `set-aside/` for the build and is put back as
the same file or tree the moment the build ends (`clawkeep/own_backups.py` has
the rules and every crash case). The run records the archive files it left out
(count and bytes), and any archive file of 256 MiB or more the snapshot still
carries, in `state.json` before the upload; temporary trees are logged.

The archive is encrypted beside itself in the staging directory, so that disk
briefly holds it twice: the run measures first and refuses
(`EXIT_ENCRYPTION_FAILED`, with the sizes) when the ciphertext would not fit
with 256 MiB to spare, instead of filling the disk the box's databases live on.

> **A snapshot is a credential.** Both editions' archives include the device's
> provider keys (`~/.hermes/.env`, OpenClaw's `credentials`), because a restore
> that brought back the config but not the keys would hand the customer a dead
> box. That is safe only because encryption is **mandatory**: `runner.run_once`
> refuses to back up at all without a device passphrase (`EXIT_NEED_PASSPHRASE`)
> and the tarball is AES-encrypted before a byte leaves the device. Never move a
> decrypted archive off the box.

On the OpenClaw edition the CLI stays the archiver and the authority on what is
safe to archive; `clawkeep/backup_guard.py` is ClawKeep's own boundary around
it. Before the call it refuses two sources that would share one archive path,
and — in one walk, all at once — it sets aside every symlink the CLI would
refuse: an absolute target outside everything the backup contains, an absolute
target that does not exist, a relative one that climbs out. (An absolute link
whose target is INSIDE the backup is not refused: the CLI stores it as the
relative link to that target, and ClawKeep leaves it alone.) Regenerable tool
output — package-manager links, OpenClaw's own plugin links, cache links and
stale browser locks — is omitted quietly; every other refused link is SKIPPED:
the snapshot carries neither it nor what it points at, the backup finishes,
and the run names it (`last_skipped_links` in `state.json`, the ClawKeep
screen, `backup_status`, and the snapshot's record in the sidecar manifest —
the count in the clear, the names sealed with the backup passphrase — which a
restore reads back into its report). Every set-aside link is journalled first
and put back as soon as the archive is built; a link is never followed. Should
the CLI still refuse a link the pre-flight let through, that link and every
link of its shape go out and the archive is rebuilt, at most twice. After a
failed call it retries a file that vanished mid-walk (bounded,
`EXIT_ARCHIVE_BUSY`). It rebuilds a SQLite database whose only damage is its
indexes, keeping a copy first; any other damage stops the run as
`EXIT_ARCHIVE_DB_DAMAGED` with the database left untouched. Duplicates, and a
link that could not be left out (no dry-run to hold it against, an unreadable
link journal, the rebuilds spent), end as `EXIT_ARCHIVE_CONFLICT`, naming the
sources. It also wipes a plaintext archive a failed `--verify` left behind.
The module docstring holds the exact rules.

Restoring across editions is **refused**: one portal account gets one R2 prefix,
so the snapshot list legitimately holds other devices' backups — including this
box's own, from before it was converted. `assert_archive_matches_device` fails
that with a plain-language message before anything on disk is touched.

Server-side is already shipped on `clawbox-website`. This client implements
the device half of the contract documented in `clawkeep-plan.md`.

## Quickstart

```bash
# Build deps. `openclaw` is shipped with OpenClaw OS; install it from npm
# (or the OpenClaw release tarball) on a non-clawbox host:
sudo apt install -y python3 python3-pip
npm install -g @openclaw/cli   # only needed off-device

# Install:
pip install --user .          # or: sudo pip install .

# Configure:
sudo install -d -m 0755 /etc/clawkeep
sudo install -d -m 0750 -o clawkeep -g clawkeep /var/lib/clawkeep /var/log/clawkeep
sudo cp config.toml.example /etc/clawkeep/config.toml
sudo $EDITOR /etc/clawkeep/config.toml

# Pair with your portal account (mint a token at https://clawbox.com/portal/dashboard):
clawkeep pair --server https://clawbox.com

# Run a backup right now (debug):
clawkeepd --verbose

# Or hand off to systemd for daily runs:
sudo install systemd/clawkeepd.service /etc/systemd/system/
sudo install systemd/clawkeepd.timer /etc/systemd/system/
sudo install systemd/clawkeep-idle.service /etc/systemd/system/
sudo install systemd/clawkeep-idle.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now clawkeepd.timer clawkeep-idle.timer
```

## Headless pairing

If you SSH'd into the device without a browser available locally, forward the
listener port back to your laptop before clicking through the portal:

```bash
ssh -L 8765:127.0.0.1:8765 clawbox@your-device
```

Then run `clawkeep pair` on the device and open the printed URL in your laptop's
browser. The redirect at `http://127.0.0.1:8765/auth?…` will tunnel back through
SSH to the device's listener.

## Files on disk

| Path | Mode | Owner | Contents |
|---|---|---|---|
| `/etc/clawkeep/config.toml` | 0644 | root | User-editable config |
| `/var/lib/clawkeep/token` | 0600 | clawkeep | The `claw_*` portal token |
| `/var/lib/clawkeep/state.json` | 0600 | clawkeep | Last run result + last cloudBytes, and what the last archive left out / still carried / skipped, and why the last run refused to upload, if it did |
| `/var/lib/clawkeep/backup-run.lock` | 0600 | clawkeep | Held (`flock`) by the backup run in progress; an empty file that means nothing when no run holds it |
| `/var/lib/clawkeep/detached-links.json` | 0600 | clawkeep | Links set aside for an archive build still in progress (or killed mid-build); put back by the next run |
| `/var/lib/clawkeep/set-aside-files.json` | 0600 | clawkeep | The box's own backup archives set aside for a build in progress (or killed mid-build), and where each is held; put back by the build, the next run or the hourly idle tick |
| `/var/lib/clawkeep/set-aside/run-*/` | 0700 | clawkeep | Where those files are held while the build runs (a `.clawkeep-set-aside/` beside the state dir when the data dir is on another filesystem); empty and removed afterwards |
| `/var/lib/clawkeep/sqlite-recovery/` | 0700 | clawkeep | A database as found before its indexes were rebuilt (the newest 3 per database) |

> **Note on encryption:** archives are encrypted on the device before upload
> (`clawkeep/crypto.py`), with a passphrase only the owner holds
> (`clawkeep set-passphrase`). Encryption is mandatory — a device with no
> passphrase refuses to back up rather than uploading plaintext, and reports
> `needs-passphrase` so the UI can prompt. Uploaded objects end in
> `.tar.gz.enc`; the legacy plaintext `.tar.gz` form is still *restorable* so
> old snapshots are not stranded.

## Backup quota admission

Before uploading, the runner lists every page of the account's snapshot prefix
and checks that **current snapshot bytes + the actual encrypted archive bytes <=
quotaBytes**. An archive that exactly fills the quota is admitted; one byte more
is not, and neither is anything against a quota of zero. The manifest and
directory markers remain excluded, matching the existing quota accounting.
Backup keys are treated as new snapshots, not replacement credit.

A run that is not admitted ends in one of two ways, and in both it uploads
nothing, leaves the manifest alone, prunes nothing and removes its own archive
(plaintext and encrypted) from the staging directory:

| Outcome | Exit code | When |
|---|---|---|
| quota full | `EXIT_QUOTA_FULL` (2) | the backup does not fit in what is free |
| usage unverified | `EXIT_NETWORK` (6) | the prefix could not be listed to its end |

The listing fails closed. It is tried three times, 5 s and 30 s apart, on top
of the SDK's own retries, because by then the archive has taken minutes to
hours to build; after that the run refuses rather than upload against a usage
it could not count. All of that is bounded: the admission check ends within
240 s, waits included, and each usage recount within 150 s, so a store that
takes the connection and never answers costs a run minutes — not the hour of
the SDK's per-read timeouts times its retries — and the run lock is free again
for the next run. "To its end" is literal: a page that fails part-way, a
listing that stops while still marked truncated, or an entry with no size is an
error, never a smaller total. Retention is applied only after a successful
upload, so what it might free later cannot admit a backup that does not fit
now — and it is refused on an incomplete listing too, since it forgets the
lock of every snapshot the listing does not name.

The refusal is written to `state.json` for the app to put into words:
`last_refusal` (`quota_full` | `usage_unverified`), `last_refusal_at_ms`, and
the sizes it was decided on — `last_refusal_needed_bytes`,
`last_refusal_used_bytes`, `last_refusal_quota_bytes`. The next run clears it as
it starts. It is separate from `quota_full_since_ms`, which records the portal
refusing to mint credentials. The heartbeat's error text gives the same sizes
in readable units ("needs 1.2 GB encrypted, but only 300 MB of 5.0 GB is free").

### One run at a time

A backup run holds `backup-run.lock` in the data directory from before it reads
`state.json` until it has written its last word, so a scheduled run and a manual
one on the same device cannot overlap. The second to start exits with
`EXIT_ALREADY_RUNNING` (14) without reading or writing state and without a
heartbeat — the run in progress keeps its own. It is not queued.

The lock is a `flock`, held by the process rather than by the file: a run that
crashes or is killed releases it as it dies, the file left behind holds
nothing, and the archiver and `openssl` child processes are never handed it. If
the lock file cannot be opened at all (a read-only data directory, a file owned
by another user) no backup starts and the log says why.

The idle tick and `clawkeep restore` take the same lock. The tick leaves when a
run holds it (the run heartbeats for itself; a tick beside it used to write
back a `state.json` it had read before the run ended). A restore is refused
while a backup runs, and a backup that starts during a restore exits 14: a
backup beside a restore archived a half-swapped tree and put what it had set
aside back into the restored one.

### Alerts: one per incident, with backoff

The portal emails the owner "ClawKeep backup needs attention" for an `error`
heartbeat. A failure incident — from the first failed run to the next one that
succeeds — reaches the portal at once, then 1, 3 and 7 days after the report
before, then every 7 days (`runner.ALERT_BACKOFF_MS`); a box that fails every
night no longer mails its owner every night. In between, a failed run posts
neither its `running` nor its `error` heartbeat (the portal keeps showing the
failure it was told), logs why, and records the failure in `state.json` as
always; `alert_incident_since_ms`, `alert_reports` and
`alert_next_report_at_ms` keep the incident. A heartbeat that did not land is
not counted, and a successful run closes the incident.

### What this does not do

This is a device-side guard, **not an atomic account-wide reservation**. Writers
on different devices or data directories, clients older than this check, and a
quota that changes after the credentials were issued can still race it and take
the account over its quota. A hard account-wide cap requires a server-side
reservation/commit protocol and restricted upload capabilities; the current
general-purpose S3 credentials cannot enforce it.

## Restoring a backup

Restore from the device UI (ClawKeep → Restore) or the CLI:

```bash
clawkeep snapshots                  # list what is in the cloud, as JSON
SNAPSHOT="2026-08-27T07-42-11.000Z-ab12cd34-hermes-backup.tar.gz.enc"
clawkeep restore "$SNAPSHOT"        # download, decrypt, verify, swap into place
```

`restore` handles the whole path: it mints credentials, downloads, decrypts with
the device passphrase (prompting via `--passphrase-file` when none is stored),
verifies with the backend that WROTE the archive, and swaps each asset into
place atomically, rolling every asset back if any one of them fails.

It refuses, loudly and before touching anything, when the snapshot was made by
the other edition — see "Two editions, two archivers" above.

### Pulling an archive by hand

Only useful for inspection or disaster recovery from another machine. Current
uploads are encrypted and end in `.tar.gz.enc`; legacy plaintext `.tar.gz`
snapshots are still restorable and skip the decrypt step.

```bash
TOKEN=$(sudo cat /var/lib/clawkeep/token)
CREDS_FILE=$(mktemp); chmod 600 "$CREDS_FILE"
trap 'shred -u "$CREDS_FILE" 2>/dev/null || rm -f "$CREDS_FILE"' EXIT

curl -s -X POST -H "Authorization: Bearer $TOKEN"      https://clawbox.com/api/clawkeep/credentials > "$CREDS_FILE"

export AWS_ACCESS_KEY_ID=$(jq -r .accessKeyId "$CREDS_FILE")
export AWS_SECRET_ACCESS_KEY=$(jq -r .secretAccessKey "$CREDS_FILE")
export AWS_SESSION_TOKEN=$(jq -r .sessionToken "$CREDS_FILE")
export AWS_DEFAULT_REGION=auto
ENDPOINT=$(jq -r .endpoint "$CREDS_FILE")
BUCKET=$(jq -r .bucket "$CREDS_FILE"); PREFIX=$(jq -r .prefix "$CREDS_FILE")

aws --endpoint-url "$ENDPOINT" s3 ls "s3://$BUCKET/$PREFIX"
SNAPSHOT="<paste one name from the listing above>"
aws --endpoint-url "$ENDPOINT" s3 cp "s3://$BUCKET/$PREFIX$SNAPSHOT" ./snap.tar.gz.enc

# Decrypt with the device passphrase (the same one `clawkeep set-passphrase` took).
# See clawkeep/crypto.py for the exact cipher and KDF parameters.
PASSPHRASE_FILE=$(mktemp); chmod 600 "$PASSPHRASE_FILE"
printf '%s' 'your-device-passphrase' > "$PASSPHRASE_FILE"
openssl enc -d -aes-256-cbc -pbkdf2   -in snap.tar.gz.enc -out snap.tar.gz -pass "file:$PASSPHRASE_FILE"
shred -u "$PASSPHRASE_FILE"

tar -tzf snap.tar.gz | head            # <root>/manifest.json + <root>/payload/posix/...
tar -xOzf snap.tar.gz '*/manifest.json' | jq .agent   # "hermes" or absent (openclaw)
```

> The decrypted tarball holds the device's provider keys. Work on it in a 0700
> directory and shred it when you are done.

## Development

```bash
pip install -e '.[dev]'
ruff check .
mypy clawkeep
pytest
```

## License

MIT
