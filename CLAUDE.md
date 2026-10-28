# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**This file is a map.** It loads into every Claude Code session and agent that starts in this repository or one of its worktrees, so it stays short: what ClawBox is, how to build and test it, the rules every change keeps, the architecture in one screen, and where to read more. Everything about one feature or area lives in `docs/agents/<area>.md` — open the file for the area you are about to touch before you change it.

**New notes go to `docs/agents/<area>.md`, never here.** Add a file there (and one line under "Where to read more") when no area fits. `src/tests/unit/claude-md-map.test.ts` fails when this file passes 40,000 bytes or a line passes 600 characters.

## Project

ClawBox is **OpenClaw OS** — the operating system for [OpenClaw Hardware](https://clawbox.com/), a private AI assistant running on NVIDIA Jetson (Tegra/ARM). It manages the full device lifecycle: broadcasts a WiFi access point with captive portal for first-boot setup from any phone/laptop, transitions to the home network, then serves a Chrome OS-style desktop environment with built-in apps. The OpenClaw AI agent controls the entire device through MCP (Model Context Protocol) tools — making ClawBox an OS the AI can operate, not just a UI the user clicks through.

## Stack

Bun runtime (package management + builds), Node.js 24 (production runtime), Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS v4. Optimized for local edge deployment on Jetson — `output: 'standalone'` in next.config.ts, no external CDN dependencies, fully offline-capable.

## Commands

- `bun run dev` — dev server on port 3000 at 0.0.0.0
- `bun run dev:privileged` — dev server on port 80 (requires root)
- `bun run build` — production build (generates `.next/standalone/`). Its type check runs over `tsconfig.build.json` — the project without its tests (0.96 GB of heap instead of 2.45 GB, which an 8 GB Jetson's default Node heap could no longer hold); the WHOLE program is still checked on every PR by `src/tests/unit/build-typecheck.test.ts`, and `tsconfig-excludes-data.test.ts` holds the build config to every exclusion `tsconfig.json` has (see `next.config.ts`)
- `bun run start` — run standalone production server on port 80
- `bun run lint` — run ESLint
- `bun run test` — run Vitest unit tests
- `node scripts/check-lockfiles.mjs` — package.json vs `bun.lock` and `package-lock.json`. After ANY edit to package.json run `bun install` and `npm install --package-lock-only --ignore-scripts` and commit all three files together; CI runs this check first in every installing job, and `git config core.hooksPath scripts/hooks` makes it a pre-commit hook
- `sudo bash install.sh` — full system install: installs bun, builds, configures avahi/mDNS, installs systemd services, starts AP and web server

## Testing

- **Unit tests**: Vitest (`vitest.config.ts`, `vitest.workspace.ts`) — tests in `src/tests/`
- **E2E tests**: Playwright (`playwright.config.ts`). Every spec mocks `/setup-api/**` in the browser except `e2e/prime-radiant-smoke.spec.ts`, which lets `/setup-api/prime-radiant/**` through to a SECOND copy of the same build that the config starts on port+1 (`e2e/helpers/prime-radiant-server.ts`: `CLAWBOX_TEST_MODE=1` + `PRIME_RADIANT_FLASH_STUB=1`, every root and `HOME` in a temp directory, an edition file naming Hermes so `POST init` writes no OpenClaw config); the spec wipes the vault before each attempt and mints an owner cookie with that server's session secret
- **Flaky shards**: each vitest shard in `pr-tests-coverage.yml` runs through `scripts/vitest-shard.sh`, which reruns a failed shard ONCE; a pass on the rerun leaves a `::warning::` annotation and a "Flaky vitest shard" job-summary section naming the tests — fix those tests, do not lean on the rerun
- Test coverage for: config store, network utils, auth, OAuth, system info, updater, gateway proxy, middleware, API routes
- **CI** and the bots' scripts: [docs/agents/testing-and-ci.md](docs/agents/testing-and-ci.md); the on-device suite: [docs/nano-hardware-tests.md](docs/nano-hardware-tests.md)
- **The bench**: `bun run bench` scores the LIVE box per area (chat, desktop, idle, API, Prime Radiant, Memory Shard, files, terminal, a coding run, resources) and overall, through the signed-in kiosk Chrome; `compare before.json after.json` says better/same/worse after an update: [docs/clawbox-bench.md](docs/clawbox-bench.md)
- **This map**: `node scripts/check-claude-md-no-loss.mjs <base-ref>` proves a move out of a long CLAUDE.md lost no paragraph (CI runs it on every pull request into beta); `src/tests/unit/claude-md-map.test.ts` is the size guard

## Rules every change keeps

Quoted from the area files, where the full paragraph and its reasons are.

- All dynamic API routes use `export const dynamic = "force-dynamic"` to prevent caching. ([setup-api](docs/agents/setup-api.md))
- **Owner-only by default**: `hasOwnerSession`, `route-auth`'s `hasValidSession` and `requireSession` all mean THE OWNER now; a non-owner session gets **403 `owner_only`** (never 401, which the desktop reads as "signed out"). ([multi-user](docs/agents/multi-user.md))
- **`path` comes from `runtime-path.ts`**: Every non-test file under `src/` imports `path` from here (`"./runtime-path"` inside `src/lib`, which keeps the modules `mcp/` imports free of the `@/` alias) and never from `"path"`/`"node:path"`, and `runtime-path-imports.test.ts` fails on one that does. ([core-libraries](docs/agents/core-libraries.md))
- **Ids that reach a path**: Every id that reaches a path on these routes is REBUILT from the alphabet rather than tested and passed through (`safeAppId` in `src/lib/webapp-icon.ts`, `safeProjectId` behind `projectDir`/`webappPath` in `src/lib/code-projects.ts`, `safeSkillName` in `src/lib/openclaw-skill-info.ts`) — a `.test()` guard leaves the caller's string in play, and CodeQL rightly flags every path built from it (`js/path-injection`). ([apps-and-webapps](docs/agents/apps-and-webapps.md))
- **Web apps are sandboxed**: agent-written HTML must never run with the owner's session, which is what a same-origin frame gave it. ([apps-and-webapps](docs/agents/apps-and-webapps.md))
- **Root runs nothing from the tree**: The rule the sweep enforces is a MECHANISM, not a list of verbs: root must never read a byte out of the clawbox-writable tree and then run it — `install` and `cp` into a root-owned path count exactly as much as `exec`, `bash` and `source` do, and are worse, because the copy becomes the file root runs on every later dispatch. ([update-and-install](docs/agents/update-and-install.md))
- **Lockfiles and flaky shards**: the `check-lockfiles.mjs` line under Commands and the Flaky shards line under Testing, above

## Architecture

### Routing

After setup completes, the root `/` serves a Chrome-like desktop environment (`src/app/page.tsx`) that includes a window manager, taskbar, and built-in apps. The setup wizard lives at `/setup`. Authentication is enforced via middleware — unauthenticated users are redirected to `/login`.

Next.js rewrites in `next.config.ts` proxy gateway paths (`/api/*`, `/assets/*`, favicons) to the OpenClaw gateway at `127.0.0.1:18789`. A catch-all route (`src/app/[...gateway]/`) handles remaining gateway paths.

### The codebase in one screen

| Where | What | Area files |
|---|---|---|
| `src/app/page.tsx`, `src/components/` | the desktop, its built-in apps and the setup wizard | desktop for the shell, then the feature's own file (each has a Frontend section) |
| `src/app/setup-api/` | the Next.js route handlers under `/setup-api/` (the gateway owns `/api/*`) | setup-api, then the feature's own file |
| `src/middleware.ts` | captive portal, session authentication, the update lock | setup-api, multi-user |
| `src/lib/` | the server libraries and the browser hooks the components share | core-libraries, then the feature's own file |
| `mcp/` | the MCP server: the agent's interface to the OS, its tool set per edition | mcp, and `mcp/README.md` |
| `scripts/`, `config/` | the setup AP, the PTY server, the gateway pre-start hook, voice servers, systemd units, root steps | update-and-install, harness-openclaw, voice, terminal, desktop (the x64 desktop session, the performance suite) |
| `install.sh`, `production-server.js` | the full install and every root step; the HTTP + WebSocket wrapper the box runs | update-and-install |
| `src/tests/`, `e2e/` | Vitest unit, route and component suites; Playwright specs | Testing, above |

Two harnesses can sit under the OS: OpenClaw (the gateway at `127.0.0.1:18789`, configured in `~/.openclaw/openclaw.json`) and Hermes (`~/.hermes`). Which one a box runs is its edition (openclaw, hermes or dual), read from the root-owned `/etc/clawbox/edition.env` by `src/lib/edition-source.ts`; where a feature behaves differently per edition, its area file says so.

### Key Constants

- WiFi interface: `wlP1p1s0` (env `NETWORK_INTERFACE`, hardcoded in shell scripts)
- AP SSID: `ClawBox-Setup`, AP IP: `10.42.0.1`
- Config file: `/home/clawbox/clawbox/data/config.json` (created at runtime, gitignored)
- KV store: `/home/clawbox/clawbox/data/kv.json`
- Session secret: `data/.session-secret` (generated at runtime)
- Project directory: `/home/clawbox/clawbox`
- OpenClaw gateway: `http://127.0.0.1:18789` (loopback, proxied through Next.js rewrites)
- OpenClaw config: `~/.openclaw/openclaw.json`
- OpenClaw workspace: `~/.openclaw/workspace` unless `agents.defaults.workspace` moves it (`openclawWorkspaceDir()`) — where `BOOTSTRAP.md`, `USER.md` and `SOUL.md` live
- Chromium CDP: port `18800` on profile `~/.config/clawbox-browser`, start page from `~/.cache/clawbox/browser.env` (details: [docs/agents/browser.md](docs/agents/browser.md))
- Coding run scope: transient user unit `clawbox-run-<runId>-<token>.scope` (MemoryHigh 3G, MemoryMax 4G, CPUWeight 20, IOWeight 20, nice 10 — a run with no scope is reniced to 10 by hand); its CPU budget `CLAWBOX_RUN_CPU_BUDGET`; its stream log `data/coding-agent-streams/<runId>.jsonl`; a project's run notes `<project>/.clawbox/run-notes.md`
- Remote access tunnel: `clawbox-tunnel.service` → `scripts/run-tunnel.sh`. A provisioned box runs its NAMED tunnel (`<boxHandle>.clawbox.tech`, credential from the portal heartbeat's `boxTunnel` in `data/cloudflared/named-tunnel`, 0600, token via `TUNNEL_TOKEN` only — `src/lib/named-tunnel.ts`); no credential, a refused token or a named run that dies inside 60 s falls back to the quick tunnel; `data/cloudflared/tunnel.mode` says which
- Terminal WebSocket: port `3006`
- Ollama: `http://127.0.0.1:11434` (chat-provider backend only; no Local AI row)
- Memory embedder: system unit `clawbox-embed.service` (`EMBED_UNIT`), llama-server at `http://127.0.0.1:8081/v1`, reached by OpenClaw through `/setup-api/local-ai/embed/v1`; woken on demand, stopped after `LOCAL_AI_IDLE_TIMEOUT_MS` (10 min) idle; GGUF in `data/embed/models/`
- Kokoro TTS: user unit `kokoro-server.service` (`KOKORO_UNIT`), socket `/tmp/kokoro-server.sock`, model freed after `IDLE_TIMEOUT` (300 s) idle

### Environment Variables

See `.env.example` for full list. Key variables: `PORT`, `GATEWAY_PORT`, `NETWORK_INTERFACE`, `CANONICAL_ORIGIN`, `ALLOWED_HOSTS`, `SESSION_SECRET`, `OLLAMA_HOST`, `CLAWBOX_ROOT`.

## Where to read more

The area files under `docs/agents/` (moved verbatim out of this file on 2026-10-15; `docs/agents/` holds every per-area note from now on):

- [setup-api.md](docs/agents/setup-api.md) — read this when you touch a route under `src/app/setup-api/` that no feature file below owns, or `src/middleware.ts`.
- [core-libraries.md](docs/agents/core-libraries.md) — read this when you touch module-level state, a `path` import, the config or KV store, auth, i18n, or any `src/lib/` module no area below owns.
- [multi-user.md](docs/agents/multi-user.md) — read this when you touch sessions, `/login`, users, or the access rule of any new route (owner-only is the default).
- [setup-wizard.md](docs/agents/setup-wizard.md) — read this when you touch the first-boot wizard, `setup/*` or the unified image's edition choice.
- [harness-openclaw.md](docs/agents/harness-openclaw.md) — read this when you touch `openclaw.json`, the gateway's auth store, the OpenClaw CLI, `gateway-pre-start.sh` or the agent's persona and first-run ritual.
- [harness-hermes.md](docs/agents/harness-hermes.md) — read this when you touch `hermes-*.ts` (but `hermes-pets.ts` is in desktop.md), the `hermes/*` routes or anything ClawBox writes under `~/.hermes`.
- [harness-swap.md](docs/agents/harness-swap.md) — read this when you touch the `harness/*` routes, the edition swap or the device-tools (MCP) switch.
- [ai-providers.md](docs/agents/ai-providers.md) — read this when you touch `ai-models/*`, `providers/*`, `ollama/*`, OAuth sign-ins or the ClawBox AI login state.
- [chat.md](docs/agents/chat.md) — read this when you touch `ChatApp.tsx`, `ChatPopup.tsx`, `chat-*` libraries (but `chat-hold-to-talk.ts` is in voice.md) or the `chat/*` routes.
- [voice.md](docs/agents/voice.md) — read this when you touch `tts`, `stt`, spoken replies, hold-to-talk, Kokoro or Whisper.
- [email.md](docs/agents/email.md) — read this when you touch `email/*`, `email-*.ts`, the SMTP/IMAP clients or draft approval.
- [channels.md](docs/agents/channels.md) — read this when you touch `telegram/*`, `discord/*` or which Telegram bot the box polls.
- [files.md](docs/agents/files.md) — read this when you touch `files/*`, `file-guard.ts` (what no file surface may touch), the Files app or `CodeEditor.tsx`.
- [apps-and-webapps.md](docs/agents/apps-and-webapps.md) — read this when you touch `apps/*`, `webapps/*`, `code/*`, the web-app sandbox, `/apps/<id>/` or `clawbox.json`.
- [browser.md](docs/agents/browser.md) — read this when you touch `browser/*`, `browser-*.ts` or the Agent Browser app.
- [desktop.md](docs/agents/desktop.md) — read this when you touch `page.tsx`, the shelf, windows, the mascot, notices, monitor mode, battery, screenshots or any desktop poll.
- [terminal.md](docs/agents/terminal.md) — read this when you touch the Terminal app, its sessions or `scripts/terminal-server.mjs`.
- [settings.md](docs/agents/settings.md) — read this when you touch `SettingsApp.tsx` or a panel it hosts.
- [coding-agent.md](docs/agents/coding-agent.md) — read this when you touch `coding-agent/*` routes, `src/lib/coding-*`, `project-*` or anything a coding run or team does on the box.
- [coding-agent-ui.md](docs/agents/coding-agent-ui.md) — read this when you touch the Coding Agent app's components (`CodingAgent*`, `CodingRun*`, `CodingTeam*`).
- [memory-shard.md](docs/agents/memory-shard.md) — read this when you touch the memory embedder, `clawkeep/memory/*` or the Memory Shard app.
- [prime-radiant.md](docs/agents/prime-radiant.md) — read this when you touch `src/lib/prime-radiant/`, `prime-radiant/*` or the Prime Radiant app.
- [clawkeep.md](docs/agents/clawkeep.md) — read this when you touch `clawkeep/` (backup and restore) or the ClawKeep components.
- [mcp.md](docs/agents/mcp.md) — read this when you touch `mcp/` (with `mcp/README.md`, the authoritative tool list).
- [update-and-install.md](docs/agents/update-and-install.md) — read this when you touch `update/*`, `updater.ts`, `install.sh`, a root step, `config/*.service`, the AP or `production-server.js`.
- [testing-and-ci.md](docs/agents/testing-and-ci.md) — read this when you touch a workflow, `e2e-install` or the triage and review bots.

Elsewhere in the tree: `mcp/README.md` (the MCP tool list, kept in step with the code), `src/lib/prime-radiant/README.md`, `scripts/x64-migration/README.md`, `docs/nano-hardware-tests.md`, `docs/clawbox-bench.md`, `docs/root-exec-mirror.md`, `docs/update-launcher-transition.md`, `docs/updater-legacy-handover.md`, `docs/hermes-reasoning-levels.md`, `docs/clawkeep-backup-mgmt-spec.md`, `CONTRIBUTING.md` and `.env.example`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
