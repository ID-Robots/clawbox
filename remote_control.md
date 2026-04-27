# ClawBox Device Remote Control - Implementation Guide

## Overview

Enable ClawBox devices to be controlled remotely via the portal using Cloudflare Tunnel. Users link their device in the portal, and can then access the local ClawBox UI from anywhere.

**Repo note:** `install.sh` currently deploys from `PROJECT_DIR=/home/clawbox/clawbox`. The live tunnel installer in this repo is `/home/clawbox/clawbox/scripts/setup-tunnel.sh`; some other service paths below are still conceptual examples.

---

## Architecture

```text
[User Browser] --> [Portal clawbox.io] --> [Cloudflare Tunnel] --> [ClawBox Device :80]
                                                                          |
                                                                    [Local Web UI]
```

**Flow:**
1. User logs into portal
2. Device displays 6-digit connect code on local UI
3. User enters code in portal
4. Device receives API token
5. Device registers its Cloudflare Tunnel URL with portal
6. User can now access device UI via portal

---

## Components to Implement

### 1. cloudflared Installation Script

**Location:** `/home/clawbox/clawbox/scripts/setup-tunnel.sh`

**Purpose:** Install and configure Cloudflare Tunnel on the device

**Current repo behavior:** The installer pins a specific `cloudflared` release and verifies the published SHA256 before moving the binary into place.

**Tasks:**
- [ ] Detect architecture (arm64/amd64)
- [ ] Download cloudflared binary from https://github.com/cloudflare/cloudflared/releases
- [ ] Install to `/usr/local/bin/cloudflared`
- [ ] Create `/etc/cloudflared/` config directory
- [ ] Create systemd service file

**Script outline:**
```bash
#!/bin/bash
set -e

CLOUDFLARED_VERSION=2026.3.0

ARCH=$(uname -m)
case $ARCH in
  aarch64) CF_ARCH="arm64" ;;
  x86_64)  CF_ARCH="amd64" ;;
  *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Download cloudflared
curl -L -o /usr/local/bin/cloudflared \
  "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${CF_ARCH}"
# Verify the published SHA256 before installing in the real script.
chmod +x /usr/local/bin/cloudflared

# Create config directory
mkdir -p /etc/cloudflared

echo "cloudflared installed successfully"
```

---

### 2. Tunnel Configuration

**Location:** `/etc/cloudflared/config.yml`

**Format:**
```yaml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: <SUBDOMAIN>.clawbox.live
    service: http://localhost:80
  - service: http_status:404
```

**Tasks:**
- [ ] Generate unique tunnel name: `clawbox-<device-serial>`
- [ ] Run `cloudflared tunnel create <name>` to get credentials
- [ ] Store credentials JSON at `/etc/cloudflared/credentials.json` (chmod 600)
- [ ] Configure DNS route: `cloudflared tunnel route dns <tunnel-id> <subdomain>.clawbox.live`
- [ ] Write config.yml with correct ingress rules

**Note:** Requires Cloudflare API token with Tunnel permissions. Token stored at `/etc/clawbox/cloudflare-token`.

---

### 3. Portal Registration Service

**Location:** `/opt/clawbox/services/portal-link.py`

**Purpose:** Handle device-to-portal authentication and registration

**Flow:**
1. Generate 6-digit alphanumeric connect code
2. Display code on local web UI
3. Wait for user to enter code in portal
4. Poll portal or wait for callback
5. Exchange code for API token via `POST /api/portal/connect/exchange`
6. Store token securely
7. Register device with portal including tunnel URL

**Tasks:**
- [ ] Generate secure 6-digit code (uppercase alphanumeric, no ambiguous chars)
- [ ] Expose code via local API: `GET /api/connect-code`
- [ ] Poll or callback mechanism for code redemption
- [ ] POST to `/api/portal/connect/exchange` with code
- [ ] Store API token at `/etc/clawbox/portal-token` (chmod 600)
- [ ] Register device via `POST /api/portal/devices/register`

**Code example:**
```python
import requests
import secrets
import string

PORTAL_API = "https://clawbox.io/api"

def generate_connect_code():
    # Exclude ambiguous: 0, O, I, 1, L
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    return ''.join(secrets.choice(alphabet) for _ in range(6))

def exchange_code(code: str) -> str:
    """Exchange connect code for API token"""
    resp = requests.post(f"{PORTAL_API}/portal/connect/exchange", json={
        "code": code,
        "device_id": get_device_serial()
    })
    resp.raise_for_status()
    return resp.json()["access_token"]

def register_device(token: str, tunnel_url: str, name: str):
    """Register device with portal"""
    resp = requests.post(f"{PORTAL_API}/portal/devices/register",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "name": name,
            "tunnelUrl": tunnel_url
        }
    )
    resp.raise_for_status()
    return resp.json()["device_id"]
```

---

### 4. Device Self-Registration API (Portal Side)

**New Endpoint:** `POST /api/portal/devices/register`

**Auth:** Bearer token (from connect/exchange)

**Request:**
```json
{
  "name": "ClawBox Living Room",
  "tunnelUrl": "https://cb-abc123.clawbox.live"
}
```

**Response:**
```json
{
  "success": true,
  "device_id": "dev_xxxxx"
}
```

**Tasks:**
- [ ] Create new route at `/src/app/api/portal/devices/register/route.ts`
- [ ] Accept Bearer token auth (not session cookie)
- [ ] Validate token and get user ID
- [ ] Create device entry in KV
- [ ] Return device ID

---

### 5. Health Check / Heartbeat

**Device Service:** `/opt/clawbox/services/heartbeat.py`

**Purpose:** Keep portal updated on device status

**Tasks:**
- [ ] Every 60 seconds, POST to `/api/portal/devices/:id/heartbeat`
- [ ] Include: uptime, version, local IP, tunnel status
- [ ] Handle token expiry/revocation gracefully

**Portal Endpoint:** `POST /api/portal/devices/:id/heartbeat`

**Request:**
```json
{
  "uptime": 12345,
  "version": "2.3.0",
  "tunnelStatus": "connected",
  "localIp": "192.168.1.100"
}
```

**Response:**
```json
{
  "success": true,
  "serverTime": "2026-04-22T08:45:00Z"
}
```

**Portal Tasks:**
- [ ] Create route at `/src/app/api/portal/devices/[id]/heartbeat/route.ts`
- [ ] Update `lastSeenAt` timestamp
- [ ] Update `isOnline` status
- [ ] Store version/uptime info

---

### 6. Local UI Connect Code Display

**Location:** ClawBox local web UI (Flask/FastAPI app)

**Tasks:**
- [ ] Add "Link to Portal" button in settings page
- [ ] When clicked, generate and display 6-digit code
- [ ] Show QR code linking to `https://clawbox.io/portal/connect?code=XXXXXX`
- [ ] Poll local API for successful connection
- [ ] Show "Connected to Portal" status with green indicator
- [ ] Show "Disconnect" button to revoke token

**UI States:**
1. **Not linked:** Show "Link to Portal" button
2. **Code displayed:** Show code + QR + "Waiting for portal connection..."
3. **Linked:** Show "Connected to clawbox.io" + user email + "Disconnect" button

---

### 7. Systemd Services

**clawbox-tunnel.service:**
```ini
[Unit]
Description=ClawBox Cloudflare Quick Tunnel
After=network-online.target clawbox-setup.service
Wants=network-online.target

[Service]
Type=simple
User=clawbox
WorkingDirectory=/home/clawbox/clawbox
ExecStart=/home/clawbox/clawbox/scripts/run-tunnel.sh
Restart=on-failure
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=15
StandardOutput=journal
StandardError=journal
Environment=CLAWBOX_ROOT=/home/clawbox/clawbox
Environment=LOCAL_SERVICE_URL=http://localhost:80

[Install]
WantedBy=multi-user.target
```

This repo currently uses a Quick Tunnel wrapper (`run-tunnel.sh`), so the on-demand `clawbox-tunnel.service` does not start `cloudflared` with `/etc/cloudflared/config.yml`.

**clawbox-portal.service:**
```ini
[Unit]
Description=ClawBox Portal Link Service
After=network-online.target clawbox-tunnel.service

[Service]
Type=simple
User=clawbox
ExecStart=/opt/clawbox/services/portal-link
Restart=always
RestartSec=10
Environment=PORTAL_API=https://clawbox.io/api
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**clawbox-heartbeat.service:**
```ini
[Unit]
Description=ClawBox Portal Heartbeat
After=network-online.target clawbox-portal.service

[Service]
Type=simple
User=clawbox
ExecStart=/opt/clawbox/services/heartbeat
Restart=always
RestartSec=10
Environment=PORTAL_API=https://clawbox.io/api
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

---

## Portal Changes Needed

### New Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/portal/devices/register` | POST | Bearer | Device self-registration |
| `/api/portal/devices/:id/heartbeat` | POST | Bearer | Update online status |

### Modified Endpoints

| Endpoint | Change |
|----------|--------|
| `/api/portal/devices` | Support Bearer auth (not just session) |
| `/api/portal/devices/:id` | Add iframe embed URL |

### Portal UI Changes

- [ ] `/portal/devices` - Show online/offline badges with last seen time
- [ ] `/portal/devices/[id]` - Add iframe to embed device tunnel URL
- [ ] Add security headers to allow iframe embedding

---

## File Structure on Device

```
/etc/clawbox/
├── portal-token          # API token (chmod 600, root:root)
├── device-id             # Registered device ID
├── device-name           # User-friendly device name
└── cloudflare-token      # Cloudflare API token (chmod 600)

/etc/cloudflared/
├── config.yml            # Tunnel config
└── credentials.json      # Tunnel credentials (chmod 600)

/home/clawbox/clawbox/   # install.sh PROJECT_DIR
├── scripts/
│   ├── setup-tunnel.sh   # cloudflared installation
│   └── reset-portal.sh   # Unlink from portal
└── services/             # conceptual examples in this guide
    ├── portal-link       # Portal registration service
    └── heartbeat         # Heartbeat service

/var/log/clawbox/
├── portal-link.log
└── heartbeat.log
```

---

## Security Considerations

1. **Token storage:** Store API token with `chmod 600`, owned by root
2. **Tunnel credentials:** Same protection for cloudflared credentials
3. **HTTPS only:** All portal API calls over HTTPS
4. **Token rotation:** Support re-linking if token is revoked
5. **Local network restriction:** Connect flow only accepts local redirect URIs
6. **Rate limiting:** Portal endpoints rate-limited to prevent abuse
7. **Code expiry:** Connect codes expire after 10 minutes
8. **One-time use:** Connect codes can only be used once

---

## Implementation Order

| # | Component | Location | Priority |
|---|-----------|----------|----------|
| 1 | cloudflared setup script | Device | High |
| 2 | Tunnel configuration generator | Device | High |
| 3 | Portal link service (token exchange) | Device | High |
| 4 | Device self-registration endpoint | Portal | High |
| 5 | Heartbeat endpoint | Portal | Medium |
| 6 | Heartbeat service | Device | Medium |
| 7 | Local UI connect code display | Device | Medium |
| 8 | Portal device iframe view | Portal | Medium |
| 9 | Online/offline status badges | Portal | Low |

---

## Testing Checklist

- [ ] cloudflared installs correctly on arm64 (Jetson)
- [ ] Tunnel creates and routes traffic
- [ ] Connect code generates and displays
- [ ] Portal accepts code and issues token
- [ ] Device exchanges code for token
- [ ] Device registers with portal
- [ ] Heartbeat keeps device online
- [ ] Portal shows online/offline status
- [ ] Iframe loads device UI correctly
- [ ] Token revocation disconnects device
- [ ] Re-linking works after disconnect

---

## Environment Variables

**Device:**
```bash
PORTAL_API=https://clawbox.io/api
DEVICE_SERIAL=<from /etc/clawbox/serial>
CLOUDFLARE_API_TOKEN=<stored in /etc/clawbox/cloudflare-token>
```

**Portal (.env):**
```bash
# Already configured
REDIS_URL=...
PORTAL_JWT_SECRET=...
```

---

## DNS Setup (One-time)

Create wildcard DNS for device subdomains:

```
*.clawbox.live CNAME <tunnel-uuid>.cfargotunnel.com
```

Or use Cloudflare Tunnel DNS routing per device.
