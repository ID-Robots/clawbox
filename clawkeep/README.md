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

> **A snapshot is a credential.** Both editions' archives include the device's
> provider keys (`~/.hermes/.env`, OpenClaw's `credentials`), because a restore
> that brought back the config but not the keys would hand the customer a dead
> box. That is safe only because encryption is **mandatory**: `runner.run_once`
> refuses to back up at all without a device passphrase (`EXIT_NEED_PASSPHRASE`)
> and the tarball is AES-encrypted before a byte leaves the device. Never move a
> decrypted archive off the box.

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
| `/var/lib/clawkeep/state.json` | 0600 | clawkeep | Last run result + last cloudBytes |

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
clawkeep snapshots                 # list what is in the cloud, as JSON
clawkeep restore <snapshot-name>   # download, decrypt, verify, swap into place
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
aws --endpoint-url "$ENDPOINT" s3 cp "s3://$BUCKET/$PREFIX<snapshot>" ./snap.tar.gz.enc

# Decrypt with the device passphrase (the same one `clawkeep set-passphrase` took).
# See clawkeep/crypto.py for the exact cipher and KDF parameters.
openssl enc -d -aes-256-cbc -pbkdf2 -in snap.tar.gz.enc -out snap.tar.gz -pass file:<passphrase-file>

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
