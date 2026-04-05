# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ClawBox is **OpenClaw OS** — the operating system for [OpenClaw Hardware](https://openclawhardware.dev/), a private AI assistant running on NVIDIA Jetson (Tegra/ARM). It manages the full device lifecycle: broadcasts a WiFi access point with captive portal for first-boot setup from any phone/laptop, transitions to the home network, then serves a Chrome OS-style desktop environment with built-in apps. The OpenClaw AI agent controls the entire device through MCP (Model Context Protocol) tools — making ClawBox an OS the AI can operate, not just a UI the user clicks through.

## Stack

Bun runtime (package management + builds), Node.js 22 (production runtime), Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS v4. Optimized for local edge deployment on Jetson — `output: 'standalone'` in next.config.ts, no external CDN dependencies, fully offline-capable.

## Commands

- `bun run dev` — dev server on port 3000 at 0.0.0.0
- `bun run dev:privileged` — dev server on port 80 (requires root)
- `bun run build` — production build (generates `.next/standalone/`)
- `bun run start` — run standalone production server on port 80
- `bun run lint` — run ESLint
- `bun run test` — run Vitest unit tests
- `sudo bash install.sh` — full system install: installs bun, builds, configures avahi/mDNS, installs systemd services, starts AP and web server

## Testing

- **Unit tests**: Vitest (`vitest.config.ts`, `vitest.workspace.ts`) — tests in `src/tests/`
- **E2E tests**: Playwright (`playwright.config.ts`)
- Test coverage for: config store, network utils, auth, OAuth, system info, updater, gateway proxy, middleware, API routes

## Architecture

### Routing

After setup completes, the root `/` serves a Chrome-like desktop environment (`src/app/page.tsx`) that includes a window manager, taskbar, and built-in apps. The setup wizard lives at `/setup`. Authentication is enforced via middleware — unauthenticated users are redirected to `/login`.

Next.js rewrites in `next.config.ts` proxy gateway paths (`/api/*`, `/assets/*`, favicons) to the OpenClaw gateway at `127.0.0.1:18789`. A catch-all route (`src/app/[...gateway]/`) handles remaining gateway paths.

### Setup API Routes (`src/app/setup-api/`)

50+ Next.js Route Handlers namespaced under `/setup-api/` to avoid conflicts with the OpenClaw gateway's `/api/*`:

- **WiFi**: `wifi/scan`, `wifi/connect`, `wifi/status`, `wifi/ethernet` — WiFi and Ethernet management
- **System**: `system/info`, `system/stats`, `system/power`, `system/credentials`, `system/hotspot` — system info, power control, password, hotspot config
- **AI Models**: `ai-models/configure`, `ai-models/status`, `ai-models/oauth/*` — API key config with OAuth flows (device auth + authorization code)
- **Ollama**: `ollama/status`, `ollama/pull`, `ollama/search`, `ollama/delete` — local model management
- **Apps**: `apps/store`, `apps/install`, `apps/uninstall`, `apps/icon/[appId]`, `apps/settings` — app store integration
- **Files**: `files/` — file list, read, write, upload, mkdir, delete
- **Browser**: `browser/` — Chromium automation via CDP (launch, navigate, click, type, screenshot)
- **Gateway**: `gateway/`, `gateway/health`, `gateway/ws-config` — gateway proxying with HTML injection
- **Telegram**: `telegram/configure`, `telegram/status` — Telegram bot config
- **Setup**: `setup/status`, `setup/complete`, `setup/reset` — setup flow state, factory reset
- **Update**: `update/run`, `update/status` — git-based system updates
- **Preferences**: `preferences/` — persistent user preferences (language, installed apps, etc.)
- **KV Store**: `kv/` — key-value store for UI state
- **Code**: `code/` — code project management (init, file ops, search, build/deploy)
- **Other**: `vnc/`, `code-server/`, `webapps/`, `mascot-lines/`

All dynamic API routes use `export const dynamic = "force-dynamic"` to prevent caching.

### Middleware (`src/middleware.ts`)

Handles two concerns:
1. **Captive portal detection** — intercepts OS-specific detection URLs (Android, Apple, Windows, Firefox) and redirects to `http://10.42.0.1/`
2. **Authentication** — enforces session cookie auth, redirects unauthenticated users to `/login`

### Server Libraries (`src/lib/`)

- **`network.ts`** — WiFi management via `nmcli` and `iw scan`. Interface from env `NETWORK_INTERFACE` (default: `wlP1p1s0`).
- **`config-store.ts`** — JSON key-value store at `/home/clawbox/clawbox/data/config.json`.
- **`kv-store.ts`** — persistent KV store at `data/kv.json` for UI state.
- **`system-info.ts`** — hostname, memory, CPU, temperature, disk, network stats via `/proc` and shell commands.
- **`updater.ts`** — multi-step system update orchestration (internet check → git fetch → checkout → build → restart).
- **`auth.ts`** — session cookie generation/verification (HMAC-SHA256).
- **`oauth-config.ts`** / **`oauth-utils.ts`** / **`google-project.ts`** — OAuth provider configuration and flows.
- **`openclaw-config.ts`** — read/write OpenClaw gateway config (`~/.openclaw/openclaw.json`).
- **`gateway-proxy.ts`** — fetch gateway HTML, inject ClawBox nav bar + auth token.
- **`i18n.tsx`** — i18n context provider with browser language detection.
- **`translations.ts`** — translation strings for 10 languages (en, de, es, fr, it, ja, nl, sv, zh, bg).
- **`tamagotchi.ts`** — mascot AI personality line generation.
- **`chat-markdown.tsx`** — Markdown rendering for chat messages.
- **`client-kv.ts`** — browser-side localStorage KV wrapper.
- **`wifi-utils.ts`** — WiFi scan result parsing.
- **`code-projects.ts`** — code project management: CRUD, file ops (write/edit/delete/search), build/bundle to webapp.

### Frontend (`src/components/`)

#### Setup Wizard (7 steps)
- **`SetupWizard.tsx`** — orchestrator, step state management, setup status check
- **`WifiStep.tsx`** — WiFi scan, network selection, password entry, Ethernet detection
- **`CredentialsStep.tsx`** — system password + WiFi hotspot configuration
- **`UpdateStep.tsx`** — system update progress tracking
- **`AIModelsStep.tsx`** — AI provider selection with OAuth flows (ClawBox AI, Claude, GPT, Gemini, OpenRouter, Ollama)
- **`TelegramStep.tsx`** — bot token input and validation
- **`DoneStep.tsx`** — system dashboard, factory reset

#### Desktop Environment
- **`ChromeShelf.tsx`** — app launcher taskbar with pinned icons
- **`ChromeLauncher.tsx`** — app discovery context menu
- **`ChromeWindow.tsx`** / **`Window.tsx`** — draggable, resizable windows with title bar controls
- **`Taskbar.tsx`** — bottom bar with system tray, clock, actions
- **`SystemTray.tsx`** — WiFi, battery, Telegram status indicators
- **`Mascot.tsx`** — animated crab mascot with personality states
- **`AndroidStatusBar.tsx`** / **`AndroidNavBar.tsx`** / **`AppDrawer.tsx`** — mobile UI

#### Built-in Apps
- **`ChatApp.tsx`** / **`ChatPopup.tsx`** — AI chat via OpenClaw gateway WebSocket
- **`TerminalApp.tsx`** — xterm.js terminal over WebSocket PTY
- **`BrowserApp.tsx`** — Chromium automation UI (CDP port 18800)
- **`FilesApp.tsx`** — file browser with upload, rename, delete, mkdir
- **`VNCApp.tsx`** — NoVNC remote desktop viewer
- **`VSCodeApp.tsx`** — VS Code server integration
- **`AppStore.tsx`** — discover and install apps from openclawhardware.dev
- **`SettingsApp.tsx`** — appearance, WiFi, AI provider, Telegram, system settings
- **`OllamaModelPanel.tsx`** — local model pull, search, delete
- **`OpenClawApp.tsx`** — OpenClaw gateway Control UI wrapper

#### Hooks
- **`useWindows.ts`** — window state management (reducer pattern)
- **`useOllamaModels.ts`** — Ollama model management

### MCP Server (`mcp/`)

The AI agent interface to the OS. Exposes 40+ tools via MCP so the OpenClaw agent can control the device:

- **`clawbox-mcp.ts`** — MCP server with tool categories:
  - **System**: `system_stats`, `system_info`, `system_power`
  - **Shell**: `run_command`
  - **Files**: `file_list`, `file_read`, `file_write`, `file_mkdir`
  - **Browser**: `browser_launch`, `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`, `browser_keypress`, `browser_close`
  - **Apps**: `app_search`, `app_install`, `app_uninstall`, `webapp_create`, `webapp_update`
  - **UI control**: `ui_open_app`, `ui_list_apps`, `ui_notify`
  - **Network**: `wifi_scan`, `wifi_status`, `vnc_status`
  - **Config**: `preferences_get`, `preferences_set`
  - **Code assistant**: `code_project_init`, `code_project_list`, `code_project_build`, `code_project_delete`, `code_file_write`, `code_file_read`, `code_file_edit`, `code_file_delete`, `code_file_list`, `code_search`
- **`clawbox-cli.ts`** — shell-callable CLI wrapper (`clawbox webapp create/update`, `clawbox app open/list`, `clawbox notify`, `clawbox system stats/info`, `clawbox code init/build/files/read/write/edit/search/delete`)

### Code Assistant (`src/lib/code-projects.ts`, `src/app/setup-api/code/`)

Enables the AI agent to build multi-file desktop webapps through an iterative coding workflow:

1. `code_project_init` — scaffold a project (index.html + style.css + app.js)
2. Write/edit files using `code_file_write` and `code_file_edit` (string-replacement edits)
3. Search code with `code_search`, inspect with `code_file_read`
4. `code_project_build` — inlines local CSS/JS into a single HTML file, deploys to `data/webapps/`, registers on the desktop

Projects live in `data/code-projects/<projectId>/`. Built webapps are deployed to `data/webapps/<projectId>/` and served at `/setup-api/webapps?app=<projectId>`.

### System Integration (`scripts/`, `config/`)

- **`scripts/start-ap.sh`** / **`scripts/stop-ap.sh`** — create/tear down WiFi AP "ClawBox-Setup" on `wlP1p1s0` at `10.42.0.1/24`
- **`scripts/terminal-server.ts`** — WebSocket PTY server on port 3006
- **`scripts/setup-optimizations.sh`** — Jetson GPU/memory tuning
- **`scripts/gateway-pre-start.sh`** — gateway pre-startup hooks
- **`scripts/kokoro-*.sh`** / **`scripts/kokoro-server.py`** — voice/TTS integration
- **`scripts/stt.py`** / **`scripts/whisper-server.py`** — speech-to-text via Whisper
- **`production-server.js`** — Node.js HTTP + WebSocket proxy wrapper (Bun doesn't support `http.Server` upgrade events)
- **`config/clawbox-ap.service`** — systemd oneshot service for WiFi AP
- **`config/clawbox-setup.service`** — systemd service for web server
- **`config/dnsmasq-captive.conf`** — DNS hijack config resolving all queries to `10.42.0.1`

### Key Constants

- WiFi interface: `wlP1p1s0` (env `NETWORK_INTERFACE`, hardcoded in shell scripts)
- AP SSID: `ClawBox-Setup`, AP IP: `10.42.0.1`
- Config file: `/home/clawbox/clawbox/data/config.json` (created at runtime, gitignored)
- KV store: `/home/clawbox/clawbox/data/kv.json`
- Session secret: `data/.session-secret` (generated at runtime)
- Project directory: `/home/clawbox/clawbox`
- OpenClaw gateway: `http://127.0.0.1:18789` (loopback, proxied through Next.js rewrites)
- OpenClaw config: `~/.openclaw/openclaw.json`
- Chromium CDP: port `18800`
- Terminal WebSocket: port `3006`
- Ollama: `http://127.0.0.1:11434`

### Environment Variables

See `.env.example` for full list. Key variables: `PORT`, `GATEWAY_PORT`, `NETWORK_INTERFACE`, `CANONICAL_ORIGIN`, `ALLOWED_HOSTS`, `SESSION_SECRET`, `OLLAMA_HOST`, `CLAWBOX_ROOT`.
