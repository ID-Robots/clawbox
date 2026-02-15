# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ClawBox is a setup wizard and dashboard for a personal AI assistant device running on an NVIDIA Jetson (Tegra/ARM). It creates a WiFi access point with a captive portal so users can configure the device from their phone, then transitions to their home network. The setup wizard guides users through WiFi configuration and Telegram bot setup.

## Stack

Bun runtime, Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4. Optimized for local edge deployment on Jetson — `output: 'standalone'` in next.config.ts, no external CDN dependencies, fully offline-capable.

## Commands

- `bun run dev` — dev server on port 80 at 0.0.0.0 (requires root for port 80)
- `bun run build` — production build (generates `.next/standalone/`)
- `bun run start` — run standalone production server on port 80
- `bun run lint` — run ESLint
- `sudo bash install.sh` — full system install: installs bun, builds, configures avahi/mDNS, installs systemd services, starts AP and web server

No test framework is configured yet.

## Architecture

### Routing

After setup completes, the root `/` proxies the OpenClaw Control UI from the gateway at `127.0.0.1:18789`. The setup wizard lives at `/setup`. The root route handler (`src/app/route.ts`) checks `setup_complete` in config and either redirects to `/setup` or serves the gateway HTML.

Next.js rewrites in `next.config.ts` proxy gateway paths (`/api/*`, `/assets/*`, favicons) to the gateway. A fallback rewrite catches remaining paths.

### Setup API Routes (`src/app/setup-api/`)

Next.js Route Handlers for the setup wizard (namespaced under `/setup-api/` to avoid conflicts with the OpenClaw gateway's `/api/*`):

- `GET /setup-api/wifi/scan`, `POST /setup-api/wifi/connect`, `GET /setup-api/wifi/status` — WiFi management
- `POST /setup-api/telegram/configure`, `GET /setup-api/telegram/status` — Telegram bot config
- `GET /setup-api/system/info` — system info (hostname, CPU, memory, temp, disk)
- `POST /setup-api/setup/complete`, `GET /setup-api/setup/status` — setup flow state

All dynamic API routes use `export const dynamic = "force-dynamic"` to prevent caching.

### Captive Portal (`src/middleware.ts`)

Next.js middleware intercepts OS-specific captive portal detection URLs (Android, Apple, Windows, Firefox) and redirects to `http://10.42.0.1/`. Uses a `matcher` config to only run on the 9 specific paths.

### Server Libraries (`src/lib/`)

- **`network.ts`** — WiFi management via `nmcli` using `child_process.execFile`. Hardcoded interface: `wlP1p1s0`.
- **`config-store.ts`** — JSON key-value store at `/home/clawbox/clawbox/data/config.json`.
- **`system-info.ts`** — gathers hostname, memory, CPU, temperature, disk info via OS module and shell commands.

### Frontend (`src/components/`)

React component tree for the 4-step setup wizard:
- **`SetupWizard.tsx`** — client component, manages step state, checks setup status on mount
- **`WifiStep.tsx`** — WiFi scan, network selection modal, connect flow
- **`TelegramStep.tsx`** — bot token input and validation
- **`DoneStep.tsx`** — system info display and setup completion

### System Integration (`scripts/`, `config/`)

- **`scripts/start-ap.sh`** / **`scripts/stop-ap.sh`** — create/tear down a NetworkManager WiFi AP named "ClawBox-Setup" on `wlP1p1s0` at `10.42.0.1/24`, with iptables rules for HTTP redirect.
- **`config/clawbox-ap.service`** — systemd oneshot service for the WiFi AP.
- **`config/clawbox-setup.service`** — systemd service that runs the Next.js standalone server via bun as root.
- **`config/dnsmasq-captive.conf`** — DNS hijack config resolving all queries to `10.42.0.1`.

### Key Constants

- WiFi interface: `wlP1p1s0` (hardcoded in `src/lib/network.ts` and shell scripts)
- AP SSID: `ClawBox-Setup`, AP IP: `10.42.0.1`
- Config file: `/home/clawbox/clawbox/data/config.json` (created at runtime, gitignored)
- Project directory: `/home/clawbox/clawbox`
- OpenClaw gateway: `http://127.0.0.1:18789` (loopback, proxied through Next.js rewrites)
