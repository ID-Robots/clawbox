# Background tasks: inventory of long processes

Every long process a person can start from Settings, how it runs today, and what happens to it when the Settings window closes. Phase 1 of the background-tasks epic. The goal: every one of these runs detached, survives Settings closing, and shows live progress in a desktop corner card.

## How this was made

It comes from reading the code at `origin/beta` (`9c7d0a2e9`), not from memory. The sweep covered nine slices of the code:

- the `src/app/setup-api` route areas, split by subject: local AI and voice, updates and system, providers, ClawKeep, devices and network, apps and messaging, Prime Radiant and the coding agent;
- `src/components/SettingsApp.tsx` in two halves;
- the panels SettingsApp renders.

Each route file in those areas was opened. For every handler that can run longer than a few seconds, the sweep traced:

- the Settings control that calls it;
- how the server runs the work;
- what the client does with the request when the window unmounts;
- where the progress lives.

Rows that two slices both found were merged. Where the slices disagreed, the call was re-read and a single verdict kept. Line numbers refer to that commit.

**What "closing Settings" means here.** Settings is a window inside the desktop page, so closing it unmounts `SettingsApp` and does not close the page. A `fetch` keeps running unless the component aborts it in a cleanup. A streamed response that nobody reads any more stays open. Whatever the component held in state is gone, and a reopened Settings starts from its mount effects.

| Verdict | Meaning |
|---|---|
| ✅ survives | The work keeps running, and a reopened Settings shows its state (it re-reads a status the server keeps). |
| ⚠️ loses progress | The work keeps running on the server, but its progress and verdict were held by the closed window, and a reopened Settings does not re-attach. A second click is usually refused `409 busy`, with no way to see the first run. |
| ❌ dies | Closing the window stops the work or leaves it unable to finish: an aborted request, a client-driven poll that was the only driver, or a server session that is reaped once the polls stop. |
| — n/a | Closing Settings has no bearing on it: the work starts from another app, or it ends in a reboot that takes the page with it. |

## Summary

| Area | Long processes from Settings | ✅ survives | ⚠️ loses progress | ❌ dies |
|---|---|---|---|---|
| Local AI and voice | 15 | 1 | 14 | 0 |
| Updates, harness and system | 13 | 5 | 7 | 0 |
| Provider sign-ins and AI settings | 9 | 2 | 2 | 5 |
| App and skill installs | 1 | 0 | 1 | 0 |
| Messaging channels | 15 | 2 | 11 | 2 |
| Network, users and devices | 9 | 1 | 8 | 0 |
| **All** | **62** | **11** | **43** | **7** |

Plus 55 long processes that start outside Settings, in their own apps (section 2), and every other route the sweep opened and judged instant (appendix).

## 1. Long processes started from Settings

### Local AI and voice

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Gemma 4 (llama.cpp) runtime install, enable, make primary | `POST /setup-api/llamacpp/install {scope:"local", activate?:true}` | LocalAiPanel.tsx:525 (install), :528 (make primary, activate:true), :531 (enable) -> runAction. Hermes… | Root step llamacpp_install started no-block and polled through systemctl and journalctl (route :134-190; | ⚠️ loses progress — With the page alive the fetch is not aborted, so the unit, the child and the in-request configure keep going. | Last journal or log line as a text line (route :162-166, :445-450; |
| Whisper speech engine install (faster-whisper, CTranslate2 CUDA build, base weights) | `POST /setup-api/whisper {action:"install-engine"}` | LocalAiPanel.tsx:580 (stt row Install) -> runAction :381-442; panel mounted at SettingsApp.tsx:4209-4210 | Root step via followRootStep("voice_whisper_install") (whisper/route.ts:290), started through the sudo launcher (root-step-runner.ts:134-154); | ⚠️ loses progress — Unit and follow loop keep running after Settings closes, but the row spinner and progress are component state (LocalAiPanel.tsx:226-228) and are not re-attached on reopen; | Last journal line every 3 s (root-step-follow.ts:208-215) shown as one text line under the row (LocalAiPanel.tsx:751-754); |
| Box's own voice (Kokoro) install | `POST /setup-api/tts/install` | LocalAiPanel.tsx:562 (tts row Install) -> runAction; VoiceOutputPanel.tsx:806-817 'fix' button -> installVoiceNotes… | Root step via followRootStep("voice_kokoro_install") (tts/install/route.ts:74-78); | ⚠️ loses progress — Unit and follow loop continue. Progress is component state (LocalAiPanel.tsx:226-228; VoiceOutputPanel.tsx:176-178) and is not re-attached on reopen. | LocalAiPanel: last journal line. VoiceOutputPanel: seconds counter only. |
| Whisper size download, then point the unit at it and try-restart | `POST /setup-api/whisper {size}` | WhisperSizesCard.tsx:70-80 (use) -> mounted by LocalAiPanel.tsx:614 under the stt row when the engine is installed and… | Web-server child: spawn /usr/bin/python3 scripts/fetch-whisper-model.py, detached process group, SIGKILL at 60 min (whisper/route.ts:58, :402-419). | ⚠️ loses progress — Child and stream keep going after the card unmounts. | Fetcher stdout lines (whisper/route.ts:421-427) plus a bytes bar re-measured every 1.5 s from the cache dir (:186-193; |
| Memory-search embedder model download | `POST /setup-api/embed/install {force?}` | EmbeddingModelCard.tsx:61-72 (download again), mounted by LocalAiPanel.tsx:615; install row LocalAiPanel.tsx:588 | Root step embed_model via followRootStep (embed/install/route.ts:82-86); | ⚠️ loses progress — Unit and follow continue; card busy and progress state lost on close. | Last journal line (EmbeddingModelCard.tsx:100). |
| Turn off Local AI (llama.cpp disable) | `POST /setup-api/local-ai {action:"disable"}` | LocalAiPanel.tsx:534 (Gemma row Disable) -> runAction. Also called in-process by the Gemma uninstall… | In-request. stopLocalAiProvider (local-ai-runtime.ts:593-598), a CLI config set clearing fallbacks (local-ai/route.ts:80-89; default spawn cap 30 s, openclaw-config.ts:1420), settleConfigWrite and… | ⚠️ loses progress — Server completes; the response is dropped; reopen re-reads roles and inventory. | Spinner only. |
| Local-only mode switch | `POST /setup-api/local-ai/exclusive {enabled}` | LocalAiPanel.tsx:444-462 (toggleLocalOnly); switch :679-693, disabled and aria-busy while null (:683-685) | In-request. setConfigBatch (one CLI batch, '10-12 s per CLI start on a Jetson', route :95-96; gateway config.patch when running), patchAllSessionOverrides via gateway sessions.patchMany (:456, :215)… | ⚠️ loses progress — Server completes the batch and session sweep; | None; the switch is disabled. |
| Engine enable/disable and turn-on (Kokoro, Whisper units) | `POST /setup-api/local-models {id, enabled}` | LocalAiPanel.tsx:497 (Enable/Disable), :515 (turn on while stopped) -> runAction | In-request. Two inventory builds around setEngineEnabled, which runs systemctl --user enable --now with a 30 s cap (local-models.ts:812-816); the ollama unit goes through sudo (:820). | ⚠️ loses progress — Server completes; result dropped. | Spinner only. |
| Speech-to-text primary switch (On this box / ClawBox cloud) | `POST /setup-api/stt {primary}` | LocalAiPanel.tsx:571-574 (use as fallback / make primary) -> runAction :381-442 | In-request. syncChannelAudio (openclaw CLI write; route comment says 8-12 s cold start, stt/route.ts:33-35), then setSttPrimary, then restartGateway() awaited when the channel list was written… | ⚠️ loses progress — Server finishes the write and restart. The amber warning and row repaint are lost on close; reopen re-reads roles from /setup-api/stt (LocalAiPanel.tsx:247-279). | Spinner only. |
| Voice config writes (select, voice, language, autoReply, autoPlayAll, shortSpoken) | `POST /setup-api/tts {action: select\|voice\|language\|autoReply\|autoPlayAll\|shortSpoken}` | VoiceOutputPanel.tsx:404-449 (post); selects :537-545, :595-598, :613-616; switches :706, :742, :778. Auto-reconcile… | In-request. probeBox and an openclaw config set (voice-box.ts:141; route :318), or the Hermes CLI. select can also wire the local voice (voice-local-wiring.ts:83-93). Hermes select is serialised by… | ⚠️ loses progress — The write lands server-side and the answer is dropped; | 'Saving...' or 'Restoring Auto...' label only. |
| Hear it (sample audition) | `POST /setup-api/tts/sample {text, engine, voice?}` | VoiceOutputPanel.tsx:464-492 (play); button :640-649 | In-request under withSpeechLock, refused rather than queued (sample/route.ts:129-130; | ⚠️ loses progress — Synthesis completes and the lock frees, but the clip is dropped. | Seconds counter. |
| Gemma 4 uninstall (GGUF file) | `DELETE /setup-api/llamacpp/models?engine=1` | LocalAiPanel.tsx:544 (uninstall when Gemma is not primary; confirm :894-896) | In-request. uninstallEngine (route :361-416) refuses while the primary is llamacpp (:378-387). If wired, it runs the row-8 disable in-process (:388-401), then fs.unlink the GGUF (:406). | ⚠️ loses progress — Completes server-side; result lost; reopen re-reads /setup-api/local-models. | Spinner only. |
| Box's own voice (Kokoro) removal | `DELETE /setup-api/tts/install` | LocalAiPanel.tsx:554 (tts row Uninstall; confirm :882-908) -> runAction | In-request. kokoro-uninstall.ts:45-56: removeUserUnit (systemctl --user disable --now, 30 s cap, local-models.ts:913), then fs.rm of the stamp and the HF cache dir. If the pick was local… | ⚠️ loses progress — Handler is not tied to the request; it completes server-side and the result is dropped. Reopen re-reads state. | Spinner only. |
| Whisper engine removal (all sizes, stamp, unit; | `DELETE /setup-api/whisper?scope=engine` | LocalAiPanel.tsx:576 (stt row Uninstall; confirm dialog :882-908) -> runAction via del() (:166) | In-request. uninstallWhisperEngine (whisper-models.ts:233-254) runs removeUserUnit (systemctl --user disable --now, 30 s cap, local-models.ts:913) and fs.rm of the cache dirs. Then… | ⚠️ loses progress — The handler is not tied to the request (no signal use in the file), so removal and any gateway restart finish server-side. | Spinner only. |
| Memory status probe (openclaw memory status --deep) | `GET /setup-api/local-models (peek, background) and GET /setup-api/clawkeep/memory (awaited when the cache is…` | SettingsApp.tsx:4210 renders LocalAiPanel, which polls /setup-api/local-models every 5 s while the Local AI tab is… | Peek: fire-and-forget. GET /memory: in-request when there is no cache. Both single-flight via statusInFlight (clawkeep-memory.ts:1327-1336). Spawn of openclaw memory status --agent main --deep --json… | ✅ survives — Background and single-flight; not aborted when Settings closes, and the result lands in the process cache. | None. The memory row stays blank until the peek answers (clawkeep-memory.ts:1392-1399). The code cites about 8 s on a Jetson (:1338-1339). |

### Updates, harness and system

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Full ClawBox update (Update everything, Force full update, Resume) | `POST /setup-api/update/run (body {force:true}, optional allowHarnessDowngrade)` | src/components/SystemUpdateApp.tsx:382-404 (triggerUpdate), embedded by SettingsApp.tsx:6533 (section 'update'). Force… | Fire-and-forget promise in the Next server. | ✅ survives — Run state lives in globalThis in the server (updater.ts:4736-4747). | Per-step list with status, running-step detail from the root unit journal (updater.ts:6120-6122; |
| Harness swap OpenClaw <-> Hermes (locked boxes) | `POST /setup-api/harness/swap {harness}` | src/components/HarnessPicker.tsx:523-562 (SwapDialog.start), shown via HarnessPicker.tsx:957. HarnessPicker rendered by… | Streamed response tied to the request (ReadableStream start(), route.ts:175-285) wrapping followRootStep('harness_swap') (route.ts:185; | ⚠️ loses progress — The unit and the route keep running. Phase lines, the log and closing notes reach only the closed stream. On reopen, HarnessPicker reads inProgress from GET (HarnessPicker.tsx:818-827) and shows a… | Five phase markers plus done (HarnessPicker.tsx:95-105), from '[harness-swap] phase=' journal lines (harness-swap.ts:316; |
| OpenClaw agent database compaction ('Run now') | `POST /setup-api/gateway/db-maintenance {action:'run'}` | src/components/DbMaintenancePanel.tsx:151-172 (runNow), rendered at SettingsApp.tsx:6408 (system section, not on… | Detached helper: startDbMaintenance starts python3 openclaw-db-maintenance.py maintain as a transient systemd --user unit (survivesRestart true, openclaw-db-maintenance.ts:283-324), with a detached… | ✅ survives — The helper is detached from the page and from the request. | Phase from the run record (DbMaintenancePanel.tsx:63-70, 245-249), last-run result, 5 s poll (DbMaintenancePanel.tsx:89). |
| ClawBox MCP (device tools) on/off | `POST /setup-api/harness/mcp {enabled}` | src/components/ClawboxMcpPanel.tsx:57-79 (toggle), rendered at SettingsApp.tsx:6106. | In-request, awaited: the switch key is written first (route.ts:72). | ✅ survives — The writes and restarts finish server-side. | Busy flag only. |
| Runtime harness switch (dual edition with licence) | `POST /setup-api/harness/select {harness}` | src/components/HarnessPicker.tsx:866-891 (select), tiles 984-1010; rendered by SettingsApp.tsx:6102. | In-request, awaited: execFile bash clawbox-identity-sync.sh <harness> with a 60 s timeout (route.ts:66-80). | ⚠️ loses progress — The handler finishes server-side after the client leaves. | Only the tile's ellipsis (HarnessPicker.tsx:1005). |
| Install cloudflared (Remote Control tunnel) | `POST /setup-api/install/run-step {step: 'cloudflared_install'}` | src/components/RemoteControlPanel.tsx:173-197 (handleInstallTunnel), button 270-283. Rendered from SettingsApp.tsx:693… | In-request, awaited on a root unit: startRootStep(step, 600 s) blocks until the oneshot unit ends (route.ts:36, 100; | ⚠️ loses progress — The unit keeps running. The 'installing' state is component-local, so reopening Settings shows no install in progress; the status refresh after success reflects the binary. | Spinner only. Error text comes from the response (RemoteControlPanel.tsx:182-185). |
| Plugin repair Retry (Needs repair badge) | `POST /setup-api/plugins/repair {pluginId}` | src/components/PluginRepairNotice.tsx:78-117 (retry), rendered at SettingsApp.tsx:4352 (Channels section, starts 4224). | In-request, awaited: claimPluginRepair stamps the row (route.ts:142-149). | ✅ survives — The repair runs server-side. The row's repairing flag (GET, route.ts:84) makes a reopened panel show 'Repairing…' while it lasts. The press's own verdict is lost. | Label only: 'Repairing…' (PluginRepairNotice.tsx:128-144). |
| Remote Access start and tunnel URL negotiation (clawbox-tunnel.service) | `POST /setup-api/portal/start` | src/components/RemoteControlPanel.tsx:118 (handleStart), :142 (handleRegenerate); mounted via SettingsApp.tsx:693 and… | systemd unit. The route runs sudo systemctl restart then enable and returns once the Type=simple unit has started (cloudflared.ts:179,185). The URL arrives later from cloudflared stdout via… | ✅ survives — The unit runs under systemd, independent of the panel. | Spinner 'negotiating' until tunnel.url is set (RemoteControlPanel.tsx:315-321). |
| Factory reset | `POST /setup-api/setup/reset {password, confirm}` | src/components/SettingsApp.tsx:3064 (resetSetup, 3053-3151). Button label 3378. Progress overlay 3048-3051. | In-request, awaited for the whole wipe: maskAndStopGateway (route.ts:319-375; | ⚠️ loses progress — The wipe and reboot proceed server-side; the erase overlay, the reconnect poll and the redirect to setup are component state and go with the window (SettingsApp.tsx:3156-3163). | Before the 200: the button label 'Resetting…' only (SettingsApp.tsx:3378). |
| Rename device (hostname), then restart | `POST /setup-api/system/hostname {hostname}` | src/components/SettingsApp.tsx:1200 (saveHostname 1187-1240), which then posts a restart at 1229. | In-request, awaited: restartGateway({awaitReady:false}) (route.ts:115-130; | ⚠️ loses progress — The rename and the reboot are dispatched server-side and complete; | Status text only: 'restarting' (SettingsApp.tsx:1222). |
| Device restart or shutdown | `POST /setup-api/system/power {action: restart\|shutdown}` | src/components/SettingsApp.tsx:1229 (the only Settings caller, after a rename). SystemTray.tsx:169 is not Settings. | In-request enqueue: dispatchPowerAction runs sudo systemctl reboot\|poweroff with a 10 s timeout (power-approval.ts:142-154). | — n/a — The box goes down. | None. The box goes offline. |
| Performance mode (power profile) | `POST /setup-api/system/power-profile {mode}` | src/components/SystemProfilePanel.tsx:133-149 (togglePower), rendered at SettingsApp.tsx:6121. | In-request, awaited: sudo clawbox-power-mode.sh --performance\|--balanced with a 20 s execFile timeout (system-profile.ts:40, 102-114, 240-246). | ⚠️ loses progress — The request finishes server-side; the response reaches only the closed fetch. On reopen the panel re-reads both GETs (SystemProfilePanel.tsx:88-104). | Spinner only. |
| Update branch pin (Advanced options: beta switch, branch Save) | `POST /setup-api/system/update-branch {branch\|null}` | src/components/SystemUpdateApp.tsx:447-476 (saveBranch), Save 822-829, beta switch 796-802; rendered via… | In-request: before the write, checkBranchHarnessDowngrade -> readPinsAtBranch runs git fetch origin <branch> once with a 20 s timeout (route.ts:50-56, 126-129; | ⚠️ loses progress — Nothing aborts the request when Settings closes, so the fetch and the pin write finish on the server; | 'Saving…' label only. |

### Provider sign-ins and AI settings

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| ClawBox AI device pairing (code, poll, background configure) | `POST /setup-api/ai-models/clawai/start, then POST /setup-api/ai-models/clawai/poll on a client timer` | AIModelsStep.tsx:2446-2451 (ClawboxAiDeviceLogin onStart) via hooks/useClawaiDeviceLogin.ts:212-256. On Hermes… | Client setTimeout poll chain with a 20 min ceiling (useClawaiDeviceLogin.ts:29, :249). | ❌ dies — The client stops polling on unmount. The server session stays pending until its 15 min TTL (clawai-connect.ts:52) with nothing polling it. A token already received keeps configuring server-side… | Device code and link, then a 'configuring' overlay. |
| Provider save (configure), incl. legacy credential doctor and gateway restart | `POST /setup-api/ai-models/configure` | AIModelsStep.tsx:1144 (saveProviderConfig) and :1421 (saveOAuthToken), in the Settings AI section… | In-request, awaited. OpenClaw CLI config writes (default spawn cap 30 s, openclaw-config.ts:1420). Legacy OAuth migration stops the gateway for doctor --fix (route :3557-3600; the clawai poll route… | ⚠️ loses progress — The route never reads request.signal (none in configure/route.ts), so the save completes server-side. | Timer-driven phases; a timeout message after 90 s (AIModelsStep.tsx:1161-1163). |
| Memory reindex started by the ClawBox AI sign-in (Settings Providers) | `POST /setup-api/ai-models/configure (provider clawai)` | SettingsApp.tsx:4132-4180 (AIModelsStep in the 'ai' section, nav label 'Providers'); AIModelsStep.tsx:1421-1426 (POST) | Fire-and-forget promise chain after the answer (route.ts:4933-4948): applyClawaiCloudDefaults, then promoteEmbeddings (clawai-cloud-defaults.ts:459-501), then… | ⚠️ loses progress — The reindex runs server-side, but Settings never shows its progress: it lives in the run-state file only Memory Shard reads (clawkeep-memory.ts:2129-2146). | Files done/total and chunks, throttled to 1.5 s (clawkeep-memory.ts:258, 2129-2146). |
| OpenAI (ChatGPT) device-code sign-in | `POST /setup-api/ai-models/oauth/device-start, then POST /setup-api/ai-models/oauth/device-poll on a client…` | AIModelsStep.tsx:1518 (startDeviceAuth; buttons :1847, :1908), in the Settings AI section (SettingsApp.tsx:4177-4179… | Client setTimeout chain (AIModelsStep.tsx:1491, :1503, :1535). | ❌ dies — AIModelsStep aborts the poll controller on unmount (AIModelsStep.tsx:758-763), and the device-code sign-in only lands through that poll; | User code and link; 'pending' only. |
| xAI (Grok) sign-in via OpenClaw's xai plugin CLI | `POST /setup-api/ai-models/xai-login {action:start\|poll\|cancel}` | AIModelsStep.tsx:2332-2340 (XaiSignInPanel), in the Settings AI section (xai in providerIds, SettingsApp.tsx:4179) | Spawns openclaw models auth login --provider xai --method oauth under util-linux script (pty), detached process group (xai-oauth-login.ts:312-337). | ❌ dies — Unmount sends cancel and the route kills the CLI (XaiSignInPanel.tsx:212-213; | Verification URL, one-time code, a 'starting' state. |
| Anthropic accounts: Use these accounts for the chat too | `POST /setup-api/anthropic/accounts {action:use_for_chat}` | src/components/AnthropicAccountsCard.tsx:323 (act call), mounted by AiProviderList.tsx:416-420 and :358-368… | In-request under the gateway lock (anthropic-gateway.ts:632). | ✅ survives — The server finishes the request. The pool re-reads on reopen, every 30 s while mounted (AnthropicAccountsCard.tsx:127, :173-177). | Busy label only. |
| Hermes ClawBox AI link: token save, apply to Hermes config, image and provider refresh | `POST /setup-api/hermes/clawai {token?, tier?}` | src/components/HermesProviderConfig.tsx:1049 and :1068 (fetch POST), reached through AIModelsStep.tsx:2131 and… | In-request and awaited. Token and picks are written first (route.ts:168-182), then applyClawaiToHermes (src/lib/hermes-clawai.ts:192): a series of runHermesCli steps, each capped at 15 s… | ✅ survives — No client abort. The token is saved before the slow apply (route.ts:168-182 before :204), so a close does not undo it. | None. The answer is the final JSON. The panel reads state back from GET /setup-api/hermes/clawai (route.ts:59-93). |
| Hermes CLI provider sign-in (pkce for anthropic, device code for copilot-acp) | `POST /setup-api/hermes/oauth/start (CLI branch)` | src/components/SettingsApp.tsx:4177 renders AIModelsStep; AIModelsStep.tsx:2131 renders HermesProviderConfig… | Detached child: spawn(bin, args, {detached:true}) in its own process group (src/lib/hermes-cli-login.ts:402). | ❌ dies — Unmount cleanup cancels the live session: cancelCliLogin → finish('cancelled') → SIGTERM the group (HermesProviderConfig.tsx:356-362; | pkce: link and a code box, no percent. device: user code, verification link, expires_in countdown, 3 s poll. Source: GET /setup-api/hermes/oauth/poll… |
| Hermes dashboard-run OAuth (providers the dashboard still runs itself: pkce or device) | `POST /setup-api/hermes/oauth/start (dashboard branch)` | src/components/HermesProviderConfig.tsx:724 (via AIModelsStep.tsx:2131 and SettingsApp.tsx:4177) | The session lives in the Hermes dashboard process. | ❌ dies — The unmount DELETE is relayed to the dashboard as DELETE /api/providers/oauth/sessions/{id} (src/app/setup-api/hermes/oauth/cancel/route.ts:30-33), which ends the session. | Dashboard status pending, approved, error or expired, relayed by the poll route (src/app/setup-api/hermes/oauth/poll/route.ts:101-113). |

### App and skill installs

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Pet install and select (Hermes CLI, or direct Petdex download on OpenClaw), or pet off | `POST /setup-api/pets/select {slug} (or {slug:null} for off)` | src/components/PetPicker.tsx:163-180 (choose, POST :167); rendered at SettingsApp.tsx:3706 (appearance section).… | in-request. Hermes arm: `hermes pets install` with a 120 s cap (hermes-pets.ts:126,796), a direct-download fallback with a 60 s cap (:599,:811), then `hermes pets select` with the 30 s default… | ⚠️ loses progress — Install and select run to completion on the server (CLI children are execFile children, hermes-cli.ts:260). | Busy label only, no percent (PetPicker.tsx:274). |

### Messaging channels

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Discord: save token (preflight, plugin install, allowlist, restart, live check) | `POST /setup-api/discord/configure (full save with botToken)` | SettingsApp.tsx:2842-2919 (saveDiscord, fetch 2854) | in-request (awaited). Discord API calls take request.signal (route.ts:414, 442, 475), but after the first durable write (set at 482) no signal is passed (comments 497-507, 207-216). OpenClaw… | ⚠️ loses progress — Closing before route line 482 aborts the preflight and saves nothing. | Spinner (dcSaving). Verdict text comes from warning codes (SettingsApp.tsx:2824-2840, 2850-2851). |
| Discord: invite wait (client poll that sync-saves every 4 s) | `POST /setup-api/discord/configure with body {sync:true}, every 4 s` | SettingsApp.tsx:2784-2821 (effect; interval 2813; DISCORD_INVITE_POLL_MS=4000 at :401) | in-request per tick (syncGuilds, route.ts:251-316). | ❌ dies — The client poll stops on unmount and is not restored on reopen; | None until the success message on needsInvite false (SettingsApp.tsx:2801-2804). |
| Discord: save member allowlist (Hermes only) | `POST /setup-api/discord/configure with body {allowedUserIds}` | SettingsApp.tsx:2932-2962 (saveDiscordMembers, fetch 2936) | in-request (awaited): setHermesDiscordAllowlist, then applyRestart, which calls ensureHermesGateway (route.ts:360-402, 395). | ⚠️ loses progress — Restart and write finish server-side; the result is lost on close. | Spinner only. |
| Email: approvals-bot switch and token (starts the approval poller) | `POST /setup-api/email/chat-approval (botToken and/or enabled); DELETE clears it` | SettingsApp.tsx:2087-2107 (submitChatApproval, fetch 2091) | in-request for the token check (fetchApprovalBotInfo, route.ts:170). | ✅ survives — The poller is not owned by the panel. Reopen re-reads the switch from GET /setup-api/email/chat-approval (SettingsApp.tsx:2019). | None. |
| Email: connect (SMTP and IMAP verify, save, Hermes inbound restart) and disconnect | `POST /setup-api/email/configure; DELETE /setup-api/email/configure` | SettingsApp.tsx:2262-2315 (saveEmail, fetch 2277); disconnectEmail 2338-2360 (fetch 2342) | in-request (awaited). SMTP and IMAP verification take request.signal (route.ts:70-71, 93-95; smtp-client.ts:79-80, 15 s connect and 20 s command). Save at :116; MCP refresh awaited at :143. Hermes… | ⚠️ loses progress — Verify, save and restart run on server; the result is lost on close. Reopen re-reads /email/status. | Spinner via emailSaving (SettingsApp.tsx:1918, 2274-2275). |
| Email: approve or reject a queued draft | `POST /setup-api/email/pending {action: approve\|reject, id}` | SettingsApp.tsx:2134-2257 (decidePending, fetch 2139); busy row 4893 | in-request (awaited). Approve claims the draft (route.ts:144), then sendMail with request.signal (:152-161), so a dropped connection can abort the send. Batch approve is chat-only… | ⚠️ loses progress — Settings unmount does not abort the request. | Spinner on the row only. |
| Email: send a test message | `POST /setup-api/email/test` | SettingsApp.tsx:2317-2336 (sendTestEmail, fetch 2321); button 4806-4810 | in-request (awaited) SMTP send. sendMail gets no signal (route.ts:60-73). Rate limit 10 per hour, held in memory (route.ts:35, 47). | ⚠️ loses progress — Send completes server-side; the result message is lost on close. | Spinner only. |
| Telegram: save bot token (restarts the gateway) | `POST /setup-api/telegram/configure` | src/components/SettingsApp.tsx:1787-1892 (saveTelegram, fetch at 1815); Save button 4730; TelegramConfiguringOverlay… | in-request (awaited). OpenClaw: restartGateway runs a systemd job via runUnitJob (60 s client, 30 s settle, then 30 s port-readiness wait) (openclaw-config.ts:4382-4420, 4307-4309, 4245-4252… | ⚠️ loses progress — Nothing aborts the POST on unmount, so the server finishes the token write, restart and verdict. | Five labels on fixed timers, not real progress (TelegramConfiguringOverlay.tsx:48-54, 215-225), then a readiness poll. |
| Telegram: approve a pairing code | `POST /setup-api/telegram/pairing {code}` | SettingsApp.tsx:1754-1785 (approvePairingCode); buttons 4551, 4603 | in-request harness CLI. OpenClaw: openclaw pairing approve telegram CODE --notify (openclaw-config.ts:3833-3839; 30 s default). Hermes: approveHermesPairing(code, request.signal) then… | ⚠️ loses progress — OpenClaw CLI has no signal and runs on. Hermes CLI is aborted only when the HTTP connection drops (route.ts:208), not on panel unmount. The verdict is lost on close. | Spinner only. |
| Telegram: progress-streaming toggle (OpenClaw only) | `POST /setup-api/telegram/streaming` | SettingsApp.tsx:1704-1733 (toggleTelegramStreaming); switch 4476-4486 (onClick 4480) | in-request (awaited): writes the config (setTelegramProgressStreaming, route.ts:81) then restartGateway (route.ts:85; | ⚠️ loses progress — Restart runs on server-side. Reopen re-reads the enabled flag (SettingsApp.tsx:1686-1689), but the in-flight restart is not shown. | Spinner (aria-busy) and a warning string on 200/502 (route.ts:99-108). |
| WhatsApp: save (enable, allowlist, mode) | `POST /setup-api/whatsapp/configure` | SettingsApp.tsx:2426-2469 (saveWhatsapp, fetch 2431); enable toggle 5703 | in-request (awaited). OpenClaw enable: ensureChannelPlugin runs 'openclaw plugins install', up to 180 s (route.ts:105; openclaw-channels.ts:112, 322-364), then setOpenclawWhatsappEnabled… | ⚠️ loses progress — Process completes server-side and the result is lost. | Spinner only. |
| WhatsApp: QR pairing session (start, heartbeat, cancel) | `POST /setup-api/whatsapp/pair (start); GET (2 s heartbeat); DELETE (cancel)` | SettingsApp.tsx:2529-2564 (startWhatsappPairing; buttons 5439, 5479); heartbeat 2627-2652; DELETE when panel hides… | Hermes: POST awaits the bridge's npm install when node_modules is missing (whatsapp-pairing.ts:263-265, 636-665; | ❌ dies — The ClawBox side stops within about 60 s with no polls. | Phases idle, preparing, starting, waiting, scanned, paired, error (whatsapp-pairing.ts:92-106) with a live QR: the raw payload on Hermes, a PNG on OpenClaw. |
| WhatsApp: unlink the phone | `POST /setup-api/whatsapp/unpair` | SettingsApp.tsx:2578-2597 (unpairWhatsappPhone, fetch 2582); button 5412; confirm 5431 | in-request (awaited). OpenClaw: config write, logout CLI (60 s; openclaw-whatsapp.ts:946-948), then restartGateway({awaitReady:false}) as a systemd job (route.ts:60; openclaw-config.ts:4413-4417).… | ⚠️ loses progress — Completes server-side; the result is lost on close and reopen re-reads status. | Spinner only. |
| Email disconnect (teardown) | `DELETE /setup-api/email/configure` | src/components/SettingsApp.tsx:2338-2367 disconnectEmail (fetch 2342); JSX 4821 | In-request teardown: clearEmailSettings, retireAllChatPrompts, clear queue and outcomes, then on Hermes clearHermesEmail and stopHermesEmailPolling (gateway restart if running), then a tool-list… | ✅ survives — The route is written not to abandon teardown on disconnect (route 242-243). | Busy flag and an emailMsg line. |
| Telegram: Check for pending pairing requests | `GET /setup-api/telegram/pairing?pending=1` | SettingsApp.tsx:1735-1752 (loadPending); buttons 4567, 4580 | in-request harness CLI. OpenClaw: openclaw pairing list telegram --json (openclaw-config.ts:3781-3789; 30 s default spawn timeout at :1420, :1295). The route notes a 10-12 s cold start… | ⚠️ loses progress — CLI runs to completion server-side. The fetched list is dropped on unmount, and reopen needs a new click on Check. | Spinner only. |

### Network, users and devices

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Background jobs switch (check-ins, memory review, skill learning) | `POST /setup-api/background-jobs {id,enabled}` | src/components/BackgroundJobsPanel.tsx:110-137 (toggle, POST :114); mounted at SettingsApp.tsx:6112 | in-request, owner-only. setBackgroundJob writes and reads the harness config back (background-jobs.ts:254-292). OpenClaw: restartGateway() awaited (:328, same 60 s plus 30 s budget). Hermes: returns… | ⚠️ loses progress — The write and gateway restart run server-side. | Switch state plus pending and failed lines (BackgroundJobsPanel.tsx:177-186). |
| Monitor layout trial (Apply, then Keep or Revert) | `POST /setup-api/monitors {action: apply\|keep\|revert}` | src/components/MonitorsPanel.tsx:324-368 (post); Apply :885-887, Revert :628, Keep :632. Mounted by… | in-process in the Next server. Apply runs up to two wlr-randr calls with a 5 s cap each (monitors.ts:68,631-656), then spanDesktopWindow (8 s budget, :668,:76). The 20 s trial is an unref'd… | ✅ survives — The revert timer is server-side. On reopen GET /setup-api/monitors returns pending.deadline (monitors.ts:583) and adopt() re-arms the countdown (MonitorsPanel.tsx:213-218). | Seconds countdown (MonitorsPanel.tsx:610,626). |
| Computer-use switch (Hermes computer_use toolset; | `POST /setup-api/settings/computer-use {enabled}` | src/components/ComputerUsePanel.tsx:62-83 (toggle, POST :66); mounted at SettingsApp.tsx:6111 | in-request, owner-only. Dormant unless CLAWBOX_COMPUTER_USE_SETTING=1 (route.ts:19-21,51,56). applyComputerUseSwitch runs register-mcp.sh with a 180 s cap (computer-use-apply.ts:53-61), then… | ⚠️ loses progress — Same pattern as path-guard: the write and apply continue server-side, and reopen GET shows the stored decision (route.ts:43-48), but the 'applying' line is lost. | 'Applying' text (ComputerUsePanel.tsx:114-118). |
| Path-guard switch (gateway or Hermes config restart) | `POST /setup-api/settings/path-guard {enabled}` | src/components/PathGuardPanel.tsx:53-75 (toggle, POST :57); mounted at SettingsApp.tsx:6108 (harness section, :6095) | in-request, owner-only (route.ts:41). applyPathGuardSwitch (path-guard-switch.ts:71-112): OpenClaw restartGateway() (:76), which is sudo systemctl restart clawbox-gateway.service with a 60 s client… | ⚠️ loses progress — Config write and restart run server-side. | 'Applying' text while busy (PathGuardPanel.tsx:101-105); |
| Hotspot on/off, SSID or password save | `POST /setup-api/system/hotspot {ssid, password?, enabled?}` | src/components/SettingsApp.tsx:1262 (performHotspotToggle), 1304 (saveHotspotSSID), 1341 (saveHotspotPassword). | In-request, awaited: settings and hotspot.env are written first (route.ts:124-139). | ⚠️ loses progress — The AP action finishes server-side, but apAction and warning reach only the closed fetch. | Spinner only in the UI. The response carries apAction (restarted, deferred, stopped, failed) and a warning (route.ts:150-195). |
| Create user account (Linux account via root step) | `POST /setup-api/users {username,password}` | src/components/UsersPanel.tsx:198-228 (handleCreate, fetch :205); mounted by SettingsApp.tsx:6527 | in-request. withUsersLock (clawbox-users.ts:320), writes the user_add record (:333-344), then awaits startRootStep('user_add', 60 s) (:347; root-step-runner.ts:134-154). The registry is written only… | ⚠️ loses progress — The POST continues on the server, and reopen reloads the listing so the new user appears. | Spinner. Failures mapped to codes and a repair command (UsersPanel.tsx:39-56,66-72). |
| Wi-Fi join (background connect with AP teardown) | `POST /setup-api/wifi/connect` | src/components/SettingsApp.tsx:1363-1383 (connectWifi, fetch :1368), button :4106, in the 'wifi' section (:3711) | fire-and-forget promise in the Next process (route.ts:51-69). | ⚠️ loses progress — The connect keeps running after the window closes. | None in Settings. WifiStep (setup wizard, not Settings) polls connect-status. |
| Saved Wi-Fi network: change password or forget | `POST /setup-api/wifi/update {action:'update'\|'forget'}` | src/components/SettingsApp.tsx:981-1001 (updateSavedPassword, fetch :988); :1002-1019 (forgetSavedNetwork, fetch :1006) | in-request. nmcli connection modify (5 s plus a 180 s lock wait), then connection up (15 s plus 180 s), both via wifi-radio.ts:17-21. The route awaits both (update/route.ts:38-51). | ⚠️ loses progress — nmcli runs to completion on the server. Reopen reloads the saved list on mount (SettingsApp.tsx:980), but the busy flag and result text are component state and are lost. | Busy flag, then savedStatus text (SettingsApp.tsx:969). |
| Remove user account (Linux account and home via root step) | `DELETE /setup-api/users {username}` | src/components/UsersPanel.tsx:230-255 (handleRemove, fetch :234); confirm dialog :327-350; mounted by… | in-request. The registry is rewritten first to revoke sessions (clawbox-users.ts:387-390), then startRootStep('user_remove', 60 s) (:396). Afterwards removeDesktopState, forgetUserLanguage and an… | ⚠️ loses progress — Removal runs to completion on the server; | Row spinner, then notice (UsersPanel.tsx:251-254). |

## 2. Long processes started outside Settings

Same epic, later phases: these start from their own apps (Browser, App Store, ClawKeep, Memory Shard, Prime Radiant, Coding Agent, chat), so closing Settings does not apply; the verdict column says what closing *their* window does where the sweep established it.

### Local AI and voice

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Chat spoken reply | `POST /setup-api/tts/speak {text, formats?}` | Not from Settings: ChatPopup.tsx:5090 | In-request under withSpeechQueue, which waits rather than refuses (tts/speak/route.ts:58; | — n/a — Not started from Settings. | n/a |
| Memory Shard setup wizard provision chain | `Client chain: GET /setup-api/embed/status, then POST /setup-api/embed/install (NDJSON stream, out of slice),…` | not from Settings. Memory Shard window (page.tsx:513-516; MemoryShardApp.tsx imports the wizard at :8). | Client-driven chain. Every step is a fetch with the same AbortSignal (MemoryShardWizard.tsx:184-187, :196, :205, :283-287, :298-302, :314-318). Server parts: the install download (out of slice… | ❌ dies — Closing the window aborts the chain at its next awaited step (MemoryShardWizard.tsx:79, :326). | NDJSON status line and percent from embed/install (MemoryShardWizard.tsx:229-233). |

### Models (Ollama / llama.cpp)

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Ollama model pull, then auto-save via configure | `POST /setup-api/ollama/pull {model}` | Not from Settings in this build. OllamaModelPanel renders only when 'ollama' is in allowedProviders… | Streamed response tied to request.signal (pull/route.ts:65-70); | — n/a — No mounted UI reaches it in this build. | Ollama's own stream, drawn as a bar (OllamaModelPanel.tsx:280-300). |
| GGUF library download (any other Hugging Face GGUF) | `POST /setup-api/llamacpp/models {repo, file}` | Not from Settings: no UI in src posts to it. LocalAiPanel.tsx:33-35 says the library UI was removed; only its DELETE… | hf download child, detached process group, 2 h deadline (route :40, :433-449). | — n/a — No caller. | Byte delta every 1.5 s (route :253-263). |
| Describe a local image (vision model) | `POST /setup-api/vision/describe {path, prompt?, codingRunId?}` | Not from Settings. Route comment (:60-70) names the coding-agent and MCP path. | In-request. describeImage with a 60 s budget and one retry after 2.5 s (vision-describe.ts:29, :50, :182-201). | — n/a — Not started from Settings. | n/a |
| Local inference and embedder proxies: wake the runtime before forwarding | `ANY /setup-api/local-ai/llamacpp/v1/[...path], /setup-api/local-ai/ollama/[...path],…` | Not from Settings: OpenClaw and memory-index traffic (embed/v1/route.ts:5-9) | Each request awaits ensureLocalAiReady before forwarding (local-ai-proxy.ts:180). | — n/a — Not started from Settings. | n/a |

### Chromium, VNC and the browser

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Browser: install Chromium (apt, snap, then Playwright) | `POST /setup-api/browser/manage {action:'install-chromium'}` | not from Settings. Started from BrowserSettingsPanel.tsx:202 (rendered inside BrowserApp.tsx:414)… | in-request. dpkg recovery 60 s (manage/route.ts:366), apt-get update 30 s (:369), apt install 120 s (:370), snap 120 s (:373), apt fallback 120 s (:376), Playwright install 300 s… | — n/a — Not a Settings process. The server keeps running after a browser window closes. | Spinner only (BrowserSettingsPanel.tsx:207). |
| Agent browser launch (desktop CDP attach or headless Chromium) | `POST /setup-api/browser {action:'launch'}` | not from Settings (agent tool and coding runs). | in-request. ensureDesktopBrowserRunning waits up to 6 s for CDP after systemctl start (route.ts:339-362, :346). page.goto has a 15 s timeout (:629); the screenshot has a 15 s cap (:33). | — n/a — Not a Settings process. | None. |
| Browser: open window, enable, disable (enable and disable restart the OpenClaw gateway) | `POST /setup-api/browser/manage {action:'open-browser'\|'enable'\|'disable'}` | not from Settings (BrowserApp desktop app, CodingAgentSetupWizard). Client deadlines: enable and disable 180 s… | in-request. enable writes two config keys and awaits restartGateway (manage/route.ts:419-436). open-browser: systemctl start with a 5 s cap (:601-603), a CDP poll of up to 10 s (:608-622), and up to… | — n/a — Not a Settings process. | Spinner in BrowserApp. |

### Updates, harness and system

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Hermes plugin reload (dashboard bounce so the agent re-scans plugins) | `POST /setup-api/hermes/plugins/reload` | Not from SettingsApp. No UI caller under src/components. The intended caller is the agent (route.ts:23-33). | In-request. reloadHermesPlugins (src/lib/hermes-plugin-reload.ts:238, :252) → bounceHermesDashboardShared → hermes dashboard --stop (cap 15 s) and a respawn wait… | — n/a — No Settings caller. | JSON answer only (restarted, inFlight, ready, loaded, stale). |
| Choose assistant (edition_select, setup wizard) | `POST /setup-api/setup/edition {edition}` | not from Settings: wizard only (src/components/EditionStep.tsx:402). SettingsApp does not import EditionStep. | Streamed response tied to the request, wrapping followRootStep('edition_select') with a 2 h budget (route.ts:148-160; | — n/a — Wizard, not Settings. | Phase lines from the journal (route.ts:151-161). |
| Timezone change (not in Settings) | `POST /setup-api/system/timezone {timezone, adopt?}` | not from Settings. The only UI caller is src/components/TimezoneAdopter.tsx:50-67 (desktop load). | In-request, serialized (runTransition, route.ts:126-132): startRootStep('set_timezone') blocks (route.ts:293; | — n/a — Not a Settings process. | None in the UI. |
| Legacy tunnel enable (spawned cloudflared child) | `POST /setup-api/tunnel/enable` | not from Settings. No component calls /setup-api/tunnel/*; only e2e-install/helpers/setup-api.ts:559 and the tests call… | in-request, up to 30 s. spawn cloudflared as a detached child (lib/tunnel.ts:206-209, unref :252) and await the trycloudflare URL line (:218-233), with a 30 s timeout that kills the child (:255-261). | — n/a — Not a Settings process. | None (single JSON reply). |
| OpenClaw-only update (no UI button) | `POST /setup-api/update/openclaw` | not from Settings: no component calls it. SystemUpdateApp.tsx:374-378 says no UI button reaches it. | Fire-and-forget promise: startOpenclawUpdate (updater.ts:5429-5454) launches a 3-step list (openclaw_install 300 s, openclaw_patch, gateway_restart) through launchUpdate. | — n/a — No Settings client exists for this route. | Same state object as the full run, read through /update/status. |
| Software update requested from chat or MCP (owner confirms) | `POST /setup-api/update/request` | not from Settings: chat/MCP path (route comment update/request/route.ts:8-12). | requestPowerApproval, then on owner Confirm dispatchPowerAction('update') calls startUpdate (power-approval.ts:142-151, 212-224). | — n/a — No Settings client. | Approval prompt only, then the full run's steps. |

### Provider sign-ins and AI settings

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Cloud defaults hand-back for one capability | `POST /setup-api/ai-cloud-defaults {capability}` | No UI caller under src/components. The only mention is a comment at src/components/ClawboxAiPitchCard.tsx:23. | In-request and awaited. clearOwnerChoice, then applyClawaiCloudDefaults({trigger:'owner'}) (route.ts:85-86). The code's own comment gives timings: an embedder probe up to 8 s, and openclaw CLI writes… | — n/a — No Settings caller. The route reads no request.signal. | JSON status plus moved and warning. |
| Chat 'turn is stuck' report | `POST /setup-api/ai-models/model-fallback` | Not from Settings: model-fallback-chat.ts:187 (chat reports the stuck turn) | In-request, raced against a 20 s answer window (route :49, :92-96). | — n/a — Not started from Settings. | n/a |
| Anthropic failed-turn report: account swap plus one retry of the turn | `POST /setup-api/anthropic/failure` | Not from SettingsApp. Callers: src/lib/anthropic-chat-swap.ts and src/app/setup-api/ai-models/model-fallback/route.ts. | Fire-and-forget work promise (reportChatFailure), raced against a 4 s answer (route.ts:38, :53-73). | — n/a — Not Settings. | handled, pending, activeLabel, nextResetAt in the answer (route.ts:75-84). |
| Coding Agent ChatGPT sign-in: codex login --device-auth | `POST /setup-api/coding-agent/openai {action:login-start}` | Not from SettingsApp (SettingsApp.tsx:236-237 says coding-agent settings moved to the Coding Agent app).… | codex child spawned detached (src/lib/coding-openai.ts:389). | ⚠️ loses progress — The CLI runs to approval or the 15 min TTL (coding-openai.ts:396-403). | Link, user code and status from the login view, polled (coding-agent/openai/route.ts:89-95). |
| Hermes chat turn (streamed agent run) | `POST /setup-api/hermes/chat` | Not from SettingsApp. Called by the chat adapter (src/lib/harness/hermes-adapter.ts:65). | A plain child: spawn(HERMES_BIN) (route.ts:127), not detached. | — n/a — Chat-owned. A client disconnect aborts the child (route.ts:152-160). | Streamed tokens and tool events (route.ts:716 onward). |
| Hermes chat clarify wait (the agent blocks for a human answer) | `POST /setup-api/hermes/chat/clarify` | Not from SettingsApp. src/components/ChatPopup.tsx:5868. | The agent turn waits in-process for the answer, with timers at clarify/route.ts:170 and :208. | — n/a — Not Settings. Chat-owned. | A question card in the chat. |

### Backups (ClawKeep)

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Manual backup (Back up now) | `POST /setup-api/clawkeep/backup` | not from Settings. Started by ClawKeepApp DashboardCard onBackup (src/components/ClawKeepApp.tsx:566-610, fetch at… | in-request: the handler awaits runBackup (backup/route.ts:96), which spawns clawkeepd without detached or unref (src/lib/clawkeep.ts:2081-2125, spawn at :2094). | ⚠️ loses progress — The daemon is not aborted when the ClawKeep window unmounts, and on reopen the progress panel re-attaches from state.json via isBackupRunning (ClawKeepApp.tsx:871-877). | Step label from currentStep (ClawKeepApp.tsx:1443-1455), upload bytes done/total and MB/s (ClawKeepApp.tsx:1258-1266, 1340). |
| Device-code pairing and token save | `POST /setup-api/clawkeep/pair/start, then POST /setup-api/clawkeep/pair/poll every interval (default 5 s)…` | not from Settings. ClawKeepApp onPair (ClawKeepApp.tsx:514-535) and poll effect (:464-512); ClawKeepWizard startPairing… | Waits on the user (portal code entry) through client-driven polling; | ❌ dies — Closing the window stops polling and nothing else polls pair-state.json: no UI calls /pair/status, and the status GET does not carry the pending session. | Code and phases pending, configuring, complete or error from POST /pair/poll (ClawKeepApp.tsx:477-495). |
| Restore from snapshot | `POST /setup-api/clawkeep/restore {name, passphrase?}` | not from Settings. RestoreModal (ClawKeepApp.tsx:1967-2013), confirm then onRestore (:694-734), performRestore fetch at… | in-request. runRestore writes restoring.flag (clawkeep.ts:2043) and runs clawkeepd restore via spawnCliJson with a 4 h kill timer (clawkeep.ts:2046-2051, RESTORE_TIMEOUT_MS :1767). The route then… | ⚠️ loses progress — The request is not aborted, so the restore continues after the window closes. | Indeterminate bar with restore copy only (ClawKeepApp.tsx:1227, :1357). |
| Snapshot list for restore picker (borderline) | `GET /setup-api/clawkeep/snapshots` | not from Settings. RestoreModal load on open (ClawKeepApp.tsx:1994-2013, fetch :1998), opened from the Restore button… | in-request. Spawns clawkeep snapshots, which mints credentials and lists the account prefix, with a 60 s kill timer (clawkeep.ts:1868-1876; spawnCliJson :1774-1866). | — n/a — Read only; the modal repeats the load each time it opens. | Loading line only; no steps or percent. |
| Scheduled (auto) backup timer | `PUT /setup-api/clawkeep/schedule arms the timer; the run fires from the timer, with no HTTP start` | not from Settings. Schedule card in ClawKeepApp saves via PUT (src/components/ClawKeepApp.tsx:1036). | fire-and-forget setTimeout in the Next server process. | ✅ survives — The timer is server-side and does not depend on any window; | None on the timer. The run's state is in state.json and is seen by the window or shelf poll. |

### Memory and reindexing

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Prime Radiant vault catch-up on memory enable | `POST /setup-api/clawkeep/memory/enable {enabled:true}` | not from Settings. MemoryShardSettingsPanel.tsx:108-111; MemoryShardWizard.tsx:298-303. | fire-and-forget: void import of prime-radiant/shard-index, then reindexPrimeRadiantVault, not awaited (enable/route.ts:82-88). | ✅ survives — A server-side promise not tied to the request. | None surfaced by this route. Duration not read. |
| Memory index pass (manual Index now / Full reindex) | `POST /setup-api/clawkeep/memory/index {mode: incremental or full}. DELETE on the same route stops a pass but…` | not from Settings. MemoryShardApp startIndex (MemoryShardApp.tsx:293-324, fetch :296); MemoryShardWizard… | fire-and-forget in the Next server process. | ✅ survives — The pass is server-side, so closing the Memory Shard window does not stop it. | run.progress {filesDone, filesTotal, chunks} written every 1.5 s to memory-index-state.json (clawkeep-memory.ts:258, :2129-2146). |
| Memory provider switch (cloud or local embedder) | `POST /setup-api/clawkeep/memory/provider {source?: cloud or local, confirm?}` | not from Settings. MemoryShardEmbedderCard.tsx:82-86; MemoryShardWizard.tsx:283-288. | in-request. switchToLocalEmbeddings (memory-shard.ts:273-296) and switchToCloudEmbeddings (memory-shard.ts:435-456) call runOpenclawConfigSetBatch, a config write that restarts the gateway. Code… | ⚠️ loses progress — The server-side config write completes after the client goes away. | None. |
| Memory folder add or remove (borderline) | `POST /setup-api/clawkeep/memory/sources {path}; DELETE /setup-api/clawkeep/memory/sources {path}` | not from Settings. MemoryShardFolders.tsx:102 (POST). | in-request. mutateExtraPaths (memory-shard.ts:178-217) serialises the read-modify-write and calls openclaw config set, plus a gateway restart, only when the list changes (memory-shard.ts:160-176). | ✅ survives — A single write that completes server-side. | None. |
| Prime Radiant ingest job (folders, files or an upload batch; | `POST /setup-api/prime-radiant/ingest (folders \| files \| upload); POST…` | not from Settings: PrimeRadiantIngest.tsx:209, 235, 281-289 (PrimeRadiantApp.tsx:24 imports it) | startIngest returns 202 at once (src/lib/prime-radiant/ingest.ts:287-366); | — n/a — Not a Settings process; the job continues when the page or stream closes. | Tallies total, done, failed, skipped, pages, calls, usdEstimate (ingest.ts:309-339) and per-file SSE events; |
| Prime Radiant ingest preview (folder walk before a job) | `POST /setup-api/prime-radiant/ingest/preview {folders}` | not from Settings: PrimeRadiantIngest.tsx:188 (client AbortController) | In-request and awaited walk (route.ts:36-41). | — n/a — Request-bound; aborted when the client aborts. | None until the walk returns. |
| Prime Radiant vault maintenance passes (reindex, connect, structure, summaries, migrate-frontmatter… | `POST /setup-api/prime-radiant/maintenance {action} (background actions answer 202)` | not from Settings: no file under src/components calls this route (grep found none) | background(): void work() as an in-process promise (route.ts:106-119); | — n/a — Not a Settings process; fire-and-forget in the web server. | Action name and final result only; no percent. |
| Prime Radiant nightly pass (Run now and the 03:00 schedule) | `POST /setup-api/prime-radiant/nightly/run (202); scheduled fires from nightly-scheduler.ts` | not from Settings: PrimeRadiantSettings.tsx:390 'Run now' (Prime Radiant app) | startNightly claims store.running and runs execute() as an in-process promise, returning the run record at once (src/lib/prime-radiant/nightly.ts:763-804; | — n/a — Not a Settings process; the pass is server-side. | Running id and run records; no step counts from this route. |
| Keyword-only index auto full rebuild (no user click) | `No HTTP start. Triggered by GET /setup-api/clawkeep/memory (getMemoryStatus) and once at boot via…` | not from Settings. MemoryShardApp polls GET /setup-api/clawkeep/memory (MemoryShardApp.tsx:234). | fire-and-forget: startMemoryIndex('full','manual',{embedderChanged:true}) (clawkeep-memory.ts:1507), the same supervised pass as the manual row, OpenClaw arm only (:1480). | ✅ survives — Server-side; no window involvement. | Same run record as the manual pass. Console line at :1502-1505. |
| Prime Radiant whole-vault search index build (triggered by search, settings index-limit change, or reindex) | `GET /setup-api/prime-radiant/search (background reindex when the index is missing or stale,…` | not from Settings: PrimeRadiantSearch.tsx:76 calls search; the Prime Radiant settings are a Prime Radiant app panel | reindexPrimeRadiantVault -> enqueue on a per-vault SerialLock that coalesces queued paths (shard-index.ts:1061-1105, 1123-1125); | — n/a — Not a Settings process; the build runs in the web server, not in the request. | vaultIndexStatus (exists, identity, needsFullScan, migrationPending); |
| Memory index scheduled pass (timer) | `PUT /setup-api/clawkeep/memory/schedule arms the timer; the pass fires from the timer` | not from Settings. Saved from MemoryShardWizard saveSchedule (MemoryShardWizard.tsx:104-115) and MemoryShardApp… | fire-and-forget setTimeout in the Next process. | ✅ survives — Server timer, independent of any window. | Same run record as the manual pass. |

### App and skill installs

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| App install: ClawHub skill or ClawBox Store app (App Store window, not Settings) | `POST /setup-api/apps/install` | not from Settings: desktop App Store window (src/app/page.tsx:491-496, 4222; src/components/AppStore.tsx:510-544) | in-request (awaited). OpenClaw skills: execFile 'openclaw skills install', 60 s timeout, 3/8/15 s rate-limit backoff (route.ts:28, 280-299); deduped by inFlightInstalls (:48, :313-325). ClawBox Store… | ⚠️ loses progress — The server keeps running the install, but the App Store window forgets the result when it closes. | None beyond the 'installing' label. |
| Publish to the ClawBox Store (not Settings) | `POST /setup-api/apps/publish` | not from Settings. No client in src/components found; the MCP tool app_publish calls it (mcp/tools/coding-agent.ts:2337) | in-request (awaited): packProject, then upload (direct up to 4 MB, otherwise blob upload). | — n/a — Not started by Settings. | None. |
| App uninstall (desktop, not Settings) | `POST /setup-api/apps/uninstall` | not from Settings (src/app/page.tsx:2118) | in-request (awaited). stopServerApp waits up to 20 s for start and 10 s for scope stop (app-server-start.ts:720-724; uninstall route.ts:196-198). Then folder removal and disablePublicLink. | — n/a — Not started by Settings. | None. |
| Hermes store skill install (CLI install, GitHub manifest repair, rollback on refusal) | `POST /setup-api/hermes/skills/install {id, category?, name?, confirmDangerous?}` | Not from SettingsApp. Desktop app hermes_skills (src/app/page.tsx:499-500) → src/components/HermesSkillsStore.tsx:358 | In-request and awaited. hermes skills install --yes capped at 120 s (route.ts:93, :199). Then manifest and missing-file repair from GitHub (:336, :851, :866). Rollback runs hermes skills uninstall… | — n/a — Not started from Settings. The route does not read request.signal. | None. One answer at the end (installed, or a refusal code). |
| Hermes skill catalogue index build (warm-up) | `GET /setup-api/hermes/skills/browse (starts warmIndex)` | Not from SettingsApp. Desktop skills store: src/components/hermes-skills/useSkillCatalog.ts:20 (BROWSE_URL) | Fire-and-forget promise: hermes skills browse with a 300 s cap, not detached (src/lib/hermes-skill-index.ts:801-817, :806-807). | — n/a — Not tied to any client. It continues after the response. | None. catalog.origin 'warming' is the only signal (browse/route.ts:361). |
| Hermes skill docs fetch (inspect phase 2) | `GET /setup-api/hermes/skills/inspect?id=…&docs=1` | Not from SettingsApp. src/components/hermes-skills/useSkillDetail.ts:20 (INSPECT_URL) | In-request and awaited. hermes skills inspect via runSkillsCli, capped at 60 s (src/lib/hermes-skills.ts:342; route.ts:467-470). Queued (max 2) and tied to request.signal (route.ts:265, :467-470). | — n/a — Tied to request.signal, so it is cancelled when the client goes away (route.ts:265, :467-470). | None. The detail view paints catalogue metadata first (phase 1, route.ts:278-442). |

### Messaging channels

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Voice transcription of a chat recording (not Settings) | `POST /setup-api/chat/transcribe` | not from Settings (src/components/ChatPopup.tsx:5466) | in-request (awaited). Cloud: upstream fetch with AbortSignal.any([req.signal, 120 s timeout]) (route.ts:101, 361). On-box: transcribeLocally (faster-whisper) (route.ts:418-421; comment at :471… | — n/a — Not started by Settings. The cloud leg aborts when the browser disconnects, by design (route.ts:359-361). | Chat-side only. |

### Network, users and devices

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Wi-Fi background scan (non-live POST: AP teardown and restore) | `POST /setup-api/wifi/scan (no ?live)` | not from Settings, and no UI caller found. SettingsApp and WifiStep send ?live=1; the MCP tool uses GET… | fire-and-forget promise (network.ts:272-280). | — n/a — No Settings caller. | GET /setup-api/wifi/scan returns scanning:true (network.ts:283-291). |

### Coding agent

| Process | Started by | Settings entry | How it runs today | Closing Settings | Progress today |
|---|---|---|---|---|---|
| Pull request CI watch and review loop after a run opens a PR | `Run settle with a pull request open (no route); the autoPr switch is set by POST…` | not from Settings: the switch lives in the Coding Agent settings (enable/route.ts:386-389) | watchPullRequest (coding-agent.ts:9542-9573) polls checks on an unref'd timer (:9515-9526), capped at PR_MAX_WAIT_MS = 30 min (coding-pr-state.ts:30, used at coding-agent.ts:9573). | — n/a — Not a Settings process; timers live in the web server, not in the page. | Run record pr and review fields. |
| GitHub backup push and Create PR (project page) | `POST /setup-api/coding-agent/git {projectId\|directory, action:'backup'\|'pr'}` | not from Settings: CodingAgentApp.tsx:1104 and 1126 | In-request and awaited: action 'pr' calls openProjectPullRequest (git/route.ts:137-147); | — n/a — Request-bound; not a Settings process. | None; spinner only. |
| GitHub device-flow login (connect GitHub, waits for the owner to approve on github.com) | `POST /setup-api/coding-agent/github-login {action:'start'}, then {action:'poll'} until approved` | not from Settings: CodingAgentSettingsPanel.tsx:438, 584, 601 and CodingAgentSetupWizard.tsx:112, 142, 163 | startDeviceLogin (src/lib/coding-github.ts:119-134) keeps pendingLogin in module memory (:86), with GitHub's interval (min 5 s, :130) and expires_in (default 900 s, :131). | — n/a — Not a Settings process; the login state is in the web server, so the page can close without stopping GitHub's approval window. | User code and verification URL, then pending or connected status (DeviceLoginPoll, coding-github.ts:96-98). |
| Speech generation for a run (media/audio) | `POST /setup-api/coding-agent/media/audio` | not from Settings: called by a run's MCP tool; no Settings component references coding-agent/media | In-request and awaited: withSpeechQueue(() => speakReply(text)) (route.ts:95), then the bytes are written (:98, :115). | — n/a — Run-driven and request-bound. | None. |
| Picture generation for a run (media/image) | `POST /setup-api/coding-agent/media/image {path, prompt, size?}` | not from Settings: called by a run's MCP tool (route.ts:16-22); no Settings component references coding-agent/media | In-request and awaited: withGenerationSlot (route.ts:102-105) then generateClawaiImageBytes, with a 120 s upstream budget per picture (route doc :43-46); | — n/a — Run-driven and request-bound; not a Settings process. | None. |
| Project import (clone a GitHub repo or copy a folder on the box) | `POST /setup-api/coding-agent/projects/import {source:'github'\|'folder', ...}` | not from Settings: the route's own note says the Import panel left the Coding Agent app (route.ts:35-45); callers are… | In-request and awaited: importGitHubRepo runs gh repo clone with CLONE_TIMEOUT_MS 10 min (src/lib/project-import.ts:83, 706); | — n/a — Request-bound; not a Settings process. | None. |
| Coding run (Claude Code or Codex harness in a systemd scope) | `POST /setup-api/coding-agent/run` | not from Settings: CodingAgentApp.tsx:1690 posts it; SettingsApp imports no coding component | Answers 202 at once (run/route.ts:153). startOrQueueRun (coding-agent.ts:13935) -> startRun (:12666) -> spawnRun (:11804) runs the harness via systemd-run --user --scope (coding-run-unit.ts:118-130)… | — n/a — Not a Settings process; the run lives in its own scope and does not depend on the request or the page. | Run record status and progress lines, transcript and stream log files (coding-agent.ts:11897-11900, 11714). |
| Coding draft start and paused-run resume (same scope-detached run as the run row) | `POST /setup-api/coding-agent/start {runId} (drafted run); POST /setup-api/coding-agent/resume {runId} (paused…` | not from Settings: CodingAgentActivityPill.tsx:163 documents the pause and resume calls; SettingsApp imports no coding… | startDraftRun (coding-agent.ts:13828) and resumeRun (:13666) start the scope-detached run described in the run row; | — n/a — Not a Settings process; same scope mechanism as the run row. | As the run row. |
| Coding team (planner, workers, reviewer board) | `POST /setup-api/coding-agent/team {goal, projectId\|directory, effort?}` | not from Settings: CodingAgentApp.tsx:773 reads the team list; CodingTeamPage.tsx:300 polls one board | Answers 202 (team/route.ts:118). startTeam (src/lib/coding-team.ts:330) starts or queues; the live board sits in a module-level Map (coding-team.ts:285); member work runs as scope-detached runs (see… | — n/a — Not a Settings process; the board and its runs do not depend on the page. | Board: tasks, log, alerts, metrics and a slim card, via GET team (team/route.ts:16-33). |
| Run history export (streamed zip of the whole history) | `GET /setup-api/coding-agent/history/export` | not from Settings: CodingRunHistoryCard.tsx:179 (an href link in the Coding Agent settings panel) | Streamed response: zipResponseStream pulls chunks from historyExportAll() (src/lib/zip-writer.ts:383-399). | — n/a — Stops when the client disconnects (cancel path, zip-writer.ts:395-397). | Browser download only. |

## 3. Phase 1: the shared mechanism and the first three processes

### Which three

Section 1 follows the brief's order: local AI, Whisper, Kokoro, models, Chromium/VNC, updates, sign-ins, backups, reindexing, app installs. Its first three rows that do not survive Settings closing are the first three installs on that list:

| # | Process | Before | After |
|---|---|---|---|
| 1 | Gemma 4 / llama.cpp install, enable, make primary — `POST /setup-api/llamacpp/install` | ⚠️ The progress lived only in the response stream, and nothing re-attached when Settings reopened. It was worse on a reload or a dropped tunnel: the route's `emit` had no `try`, so the first status line written to the closed stream threw. That ended the flow after the root step, and the runtime was never started or configured. The route had no in-flight guard either, so a second click started a second flow. | A background task. Asking again with the same settings follows the running task. Different settings (for example "make primary" during a plain enable) get `409 busy` with the `taskId`. |
| 2 | Whisper engine install — `POST /setup-api/whisper {action:"install-engine"}` | ⚠️ The root unit ran on, but the progress was lost. A reopened Settings showed "Not installed", and Install answered `409 busy`. | A background task. A second POST follows it. The size picker and both removals still refuse while it runs. |
| 3 | Kokoro voice install — `POST /setup-api/tts/install` (Local AI row, and the Voice panel's fix button) | ⚠️ Same as Whisper. | A background task. A second POST follows it, and the removal refuses while it runs. |

### The mechanism

- **Runner: `src/lib/background-tasks.ts`.**
  - A task is a promise of the web server, never awaited by a request, so a client that leaves cannot end it.
  - Its record holds the steps (weighted), the headline, byte progress, a 200-line log ring and how it ended. The record is persisted atomically to `data/background-tasks.json`. Progress is written at most once a second; steps and endings are written at once.
  - One task per group runs at a time. The check is synchronous, so two simultaneous requests cannot both start one.
  - A record another server process left `running` is closed as `interrupted` when it is read, so no bar sits frozen forever.
  - `backgroundTaskStream` replays a task in the NDJSON shape the install routes already answered with (`{status}`, `{completed,total}`, then one `{success}` or `{error}`). Its first line names the `taskId`. The existing readers (`readInstallStream`, `useLlamaCppModels`, the Voice panel) read it unchanged.
- **API.** The new routes sit beside `/setup-api/background-jobs`, which handles the harness's recurring jobs:
  - `GET /setup-api/background-jobs/tasks` lists tasks; `?kind=` and `?id=` narrow it.
  - `POST` with `{id, action: "dismiss"}` dismisses a card. It needs a person's browser on the same origin.
  - `GET /setup-api/background-jobs/tasks/follow?id=` re-attaches to a task.
- **Desktop corner card: `src/components/BackgroundTaskCards.tsx`.** It sits in the top-right notice column of `src/app/page.tsx`, one card per task, showing:
  - the title and live headline;
  - the steps with their states;
  - a bar with the percentage;
  - the time left, once the work has moved enough to give a rate;
  - a collapsible live log.

  It polls every 2 s while something runs and every 20 s otherwise, and asks at once when a surface fires `clawbox:background-task`. A success hides itself after 30 s. A failure or an interruption stays until it is closed.
- **Settings re-attach.** When `LocalAiPanel` mounts, it asks for running tasks and follows each one on its own row, through the same reader, spinner and verdict as the click that started it. While a task runs, the row says "Runs in the background — you can close Settings."

### Not in phase 1

- If the web server restarts mid-install, the task is reported `interrupted`. Its root unit may still finish under systemd, and the row then reads the result from the inventory. Re-adopting a root unit that is still running after a restart is left for later.
- There is no Cancel: these root steps have no safe stop half-way through.
- The next rows in section 1 that lose progress or die are:
  - the Whisper size download (same route);
  - the memory embedder download;
  - the Ollama pull and llama.cpp model downloads;
  - the Chromium install;
  - the harness swap;
  - the device-code provider sign-ins;
  - WhatsApp pairing;
  - the ClawKeep backup and restore.

## Appendix: routes opened and judged instant

Every route file under `src/app/setup-api` in the areas above was opened; these were judged to finish within a few seconds (one config write and its read-back, a status read) and are not background-task candidates.

- Boot-started, not user-started: src/instrumentation.ts:198,282,409 (shared-browser profile migration and keeper timer) and :690 (monitor reconciler). Not Settings.
- DELETE /setup-api/clawkeep/memory/index (stop pass): sends SIGTERM and SIGKILL after 5 s, and returns at once (index/route.ts:113-132; clawkeep-memory.ts:2283-2290, :626-634). No UI caller in src/components.
- DELETE /setup-api/whisper?size=: one cache dir removed (whisper/route.ts:359-384; whisper-models.ts:196-209). Judged short, not measured.
- GET /setup-api/ai-models/catalog: one catalogue read, cached
- GET /setup-api/ai-models/oauth/providers: static list (oauth/providers/route.ts:6-11).
- GET /setup-api/ai-models/status (SettingsApp.tsx:1390; use-clawbox-login.ts:93): read; the 30 s shared poll is at use-clawbox-login.ts:92; the portal lookup carries a 4 s timeout per the route comment…
- GET /setup-api/ai-models/status: 4 s portal bound (ai-models/clawai/poll/route.ts:120-126), polled every 30 s (AIModelsStep.tsx:704-748).
- GET /setup-api/ai-models/usage: portal read (usage/route.ts:36-43).
- GET /setup-api/clawkeep (status): file reads and PATH stats only (clawkeep/route.ts:9-20; clawkeep.ts:1062-1076, :1331-1343).
- GET /setup-api/clawkeep/memory/provider: read. Not fully traced: getEmbedProvisioningStatus and readCloudDefaultsFacts are outside slice (provider/route.ts:46-107).
- GET /setup-api/clawkeep/memory/search: agent-facing read, not started from Settings, bounded by a 60 s deadline (search/route.ts:42-102, :77; memory-index-local.ts:244).
- GET /setup-api/clawkeep/memory/sources: read (sources/route.ts:66-70).
- GET /setup-api/clawkeep/pair/status: session read, no UI caller (pair/status/route.ts:15-47).
- GET /setup-api/discord/status and GET /setup-api/discord/members (SettingsApp.tsx:2713, 2747): reads; status uses a cached bot probe (discord/status/route.ts:76-105); members is a Discord REST read.
- GET /setup-api/email/status, /email/pending, /email/chat-approval (SettingsApp.tsx:1933, 1970, 2019): reads on a 15 s refresh (email-pending-refresh.ts:37). The status route itself was not opened; the SettingsApp…
- GET /setup-api/harness/active (client-harness.ts:89, reached from SettingsApp.tsx:1414): read; route not opened.
- GET /setup-api/harness/active: config read (harness/active/route.ts:27-30).
- GET /setup-api/harness/status: liveness probes, up to 3 x 2.5 s per harness plus retry gaps (harness.ts:256-277). Read-only; polled once on HarnessPicker mount.
- GET /setup-api/harness/swap and GET /setup-api/harness/mcp: reads, covered in the swap and MCP rows.
- GET /setup-api/hermes/models ?refresh=1: a model-list refresh bounded by the dashboard's 8 s cap
- GET /setup-api/llamacpp/models: listing plus a HEAD probe capped at 10 s (llamacpp/models/route.ts:116-181, :43).
- GET /setup-api/llamacpp/status and GET /setup-api/ollama/status: 5 s probes (llamacpp/status/route.ts:13-41; ollama/status/route.ts:8-42).
- GET /setup-api/local-ai/exclusive: config read (local-ai/exclusive/route.ts:381-387).
- GET /setup-api/local-models: inventory polled every 5 s; short (LocalAiPanel.tsx:312-314; local-models/route.ts:82-85).
- GET /setup-api/monitors (SettingsApp.tsx:635): status read, monitors/route.ts:54-59.
- GET /setup-api/ollama/search: external ollama.com fetch, 10 s cap (ollama/search/route.ts:173-183). Only the unmounted Ollama panel calls it.
- GET /setup-api/pets/thumb: one thumbnail read
- GET /setup-api/plugins/repair (SettingsApp.tsx:1558): read of marker rows (plugins/repair/route.ts:69-73).
- GET /setup-api/setup/status (SettingsApp.tsx:1429-1436): read with no probe, per the route comment at setup/status/route.ts:39.
- GET /setup-api/setup/status and POST /setup-api/setup/progress: a read and a config write (setup/status/route.ts:12-120; setup/progress/route.ts:18-43). status is read from SettingsApp.tsx:1429 and 3123.
- GET /setup-api/stt: filesystem plus one cached python probe, capped at 15 s on first use (stt/route.ts:107-114; stt-local.ts:46-47).
- GET /setup-api/system/battery: sysfs read for the tray (system/battery/route.ts:22-33).
- GET /setup-api/system/build-identity (BuildIdentityPanel.tsx:63-81): one-shot read with a 30 s cache (system/build-identity/route.ts:17-27).
- GET /setup-api/system/build-identity: git reads cached 30 s (system/build-identity/route.ts:17-34); BuildIdentityPanel.tsx:63-84, SettingsApp.tsx:858 and 6574.
- GET /setup-api/system/hostname: config read plus local address lookup (system/hostname/route.ts:32-44).
- GET /setup-api/system/info: gather(); no caller in src/components (system/info/route.ts:6-16).
- GET /setup-api/system/stats, polled every 3 s (SettingsApp.tsx:862-879): reads; ps is spawned only while the processes block is open (system/stats/route.ts:197-199; SettingsApp.tsx:869-871); the route comment cites…
- GET /setup-api/system/stats: memoised 5 s df/ps read, polled by SettingsApp and SystemApp (system/stats/route.ts:39-40, 302-401).
- GET /setup-api/system/timezone: read (system/timezone/route.ts:134-144).
- GET /setup-api/system/update-branch: reads the pin file and resolves the effective branch locally (update-branch/route.ts:66-80); not traced for network use.
- GET /setup-api/telegram/status, GET /setup-api/telegram/pairing without pending, GET /setup-api/telegram/streaming (SettingsApp.tsx:1630, 1658, 1686): reads; status does a Telegram getMe and memoised Hermes probes…
- GET /setup-api/tts: status read, filesystem only per its own comment (tts/route.ts:253-260, :61-63).
- GET /setup-api/update/status: a read, but it can start the post-reboot continuation (update/status/route.ts:51-53; updater.ts:5120-5128). Covered in the full-update row.
- GET /setup-api/update/versions (SettingsApp.tsx:894): cached read, updater.ts:4550-4584 with a 30 min good-answer TTL (updater.ts:4320); the update run itself is SystemUpdateApp at SettingsApp.tsx:6533, outside this…
- GET /setup-api/update/versions ?refresh=1: a forced version read, read-only
- GET /setup-api/update/versions: a forced version read, read-only
- GET /setup-api/update/whats-new: read or prefetch for the /updating page (use-update-whats-new.ts:73); not Settings (update/whats-new/route.ts:19-29).
- GET /setup-api/whatsapp/status (SettingsApp.tsx:2383): NOT OPENED, only grepped; the SettingsApp comment at 2389-2397 says it is a status read.
- GET /setup-api/whisper: filesystem reads only (whisper/route.ts:105-126).
- GET /setup-api/wifi/status, /wifi/ethernet, /wifi/saved, /system/hotspot, /system/hostname (SettingsApp.tsx:972, 1164-1184): reads with 2-3 s command timeouts (wifi/status/route.ts:16, 34; system/hotspot/route.ts:48-50).
- GET and PUT /setup-api/clawkeep/schedule: file read or atomic write, plus in-process timer re-arm (schedule/route.ts:8-65; clawkeep-scheduler.ts:341-351).
- GET/POST /setup-api/update/dismissal: store get/set; used by the desktop page only (src/app/page.tsx:2785, 2818).
- POST /setup-api/ai-models/clawai/start: upstream capped at 15 s, returns a code (clawai/start/route.ts:77-83). Folded into the ClawBox AI pairing row.
- POST /setup-api/ai-models/oauth/device-start: upstream capped at 30 s (oauth/device-start/route.ts:46-51).
- POST /setup-api/ai-models/oauth/exchange: token exchange capped at 30 s (oauth/exchange/route.ts:141-153). The Anthropic card (AnthropicAccountsCard.tsx:260, :286) calls both routes; it has no abort on unmount, but the…
- POST /setup-api/ai-models/oauth/start: local PKCE only, no upstream call (oauth/start/route.ts:17-108).
- POST /setup-api/clawkeep/memory/enable, switch part only: flag write plus timer re-arm (enable/route.ts:34-80). Its Prime Radiant catch-up is listed as its own row.
- POST /setup-api/clawkeep/reset-state: state.json rewrite (reset-state/route.ts:17-41; clawkeep.ts:840-872). Clears the stuck-running fields; it does not stop a daemon.
- POST /setup-api/clawkeep/setup: single config-store flag write (setup/route.ts:17-48; clawkeep.ts:1303-1306).
- POST /setup-api/clawkeep/snapshots/label, /snapshots/lock, /snapshots/delete: one CLI call each, with 30 s, 30 s and 60 s kill timers (clawkeep.ts:1968-2014). Durations not measured.
- POST /setup-api/clawkeep/unpair: local token delete, no upstream call (unpair/route.ts:19-50; clawkeep.ts:816-827). Also reached from the Settings-driven ClawBox AI account change…
- POST /setup-api/monitors/brightness: one DDC/backlight write
- POST /setup-api/ollama/delete: one model delete, 30 s cap (ollama/delete/route.ts:52-57). Not reachable from a mounted UI in this build.
- POST /setup-api/portal/start (RemoteControlPanel.tsx:118, :142): single systemctl restart of the tunnel service (src/lib/cloudflared.ts:178-179); URL negotiation is a separate status poll…
- POST /setup-api/setup/complete: wizard config writes (setup/complete/route.ts:9-70); not Settings (SetupWizard.tsx:614).
- POST /setup-api/system/credentials (SettingsApp.tsx:1098): one chpasswd root step capped at 30 s (src/app/setup-api/system/credentials/route.ts:142). Not measured; judged short from the cap.
- POST /setup-api/system/credentials and /credentials/verify: one chpasswd root step with a 30 s budget (system/credentials/route.ts:137-147), and a password check (credentials/verify/route.ts:26-57). Judged short; not…
- POST /setup-api/system/desktop: sets the boot target via a sudo script that takes effect at reboot (system/desktop/route.ts:28-61; system-profile.ts:225-237). Judged instant; not measured.
- POST /setup-api/system/power (SettingsApp.tsx:1229): enqueues a systemctl poweroff or reboot job and returns (src/lib/power-approval.ts:142-154); the reboot itself is covered in the hostname row.
- POST /setup-api/system/power-profile (SettingsApp desktop panel): setPowerMode applies immediately with no reboot (src/lib/system-profile.ts:239-246); script capped at 20 s (:40).
- POST /setup-api/system/power/approval: approval answer only (power/approval/route.ts:8-29).
- POST /setup-api/tts/warm: systemctl start --no-block with a 10 s cap, returns 202 (tts/warm/route.ts:51-81; local-models.ts:855-868).
- POST /setup-api/update/dismiss: in-memory clear plus one store write (updater.ts:4794-4848). Instant.
- POST /setup-api/wifi/scan ?live=1: a live scan of at most 15 s, nothing to re-attach
- POST /setup-api/wifi/update (SettingsApp.tsx:988, :1006): nmcli delete, modify and up with 5 s to 15 s caps (src/app/setup-api/wifi/update/route.ts:30-46).
- POST and DELETE /setup-api/clawkeep/encryption: one daemon CLI call with a 10 s kill timer (encryption/route.ts:44-130; clawkeep.ts:1232-1266, timeout :1246, :1260). Daemon-side work not read (Python, outside slice).…
- PUT /setup-api/clawkeep/memory/schedule (write plus timer re-arm) and POST /setup-api/clawkeep/memory/reset (flag writes, no spawn): instant (schedule/route.ts:36-53; reset/route.ts:39-80).
- System timezone change re-arms both schedulers: instant, called from TimezoneAdopter, not Settings (system/timezone/route.ts:86-105).
- TelegramStep.tsx:130 also POSTs /setup-api/telegram/configure, but it is the onboarding step and is not imported by SettingsApp (SettingsApp.tsx:3-57).
- apps/store, apps/icon, apps/skill-info (openclaw-skill-info.ts:121-124, a skills-list CLI call cached 30 s, desktop window only), apps/settings (write; InstalledAppSettings.tsx:203-232), apps/public-link (writes; the…
- coding-agent/anthropic and coding-agent/openai key verbs: one live key check, then a config write (anthropic/route.ts:87-149; openai/route.ts:133-181)
- coding-agent/artifacts GET: one file read, capped at 20 MB (artifacts/route.ts:21, 44-52)
- coding-agent/draft POST: createDraftRun writes a draft record only, starts nothing (coding-agent.ts:13794-13823)
- coding-agent/enable POST: config setters and MCP refresh, no install step (enable/route.ts:166-476)
- coding-agent/git GET: local git reads only (git/route.ts:34-80)
- coding-agent/kill POST: one killRunLeftovers call (kill/route.ts:26-29)
- coding-agent/message POST: 4 s delivery wait (message/route.ts:66, 82)
- coding-agent/projects/delete GET and DELETE: rename into a trash folder, no recursive removal (projects/delete/route.ts:39-43)
- coding-agent/projects/desktop POST: one manifest read and one registration call (projects/desktop/route.ts:39-53)
- coding-agent/reset POST: resetCodingAgentSetup then status (reset/route.ts:28-51)
- discord/status GET and discord/members GET: reads with 60 s and 15 s caches (discord/status/route.ts:69-70, 128-134; discord/members/route.ts:24-25).
- email/messages GET (IMAP listing, used by chat-email.tsx:314), email/send (agent MCP path), email/chat-reply (harness hook): none are Settings-started.
- email/status GET, email/chat-approval GET, email/pending GET: reads (email/status/route.ts:27-; email/chat-approval/route.ts:76-86; email/pending/route.ts:80-93).
- embed/status GET: read (embed/status/route.ts:17-44). embed DELETE: stops the unit and unlinks the GGUF; short (embed/install/route.ts:119-148; LocalAiPanel.tsx:587).
- files/* (listing, uploads, ZIP streams: files/route.ts:304-330; files/[...path]/route.ts:76-107). Not Settings.
- lib/child-run.ts: a runner for git, gh, ffmpeg, pdftotext, libreoffice and ss (child-run.ts:114-182). No route in this slice calls it; callers are in voice, coding, store-publish and project-import libs outside the…
- lib/harness-downgrade.ts: refusal assessment. Its backup is covered in the full-update row (harness-downgrade-backup.ts:38).
- lib/harness-probe.ts, lib/coding-harness*.ts: NOT OPENED. lib/client-harness.ts: client cache of GET /harness/active, read-only.
- lib/root-step-journal.ts: journal argument helpers only (root-step-journal.ts:63-90). Not a process.
- mascot-lines (pack-only phrase lookup, mascot-phrases-server.ts:102-116) and whats-new (read or dismiss, whats-new/route.ts:24-77): instant.
- prime-radiant/claims/verify POST: one verify and one commit (claims/verify/route.ts:22-33)
- prime-radiant/daily GET: read-only (daily/route.ts:20-31)
- prime-radiant/golden GET and POST, golden/[id] PATCH and DELETE: in-request read or one commit (golden/route.ts:32-60; golden/[id]/route.ts:27-51)
- prime-radiant/ingest/[id] GET and DELETE: read, or a stop signal (ingest/[id]/route.ts:26-47)
- prime-radiant/ingest/upload POST: one file per request, 9 MiB cap (ingest/upload/route.ts:34-49)
- prime-radiant/init POST: one initialise call (init/route.ts:22-38)
- prime-radiant/status GET: index status read (status/route.ts:27)
- src/app/setup-api/anthropic/accounts/route.ts (actions other than use_for_chat): instant pool writes. add_key verify is capped at 10 s (src/lib/coding-anthropic.ts:48, :164; route.ts:202). connect_oauth reads the…
- src/app/setup-api/browser/manage/route.ts GET (298-351) and browser/route.ts non-launch actions: short probes and page actions, each under 15 s. Not Settings.
- src/app/setup-api/browser/setup/route.ts:29-110: config writes only, instant.
- src/app/setup-api/code/route.ts:38-186: code-project file operations. buildProject (src/lib/code-projects.ts:591) spawns nothing. Not from Settings.
- src/app/setup-api/desktop/chrome/route.ts with lib/desktop-chrome.ts:62-63: systemd-run returns once the unit starts, 10 s cap. Not Settings.
- src/app/setup-api/desktop/state/route.ts: instant reads and writes.
- src/app/setup-api/gateway/db-maintenance/route.ts:35-43 (GET): status read via python status --json, capped at 30 s (src/lib/openclaw-db-maintenance.ts:226-232). The run is a row above.
- src/app/setup-api/gateway/health/route.ts:37-69: TCP port probe, 1 s (:40).
- src/app/setup-api/gateway/route.ts:14-107: Control UI HTML proxy with a 3 s fetch cap (:17-19).
- src/app/setup-api/gateway/ws-config/route.ts:29-66: config and token read.
- src/app/setup-api/hermes/commands/route.ts:33-48: one dashboard RPC for the chat composer; not Settings.
- src/app/setup-api/hermes/models/route.ts:67-383: GET reconciles once per process (:100-103); POST is two hermes config set calls (:311-334). The explicit refresh is row 11.
- src/app/setup-api/hermes/oauth/cancel/route.ts:13-38: instant DELETE (the row above covers its unmount effect).
- src/app/setup-api/hermes/oauth/route.ts:24-53: catalogue read; cliAvailable is a PATH stat (src/lib/hermes-cli-login.ts:134-136).
- src/app/setup-api/hermes/provider-key/route.ts:72-74: one hermes auth add capped at 20 s, then a reload RPC (:115). A credential write, not a long process.
- src/app/setup-api/hermes/skills/inspect/route.ts:278-442: phase 1 reads disk and catalogue only (phase 2 is a row above).
- src/app/setup-api/hermes/skills/installed/route.ts:14-72: disk walk, no CLI.
- src/app/setup-api/hermes/skills/secrets/route.ts:35-137: .env read and write.
- src/app/setup-api/hermes/skills/uninstall/route.ts:63-306: one CLI call capped at 30 s (:129-132), then lock and directory checks. Skills store only (HermesSkillsStore.tsx:451).
- src/app/setup-api/kiosk/tabs/route.ts: short CDP calls. Not Settings.
- src/app/setup-api/kv/route.ts, screenshots/route.ts, and preferences/route.ts: instant store I/O. Not Settings-started (desktop apps and Mascot).
- src/app/setup-api/monitors/route.ts GET (54-60): wlr-randr read capped at 5 s (monitors.ts:68,621-624), polled every 5 s. Read only.
- src/app/setup-api/network/internet/route.ts:13-24: ping capped at 3 s, cached 5 s. Used by SystemTray, not Settings.
- src/app/setup-api/pets/route.ts GET and pets/sprite/route.ts: local filesystem reads, fail-open.
- src/app/setup-api/portal/heartbeat-tick/route.ts: systemd timer (config/clawbox-heartbeat.service:31), curl --max-time 10. Not Settings.
- src/app/setup-api/portal/status/route.ts:34-62: fast read polled by RemoteControlPanel. Side effect: fire-and-forget heartbeat push that can restart the tunnel (see notes).
- src/app/setup-api/portal/stop/route.ts:6-37: Settings Remote 'off' (RemoteControlPanel.tsx:160). sudo systemctl stop and disable with no timeout in code (lib/cloudflared.ts:190-199); usually seconds. Judged quick, but…
- src/app/setup-api/providers/default/route.ts:40-171: delegates to hermes/models or chat/model; chat/model hot-applies with no gateway restart (src/app/setup-api/chat/model/route.ts:1773-1790). Its own comment at…
- src/app/setup-api/providers/enabled/route.ts:26-101: instant flag write; the catalogue refresh is deliberately not run (:81-97).
- src/app/setup-api/providers/status/route.ts:19-22: read-only. The Hermes branch's model options use an 8 s dashboard cap (src/lib/hermes-model-options.ts:230, :954-961).
- src/app/setup-api/settings/path-guard, settings/computer-use, and background-jobs GET: reads.
- src/app/setup-api/tunnel/status/route.ts and tunnel/disable/route.ts: instant reads. Disable refuses while the unit runs (lib/tunnel.ts:271-278). No Settings caller.
- src/app/setup-api/users/route.ts GET and users/me/route.ts: reads.
- src/app/setup-api/vnc/clipboard/route.ts: xclip with a 5 s cap (lines 15,56-81). Not Settings.
- src/app/setup-api/vnc/resolution/route.ts:93-108: systemctl MainPID plus SIGKILL restart, quick. Reached from BrowserSettingsPanel (VncResolutionSetting), not SettingsApp.
- src/app/setup-api/vnc/route.ts GET: spawns websockify then waits 1 s (lines 42,55-57). Polled by VNCApp, not Settings.
- src/app/setup-api/wifi/ethernet/route.ts, wifi/connect-status/route.ts, and GET wifi/scan: instant.
- src/app/setup-api/wifi/saved/route.ts:14-17: nmcli 5 s cap. Settings read (SettingsApp.tsx:972).
- src/app/setup-api/wifi/status/route.ts:12-47: iw and ping each capped at 2 s, 3 s cache (lines 12,16,34). Settings read on mount (SettingsApp.tsx:1164).
- src/components/AiProviderList.tsx: container only. Its children are the plugin repair row and the Anthropic accounts card, plus the status hook.
- src/components/AnthropicAccountsCard.tsx:256-301: calls /setup-api/ai-models/oauth/start (:260) and /setup-api/ai-models/oauth/exchange (:286), one shot each. Those routes are outside this slice and were not traced…
- src/components/ClawBoxLoginModal.tsx:86-100: opens the portal in a new tab; no server process.
- src/components/FreeTierUpgradeCard.tsx:25, :69: static portal link.
- src/hooks/useProviderStatus.ts:107-154: client poll of /setup-api/providers/status with backoff only while a row is checking. Read-only.
- src/lib/claude-login.ts: reads only; no spawn or execFile (grep). hasAnthropicLogin (:113), anthropicLoginEmail (:122).
- src/lib/login-rate-limit.ts: lockout bookkeeping and response padding (:115-202). No process.
- src/lib/oauth-config.ts: static provider constants (:23-27, :33-35, :39, :90).
- src/lib/oauth-handoff.ts: file store with a 15 min TTL (:24, :74-103). No process.
- src/lib/oauth-utils.ts: client helpers tryCloseOAuthWindow and parseAuthInput (:6, :27). No process.
- src/lib/use-clawbox-login.ts: browser poll of /setup-api/ai-models/status every 30 s (:92, :233-258). Read-only; the route is outside this slice.
- telegram/status GET: read only. Hermes probes are cached 15 s, OpenClaw uses the shared channel-status memo, getMe has a 5 s timeout (telegram/status/route.ts:24-47, 128-221). Not user-started.
- telegram/streaming GET: read only (telegram/streaming/route.ts:38-60).
- webapps/*, terminal/shells, terminal/paste-image, chat/history, chat/capabilities, chat/attachments (bounded streamed upload), chat/media, chat/images, chat/tabs, chat/model, chat/spoken-history: instant, or not…
- whatsapp/status GET: read; gateway probe comes from a shared memo (whatsapp/status/route.ts:20-29).
