# clawkeep-device

On-device backup client for [ClawBox hardware](https://openclawhardware.dev/) and any
Linux box (Pi, Jetson, x86 server, VPS) that wants to back up to Cloudflare R2 through
the OpenClaw portal.

This is a thin Python wrapper around the [`openclaw backup`](https://docs.openclaw.ai/cli/backup) CLI that:

1. Pairs the device with a portal account (one-time OAuth2 flow).
2. On a daily systemd timer, mints short-lived R2 credentials from the portal.
3. Runs `openclaw backup create` to produce a timestamped `.tar.gz` of OpenClaw state/config/credentials/workspaces, then PUTs it to the user's R2 prefix.
4. Reports status (size + snapshot count from `list-objects-v2`) back to the portal.

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

# Pair with your portal account (mint a token at https://openclawhardware.dev/portal/dashboard):
clawkeep pair --server https://openclawhardware.dev

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

> **Note on encryption:** the `openclaw backup` archive is plaintext —
> Cloudflare R2 encrypts at rest, but anyone with read access to the bucket
> sees the credentials/sessions inside the tarball. The portal-issued STS
> creds are scoped to the user's prefix only, but if you need
> defence-against-bucket-compromise, layer GPG/age over the archive before
> upload. A future v1.1 will fold this in.

## Restoring a backup

v1 doesn't ship a restore CLI. Until v2 lands, mint creds, list the user's
prefix, and pull the most recent `.tar.gz` with `aws s3 cp` (or any
S3-compatible client). Never write the credentials response to a
world-readable path like `/tmp/creds.json`:

```bash
TOKEN=$(sudo cat /var/lib/clawkeep/token)
CREDS_FILE=$(mktemp)
chmod 600 "$CREDS_FILE"
trap 'shred -u "$CREDS_FILE" 2>/dev/null || rm -f "$CREDS_FILE"' EXIT

curl -s -X POST -H "Authorization: Bearer $TOKEN" \
     https://openclawhardware.dev/api/clawkeep/credentials > "$CREDS_FILE"

export AWS_ACCESS_KEY_ID=$(jq -r .accessKeyId "$CREDS_FILE")
export AWS_SECRET_ACCESS_KEY=$(jq -r .secretAccessKey "$CREDS_FILE")
export AWS_SESSION_TOKEN=$(jq -r .sessionToken "$CREDS_FILE")
export AWS_DEFAULT_REGION=auto

ENDPOINT=$(jq -r .endpoint "$CREDS_FILE")
BUCKET=$(jq -r .bucket "$CREDS_FILE")
PREFIX=$(jq -r .prefix "$CREDS_FILE")

# List all snapshots under your prefix:
aws --endpoint-url "$ENDPOINT" s3 ls "s3://$BUCKET/$PREFIX"

# Pull the most recent one:
LATEST=$(aws --endpoint-url "$ENDPOINT" s3 ls "s3://$BUCKET/$PREFIX" \
  | awk '{print $4}' | sort | tail -1)
aws --endpoint-url "$ENDPOINT" s3 cp \
  "s3://$BUCKET/$PREFIX$LATEST" /tmp/restore.tar.gz

# Then validate the manifest and unpack:
openclaw backup verify /tmp/restore.tar.gz
tar -xzf /tmp/restore.tar.gz -C /tmp/restore
# trap shreds the temp creds file when the shell exits.
```

## Development

```bash
pip install -e '.[dev]'
ruff check .
mypy clawkeep
pytest
```

## License

MIT
