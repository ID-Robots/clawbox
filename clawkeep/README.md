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
exclude option, so a snapshot would carry every older backup kept inside
`~/.openclaw`. ClawKeep leaves out archive files in `~/.openclaw/backups/` (any
depth) and OpenClaw's own `…-openclaw-backup.tar.gz[.enc]` files anywhere in
the backup: each is set aside for the build by a same-filesystem rename into
`set-aside/` and put back as the same file the moment the build ends
(`clawkeep/own_backups.py` has the rule and every crash case). The run records
what it left out (count and bytes), and any archive file of 256 MiB or more the
snapshot still carries, in `state.json` before the upload.

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
| `/var/lib/clawkeep/state.json` | 0600 | clawkeep | Last run result + last cloudBytes, and what the last archive left out / still carried / skipped |
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

### Backup quota admission

Before uploading, the runner lists every page of the account's snapshot prefix
and checks that **current snapshot bytes + the actual encrypted archive bytes <=
quotaBytes**. The manifest and directory markers remain excluded, matching the
existing quota accounting. A failed listing stops the upload; a full quota
reports the required and available bytes. Neither refusal uploads, changes the
manifest, nor prunes existing snapshots. Retention is still applied only after a
successful upload, so its potential future savings cannot admit a backup that
does not fit now. Increase storage or explicitly review/remove unneeded backups
before retrying. Backup keys are treated as new snapshots, not replacement credit.

A nonblocking `backup-run.lock` serializes backup runs sharing the device data
directory, including manual/timer overlap. A competing invocation returns a backup
failure without changing the active run's heartbeat/state. This is **not an atomic
account-wide reservation**: writers on different devices/data directories, older
clients, or quota changes after credentials were issued can still race. A hard
account-wide cap requires a server-side reservation/commit protocol and restricted
upload capabilities; the current general-purpose S3 credentials cannot enforce it.
