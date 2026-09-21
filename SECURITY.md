# Security Policy

ClawBox is the operating system for [OpenClaw Hardware](https://clawbox.com/),
running on NVIDIA Jetson. Because it manages WiFi, system credentials, OAuth tokens,
and the on-device AI agent, we take security reports seriously.

## Supported Versions

Only the latest release line receives security fixes. Devices update in place via
**Settings → System Update** or `sudo clawbox update`, so we ask everyone to stay current.

| Version | Supported |
| ------- | --------- |
| Latest release (3.1.x) | ✅ |
| Older releases | ❌ — please update first |

## Network exposure

Devices ship with a default-deny inbound firewall (ufw). Nothing is reachable
unless it is listed below, and the TCP services are reachable only from private
IPv4 LAN ranges (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10 for
Tailscale). IPv6 is not source-scoped, because a dual-stack LAN gives the box a
global address and that is the one it advertises for `clawbox.local`. Outbound
and routed traffic are unchanged, so hotspot internet sharing keeps working.

| Port | Service |
| ---- | ------- |
| 22/tcp | SSH |
| 80/tcp | ClawBox web OS |
| 443/tcp | ClawBox web OS over TLS, when certs are installed in `data/certs/` |
| 18789/tcp | OpenClaw gateway |
| 8090/tcp | Hermes dashboard proxy (Hermes and dual editions) |
| 5353/udp | mDNS, so `clawbox.local` resolves (any source) |
| 53/tcp+udp | Captive-portal DNS, from the hotspot subnets only |
| 67/udp | DHCP, on the access-point interface only |

Services that were previously reachable on the LAN are now closed there: CUPS
(631), rpcbind (111 — also disabled and masked, unless an NFS/NIS package is
installed, in which case it is left running and merely firewalled) and the
terminal PTY socket (3006), which is unauthenticated when reached directly and
is only intended to be used through the session-gated proxy on port 80.

## Reporting a Vulnerability

**Please do not open a public issue for security problems.**

Report privately using **GitHub's private vulnerability reporting**:
the repository **Security** tab → **Report a vulnerability**. This keeps the report
confidential between you and the maintainers until a fix is available.

If private reporting is unavailable, email **yanko@idrobots.com** instead. Encrypt
or omit sensitive details (tokens, device IPs) and we will arrange a secure channel.

Please include, where you can:

- ClawBox and OpenClaw versions (Settings → System), and Jetson/JetPack model
- A description of the issue and its impact
- Steps to reproduce or a proof of concept
- Any logs or screenshots (with secrets redacted)

### What to expect

- **Acknowledgement** within 3 business days.
- An initial assessment and severity triage within 7 days.
- Progress updates until the issue is resolved, and credit in the release notes
  once a fix ships (unless you prefer to stay anonymous).

Thank you for helping keep ClawBox devices and their owners safe.
