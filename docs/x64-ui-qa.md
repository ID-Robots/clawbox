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
  Update, Store/installed skills/web apps, Browser, Remote Desktop, OpenClaw,
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
| QA-016 | P1 | Open | Files mutation/discard dialogs lack complete dialog semantics, focus containment, and Escape handling. |
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
| QA-036 | P2 | Open | The System Update beta control and several Chat icon controls have incomplete accessible names. |
| QA-037 | P1 | Open | Files rows require pointer double-click and mutation/discard dialogs are incomplete for keyboard-only users. |
| QA-038 | P0 | Fixed | A healthy Codex plugin migrated from OpenClaw v1 could remain enabled without v2 capability consent, crash-looping the gateway even when a non-Codex model was primary. |

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

1. Close the current CI/review loop, then add reconnection recovery for QA-010.
2. Harden the remaining false-green power, Store, captive-probe, and ClawKeep tests.
3. Add mocked Email/WhatsApp/Discord/Remote state-machine coverage.
4. Add live spokes for Store, VNC input, System Update, web apps, and ClawKeep.
5. Add Hermes and mobile Playwright projects, then keyboard/a11y and browser matrix.
