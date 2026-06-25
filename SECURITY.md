# Security Policy

ClawBox is the operating system for [OpenClaw Hardware](https://openclawhardware.dev/),
running on NVIDIA Jetson. Because it manages WiFi, system credentials, OAuth tokens,
and the on-device AI agent, we take security reports seriously.

## Supported Versions

Only the latest release line receives security fixes. Devices update in place via
**Settings → System Update** or `sudo clawbox update`, so we ask everyone to stay current.

| Version | Supported |
| ------- | --------- |
| Latest release (3.1.x) | ✅ |
| Older releases | ❌ — please update first |

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
