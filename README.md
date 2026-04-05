<p align="center">
  <img src="public/clawbox-logo.png" alt="ClawBox" width="180" />
</p>

<h3 align="center">OpenClaw OS</h3>

<p align="center">
  The operating system for <a href="https://openclawhardware.dev/">OpenClaw Hardware</a> — a private AI assistant you own, running on NVIDIA Jetson.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Source_Available-blue?style=flat-square" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-NVIDIA_Jetson-76b900?style=flat-square&logo=nvidia" />
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js_16-black?style=flat-square&logo=next.js" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Bun" src="https://img.shields.io/badge/Bun-fbf0df?style=flat-square&logo=bun&logoColor=black" />
</p>

---

## What is ClawBox?

ClawBox **is** OpenClaw OS — the system software that turns a bare NVIDIA Jetson board into a fully functional private AI device. It handles everything from first-boot provisioning to the desktop you interact with daily:

1. **First boot** — The Jetson broadcasts a WiFi hotspot (`ClawBox-Setup`). You connect from any phone or laptop and walk through guided setup at `http://clawbox.local/`.
2. **Configuration** — A 7-step wizard configures WiFi, security credentials, system updates, AI provider keys (Claude, GPT, Gemini, Ollama, etc.), and optional Telegram integration.
3. **Daily use** — After setup the same URL serves a full desktop environment with windowed apps, a taskbar, and system tray. The AI agent (OpenClaw) runs locally and can control the entire device through MCP tools.

Everything runs on the device. No cloud dependency, no subscription, no data leaving your network unless you choose to connect an external AI provider.

## Quick Start

```bash
sudo bash install.sh
```

Connect to the **ClawBox-Setup** WiFi network (open, no password) and navigate to:
- `http://clawbox.local/`
- `http://10.42.0.1/`

## How It Works

### Layer 1 — System Bootstrap

The installer (`install.sh`) provisions the Jetson from scratch:
- Installs system packages, Node.js 22, Bun runtime
- Sets hostname to `clawbox`, enables mDNS discovery
- Builds the web OS, installs the OpenClaw gateway
- Configures systemd services and captive-portal DNS
- Creates the WiFi access point for first-boot setup

Two systemd services run the OS:

| Service | Role |
|---|---|
| `clawbox-ap` | WiFi access point (SSID: ClawBox-Setup, IP: 10.42.0.1) |
| `clawbox-setup` | Web server on port 80 (Next.js + WebSocket proxy) |

### Layer 2 — Setup Wizard

On first boot (or after factory reset), the OS presents a 7-step wizard:

1. **Welcome** — Language selection (10 languages supported)
2. **Security** — Device password + WiFi hotspot credentials
3. **WiFi** — Connect to your home/office network (or use Ethernet)
4. **Update** — Pull latest system updates
5. **AI Models** — API key or OAuth login for Claude, GPT, Gemini, OpenRouter, ClawBox AI, or local Ollama
6. **Telegram** — Optional bot token for remote messaging
7. **Done** — System status dashboard and factory reset option

### Layer 3 — Desktop Environment

After setup, ClawBox serves a Chrome OS-style desktop accessible from any browser:

- **AI Chat** — Full-window and floating popup chat via the OpenClaw gateway
- **Terminal** — xterm.js shell with WebSocket PTY
- **File Manager** — Browse, upload, rename, delete files on the device
- **Browser Automation** — Visual Chromium control via DevTools Protocol
- **Remote Desktop** — NoVNC viewer for VNC sessions
- **VS Code** — Integrated code-server IDE
- **App Store** — Discover and install skills from openclawhardware.dev
- **Settings** — WiFi, AI provider, appearance, Telegram, system management
- **Ollama Models** — Pull, search, and manage local AI models
- **Mascot** — Animated crab companion with personality states

The desktop features draggable/resizable windows, a taskbar with system tray, and a responsive mobile layout for phone access.

### Layer 4 — AI Agent Integration (MCP)

The OpenClaw AI agent controls the device through an MCP (Model Context Protocol) server. This is what makes ClawBox an *OS* rather than just a dashboard — the AI can operate the device autonomously.

**Device control tools:**

```text
system_stats / system_info / system_power   — monitor and manage the device
run_command                                  — execute any shell command
file_list / file_read / file_write           — file operations
wifi_scan / wifi_status                      — network management
ui_open_app / ui_notify                      — control the desktop UI
```

**Browser automation tools:**

```text
browser_launch / browser_navigate / browser_click / browser_type
browser_scroll / browser_screenshot / browser_keypress / browser_close
```

**App management tools:**

```text
app_search / app_install / app_uninstall     — app store operations
webapp_create / webapp_update                — create desktop apps from HTML
preferences_get / preferences_set            — user preferences
```

**Code assistant tools** (for building new desktop webapps):

```text
code_project_init    — scaffold a new multi-file webapp project
code_project_list    — list all projects
code_file_write      — create or overwrite a project file
code_file_read       — read a project file
code_file_edit       — surgical string-replacement edits
code_file_delete     — remove a file
code_file_list       — recursive project tree
code_search          — grep across project files
code_project_build   — bundle CSS/JS into HTML, deploy to desktop, open the app
code_project_delete  — remove a project
```

The code assistant enables the AI to iteratively build, test, and deploy new desktop apps — write code across multiple files, make precise edits, search the codebase, then build a self-contained webapp that appears on the user's desktop.

**CLI wrapper** (`clawbox` command):
```bash
clawbox webapp create <appId> <name> [color] < file.html
clawbox app open <appId>
clawbox app list
clawbox notify <message>
clawbox system stats
clawbox code init <projectId> <name> [template] [color]
clawbox code build <projectId>
clawbox code files <projectId>
clawbox code search <projectId> <pattern>
```

## Architecture

```text
Browser (http://clawbox.local)
  │
  ├── Port 80: Next.js (production-server.js)
  │     ├── /setup          → Setup wizard (React SPA)
  │     ├── /login          → Authentication
  │     ├── /               → Desktop environment (post-setup)
  │     ├── /setup-api/*    → 50+ API routes (system, files, code, browser, etc.)
  │     ├── /api/*          → Proxy to OpenClaw gateway
  │     └── WebSocket       → Proxy to gateway + terminal PTY
  │
  ├── Port 3006: Terminal WebSocket PTY server
  │
  ├── Port 18789: OpenClaw Gateway (localhost only)
  │     ├── AI Agent (MCP tools → controls the entire OS)
  │     ├── Control UI
  │     ├── WebSocket (real-time chat)
  │     └── REST API
  │
  └── Port 18800: Chromium CDP (browser automation)
```

Node.js is used for the production server because Bun doesn't support `http.Server` upgrade events needed for WebSocket proxying.

## Tech Stack

- **Next.js 16** / React 19 / TypeScript 5 — web OS frontend and API
- **Tailwind CSS 4** — styling
- **Bun** — package management and builds
- **Node.js 22** — production runtime
- **MCP SDK** — AI agent tool protocol
- **xterm.js** / **node-pty** — terminal emulation
- **NoVNC** — remote desktop
- **NetworkManager** — WiFi AP and client management
- **Avahi** — mDNS discovery (`clawbox.local`)
- **Vitest** / **Playwright** — unit and E2E testing

## Project Structure

```text
├── config/                 Systemd services, captive-portal DNS
├── mcp/                    MCP server + CLI (AI agent interface to the OS)
├── scripts/                WiFi AP, terminal server, voice/TTS, Jetson tuning
├── src/
│   ├── app/                Next.js App Router (pages + 50+ API routes)
│   │   └── setup-api/      WiFi, AI models, Ollama, apps, files, browser, code, system
│   ├── components/         Setup wizard, desktop environment, built-in apps
│   ├── hooks/              Window manager, Ollama model management
│   ├── lib/                Config, network, auth, OAuth, i18n, updater, code-projects
│   ├── tests/              Unit + API route tests
│   └── middleware.ts       Captive portal detection + session auth
├── production-server.js    Node.js HTTP + WebSocket proxy wrapper
└── install.sh              Full system installer (idempotent)
```

## Development

```bash
bun install
bun run dev              # Port 3000
bun run dev:privileged   # Port 80 (requires root)
bun run build
bun run lint
bun run test             # Unit tests (Vitest)
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `80` | Web server port |
| `GATEWAY_PORT` | `18789` | OpenClaw gateway port |
| `NETWORK_INTERFACE` | `wlP1p1s0` | WiFi interface for AP |
| `CANONICAL_ORIGIN` | `http://clawbox.local` | Default redirect origin |
| `ALLOWED_HOSTS` | `clawbox.local,10.42.0.1,localhost` | Trusted hostnames |
| `SESSION_SECRET` | Auto-generated | Session cookie signing key |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama server URL |
| `CLAWBOX_ROOT` | `/home/clawbox/clawbox` | Project root directory |

## Internationalization

10 languages: English, German, Spanish, French, Italian, Japanese, Dutch, Swedish, Chinese, Bulgarian. Auto-detected from browser, changeable in settings.

## License

ClawBox is released under the [ClawBox Source Available License v1.0](LICENSE). Free to use, modify, and redistribute for **personal, non-commercial purposes**. Commercial use requires a separate license from [IDRobots Ltd.](https://openclawhardware.dev/) — contact yanko@idrobots.com.

---

<p align="center">
  <a href="https://openclawhardware.dev/">openclawhardware.dev</a><br/>
  Built by <a href="https://github.com/ID-Robots">ID Robots</a> — source available
</p>
