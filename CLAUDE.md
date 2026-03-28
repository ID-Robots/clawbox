# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and other AI coding agents.

## Project

ClawBox is the setup wizard and dashboard for [OpenClaw Hardware](https://openclawhardware.dev/) — a private AI assistant device running on NVIDIA Jetson Orin Nano. It creates a WiFi access point with a captive portal so users can configure the device from their phone, then transitions to their home network. After setup, it proxies the OpenClaw gateway Control UI.

## Stack

- **Runtime:** Node.js 22 (production), Bun (dev/build/package management)
- **Framework:** Next.js 16 (App Router), React 19
- **Language:** TypeScript 5
- **Styling:** Tailwind CSS 4
- **Testing:** Vitest + @vitest/coverage-v8 (80% coverage target)
- **Linting:** ESLint 9 with next/core-web-vitals + next/typescript
- **Output:** Standalone build (`output: 'standalone'`), fully offline-capable

## Commands

```bash
bun install              # install dependencies
bun run dev              # dev server (port 3000 by default)
bun run build            # production build → .next/standalone/
bun run start            # production server (port 80)
bun run test             # run tests
bun run test:coverage    # run tests with coverage
bun run lint             # ESLint
sudo bash install.sh     # full system install on Jetson
sudo bash install.sh --step NAME  # run single update step
bash install-x64.sh      # x64 Linux development install
```

## Architecture

### Routing

- `/` → Proxies OpenClaw Control UI from gateway at `127.0.0.1:18789` (after setup)
- `/setup` → Setup wizard React SPA (redirected to if not configured)
- `/setup-api/*` → Backend API routes (WiFi, AI models, Telegram, system, updates)
- `/api/*` → Proxy to OpenClaw gateway
- WebSocket connections proxied via `production-server.js` upgrade handler

### Setup API Routes (`src/app/setup-api/`)

| Endpoint | Purpose |
|----------|---------|
| `wifi/scan`, `wifi/connect`, `wifi/status` | WiFi AP and client management |
| `ai-models/configure` | API key configuration |
| `ai-models/oauth/*` | OAuth device flow for Claude/GPT/Gemini |
| `ollama/*` | Local model management (pull, delete, search, status) |
| `telegram/configure`, `telegram/status` | Telegram bot setup |
| `system/info`, `system/credentials`, `system/hotspot` | System management |
| `system/update-branch` | Branch selection for updates |
| `update/run`, `update/status` | System update execution |
| `setup/complete`, `setup/status`, `setup/reset` | Setup flow state |

### Key Libraries (`src/lib/`)

- **`config-store.ts`** — SQLite-backed config store (was JSON, migrated)
- **`network.ts`** — WiFi management via `nmcli` using `child_process.execFile`
- **`system-info.ts`** — Hardware info (hostname, CPU, memory, temp, disk)
- **`gateway-proxy.ts`** — Proxy helpers for OpenClaw gateway
- **`oauth-config.ts`** / **`oauth-utils.ts`** — OAuth device flow for AI providers
- **`openclaw-config.ts`** — OpenClaw gateway configuration
- **`updater.ts`** — System update steps and phases
- **`google-project.ts`** — Google Cloud project setup for Gemini

### Frontend Components (`src/components/`)

7-step setup wizard:
1. `WelcomeStep.tsx` — Introduction
2. `CredentialsStep.tsx` — Device password
3. `WifiStep.tsx` — Network selection and connection
4. `UpdateStep.tsx` — System packages, JetPack, OpenClaw
5. `AIModelsStep.tsx` — Provider configuration + `OllamaModelPanel.tsx`
6. `TelegramStep.tsx` — Bot token setup
7. `DoneStep.tsx` — Dashboard with system info and factory reset

### Captive Portal (`src/middleware.ts`)

Intercepts OS-specific captive portal detection URLs (Android, Apple, Windows, Firefox) and redirects to `http://10.42.0.1/`.

### System Integration

- **`scripts/start-ap.sh`** / **`stop-ap.sh`** — WiFi AP "ClawBox-Setup" at `10.42.0.1/24`
- **`scripts/install-voice.sh`** — Optional STT/TTS pipeline
- **`scripts/optimize-ollama.sh`** — Jetson-specific Ollama tuning
- **`scripts/recover.sh`** — Recovery/factory reset
- **`config/clawbox-*.service`** — Systemd services
- **`config/dnsmasq-captive.conf`** — DNS hijack for captive portal

### Key Constants

- WiFi interface: auto-detected (override with `NETWORK_INTERFACE` env)
- AP SSID: `ClawBox-Setup`, AP IP: `10.42.0.1`
- Config: SQLite at `/home/clawbox/clawbox/local-data/data/config.db`
- Project directory: `/home/clawbox/clawbox`
- OpenClaw gateway: `http://127.0.0.1:18789`

## Conventions

- All API routes use `export const dynamic = "force-dynamic"` (no caching)
- Node.js for production-server.js (Bun lacks HTTP upgrade events for WebSocket proxy)
- Shell commands use `execFile` (not `exec`) to prevent injection
- Test files: `src/tests/*.test.ts`
- Git: Never push directly to `main` — use feature branches + PRs
