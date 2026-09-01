# x64 real-device UI QA

Living test plan and bug ledger for PR #567 (`x64-installer` → `beta`). The
reference device is Ubuntu 24.04 x86_64 with ClawBox AI connected through the
real Settings UI. Destructive power, factory-reset, account-switch, and channel
message actions are covered with mocks unless explicitly marked live.

## Real-device coverage

| Surface | Result |
| --- | --- |
| Installer fresh/repeat run | Pass |
| ClawBox AI portal-token connect | Pass |
| Cloud chat + post-restart chat | Pass |
| Gemma 4 install, standby wake, completion | Pass |
| Ollama AMD/ROCm runtime | Pass |
| Terminal PTY + anonymous rejection | Pass |
| Files create/read/list/delete | Pass |
| Browser service + CDP open/close | Pass |
| VNC/websockify + standalone Remote Desktop | Pass after QA-002 |
| Store catalogue, ClawKeep, system/provider/tunnel/update status | Pass |
| Standalone built-ins (`/app/*`) | Mixed: all render, OpenClaw assets fail (QA-044) |
| Service restart persistence | Pass |
| Voice cloud sample playback | Pass |
| Memory Shard incremental index | Pass |
| Privileged x64 recovery/actions | Fail (QA-040–QA-042) |

Automated-only coverage: the mobile Settings account/password overlay
regressions pass after QA-004. The follow-up real-device audit below covers the
mobile section list and all channel detail/back paths, but did not submit an
account or password change.

## UI path matrix

- Routes: desktop, setup, login, standalone apps, portal subscribe, OpenClaw
  proxy, captive-portal probes, and Hermes dashboard gating.
- Desktop shell: icons/grid, selection/drag/context menus, window lifecycle,
  launcher, shelf, tray/power, mascot, notifications, upload overlay, mobile.
- Apps: Chat, Files, Terminal, Coding Agent, ClawKeep, Memory Shard, System
  Update, Store/installed skills/web apps, Browser, Remote Desktop, OpenClaw,
  Hermes Skills/dashboard.
- Settings: Appearance, Providers, Local AI, Telegram, Email, WhatsApp,
  Discord, Voice, Network, Remote Control, System, About.
- Setup: Wi-Fi, update, credentials/hotspot, AI provider, Telegram, completion.
- Dialog families: desktop uninstall/notifications, Settings destructive and
  account dialogs, Chat media/approval dialogs, Files mutations, ClawKeep,
  Store/Hermes Skills, Update, VNC, Coding Agent, Memory Shard.

## Follow-up live feature audit — 2026-09-01

Tested through the authenticated rendered UI on the reference x64 device at
`497cc88b`. Reversible changes (language and disposable Files data) were
restored/removed after the assertion. Power, factory reset, account/provider
replacement, public-tunnel changes, channel sends/pairing, backup restore, full
reindex, and software update stopped at their confirmation boundary.

| Area | Live paths exercised | Result |
| --- | --- | --- |
| Desktop shell | Launcher search/no-results, shelf, Files window maximize/restore/minimize/close, tray, first-click restart arm | Pass; accessible names fail QA-047 |
| Routes | Desktop, setup redirect, subscribe plans, 12 standalone apps | Mixed; OpenClaw Control UI fails QA-044 |
| Settings | 9 top-level sections: Appearance, Providers, Local AI, Channels, Voice, Network, Remote Control, System, About; plus Telegram, Email, WhatsApp, Discord detail/back paths | Mixed; x64 Network/System/Remote failures QA-041/QA-043 |
| Chat popup | Real ClawBox AI turn, tabs/two-click close, provider menu, dock/undock, attachment/remove, HTTP voice recovery | Pass |
| Standalone Chat | Render, staged image preview | Text chat renders; image-only send fails QA-046 |
| Files | Downloads upload, context menu, delete confirmation, cleanup | Pass; dialog/keyboard semantics confirmed QA-016/QA-037 |
| Terminal | Real PTY command round-trip | Pass |
| Store | Catalogue, search, detail, install-warning dialog/cancel | Pass; repeated unlabeled Install actions contribute to QA-047 |
| Browser | Installed/running status, agent integration state, VNC launch action | Pass |
| Remote Desktop | Live noVNC canvas and paste dialog/cancel | Pass; repair path fails QA-041 |
| Coding Agent | Disabled state and embedded Settings/back path | Pass; run creation intentionally not started |
| ClawKeep | Unpaired state, portal-pair surface, Memory Shard link | Pass; external pairing not submitted |
| Memory Shard | Health/stats, incremental “Index now”, completion to 0 pending/0 failed | Pass |
| System Update | Current status, advanced options, forced-update dialog/cancel | UI pass; actual x64 updater infrastructure is missing (QA-041) |
| Voice | Cloud source, sample text request, 200 response, rendered audio player | Pass |
| Responsive | 390×844 Settings list, Channels/detail/back, no horizontal overflow | Pass; accessible names fail QA-047 |
| Appearance language | English → Bulgarian → English through UI | UI returns 200; persona propagation fails QA-045 |

## Bug ledger

| ID | Priority | Status | Finding |
| --- | --- | --- | --- |
| QA-001 | P0 | Fixed | Codex plugin repair omitted OpenClaw 2 capability consent and crash-looped the gateway. |
| QA-002 | P0 | Fixed | noVNC 1.6 private CommonJS imports crashed Turbopack browser chunks with `exports is not defined`. |
| QA-003 | P0 | Fixed | New-tab routes for Chat, ClawKeep, System Update, Setup, and Hermes were missing. |
| QA-004 | P0 | Fixed | Mobile Settings returned before rendering ClawBox login and password-confirmation overlays. |
| QA-005 | P0 | Fixed | Shelf clock was labelled “System Settings” but wired to a no-op. |
| QA-006 | P1 | Fixed | Telegram readiness timeout called success and could advance setup while messaging was unavailable. |
| QA-007 | P1 | Fixed | Factory reset treated any fetch exception as accepted and then polled without a hard deadline. |
| QA-008 | P1 | Fixed | Installed skill settings could show Saved after non-OK preference/config writes. |
| QA-009 | P1 | Fixed | Wi-Fi handoff promised manual fallback but supplied no fallback action. |
| QA-010 | P1 | Open | Settings Wi-Fi/hotspot radio switches lack the setup wizard’s reconnection recovery. |
| QA-011 | P1 | Fixed | Tray power flow ignored request status and reconnect had no terminal timeout. |
| QA-012 | P1 | Verified | Hostname save already checks the hostname POST on current beta; no defect remains. |
| QA-013 | P1 | Fixed | OpenClaw redirect OAuth now reserves its tab synchronously and exposes the authorization URL as a recovery link; OpenAI itself already uses a user-click device-code page. |
| QA-014 | P1 | Fixed | Store Installed view now resolves installed ids missing from the capped initial catalogue page through the per-app endpoint. |
| QA-015 | P1 | Fixed | Custom wallpaper delete button was nested inside another button. |
| QA-016 | P1 | Confirmed | Files mutation/discard dialogs lack complete dialog semantics, focus containment, and Escape handling; the live delete confirmation has no `dialog` role. |
| QA-017 | P1 | Open | ClawKeep has no change-passphrase action after encryption is configured. |
| QA-018 | P1 | Fixed | Remote Control/Browser now require an explicit readable `installed: false` before offering installation. |
| QA-019 | P2 | Open | Standalone Settings appearance callbacks and Store/install/uninstall state are incomplete. |
| QA-020 | P2 | Open | No mobile, Firefox/WebKit, accessibility, or broad visual-regression Playwright project exists. |
| QA-021 | P1 | Fixed | Full-install “main → target” did not establish a real main baseline; its serial tail now updates the PR-head install to main, verifies it, then exercises main → target. |
| QA-022 | P1 | Fixed | Chat popup placement retained a 400 px-width offset after the default grew to 520 px, so first-load alignment was wrong and CI sampled its entrance animation. |
| QA-023 | P1 | Open | Chat popup drag coordinates are not viewport-clamped and can leave the window off-screen. |
| QA-024 | P1 | Open | Chat silently discards the oldest queued turn once the 20-turn client queue fills. |
| QA-025 | P1 | Open | Main-chat reset is destructive on one click while secondary-session deletion requires a confirming second click. |
| QA-026 | P2 | Open | Launcher page index is not clamped when filtering, app count, or grid dimensions change, which can expose an empty invalid page. |
| QA-027 | P2 | Open | Several Settings toggles expose neither switch semantics nor checked state to assistive technology. |
| QA-028 | P1 | Open | Voice settings can remain on a permanent loading skeleton after the first status request fails. |
| QA-029 | P1 | Open | Telegram approved users can be inspected but not revoked from Settings. |
| QA-030 | P1 | Open | Email disconnect is immediate and failed approved-mail “lost drafts” have no retry/copy/requeue recovery. |
| QA-031 | P1 | Open | Discord Settings exposes no disconnect/remove-token path. |
| QA-032 | P1 | Open | Wi-Fi rescan can retain stale networks after a successful empty scan, and connect can be re-entered from Enter while its button is disabled. |
| QA-033 | P1 | Open | Coding Agent GitHub device polling ignores non-OK responses and can remain indefinitely on Waiting. |
| QA-034 | P1 | Open | Memory Shard treats an unreachable or malformed first response as permanent loading with no error/retry action. |
| QA-035 | P1 | Open | VNC “Install / Repair & Reboot” is a single impactful action with no confirmation. |
| QA-036 | P2 | Confirmed | The System Update beta control and several Chat icon controls have incomplete accessible names. |
| QA-037 | P1 | Confirmed | Files rows require pointer double-click and mutation/discard dialogs are incomplete for keyboard-only users. |
| QA-038 | P0 | Fixed | A migrated OpenAI model can declare the Codex agent runtime, which makes v2 auto-enable Codex despite a missing/stale-disabled plugin entry; that state bypassed package health and capability consent and crash-looped the gateway. |
| QA-039 | P1 | Fixed | Telegram readiness recovery could hang behind a stalled configure/health request, restart when inline callbacks changed, and leave Connect disabled despite telling the owner to retry. |
| QA-040 | P0 | Open | Fresh x64 onboarding cannot complete Credentials: the password route requires `clawbox-root-update@chpasswd.service`, but `install-x64.sh` installs neither the root-update template nor its dispatcher/helper/grant. Existing testing reused completed state, while install CI runs Jetson `install.sh`. |
| QA-041 | P0 | Open | `install-x64.sh` omits the privileged runtime used by post-setup UI actions. Live Remote Control Start returns 500 (missing tunnel unit/sudo grant), VNC repair returns 500 (root-update start requires authentication), and Desktop environment returns 503 (helper absent). System Update, hostname/password/hotspot, browser/llama.cpp repair, power, and reset share the same gap. |
| QA-042 | P0 | Open | Factory reset is unsafe on non-`clawbox` x64 users: it hardcodes `/home/clawbox/.openclaw`, leaving this owner’s real `/home/skycore/.openclaw` credentials/state while wiping `/home/skycore` data before later missing root operations fail. Dialog only was tested; reset was not submitted. |
| QA-043 | P1 | Open | x64 Network is Jetson-bound: this Ethernet-only PC has no Wi-Fi device, `/setup-api/wifi/status` returns 500, yet Settings offers hotspot/network controls, defaults helpers to `wlP1p1s0`, and says “The Jetson has a single WiFi radio.” |
| QA-044 | P1 | Open | OpenClaw Control UI is effectively blank in both standalone/external use: its `/assets/*` JavaScript/CSS requests resolve at the ClawBox origin and return 403; the frame renders only the “ClawBox” brand. |
| QA-045 | P1 | Open | Appearance language changes return 200 and update the UI, but persona propagation hardcodes `/home/clawbox/.openclaw/workspace`; English → Bulgarian left the real x64 owner’s `USER.md`/`SOUL.md` unchanged. |
| QA-046 | P1 | Open | Standalone `/app/clawbox` stages and previews an image-only turn, but Send remains disabled while the textarea is empty even though its send handler supports image-only messages. |
| QA-047 | P2 | Open | Material Symbols leak into accessible names across real UI controls: launcher/sidebar entries announce names such as “settingsSettings”/“paletteAppearance…”, mobile rows add `chevron_right`, and Store exposes many indistinguishable “Install” buttons without app context. |

## False-green tests to harden

- Chat “streams a reply” did not assert the assistant reply. **Hardened.**
- Installed-app settings did not toggle enablement despite its title. **Hardened.**
- Main-to-beta precondition accepted any branch string. **Hardened.**
- Power restart can ignore request failure and force-stop the test container.
- Store live install can install nothing and skip all useful follow-ups.
- Full-install desktop smoke claimed Files/Terminal without opening them. **Hardened.**
- Captive probes accept unrelated 404 responses.
- Wrong-password login checked only that the URL stayed on `/login`. **Hardened.**
- ClawKeep schedule checks only a heading; the live ClawKeep suite is skipped.

## Next order

1. Fix the x64 privileged installer contract and fresh Credentials path (QA-040/QA-041) without changing Jetson `install.sh`.
2. Make factory reset resolve the configured owner/home and fail before destructive work (QA-042).
3. Repair OpenClaw Control UI asset routing/proxying (QA-044).
4. Capability-gate x64 Wi-Fi/hotspot UI and stop using Jetson interface defaults/copy (QA-043).
5. Fix owner-home persona propagation, standalone image-only Chat, and accessible names (QA-045–QA-047).
6. Harden the remaining false-green power, Store, captive-probe, and ClawKeep tests.
7. Add Hermes, mobile, keyboard/a11y, and Firefox/WebKit projects.
