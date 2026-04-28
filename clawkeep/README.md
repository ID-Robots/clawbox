# clawkeep-device

On-device backup client for [ClawBox hardware](https://openclawhardware.dev/) and any
Linux box (Pi, Jetson, x86 server, VPS) that wants to back up to Cloudflare R2 through
the OpenClaw portal.

This is a thin Python wrapper around `restic` that:

1. Pairs the device with a portal account (one-time OAuth2 flow).
2. On a daily systemd timer, mints short-lived R2 credentials from the portal.
3. Runs `restic backup` to the user's R2 prefix.
4. Reports status back to the portal.

Server-side is already shipped on `clawbox-website`. This client implements
the device half of the contract documented in `clawkeep-plan.md`.

## Quickstart

```bash
# Build deps:
sudo apt install -y python3 python3-pip restic

# Install:
pip install --user .          # or: sudo pip install .

# Configure:
sudo install -d -m 0755 /etc/clawkeep /var/lib/clawkeep /var/log/clawkeep
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
| `/var/lib/clawkeep/repo-pass` | 0600 | clawkeep | restic repo password (32 bytes hex) |
| `/var/lib/clawkeep/state.json` | 0600 | clawkeep | Last run result + last cloudBytes |

> **Critical:** `/var/lib/clawkeep/repo-pass` is the only secret that can decrypt the
> backup. Lose it and the backup is permanently unrecoverable. v1 prints it during
> `clawkeep pair` — copy it somewhere safe (password manager, paper, etc.). v1.1
> will mirror an encrypted copy to the portal.

## Restoring a backup

v1 doesn't ship a restore CLI. Until v2 lands:

```bash
# Mint creds against the portal:
TOKEN=$(cat /var/lib/clawkeep/token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
     https://openclawhardware.dev/api/clawkeep/credentials > /tmp/creds.json

# Plug them into restic:
export AWS_ACCESS_KEY_ID=$(jq -r .accessKeyId /tmp/creds.json)
export AWS_SECRET_ACCESS_KEY=$(jq -r .secretAccessKey /tmp/creds.json)
export AWS_SESSION_TOKEN=$(jq -r .sessionToken /tmp/creds.json)
export RESTIC_PASSWORD=$(cat /var/lib/clawkeep/repo-pass)

REPO="s3:$(jq -r .endpoint /tmp/creds.json)/$(jq -r .bucket /tmp/creds.json)/$(jq -r .prefix /tmp/creds.json)"
restic -r "$REPO" snapshots
restic -r "$REPO" restore <snapshot-id> --target /tmp/restore
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
