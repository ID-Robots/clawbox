<p align="center">
  <img src="public/clawbox-logo.png" alt="ClawBox" width="180" />
</p>

<h1 align="center">ClawBox</h1>

<p align="center">
  <strong>Your private AI assistant that runs 24/7 on your desk.</strong><br/>
  Plug in. Scan QR. Done. No cloud required.
</p>

<p align="center">
  <a href="https://github.com/ID-Robots/clawbox/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/ID-Robots/clawbox/ci.yml?style=flat-square&label=CI" /></a>
  <a href="https://openclawhardware.dev"><img alt="Website" src="https://img.shields.io/badge/🌐_Website-openclawhardware.dev-orange?style=flat-square" /></a>
  <a href="https://discord.gg/FbKmnxYnpq"><img alt="Discord" src="https://img.shields.io/badge/Discord-78K+_members-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Source_Available-blue?style=flat-square" /></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-NVIDIA_Jetson-76b900?style=flat-square&logo=nvidia" />
</p>

<p align="center">
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js_16-black?style=flat-square&logo=next.js" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Bun" src="https://img.shields.io/badge/Bun-fbf0df?style=flat-square&logo=bun&logoColor=black" />
  <img alt="Tests" src="https://img.shields.io/badge/coverage-80%25-brightgreen?style=flat-square" />
</p>

---

## What is ClawBox?

ClawBox is a dedicated AI assistant that runs on **NVIDIA Jetson** hardware. Unlike cloud AI, your data never leaves your device. It manages your emails, automates your browser, controls your smart home, and connects to you via **Telegram, WhatsApp, or Discord** — all running locally at 15 watts.

This repository contains the **setup wizard and dashboard** — the web UI that turns a bare Jetson into a fully configured AI assistant in under 5 minutes.

### ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🧙 **5-minute setup** | Guided wizard: WiFi → updates → AI provider → messaging → done |
| 🤖 **580+ skills** | Browse and install from the built-in app store |
| 🔒 **Privacy-first** | Everything runs locally. No telemetry. No data collection. |
| 🧠 **Hybrid AI** | Local models (Llama, Gemma, Mistral) + optional cloud (Claude, GPT, Gemini) |
| 🌐 **Browser automation** | Your AI controls a real browser — fills forms, scrapes data, posts content |
| 💬 **Multi-platform** | Telegram, WhatsApp, Discord, web panel |
| 🎤 **Voice I/O** | Speak to it, it speaks back — all processed on-device |
| 📊 **Dashboard** | Real-time system monitoring, settings, and skill management |
| ⚡ **Always-on** | 7-15W power. Runs 24/7 for ~€39/year in electricity |

### 🖥️ Hardware

| Component | Spec |
|-----------|------|
| **Processor** | NVIDIA Jetson Orin Nano 8GB (Super) |
| **AI Performance** | 67 TOPS |
| **Storage** | 512GB NVMe SSD |
| **Power** | 7-15W typical, USB-C |
| **Size** | 100 × 79 × 31mm |
| **Case** | Carbon fiber |

> **Don't have the hardware?** The dashboard also runs on x64 Linux for development. See [x64 Install](#x64-development).

---

## 🚀 Quick Start

### On Jetson (production)

```bash
# Full automated install (Jetson Orin Nano)
sudo bash install.sh
```

Connect to the **ClawBox-Setup** WiFi network and navigate to:
- `http://clawbox.local/`
- `http://10.42.0.1/`

### On x64 (development)

```bash
# x64 Linux development install
sudo bash install-x64.sh

# Or manual
bun install
bun run build
node production-server.js
```

---

## 📱 Setup Wizard

The wizard walks you through 7 steps — no terminal or Docker knowledge needed:

1. **Welcome** — Introduction and overview
2. **Security** — Set a device password
3. **WiFi** — Connect to your home/office network
4. **System Update** — Packages, JetPack, OpenClaw engine
5. **AI Models** — Configure API keys or OAuth for Claude/GPT/Gemini/Ollama
6. **Telegram** — Optional bot integration
7. **Done** — Dashboard with status monitoring and factory reset

After setup, the root URL serves the **OpenClaw Control UI** — your central command for the AI assistant.

---

## 🏗️ Architecture

```text
Browser (http://clawbox.local)
  │
  ├── Port 80: Next.js (production-server.js)
  │     ├── /setup          → Setup wizard (React SPA)
  │     ├── /setup-api/*    → Setup API routes (WiFi, updates, AI config)
  │     ├── /api/*          → Proxy to OpenClaw gateway
  │     ├── /               → Gateway HTML + ClawBox navigation bar
  │     └── WebSocket       → Proxy to gateway (real-time events)
  │
  └── Port 18789: OpenClaw Gateway (localhost only)
        ├── Control UI      → Chat, settings, monitoring
        ├── WebSocket       → Real-time messaging
        └── REST API        → Skills, config, system info
```

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 16, React 19, Tailwind CSS 4 |
| **Language** | TypeScript 5 |
| **Package Manager** | Bun |
| **Runtime** | Node.js 22 (production), Bun (dev/build) |
| **Networking** | NetworkManager (WiFi AP), Avahi (mDNS) |
| **AI Engine** | [OpenClaw](https://github.com/openclaw/openclaw) |
| **Local Models** | Ollama (Llama, Gemma, Mistral) |
| **Testing** | Vitest + Playwright (80% coverage) |

## 📁 Project Structure

```text
├── config/                 Systemd services, dnsmasq, captive portal
├── scripts/                WiFi AP, voice install, Ollama optimization
├── src/
│   ├── app/                Next.js App Router
│   │   ├── setup/          Setup wizard pages
│   │   ├── setup-api/      Backend API routes (WiFi, updates, AI)
│   │   └── api/            Gateway proxy routes
│   ├── components/         React components (wizard steps, dashboard)
│   └── lib/                Config store (SQLite), system info, updater
├── public/                 Static assets, logos
├── production-server.js    Node.js HTTP/WS server
├── install.sh              Jetson full install (19 steps)
└── install-x64.sh          x64 development install
```

---

## 🧪 Development

```bash
# Install dependencies
bun install

# Development server (hot reload)
bun run dev

# Run tests
bun run test

# Type checking
bun run typecheck

# Lint
bun run lint

# Build for production
bun run build
```

### Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `80` |
| `GATEWAY_URL` | OpenClaw gateway URL | `http://127.0.0.1:18789` |
| `GATEWAY_TOKEN` | Gateway authentication token | *(from gateway)* |
| `HOSTNAME` | Device hostname | `clawbox` |

---

## 🌍 Community & Links

- **🌐 Website:** [openclawhardware.dev](https://openclawhardware.dev)
- **🧠 Product page — [ClawBox AI](https://clawboxai.dev):** specs, FAQ, and buyer guide for the ClawBox AI appliance
- **💬 Discord:** [discord.gg/FbKmnxYnpq](https://discord.gg/FbKmnxYnpq) (78K+ members)
- **📖 Docs:** [openclawhardware.dev/docs](https://openclawhardware.dev/docs)
- **🛒 Buy ClawBox:** [openclawhardware.dev](https://openclawhardware.dev) — €549, free worldwide shipping
- **🤖 Powered by:** [OpenClaw](https://github.com/openclaw/openclaw)

---

## 🤝 Contributing

ClawBox is source-available. While we're not accepting external contributions at this time, we welcome:

- **Bug reports** — [Open an issue](https://github.com/yalexx/clawbox/issues)
- **Feature requests** — [Start a discussion](https://github.com/yalexx/clawbox/discussions)
- **Security reports** — Email yanko@idrobots.com

---

## 📄 License

[ClawBox Source Available License v1.0](LICENSE) — Copyright © 2025-2026 IDRobots Ltd.

You may view and study the code. Commercial use, redistribution, and modification require written permission from IDRobots Ltd.

---

<p align="center">
  <sub>Built with ❤️ by <a href="https://idrobots.com">IDRobots</a> in the EU 🇪🇺</sub>
</p>
