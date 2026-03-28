# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ClawBox, please report it responsibly:

**Email:** [yanko@idrobots.com](mailto:yanko@idrobots.com)

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

**Please do not open public issues for security vulnerabilities.**

## Scope

This policy covers:
- The ClawBox setup wizard and dashboard (`src/`)
- Install scripts (`install.sh`, `install-x64.sh`)
- System configuration files (`config/`)
- Network management (`scripts/`)

## Security Model

- ClawBox runs on a local network — the dashboard is not exposed to the internet by default
- WiFi AP mode uses an open network for initial setup only, then switches to the user's secured network
- API keys and credentials are stored in a local SQLite database on the device
- The OpenClaw gateway is bound to localhost (`127.0.0.1:18789`) and proxied through Next.js
- Shell commands use `execFile` (not `exec`) to prevent command injection
