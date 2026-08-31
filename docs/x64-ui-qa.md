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
| Standalone built-ins (`/app/*`) | Pass after QA-003 |
| Mobile Settings account/password overlays | Automated after QA-004 |
| Service restart persistence | Pass |

## UI path matrix

- Routes: desktop, setup, login, standalone apps, portal subscribe, OpenClaw
  proxy, captive-portal probes, and Hermes dashboard gating.
- Desktop shell: icons/grid, selection/drag/context menus, window lifecycle,
  launcher, shelf, tray/power, mascot, notifications, upload overlay, mobile.
- Apps: Chat, Files, Terminal, Coding Agent, ClawKeep, Memory Shard, System
  Update, Store/installed skills/webapps, Browser, Remote Desktop, OpenClaw,
  Hermes Skills/dashboard.
- Settings: Appearance, Providers, Local AI, Telegram, Email, WhatsApp,
  Discord, Voice, Network, Remote Control, System, About.
- Setup: Wi-Fi, update, credentials/hotspot, AI provider, Telegram, completion.
- Dialog families: desktop uninstall/notifications, Settings destructive and
  account dialogs, Chat media/approval dialogs, Files mutations, ClawKeep,
  Store/Hermes Skills, Update, VNC, Coding Agent, Memory Shard.

## Bug ledger

| ID | Priority | Status | Finding |
| --- | --- | --- | --- |
| QA-001 | P0 | Fixed | Codex plugin repair omitted OpenClaw 2 capability consent and crash-looped the gateway. |
| QA-002 | P0 | Fixed | noVNC 1.6 private CommonJS imports crashed Turbopack browser chunks with `exports is not defined`. |
| QA-003 | P0 | Fixed | New-tab routes for Chat, ClawKeep, System Update, Setup, and Hermes were missing. |
| QA-004 | P0 | Fixed | Mobile Settings returned before rendering ClawBox login and password-confirmation overlays. |
| QA-005 | P0 | Fixed | Shelf clock was labelled “System Settings” but wired to a no-op. |
| QA-006 | P1 | Open | Telegram readiness timeout calls success and can advance setup while messaging is unavailable. |
| QA-007 | P1 | Open | Factory reset treats any fetch exception as accepted and then polls without a hard deadline. |
| QA-008 | P1 | Open | Installed skill settings can show Saved after non-OK preference/config writes. |
| QA-009 | P1 | Open | Wi-Fi handoff promises manual fallback but supplies no fallback action. |
| QA-010 | P1 | Open | Settings Wi-Fi/hotspot radio switches lack the setup wizard’s reconnection recovery. |
| QA-011 | P1 | Open | Tray power flow ignores request status and reconnect has no terminal timeout. |
| QA-012 | P1 | Open | Hostname save does not verify the POST before entering reboot UI. |
| QA-013 | P1 | Open | OpenAI OAuth popup opens after an awaited request and has no blocked-popup recovery link. |
| QA-014 | P1 | Open | Store Installed view only filters loaded catalogue rows; unloaded installed apps disappear. |
| QA-015 | P1 | Open | Custom wallpaper delete button is nested inside another button. |
| QA-016 | P1 | Open | Files mutation/discard dialogs lack complete dialog semantics, focus containment, and Escape handling. |
| QA-017 | P1 | Open | ClawKeep has no change-passphrase action after encryption is configured. |
| QA-018 | P1 | Open | Remote Control/Browser can interpret unreadable status as not installed while also reporting a fetch error. |
| QA-019 | P2 | Open | Standalone Settings appearance callbacks and Store/install/uninstall state are incomplete. |
| QA-020 | P2 | Open | No mobile, Firefox/WebKit, accessibility, or broad visual-regression Playwright project exists. |

## False-green tests to harden

- Chat “streams a reply” does not assert the assistant reply.
- Installed-app settings does not toggle enablement despite its title.
- Main-to-beta precondition accepts any branch string.
- Power restart can ignore request failure and force-stop the test container.
- Store live install can install nothing and skip all useful follow-ups.
- Full-install desktop smoke claims Files/Terminal without opening them.
- Captive probes accept unrelated 404 responses.
- Wrong-password login checks only that the URL stays on `/login`.
- ClawKeep schedule checks only a heading; the live ClawKeep suite is skipped.

## Next order

1. Fix QA-006 through QA-012 with explicit failure-path tests.
2. Harden false-green PR tests so their names match what they prove.
3. Add mocked Email/WhatsApp/Discord/Remote state-machine coverage.
4. Add live spokes for Store, VNC input, System Update, webapps, and ClawKeep.
5. Add Hermes and mobile Playwright projects, then keyboard/a11y and browser matrix.
