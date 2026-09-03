# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ClawBox is **OpenClaw OS** — the operating system for [OpenClaw Hardware](https://clawbox.com/), a private AI assistant running on NVIDIA Jetson (Tegra/ARM). It manages the full device lifecycle: broadcasts a WiFi access point with captive portal for first-boot setup from any phone/laptop, transitions to the home network, then serves a Chrome OS-style desktop environment with built-in apps. The OpenClaw AI agent controls the entire device through MCP (Model Context Protocol) tools — making ClawBox an OS the AI can operate, not just a UI the user clicks through.

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
- **System**: `system/info`, `system/stats`, `system/power`, `system/credentials`, `system/hotspot`, `system/desktop`, `system/power-profile` — system info, power control, password, hotspot config, desktop/headless toggle, Jetson power profile + memory guards
- **AI Models**: `ai-models/configure`, `ai-models/status`, `ai-models/oauth/*` — API key config with OAuth flows (device auth + authorization code). `providers/status` lists every provider (cloud and on-device) with its connection state, whether it is the default, and `enabled`; `providers/enabled` (owner-only) is the per-provider switch — a switched-off provider keeps its credential but is never offered to the chat or written as a fallback, and the current default can never be switched off. Connecting a provider through `configure` switches it back on.
- **Voice**: `tts` — speech output: which engine speaks first (ClawBox cloud or Kokoro on the box; the gateway falls through to the other), the voice each engine speaks with (`{action:"voice"}` — the local one is the file `clawbox-tts.sh` reads, the cloud one is OpenClaw's own `providers.<cloud>.voice`) and the sample language (the desktop's UI language until the owner picks one; only `{action:"language"}` persists a pick). Every refusal carries a stable `code` beside its English `error`, and the status carries the privacy notice as a fact (`disclosure: {kind, providers}`) beside the worded `warning`, so the Voice tab speaks the owner's language. `tts/sample` speaks typed text with ONE engine and voice and answers the WAV, for the Voice tab's player — deliberately not the fall-through chain, because an audition of the cloud voice that quietly played Kokoro would be the wrong answer; when `clawbox-tts.sh` refuses, its stated reason reaches the owner (the memory guard as `local_memory` with the numbers), never its install hint or a path. `tts/speak` (`{text}`) speaks a chat REPLY through the chain — the engine the Voice tab put first, then the other (`src/lib/voice-speak.ts`, shared with `sample`) — with the Markdown lifted off (`src/lib/speech-text.ts`) and capped, naming the engine that spoke in `X-ClawBox-Voice-Engine`; it is what the desktop chat plays after a voice message, and is refused while the spoken-replies switch is off. That switch (`{action:"autoReply", enabled}`, owner-only, `autoReply` in the status, `voice_auto_reply` in the config store, on by default — `src/lib/voice-reply.ts`) writes OpenClaw's `tts.auto` as `inbound`/`off` so a channel voice note is answered with a voice note and a typed message never is; the boot repair `ensureVoiceAutoReplyMode` seeds the mode once on a box that predates the switch, never over a value that is there. Selecting the box's own voice (`{action:"select", choice:"local"}`) REPAIRS the wiring when Kokoro is installed but openclaw.json has no `tts-local-cli` entry (`src/lib/voice-local-wiring.ts` writes the same provider JSON install.sh does, asking `clawbox-tts.sh --provider-timeout-ms` for the timeout), and when the pick still cannot be honoured it settles on Auto and answers 200 with `fallback: { requested, reason: "not_installed" | "not_wired" }` instead of a 409 — the panels show that in amber. `tts/install` (owner-only, streamed like the Gemma install) runs install.sh's `openclaw_tts` root step for an absent Kokoro; `openclaw_tts` is on the WEB root-step list for it and deliberately not on the UI list, which `install/run-step` serves to the MCP bearer too. `stt` — speech input: `stt_primary` orders ClawBox cloud transcription and Whisper on the box for BOTH the chat microphone (`chat/transcribe`, which now falls through and reports `engine`) and channel voice notes (`tools.media.models[]`, OpenClaw 2's shared media-model list — audio rows tagged `capabilities: ["audio"]` — tried in order). Microsoft's bundled Edge TTS is switched off at boot on any box with its own voice (`ensureMicrosoftTtsExcluded`), so the speech chain is exactly cloud → Kokoro.
- **Ollama**: `ollama/status`, `ollama/pull`, `ollama/search`, `ollama/delete` — local model management. `search` offers only sizes under the ollama.service memory cap (`OLLAMA_MAX_MODEL_PARAM_B` in `resource-limits.ts`, answered as `maxParamBillions`); `pull` follows the client's abort so a cancelled download stops. The runtime's idle standby (`systemctl stop`, never `disable`, ten minutes after the last proxied use) is reported by `local-models` as `on-demand` — "starts when needed" — not as off; `POST local-models {id:"ollama", enabled:true}` wakes it.
- **Apps**: `apps/store`, `apps/install`, `apps/uninstall`, `apps/icon/[appId]`, `apps/settings`, `apps/skill-info` — app store integration. ClawHub namespaces skills as `@owner/slug` and `openclaw skills install` refuses a bare slug more than one publisher uses, so `install` resolves the publisher first (`src/lib/clawhub-url.ts` — GET clawhub.ai/api/v1/skills/<slug>): one owner installs; an ambiguous slug is settled only by the store listing's own `developer`, otherwise the route answers 409 `{ code: "ambiguous", matches: [{ ownerHandle, ref, url }] }` and the caller re-posts `{ appId, owner }` or `{ appId: "@owner/slug" }`; a slug ClawHub lacks is 404 `not_found`. Every install failure is a non-2xx with `ok: false`, an honest `code` and `retryable` (the CLI's trust gate is left alone — no `--acknowledge-clawhub-risk` — so a `review_required` release tells the owner to install it from the Terminal). Locally everything stays keyed by the bare slug, and the icon is downloaded only after the install succeeded. `install`, `uninstall` and the webapp registry (`src/lib/webapp-registry.ts`, behind webapp deploys) are the only writers of `installed_apps`/`installed_meta`; `uninstall` also drops `skills.entries.<id>` from openclaw.json, the window's KV keys and `app_<id>_settings`. The enable switch (`settings` `_setEnabled`) is a direct JSON write of `skills.entries.<id>.enabled` (the gateway hot-reloads it; the CLI cost 10–17 s per click), and `skill-info?appId=` reads `enabled` back from the same file — its list comes from `openclaw skills list --json` served stale-while-revalidate (`src/lib/openclaw-skill-info.ts`; the routes rescan behind an install/uninstall), answering 404 `not_installed` for a skill that is gone and 503 `skills_unavailable` when the CLI failed with nothing cached. `store?slug=` adds `ownerHandle` (and `clawhubMatches`) from ClawHub and rewrites `clawhubUrl` to the real page, or removes it. `icon/[appId]` persists to `data/icons/` only for installed apps and remembers an upstream 404 for an hour.
- **Files**: `files/` — file list, read, write, upload, mkdir, delete
- **Browser**: `browser/` — Chromium automation via CDP (launch, navigate, click, type, screenshot)
- **Gateway**: `gateway/`, `gateway/health`, `gateway/ws-config` — gateway proxying with HTML injection
- **Telegram**: `telegram/configure`, `telegram/status` — Telegram bot config
- **Email**: `email/configure`, `email/status`, `email/test`, `email/send`, `email/messages`, `email/pending` — a mail account (any provider; Gmail app-password guide in the UI) with ONE of three modes: send only, read on demand (`email/messages` backs the `email_list`/`email_read` MCP tools over ClawBox's own IMAP client — no polling, EXAMINE + BODY.PEEK so reading never marks mail seen), or answer senders (Hermes' native adapter, allowlist-only). A separate "ask me before sending" gate turns `email/send` into a queued draft; `email/pending` approves or deletes it and refuses the MCP bearer, because the agent is the party it gates (`coding-agent/enable` refuses it for the same reason). Its `approve_batch` action is what the chat's batch card posts: one consent for a NAMED set of drafts, each carrying the content fingerprint it was shown with, so nothing queued while the owner was reading can ride along — and it answers per draft, 207 unless every one of them went. `email/chat-approval` (owner-only, off by default) connects a SECOND Telegram bot that ClawBox polls itself and never hands to the harness, so a queued draft can be approved with a button in the owner's chat: the tap arrives from Telegram, not from the agent.
- **Discord**: `discord/configure`, `discord/status`, `discord/members` — Discord bot config (token validated live against the Discord API before it is saved), gateway connection state, and the guild-member allowlist picker
- **Setup**: `setup/status`, `setup/complete`, `setup/reset` — setup flow state, factory reset
- **Update**: `update/run`, `update/status` — git-based system updates
- **Preferences**: `preferences/` — persistent user preferences (language, installed apps, etc.)
- **KV Store**: `kv/` — key-value store for UI state
- **Code**: `code/` — code project management (init, file ops, search, build/deploy)
- **Coding agent**: `coding-agent/status`, `coding-agent/enable`, `coding-agent/run`, `coding-agent/runs`, `coding-agent/stop`, `coding-agent/artifacts`, `coding-agent/projects` — a headless Claude Code run (`claude-ds -p`) the assistant delegates a whole task to; runs live in the web server and persist in `data/coding-agent-runs.json`. `enable` is owner-only (refuses the MCP bearer) because it is the consent for a delegated shell; `run` answers 409 while the switch is off. Each run gets an evidence folder (`data/coding-agent-artifacts/<runId>/`) for the screenshots and test output it saves; when a run settles, its closing message is filed there as `report.md` too (unless the run wrote its own), and the app renders that — and any `.md` a run wrote — as Markdown through the chat's own renderer; `artifacts` serves one such file (images inline, everything else as plain text — agent-written HTML must never execute in the app's origin), and the runs listing decorates each run with the folder's contents at read time. `projects` (read-only) lists what the owner can point a run at: every folder directly under the project folder that has a `.git` directory of its own, plus every code project under `data/code-projects/` except the Test-harness button's `harness-test` scratch project (`kind: "folder" | "codeProject"`), each with its last commit, whether it is on the desktop and its newest run. The default project folder (`enable { defaultDirectory }`) must be an absolute path — a bare name is a run-folder shorthand, resolved inside the default, and cannot define it.
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
- **`smtp-client.ts`** — dependency-free SMTP submission client (STARTTLS/implicit TLS, AUTH PLAIN/LOGIN) used for the email feature. Never authenticates over an unencrypted connection.
- **`email-config.ts`** — the mail account in `data/config.json`: the three mailbox modes and their migration, IMAP-host derivation (`smtp.gmail.com` → `imap.gmail.com`), validation, masking, and the only reader of the stored app password.
- **`imap-client.ts`** — dependency-free, READ-ONLY IMAP client (implicit TLS 993, STARTTLS, LOGIN). EXAMINE and BODY.PEEK only; it contains no verb that can modify a mailbox. Never authenticates over an unencrypted connection.
- **`email-pending.ts`** — outgoing drafts waiting for the owner's approval (`data/email-pending.json`, 0600, capped; a full queue refuses rather than evicting).
- **`owner-session.ts`** — "is the PERSON asking, or the agent?". Accepts a session cookie only, and is what stops the MCP bearer from opening the approval gate.
- **`email-approval.ts`** — approving a queued email from the chat the owner is already in. A SECOND owner-authenticated path, never a wider first one: nothing here sends without a `callback_query` Telegram delivered, from a user id already on the harness's owner allowlist, naming one draft and the fingerprint it had when the question was asked.
- **`email-approval-telegram.ts`** — the approvals bot's Bot API calls, and the reason it has to be a bot ClawBox owns exclusively: the harness is the single consumer of the MAIN bot's `getUpdates`, so a button on that bot delivers its callback into the process that runs the agent.
- **`email-approval-prompts.ts`** — the outstanding questions (`data/email-approval-prompts.json`, 0600, capped, 24h): handle → draft id + fingerprint, claimed read-and-remove so one handle answers once.
- **`coding-harness.ts`** — the one name for the `claude-ds` wrapper (Claude Code on the box's ClawBox AI plan) and where install.sh puts it. The wrapper (`scripts/claude-ds`) pre-answers Claude Code's trust dialog for the folder it starts in — whichever folder: a run's project, a code project, the home — because on this appliance every one of them is the owner's own and the dialog's only other answer is "exit" (only `$PWD` is seeded, nothing else in the config is touched). It reads the owner's effort from the config store so a terminal it opens thinks as hard as a delegated run: the fixed levels are pinned through `CLAUDE_CODE_EFFORT_LEVEL`, while `ultracode` (Claude Code's xhigh-plus-Workflow-orchestration mode, the default) is requested with `--effort ultracode` and the pin left unset, because a pinned level blocks the mode.
- **`coding-agent.ts`** — the coding agent runner: spawns `claude-ds -p` with an explicit environment, `acceptEdits`, a Bash allow/deny-list and file deny rules, parses the `stream-json` output into a persisted run record (a write into the run's own evidence folder is never counted among its changed files — it is listed with the artifacts, and a review pass that changed nothing must say so), enforces the owner's switch, readiness, one-run-at-a-time and the working-folder rules, settles runs lost to a restart. Wires the clawbox MCP server into each run (`--strict-mcp-config`, browser-only profile, no secret in argv) so a run can drive the device's Chromium to verify its work. Sub-agents: the Agent tool with three flash-model helpers (explorer / tester / reviewer, `SUBAGENT_DEFINITIONS`) on every run, plus a `workflow-subagent` definition that shadows Claude Code's built-in default workflow agent so an untyped `agent()` runs on flash and read-only rather than as a tier-model writer, and under ultracode also the `Workflow` tool — listed in `--tools` AND pre-approved in `--allowedTools`, because listed alone a headless run is refused ("Review dynamic workflow before running") — with `ULTRACODE_BRIEF` saying what to fan out. The stream parser keeps a helper "active" until its `task_notification` (on the installed CLI, 2.1.259, the tool_result is only a launch receipt), counts a workflow as one helper of type `workflow` billed live from its `task_progress` totals, takes a refused launch back out of the counts, bills each API message once (the CLI streams one assistant event per content block, each with the whole usage), ignores a helper's own turns for commands and progress, and adds up the per-segment `num_turns`/denials of the second result a background helper's return produces.
- **`coding-agent-status.ts`** — the run status machine, the ONE list the server, the client and the MCP server derive from (`RUN_STATUSES`, `isLive`, `isHeld`, `isSettled`); a status missing from the persisted allow-list once made a restart silently delete paused runs and drafts.
- **`coding-agent-route.ts`** — the shared run-lifecycle route factory behind `stop`/`pause`/`resume`/`start`/`draft`: session → run id (`runId` or `id`) → 404 → the owner gate (an owner-sourced run answers 403 `owner_only` to the MCP bearer in ANY state) → the action → `CodingAgentError` mapped through `httpStatusForCodingError`.
- **`coding-agent-artifacts.ts`** — the run evidence store: per-run folder under `data/coding-agent-artifacts/`, listing/serving-path validation (traversal- and symlink-proof), removal when a run record is dropped.
- **`vision-describe.ts`** — text eyes for image-blind run models: describes a screenshot through the box's resolved vision model, answering `{ text, error }` instead of throwing; retries once on a transient proxy failure, never after a timeout. `POST /setup-api/vision/describe { path, prompt? }` is its route: a protected path answers 404 like a missing one, and every caller is fenced to a server-chosen root (403 outside): the MCP bearer to the active run's working and evidence folders, a session cookie to the tree the Files app browses; the file is read through one open handle, never stat-then-read.
- **`provider-enablement.ts`** — the per-provider switch (`ai_disabled_providers` in the config store): read by `provider-status.ts`, the chat model options, `providers/default` and the fallback writer; refuses to switch off the current default.
- **`stt-preference.ts`** / **`stt-local.ts`** — speech-input ordering (`stt_primary`, the `tools.media.models[]` shapes the boot script recognises as ours) and the on-box Whisper client (temp file, `stt-client.py`, never throws).
- **`coding-agent-notify.ts`** — the finish notice: a top-right card with an Open button on every open desktop (through the owner-notice ring) plus a template-only Telegram message to approved senders. Never the task or the summary.
- **`webapp-sandbox.ts`** / **`webapp-kv-bridge.ts`** — the webapp iframe contract. A webapp is HTML the agent wrote, served from the ClawBox origin; framed with `allow-same-origin` it ran with the OWNER's session and could reach every owner-only route and script the desktop. `WEBAPP_IFRAME_SANDBOX` (never `allow-same-origin`) is the one sandbox both the desktop window in `page.tsx` and the standalone `/app/[id]` page use. What the opaque origin loses is persistence, and the bridge gives it back without the origin: the guest snippet (`WEBAPP_KV_CLIENT_SNIPPET`, `window.clawboxKv = { get, set, delete, list }`) posts `{ clawboxKv: { id, op, key, value } }` to `window.parent`; the host (`attachWebappKvBridge()`, mounted once per page) attributes it to an `iframe[data-webapp-id]` by `event.source` identity, forces the `<appId>:` key prefix (any other prefix is refused), performs the `/setup-api/kv` call itself and answers `{ clawboxKvResult }` to that frame only.
- **`pending-actions.ts`** — the owner-notice ring: KV key `ui:pending-actions`, a JSON array of `{ id, ts, ...action }` newest last that every open desktop polls and NO reader deletes or rewrites (the single slot it replaced, `ui:pending-action`, was consumed by the first desktop to poll it, so every other screen missed the notice). `pushPendingAction(action, id?)` is the one in-process writer — the coding finish card, `notifyOwner()`, the web-app icon nudge — and prunes entries older than 60 s and beyond 20; the MCP tools and `clawbox notify` post the legacy key to `/setup-api/kv`, which folds the value into the ring.
- **`hermes-env.ts`** — writes `~/.hermes/.env` with Hermes' own `save_env_value` semantics. Needed because `hermes config set` routes no `EMAIL_*` key to `.env` and would put a mailbox password in `config.yaml` instead.
- **`hermes-email.ts`** — Hermes' native inbound email adapter (opt-in, allowlist-only).
- The desktop's CSP (`next.config.ts`) allows `frame-src 'self' blob: http: https:`: an app the coding agent serves on its own port is reached on the box's own host at that port, at whatever address the owner typed, and `'self'` alone showed "This content is blocked" over a running app. The webapp iframe sandbox (`webapp-sandbox.ts`) is what protects the desktop, not that list; the `clawbox_context` storage guide tells the agent to register such an app as a webapp that redirects to `location.hostname:<port>`, never localhost.
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
- **`ChromeLauncher.tsx`** — app discovery context menu (its ids for installed apps carry the `installed-` prefix; "Add to desktop" un-hides such an app by its raw id and never writes it into `desktop_apps`, which holds built-in ids only)
- **`ChromeWindow.tsx`** — the draggable, resizable desktop window with title bar controls
- **`SystemTray.tsx`** — WiFi, battery, Telegram status indicators
- **`Mascot.tsx`** — animated crab mascot with personality states
- Phone layout — no separate mobile UI: at phone widths `page.tsx` (`isMobile`) uses `ChromeShelf`'s mobile branch plus `ChromeLauncher`, and windows go fullscreen with the page's own header

#### Built-in Apps
- **`ChatApp.tsx`** / **`ChatPopup.tsx`** — AI chat via OpenClaw gateway WebSocket
- **`TerminalApp.tsx`** — xterm.js terminal over WebSocket PTY
- **`BrowserApp.tsx`** — Chromium automation UI (CDP port 18800)
- **`FilesApp.tsx`** — file browser with upload, rename, delete, mkdir
- **`VNCApp.tsx`** — NoVNC remote desktop viewer
- **`VSCodeApp.tsx`** — VS Code server integration
- **`AppStore.tsx`** — discover and install apps from clawbox.com
- **`SettingsApp.tsx`** — Providers, Local AI, Channels (Telegram, Discord, Email), Voice, Network, Remote Control, Appearance, System, System Update, About (Coding Agent settings live in the Coding Agent app itself). System Update is the `update` section: it embeds `SystemUpdateApp` (`embedded` prop — the same component the `system_update` desktop window and `/app/system_update` render on their own), and About's update tile switches to it; the beta toggle, the branch pin and the update overlay that Settings used to carry itself live only there now
- **`OllamaModelPanel.tsx`** — local model pull, search, delete
- The Coding Agent's desktop icon is the Material `smart_toy` glyph — the same glyph the finish card's Open button uses.
- **`NewAppWizardCard.tsx`** — the "A new app for your desktop" card (the chat composer's + button and the Coding Agent home) has two modes: a NEW app (name, what, starter → `buildNewAppPrompt`) and an EXISTING project (the rows of GET /setup-api/coding-agent/projects; the chosen one's last run is shown, and "what should the next run do?" becomes `buildResumeProjectPrompt` — a message that tells the assistant to run in that folder, read the last run and the commits first, rebuild a code project afterwards, and report what is left). The example copy is a small-business app (an invoice generator), in every locale.
- **`CodingAgentApp.tsx`** — the Coding Agent desktop app: harness readiness, the Test-harness button, the owner's projects (git-initialised folders and code projects), recent runs (this icon used to open an interactive `claude-ds` terminal) with summaries, and a "New app" wizard that composes one message and hands it to the mascot chat (`CHAT_MESSAGE_EVENT`) — the assistant carries on from there. Its Settings button opens the settings page embedded in the app itself; the home page leads with a Create New Project wizard (handed to the chat), and each project expands into its own page with a git block (branch, commits, origin — GET /setup-api/coding-agent/git?projectId=) plus that project's runs; runs filed under no listed project are drawn on home under "Runs outside your projects" (they used to be computed and never rendered). A run has its OWN PAGE (`view.face === "run"`, `data-testid="coding-agent-run-page"`) instead of a row that unfolds: status, task, project chip, controls (pause/resume/start, stop, terminal, Live view, backup, report), a figures grid (steps, files, duration, tokens, helpers by type, commit, denials, models), helpers at work, the plan, the error, the summary rendered as Markdown, the files changed, the evidence folder, the denied actions and an activity log. Opened from a row's Details button, a review chip, or from outside through `dispatchOpenCodingRun(runId)` / `handoffCodingRun` + `OPEN_CODING_RUN_EVENT` in `ui-events.ts` (the desktop's finish card and the chat's run card use it).
- **`CodingAgentSettingsPanel.tsx`** — the Coding Agent app's embedded Settings page: the owner's switch for delegated Claude Code runs, the default project folder, effort, the per-run ceilings, the automatic review pass switch (POST /setup-api/coding-agent/enable `{ reviewPass }`) and the GitHub card (device-flow login, sign-out, terminal fallback). Emits `CODING_AGENT_CHANGED_EVENT` after every saved change so an open Coding Agent window refreshes.
- **`MemoryShardApp.tsx`** — the Memory Shard desktop app (`memory-shard`, OpenClaw only): the memory index card that used to sit inside ClawKeep — index now, schedule, status. ClawKeep keeps a one-line pointer card to it; the shared card/stat/dialog helpers live in `clawkeep-ui.tsx`.
- **`ToastHost.tsx`** — the desktop's toast surface; the only listener for the `clawbox:toast` event every server-side owner notice ends in
- A window record can carry `meta` (`openApp(appId, forceNew, meta)`); the Terminal window's command travels that way (`clawbox:open-terminal` → `meta.command`), never in shared state, so a plain Terminal opened later types nothing.
- Top-right notices — the finished-run card, the update card, the ClawBox AI offer and a Telegram access request — all leave on their own after `NOTICE_AUTO_HIDE_MS` (`src/lib/use-auto-hide.ts`, `useAutoHide(keys, onExpire)`): a key keeps its clock across re-renders, a hand dismissal clears it, and none of the timeouts is recorded as a dismissal (the update card is back after a reload; a timed-out pairing request stays off the desktop for the session only and is still in Settings → Telegram).
- **`TerminalTabs.tsx`** — the Terminal window: several shells as tabs, every tab's `TerminalApp` kept mounted (its PTY survives a switch; the panel is `hidden`), the first tab carrying the window's `initialCommand` and named after it, at most `MAX_TERMINAL_TABS` (8) shells per window, the close button a sibling of the `role="tab"` element, Alt+Shift+T / Alt+Shift+W / Alt+Shift+PageUp/PageDown handed up from the terminal (`onTabAction`; the Ctrl+Shift forms are the browser's own accelerators and never reach the page), closing the last tab opening a fresh one. `TerminalApp` itself gained `active` (focus + refit when the tab comes to the front) and a right-click menu (Copy — over plain HTTP through the execCommand fallback —, Paste when the origin can read the clipboard and named as Ctrl+Shift+V when it cannot, Select all, Clear; `rightClickSelectsWord` so a right click on a word selects it). The live preview still embeds the single `TerminalApp`. Terminal strings are `terminal.*` keys in the desktop translations.
- The chat's coding run card has one button, **View** (`codingAgent.liveView`): `dispatchOpenCodingRun(runId, { maximize: true })` opens the Coding Agent app on the run's page with the window MAXIMIZED (`dispatchOpenApp(appId, { maximize })` → the window record's `maximizeNonce` → `ChromeWindow`'s `maximizeSignal`). While a run is live its page embeds a `TerminalApp` tailing the transcript (`scripts/coding-run-preview`, the command from `src/lib/coding-run-preview.ts`) where the activity log otherwise sits, with an Open-in-Terminal button; a settled run shows the log. The floating live-preview terminal and the pill's "open" link are gone. The desktop's coding finish cards hide themselves after `NOTICE_AUTO_HIDE_MS` and their Open button lands on the run's page.
- **`ChromeWindow.tsx`** — the desktop window. A docked chat (`rightInset > 0`) only narrows the desktop: windows keep their own size and place and every control, and a MAXIMIZED window keeps `DOCK_GAP` on every side (the chat's own gap on the right) with its corners, the way the chat floats; `maximizeSignal` maximizes it on request. (The fill-the-pane layout that once replaced every window's geometry while the chat was docked is gone at the owner's request.)
- ClawKeep's "What's in a backup" list sits behind a question-mark button beside the title (`BackupContentsInfo`, testids `clawkeep-contents-toggle` / `-popover`; Escape or a click elsewhere closes it), not in a card of its own.
- **`ClawKeepWizard.tsx`** / **`ClawKeepArt.tsx`** / **`ClawKeepPairChallengeCard.tsx`** — ClawKeep's first-run wizard (intro with the artwork → pair through the device-code loop → passphrase → schedule, then `POST /setup-api/clawkeep/setup { setupComplete: true }`), shown by `ClawKeepApp` while the status says `setupComplete: false` AND the box is not paired; "Not now" marks setup done without pairing. The pair-code card is shared with the dashboard.
- **`OpenClawApp.tsx`** — OpenClaw gateway Control UI wrapper

#### Hooks
- **`useOllamaModels.ts`** — Ollama model management

### MCP Server (`mcp/`)

The AI agent interface to the OS. See `mcp/README.md` for the authoritative tool
list, the safety rules and the layout — that file is kept in step with the code;
this section is only a map.

**The tool set depends on the device edition**, resolved once at startup from the
root-owned `/etc/clawbox/edition.env` (`src/lib/edition-source.ts`). A tool that
cannot work on the running edition is not registered at all, because Hermes runs
a per-server circuit breaker that would take every ClawBox tool offline once one
of them kept failing.

- **`clawbox-mcp.ts`** — server entry: resolve edition → probe capabilities →
  register → connect. Tool families live in `mcp/tools/` (`orientation`,
  `skills`, `ai`, `system`, `desktop`, `browser`, `email`, `coding`,
  `coding-agent`) and the shared
  machinery in `mcp/lib/` (`edition`, `guard`, `api`, `errors`, `schema`,
  `register`, `context`, `jobs`, `web`).
  - **Both editions**: `device_status`, `clawbox_health`, `clawbox_context`,
    `system_stats`, `system_info`, `system_power`, `disk_usage`, `disk_cleanup`,
    `update_check`, `logs_tail`, `screen_capture`, `backup_status`,
    `telegram_status`, `email_send`, `wifi_scan`, `wifi_status`, `vnc_status`,
    `preferences_get`, `preferences_set`, `ui_open_app`, `ui_list_apps`,
    `ui_notify`, `app_uninstall`, `webapp_create`, `webapp_update`,
    `code_project_init/list/build/delete`, `browser_open/navigate/screenshot/close`,
    `describe_image`,
    `coding_agent_run/status/stop` (registered only while the owner's switch is on
    and the `claude-ds` harness is ready — probed at startup like `email_list`)
  - **Hermes only**: `skill_search`, `skill_list`, `skill_info`, `skill_install`,
    `skill_uninstall`, `ai_list_models`, `ai_set_provider`, `ai_set_model`
  - **OpenClaw only**: `app_search`, `app_install`, `backup_list`, `backup_now`,
    `browser_click/type/keypress/scroll`, and the coding family — `bash`,
    `job_status`, `job_stop`, `read_file`, `write_file`, `edit_file`,
    `list_directory`, `glob`, `grep`, `notebook_edit`, `web_fetch`, `web_search`
- **`clawbox-cli.ts`** — shell-callable CLI wrapper (`clawbox webapp create/update`, `clawbox app open/list`, `clawbox notify`, `clawbox system stats/info`, `clawbox edition`, `clawbox code init/build/files/read/write/edit/search/delete`)
- **Registration** — the harness spawns this server only if its own config lists
  it. OpenClaw: `scripts/gateway-pre-start.sh` writes `mcp.servers.clawbox` into
  `~/.openclaw/openclaw.json`. Hermes: `scripts/register-mcp.sh` writes
  `mcp_servers.clawbox` into `~/.hermes/config.yaml`, and is run by
  `production-server.js` at every web-server boot and by
  `scripts/setup-hermes-edition.sh` at install time.

### Code Assistant (`src/lib/code-projects.ts`, `src/app/setup-api/code/`)

Enables the AI agent to build multi-file desktop webapps through an iterative coding workflow:

1. `code_project_init` — scaffold a project (index.html + style.css + app.js)
2. Write/edit files using `code_file_write` and `code_file_edit` (string-replacement edits)
3. Search code with `code_search`, inspect with `code_file_read`
4. `code_project_build` — inlines local CSS/JS into a single HTML file, deploys to `data/webapps/`, registers on the desktop

Projects live in `data/code-projects/<projectId>/`. Built webapps are deployed to `data/webapps/<projectId>/` and served at `/setup-api/webapps?app=<projectId>`. The desktop and the standalone `/app/[id]` page frame a webapp with the one sandbox in `src/lib/webapp-sandbox.ts` (`WEBAPP_IFRAME_SANDBOX`, never `allow-same-origin`): agent-written HTML must never run with the owner's session, which is what a same-origin frame gave it. A framed app therefore has an opaque origin and cannot fetch `/setup-api/kv` (or any `/setup-api` route) — it persists through the KV bridge instead: the guest snippet (`WEBAPP_KV_CLIENT_SNIPPET`, inlined into every `code_project_init` scaffold and quoted in the `clawbox_context` storage guide for one-file apps) defines `window.clawboxKv.get/set/delete/list`, which post `{ clawboxKv: { id, op, key, value } }` to the host; the host answers only the frame it opened, forces the `<appId>:` key namespace and does the KV call with the owner's session. A webapp written earlier against `fetch('/setup-api/kv')` has lost its persistence and must be rebuilt on the bridge. An app created or built without an icon gets one generated by ClawBox AI's image model when the box is linked (`src/lib/webapp-icon.ts`): fire-and-forget after `deployWebapp`/`buildProject` register the app, written atomically to `data/icons/<appId>.png` where the icon route already looks, never overwriting an existing icon, one picture per app and one generation at a time (a rebuild while the picture is being drawn joins it; a failure is not retried for a few minutes), dropped if the app was uninstalled meanwhile, and the open desktop is nudged with a `register_webapp` re-push so the icon appears without a reload.

A webapp always runs in a sandboxed iframe with an opaque origin (`src/lib/webapp-sandbox.ts`) — on the desktop and at `/app/installed-<id>` alike — so it can neither call the session-authenticated `/setup-api` nor reach the desktop around it. Its storage is `window.clawboxKv` (get/set/delete/list, Promises), a postMessage bridge the host page answers under the app's own `<appId>:` key namespace; the scaffold inlines the snippet into new projects and the `clawbox_context` storage guide tells the agent to use it. A webapp written before the bridge that fetches `/setup-api/kv` directly no longer persists anything (the call is cross-origin now and the cookie is not sent) — it has to be rebuilt on `window.clawboxKv`. Installed apps and their meta are written by the install/uninstall/webapp-registry routes only; the desktop no longer re-persists `installed_apps`/`installed_meta`, so an install or uninstall made by the agent or the API survives an open desktop (each remaining preference key is written on its own, only when its own state changes).

### System Integration (`scripts/`, `config/`)

- **`scripts/start-ap.sh`** / **`scripts/stop-ap.sh`** — create/tear down WiFi AP "ClawBox-Setup" on `wlP1p1s0` at `10.42.0.1/24`
- **`scripts/terminal-server.mjs`** — WebSocket PTY server on port 3006 (plain ESM JS, started with the web server's own Node — no npx, no transpiler)
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
