# Non-instant Settings actions

The owner's rule (TASK-2148): **every Settings action that is not instant** — anything that can take more than about a second — runs as a **detached job of the box**, with the desktop's top-right corner card (turning ring, current step, then done or failed with the error), survives closing Settings, and shows its true state when Settings is opened again (here, in another tab, on another device) without a refresh.

This file lists every such action Settings can start, where it lives, what closing Settings did to it when the actions were inventoried, and whether it already runs as a job. The per-action detail (caps, what a web-server restart does, how to stop it by hand) is in [INVENTORY.md](INVENTORY.md), whose section 1 these rows come from (line numbers there refer to `a2c1718af`).

## How an action becomes a job

One shared helper, built on the background tasks of TASK-2056 (`src/lib/background-tasks.ts`):

1. **Kind.** Add the action's kind (and its group: one job per group at a time) to `src/lib/background-task-kinds.ts`, and to `SETTINGS_JOB_KINDS` — that is what gives it the corner card's turning ring.
2. **Route.** In the action's route, put `routeAsSettingsJob(request, { path, kind, group, describe, handler })` (`src/lib/settings-jobs.ts`) in front of the route's own handler. A request that asks `background: true` (or `?background=1` for a body-less request) is answered `202 { taskId }`; the job calls the same handler with the same body and ends with its answer, HTTP status kept. The same ask while it runs follows the running job (a double click starts nothing); any other ask of the group is refused `409` with the running job named. Actions with steps of their own (a restart to wait out, a read-back) build their job with `startSettingsJob` instead, as `src/lib/provider-auth-tasks.ts` does.
3. **Client.** Replace the call's `fetch(url, init)` with `settingsJobFetch(url, init)` (`src/lib/settings-job-client.ts`): it asks for the job, follows it, and hands back the Response the route would have answered in-request, so the caller's own handling reads it unchanged. Aborting stops the following, never the job.
4. **Reopen.** In the Settings section, read the group's jobs with `useSettingsJobs(group, { onEnded })` (`src/hooks/useSettingsJobs.ts`): draw a running one (`BackgroundTaskInline` for the steps, or the row's own spinner), hold the controls that would start another, and re-read the section's state in `onEnded`.

## Where things stand

| | Actions | Run as a job |
|---|---|---|
| Local AI and voice | 19 | 6 (TASK-2056) |
| Updates, harness and system | 19 | 0 |
| Provider sign-ins and AI settings (with the sign-out) | 17 | 5 (this PR) |
| Messaging channels | 21 | 8 (this PR) |
| Network, users, devices and appearance | 12 | 0 |

Rows below that say **no** are the work of the next PRs. A row whose verdict is "— n/a" or "✅ survives" with nothing in the window to lose may still be judged instant or not worth a job; that judgement is per row, made when its area is converted.

### Not converted on purpose, and why

- **The owner's own half of a sign-in** — the ClawBox AI device code, the OpenAI and xAI device codes, the Anthropic paste-a-code, the Hermes CLI and dashboard sign-ins, the WhatsApp QR. The work there is the owner's (approving on another device); what follows the approval is a job since this PR. Making the WAIT a job needs the box to poll the provider itself, with the code on the card — INVENTORY "Still to do".
- **The Discord invite wait** — a client poll of `{sync: true}` while the owner adds the bot to a server; same reason.

## Every action, by area

### Local AI and voice

| Action | Route | File | Closing Settings at `a2c1718af` | Runs as a job now |
|---|---|---|---|---|
| Gemma 4 (llama.cpp) install, enable, make primary | `POST /setup-api/llamacpp/install {scope:'local', activate?}` | `src/app/setup-api/llamacpp/install/route.ts` | ✅ survives | ✅ job (TASK-2056) |
| Turn off Local AI (Gemma stop, fallback clear) | `POST /setup-api/local-ai {action:'disable'}` | `src/app/setup-api/local-ai/route.ts` | ⚠️ loses progress | no |
| Gemma 4 GGUF removal (uninstall) | `DELETE /setup-api/llamacpp/models?engine=1` | `src/app/setup-api/llamacpp/models/route.ts` | ⚠️ loses progress | no |
| Box voice (Kokoro) install, Local AI row | `POST /setup-api/tts/install {}` | `src/app/setup-api/tts/install/route.ts` | ✅ survives | ✅ job (TASK-2056) |
| Box voice (Kokoro) install, Voice tab 'fix' button | `POST /setup-api/tts/install {}` | `src/app/setup-api/tts/install/route.ts` | ⚠️ loses progress | ✅ job (TASK-2056), re-attach added in its second slice |
| Box voice (Kokoro) removal | `DELETE /setup-api/tts/install` | `src/app/setup-api/tts/install/route.ts` | ⚠️ loses progress | no |
| Speech engine install (faster-whisper, CUDA build, base weights) | `POST /setup-api/whisper {action:'install-engine'}` | `src/app/setup-api/whisper/route.ts` | ✅ survives | ✅ job (TASK-2056) |
| Speech model size download, then switch (weights fetch, then unit restart) | `POST /setup-api/whisper {size}` | `src/app/setup-api/whisper/route.ts` | ⚠️ loses progress | ✅ job (TASK-2056) |
| Speech model size removal | `DELETE /setup-api/whisper?size=` | `src/app/setup-api/whisper/route.ts` | ⚠️ loses progress | no |
| Speech-to-text engine removal (all sizes, stamp, unit) | `DELETE /setup-api/whisper?scope=engine` | `src/app/setup-api/whisper/route.ts` | ⚠️ loses progress | no |
| Memory-search embedder (Qwen3 GGUF) download, incl. 'Download again' | `POST /setup-api/embed/install {force}` | `src/app/setup-api/embed/install/route.ts` | ⚠️ loses progress | ✅ job (TASK-2056) |
| Memory-search model removal | `DELETE /setup-api/embed/install` | `src/app/setup-api/embed/install/route.ts` | ⚠️ loses progress | no |
| Kokoro or Whisper unit enable or disable (enable --now), and turn on while stopped | `POST /setup-api/local-models {id, enabled}` | `src/app/setup-api/local-models/route.ts` | ⚠️ loses progress | no |
| Speech-to-text primary switch (on this box / ClawBox cloud) | `POST /setup-api/stt {primary}` | `src/app/setup-api/stt/route.ts` | ⚠️ loses progress | no |
| Local-only mode switch (fallback list, session overrides, gateway settle) | `POST /setup-api/local-ai/exclusive {enabled}` | `src/app/setup-api/local-ai/exclusive/route.ts` | ⚠️ loses progress | no |
| Kokoro voice warm-up (model load after start) | `POST /setup-api/tts/warm` | `src/app/setup-api/tts/warm/route.ts` | ✅ survives | no |
| Voice settings writes: engine select (incl. wiring), voice, language, auto-reply, auto-play, short answers | `POST /setup-api/tts {action:'select'\\|'voice'\\|'language'\\|'autoReply'\\|'autoPlayAll'\\|'shortSpoken'}` | `src/app/setup-api/tts/route.ts` | ⚠️ loses progress | no |
| Voice sample ('Hear it') synthesis | `POST /setup-api/tts/sample {text, engine, voice}` | `src/app/setup-api/tts/sample/route.ts` | ⚠️ loses progress | no |
| Memory status probe (openclaw memory status --deep), started by the Local AI poll | `GET /setup-api/local-models (peek)` | `src/app/setup-api/local-models/route.ts` | ✅ survives | no |

### Updates, harness and system

| Action | Route | File | Closing Settings at `a2c1718af` | Runs as a job now |
|---|---|---|---|---|
| Full ClawBox update (Update everything, Force full update, Resume, downgrade override) | `POST /setup-api/update/run {force:true[, allowHarnessDowngrade]}` | `src/app/setup-api/update/run/route.ts` | ✅ survives | no |
| Check for updates (version and tag probe; also runs on every open of the Update section) | `GET /setup-api/update/versions?force=1` | `src/app/setup-api/update/versions/route.ts` | ✅ survives | no |
| Update branch pin (Beta channel switch, branch override Save, downgrade override) | `POST /setup-api/system/update-branch {branch\\|null[, downgrade override]}` | `src/app/setup-api/system/update-branch/route.ts` | ⚠️ loses progress | no |
| Harness swap OpenClaw <-> Hermes (locked boxes; NDJSON stream around root unit harness_swap) | `POST /setup-api/harness/swap {harness}` | `src/app/setup-api/harness/swap/route.ts` | ⚠️ loses progress | no |
| Runtime harness switch (dual edition with licence: identity sync, then flip) | `POST /setup-api/harness/select {harness}` | `src/app/setup-api/harness/select/route.ts` | ⚠️ loses progress | no |
| ClawBox MCP device tools on/off | `POST /setup-api/harness/mcp {enabled}` | `src/app/setup-api/harness/mcp/route.ts` | ⚠️ loses progress | no |
| Path-guard switch (protected-path guard) | `POST /setup-api/settings/path-guard {enabled}` | `src/app/setup-api/settings/path-guard/route.ts` | ⚠️ loses progress | no |
| Computer-use switch (Hermes desktop control; dormant unless CLAWBOX_COMPUTER_USE_SETTING=1) | `POST /setup-api/settings/computer-use {enabled}` | `src/app/setup-api/settings/computer-use/route.ts` | ⚠️ loses progress | no |
| Background jobs switch (check-ins, memory review, skill learning; OpenClaw restart) | `POST /setup-api/background-jobs {id, enabled}` | `src/app/setup-api/background-jobs/route.ts` | ⚠️ loses progress | no |
| Desktop environment switch (boot target; takes effect at next boot) - NOT in the old inventory | `POST /setup-api/system/desktop {enabled}` | `src/app/setup-api/system/desktop/route.ts` | ⚠️ loses progress | no |
| Performance mode (power profile) | `POST /setup-api/system/power-profile {mode}` | `src/app/setup-api/system/power-profile/route.ts` | ⚠️ loses progress | no |
| Remote Access tunnel start, regenerate URL, and Cancel (clawbox-tunnel.service) | `POST /setup-api/portal/start (regenerate uses the same route); /setup-api/portal/stop (Cancel)` | `src/app/setup-api/portal/start/route.ts` | ✅ survives | no |
| Install cloudflared (Remote Access) | `POST /setup-api/install/run-step {step:'cloudflared_install'}` | `src/app/setup-api/install/run-step/route.ts` | ⚠️ loses progress | no |
| Plugin repair Retry ('Needs repair' badge; Channels and Providers) | `POST /setup-api/plugins/repair {pluginId}` | `src/app/setup-api/plugins/repair/route.ts` | ✅ survives | no |
| OpenClaw agent database maintenance ('Run now') | `POST /setup-api/gateway/db-maintenance {action:'run'}` | `src/app/setup-api/gateway/db-maintenance/route.ts` | ✅ survives | no |
| Factory reset (wipe and reboot) | `POST /setup-api/setup/reset {password, confirm}` | `src/app/setup-api/setup/reset/route.ts` | ⚠️ loses progress | no |
| Device rename (hostname), then reboot | `POST /setup-api/system/hostname {hostname}, then /setup-api/system/power {action:'restart'}` | `src/app/setup-api/system/hostname/route.ts` | ⚠️ loses progress | no |
| Device restart or shutdown (only Settings caller is the rename above) | `POST /setup-api/system/power {action:'restart'\\|'shutdown'}` | `src/app/setup-api/system/power/route.ts` | — n/a | no |
| Monitor layout trial (Apply, then Keep or Revert); old row 130, re-verified | `POST /setup-api/monitors {action: apply\\|keep\\|revert}` | `src/app/setup-api/monitors/route.ts` | ✅ survives | no |

### Provider sign-ins and AI settings

| Action | Route | File | Closing Settings at `a2c1718af` | Runs as a job now |
|---|---|---|---|---|
| ClawBox AI device login before the token (OpenClaw and Hermes) | `POST start, then POST poll on a client timer chain /setup-api/ai-models/clawai/start ; /setup-api/ai-models/clawai/poll` | `src/app/setup-api/ai-models/clawai/start/route.ts` | ❌ dies | no |
| ClawBox AI configure after the token lands (background) | `Fire-and-forget promise started by the poll that sees the token /setup-api/ai-models/clawai/poll (status configuring), calls the configure h` | `src/app/setup-api/ai-models/clawai/poll/route.ts` | ⚠️ loses progress | ✅ job (TASK-2148, this PR) |
| OpenAI (ChatGPT) device-code sign-in (OpenClaw) | `POST device-start; POST device-poll on a setTimeout chain; then configure with oauthHandoff /setup-api/ai-models/oauth/device-start ; /setup` | `src/app/setup-api/ai-models/oauth/device-start/route.ts` | ⚠️ loses progress | no |
| Anthropic (Claude) subscription sign-in in the Providers panel (OpenClaw): authorize, paste code, exchange, configure | `POST oauth/start (opens a tab); POST oauth/exchange on paste; then configure /setup-api/ai-models/oauth/start ; /setup-api/ai-models/oauth/e` | `src/app/setup-api/ai-models/oauth/start/route.ts` | ❌ dies | no |
| Anthropic account added in Providers, Anthropic accounts card (sign-in, paste code, connect or re-authenticate) | `POST oauth/start (new tab); POST oauth/exchange; POST anthropic/accounts {connect_oauth\\|reauth_oauth} /setup-api/ai-models/oauth/start ; /s` | `src/app/setup-api/anthropic/accounts/route.ts` | ✅ survives | no |
| Put the chat on the Anthropic accounts (Use these accounts for the chat too) | `POST action use_for_chat /setup-api/anthropic/accounts (action use_for_chat)` | `src/app/setup-api/anthropic/accounts/route.ts` | ✅ survives | no |
| Anthropic API-key account add or replace (key verified first) | `POST anthropic/accounts {add_key\\|replace_key} /setup-api/anthropic/accounts` | `src/app/setup-api/anthropic/accounts/route.ts` | ✅ survives | no |
| Gateway mirror sync after a pool change (connect, re-auth, remove, reorder, clear limit) | `Fire-and-forget after the answer /setup-api/anthropic/accounts (actions connect_oauth, reauth_oauth, remove, reorder, clear_limit)` | `src/app/setup-api/anthropic/accounts/route.ts` | ✅ survives | no |
| OpenClaw provider save: API key, ClawBox AI token, OAuth handoffs (OpenAI, Anthropic, xAI completion) | `POST configure, awaited, with detached tails /setup-api/ai-models/configure` | `src/app/setup-api/ai-models/configure/route.ts` | ⚠️ loses progress | ✅ job (TASK-2148, this PR) |
| Full memory re-index after the ClawBox AI link switches the embedder to the cloud | `No HTTP of its own; started after a sign-in answer none (tail of POST /setup-api/ai-models/configure and POST /setup-api/hermes/clawai)` | `src/app/setup-api/ai-models/configure/route.ts` | ⚠️ loses progress | no |
| xAI (Grok) sign-in via OpenClaw's CLI (run under util-linux script for a pty) | `POST xai-login {start}; {poll} every 3 s; {cancel} on Cancel or on leaving /setup-api/ai-models/xai-login` | `src/app/setup-api/ai-models/xai-login/route.ts` | ❌ dies | no |
| Hermes provider sign-in run by the Hermes CLI (external flows: PKCE or device code) | `POST oauth/start (CLI branch); GET oauth/poll every 3 s; POST oauth/submit (PKCE); DELETE oauth/cancel /setup-api/hermes/oauth/start ; /setu` | `src/app/setup-api/hermes/oauth/start/route.ts` | ❌ dies | no |
| Hermes provider sign-in run by the Hermes dashboard (providers the dashboard still runs itself) | `POST oauth/start (dashboard branch); GET oauth/poll relay; POST oauth/submit relay; DELETE oauth/cancel relay /setup-api/hermes/oauth/start ` | `src/app/setup-api/hermes/oauth/start/route.ts` | ❌ dies | no |
| Hermes ClawBox AI link: token save, apply to Hermes config, tier change | `POST /setup-api/hermes/clawai {token?, tier?} (awaited) /setup-api/hermes/clawai` | `src/app/setup-api/hermes/clawai/route.ts` | ✅ survives | ✅ job (TASK-2148, this PR) |
| Hermes provider key and model save (Settings Save) | `POST /setup-api/hermes/provider-key (if a key is pasted), then POST /setup-api/hermes/models /setup-api/hermes/provider-key ; /setup-api/her` | `src/app/setup-api/hermes/provider-key/route.ts` | ✅ survives | ✅ job (TASK-2148, this PR) |
| Provider sign-out, every row, both harnesses (not in the old inventory) | `POST /setup-api/providers/sign-out {provider}`; `POST /setup-api/ai-models/clawai/sign-out` | `src/app/setup-api/providers/sign-out/route.ts` | ⚠️ loses progress (request, then a gateway wait in the window) | ✅ job (TASK-2148, this PR) |
| Hermes: make a connected provider the default when it is picked | `POST /setup-api/providers/default (automatic on pick) /setup-api/providers/default` | `src/app/setup-api/providers/default/route.ts` | ✅ survives | no |

### Messaging channels

| Action | Route | File | Closing Settings at `a2c1718af` | Runs as a job now |
|---|---|---|---|---|
| Telegram save bot token: OpenClaw gateway restart, or Hermes gateway ensure; a Hermes token change first runs a pairing reset | `POST, awaited fetch with AbortController /setup-api/telegram/configure POST` | `src/app/setup-api/telegram/configure/route.ts` | ⚠️ loses progress | ✅ job (TASK-2148, this PR) |
| Telegram readiness wait in the configuring overlay: gateway health poll (OpenClaw) or Telegram status poll (Hermes), up to 60 s | `Client-side GET poll every 2 s /setup-api/gateway/health GET (OpenClaw); /setup-api/telegram/status GET (Hermes)` | `src/app/setup-api/gateway/health/route.ts` | ❌ dies | no |
| Telegram progress-streaming toggle (OpenClaw only): config write then gateway restart | `POST, awaited fetch /setup-api/telegram/streaming POST` | `src/app/setup-api/telegram/streaming/route.ts` | ⚠️ loses progress | ✅ job (TASK-2148, this PR) |
| Telegram pairing approve (openclaw pairing approve --notify, or Hermes pairing approve plus a hermes send notice) | `POST {code}, awaited fetch /setup-api/telegram/pairing POST` | `src/app/setup-api/telegram/pairing/route.ts` | ⚠️ loses progress | no |
| Telegram pending-request check (openclaw pairing list --json, or Hermes pairing list) | `GET ?pending=1, awaited fetch /setup-api/telegram/pairing?pending=1 GET` | `src/app/setup-api/telegram/pairing/route.ts` | ⚠️ loses progress | no |
| Channel status reads that spawn the harness CLI: OpenClaw channels status (15 s memo); Hermes gateway status and send --list | `GET on section open (no mutation) /setup-api/telegram/status GET; /setup-api/discord/status GET; /setup-api/whatsapp/status GET` | `src/app/setup-api/telegram/status/route.ts` | — n/a | no |
| Discord save: token preflight, OpenClaw plugin install, allowlist, gateway restart, live channel check | `POST {botToken}, awaited fetch with AbortController /setup-api/discord/configure POST (full save)` | `src/app/setup-api/discord/configure/route.ts` | ⚠️ loses progress | ✅ job (TASK-2148, this PR) |
| Discord invite wait: client poll every 4 s that posts sync, server ticks may restart the gateway and verify the channel | `Client poll (setInterval), POST {sync:true} per tick /setup-api/discord/configure POST {sync:true}` | `src/app/setup-api/discord/configure/route.ts` | ❌ dies | no |
| Discord member allowlist save (Hermes): .env write, then gateway restart | `POST {allowedUserIds}, awaited fetch with no abort controller /setup-api/discord/configure POST {allowedUserIds}` | `src/app/setup-api/discord/configure/route.ts` | ⚠️ loses progress | ✅ job (TASK-2148, this PR) |
| Discord member picker load (Hermes): guild member walk, cached 60 s | `GET, awaited fetch /setup-api/discord/members GET` | `src/app/setup-api/discord/members/route.ts` | — n/a | no |
| Email approvals bot: token check (Telegram getMe) and enable/disable switch | `POST {botToken?, enabled?}; DELETE forgets the bot; awaited fetch /setup-api/email/chat-approval POST; DELETE` | `src/app/setup-api/email/chat-approval/route.ts` | ✅ survives | no |
| Email approval poller: Telegram getUpdates long poll, running only while an approval prompt is outstanding | `In-process loop, long poll none; started by POST /setup-api/email/chat-approval (route.ts:196), by boot (instrumentation.ts:587), and after ` | `src/lib/email-approval.ts` | ✅ survives | no |
| Email connect: SMTP and IMAP verification, save, Hermes inbound gateway restart | `POST, awaited fetch /setup-api/email/configure POST` | `src/app/setup-api/email/configure/route.ts` | ⚠️ loses progress | ✅ job (TASK-2148, this PR) |
| Email disconnect: teardown, Hermes gateway restart if one is running, MCP reload | `DELETE, awaited fetch with no signal /setup-api/email/configure DELETE` | `src/app/setup-api/email/configure/route.ts` | ✅ survives | ✅ job (TASK-2148, this PR) |
| Email approve (SMTP send of a queued draft) or reject (delete) | `POST {action, id}, awaited fetch with no abort /setup-api/email/pending POST` | `src/app/setup-api/email/pending/route.ts` | ⚠️ loses progress | no |
| Email test send to the configured account | `POST, awaited fetch with no signal /setup-api/email/test POST` | `src/app/setup-api/email/test/route.ts` | ⚠️ loses progress | no |
| WhatsApp save: enable, allowlist, mode. OpenClaw enable installs the plugin, writes config, restarts the gateway and checks the channel. Hermes writes .env and restarts. | `POST, awaited fetch with no abort /setup-api/whatsapp/configure POST` | `src/app/setup-api/whatsapp/configure/route.ts` | ⚠️ loses progress | ✅ job (TASK-2148, this PR) |
| WhatsApp QR pairing, Hermes arm: npm install of the bridge, then node bridge.js --pair-only --pair-json; respawn and reaper | `POST start, 2 s GET heartbeat, DELETE cancel /setup-api/whatsapp/pair POST (start); GET (heartbeat); DELETE (cancel)` | `src/app/setup-api/whatsapp/pair/route.ts` | ❌ dies | no |
| Gateway restart after a WhatsApp link (Hermes): fire-and-forget from the bridge connected event | `Fire-and-forget promise, no route none; triggered by the bridge's connected event within the pairing started at POST /setup-api/whatsapp/pai` | `src/lib/whatsapp-pairing.ts` | ⚠️ loses progress | no |
| WhatsApp QR pairing, OpenClaw arm: gateway web.login RPCs, plugin repair (install, enable, gateway restart), 5 s keepalive | `POST start, 2 s GET heartbeat, DELETE cancel /setup-api/whatsapp/pair POST; GET; DELETE` | `src/app/setup-api/whatsapp/pair/route.ts` | ❌ dies | no |
| WhatsApp unlink: OpenClaw disables the channel, runs logout, restarts the gateway; Hermes removes session files and the env flag | `POST, awaited fetch with no signal /setup-api/whatsapp/unpair POST` | `src/app/setup-api/whatsapp/unpair/route.ts` | ⚠️ loses progress | ✅ job (TASK-2148, this PR) |

### Network, users, devices and appearance

| Action | Route | File | Closing Settings at `a2c1718af` | Runs as a job now |
|---|---|---|---|---|
| Wi-Fi scan (live iw scan) | `POST /setup-api/wifi/scan?live=1` | `src/app/setup-api/wifi/scan/route.ts` | ⚠️ loses progress | no |
| Wi-Fi join (background connect; AP torn down, restored on failure) | `POST /setup-api/wifi/connect {ssid,password}` | `src/app/setup-api/wifi/connect/route.ts` | ⚠️ loses progress | no |
| Saved Wi-Fi network: change password or forget | `POST /setup-api/wifi/update {action:'update'\\|'forget', ssid, password?}` | `src/app/setup-api/wifi/update/route.ts` | ⚠️ loses progress | no |
| Hotspot toggle, name and password (AP restart or stop) | `POST /setup-api/system/hotspot {enabled?, ssid, password?}` | `src/app/setup-api/system/hotspot/route.ts` | ⚠️ loses progress | no |
| Reboot wait, then redirect to the new .local name | `GET (no-cors probe) none (probe of the new origin's /setup-api/setup/status)` | — | ❌ dies | no |
| Create user account (Linux account via user_add root step) | `POST /setup-api/users {username,password}` | `src/app/setup-api/users/route.ts` | ⚠️ loses progress | no |
| Remove user account and home (user_remove root step) | `DELETE /setup-api/users {username}` | `src/app/setup-api/users/route.ts` | ⚠️ loses progress | no |
| Monitor brightness writes over DDC/CI (ddcutil) | `POST (GET for reads) /setup-api/monitors/brightness {monitor, value}` | `src/app/setup-api/monitors/brightness/route.ts` | ✅ survives | no |
| Pet install and select, or pet off (Hermes CLI, or direct Petdex download on OpenClaw) | `POST /setup-api/pets/select {slug} or {slug:null}` | `src/app/setup-api/pets/select/route.ts` | ⚠️ loses progress | no |
| Pet thumbnail fetch (remote sheet, cropped and cached) | `GET /setup-api/pets/thumb?slug=` | `src/app/setup-api/pets/thumb/route.ts` | ✅ survives | no |
| Wallpaper upload (client-only) | `none none` | `src/app/page.tsx` | — n/a | no |
| System password change (chpasswd root step) *(coverage pass)* | `POST /setup-api/system/credentials` | `src/app/setup-api/system/credentials/route.ts` | ⚠️ loses progress | no |

## Started outside Settings

INVENTORY section 2 lists the long processes started from other windows (Browser, App Store, ClawKeep backups and restore, Memory Shard, Prime Radiant, Coding Agent, chat). The same rule applies to the ones a person waits on — a manual backup, a restore, Chromium's install, an app install — and the same helper fits them; they are out of this file's scope (Settings) and listed there.
