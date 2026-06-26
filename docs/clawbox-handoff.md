# ClawBox setup-wizard work — handoff (2026-06-01)

Repo: `C:\Users\USER\clawbox` (origin `id-robots/clawbox`). Stack: Next.js 16 / React 19 / Bun build, runs on a Jetson. Setup wizard = `src/components/SetupWizard.tsx` (5 steps: WiFi → Update → Security → AI → Telegram); Step 1 = `src/components/WifiStep.tsx`.

## Where things stand

**v3.0.7 is SHIPPED** — merged to `main`, tagged `v3.0.7`, GitHub release cut, closed #149/#150/#151 (gateway-token security, post-update smokes), also carried #152 (codex pin) + #157 (Telegram toggle + chat reconnect bar). Devices auto-update (tag-based updater). `#114` (e2e specs flaky on GitHub Actions only) was **reopened** — closed by a reverted commit's keyword; the 6 specs are still `test.fixme()`'d. Not fixed; needs an evidence-first pass (pull the Playwright trace/console from a failing CI run before guessing — timeout bumps and the prod-build approach already failed).

**Two feature branches are DONE + verified but NOT PR'd** (standing user rule: *never open a PR until the user explicitly says so* — see `clawbox-workflow.md`). The colleague's main job is to take these through the PR flow. They are **stacked**:

1. `feature/wifi-wrong-password-feedback` (off `beta`) — verified on hardware.
   - Setup Step 1 now shows **"Wrong WiFi password"** when the WPA handshake fails, instead of the box silently vanishing. Single-radio handoff: connect runs fire-and-forget, the wizard polls a new status endpoint across the AP outage.
   - Verified on box: wrong password → ~50s → `failed/wrong-password`; correct password → ~11s → `connected`.

2. `feature/setup-step1-ethernet-first` (off branch #1, so it INCLUDES it) — built, deployed, **adversarially reviewed (3 findings applied)**.
   - Ethernet-first Step 1: recommends Ethernet, **polls cable status live (3.5s)**, shows connected / "getting internet…" / recommend-a-cable / after-15s "cable but no internet — check cable or use Wi-Fi" nudge; gates "Continue with Ethernet" on a real connection; Wi-Fi is the labelled alternative.
   - Fixed a real backend bug in `getEthernetStatus` (`state.includes("connected")` also matched `"disconnected"` → unplugged ethernet read as connected) + added a real `/sys/class/net/<iface>/carrier` physical-link read; returns `{connected, cable, iface}`.
   - Verified on box: build ✓, unit tests 22/22 ✓, live `{"connected":true,"cable":true,"iface":"enP8p1s0"}` ✓. UI button layout was reported broken and **fixed** (stacked full-width buttons).

Per-file details, rationale, and test results are in the **commit messages** on each branch (don't duplicate here): `git log beta..feature/wifi-wrong-password-feedback` and `git log feature/wifi-wrong-password-feedback..feature/setup-step1-ethernet-first`.

## What the colleague needs to do

1. **Decide PR structure** for the two stacked branches — either one combined "setup Step 1 improvements" PR, or sequence wrong-password first then ethernet. Both touch `WifiStep.tsx` (that's why ethernet was branched off wrong-password, to avoid conflicts).
2. Follow the repo workflow (`clawbox-workflow.md`): **`/simplify` the diff → push → PR with `--base beta` → let CodeRabbit review → merge to beta → separate beta→main promotion PR (`Closes` keywords) + version bump to v3.0.8 + GitHub release.** Use the **KrasimirKralev** GitHub account; **no "🤖 Generated with Claude Code" footer** in PR bodies.
3. After merge, the in-app updater ships it (tag-based). NB: a *manual* SSH deploy (git pull + build + restart) does **not** equal an update — it skips `gateway_setup`/`openclaw_install`; see `clawbox-update-mechanism-gotchas.md`.

## Test box (the unit used all session)

- `clawbox.local` → currently `192.168.50.194` (ethernet `enP8p1s0`) — the user **switched networks** mid-session, so the IP/mDNS may move again; re-resolve `clawbox.local`. Host-key fingerprint: `SHA256:WKCQFKqumBCYbuOcNdxZotXW3U8GKOamU7yl2aEf8Ro`.
- Credentials: this unit uses the **default device password** (see `clawbox-credentials.md` in memory; do not hardcode). SSH **key auth is currently failing** on it — use **plink** (PuTTY; `sshpass` doesn't work on Windows) at `%TEMP%\plink.exe` with `-batch -hostkey <fp> -pw <pw>`. Re-adding the pubkey to `~/.ssh/authorized_keys` restores native `ssh`.
- State: **reset to Step 1** (`data/config.json` set to `{}`, backed up to `data/config.json.preEthTest.bak`). Running `feature/setup-step1-ethernet-first`. **ClawBox-Setup AP is broadcasting** (a leftover `probe-net` profile with autoconnect=yes was deleted so the single radio is free for the AP).
- Single-radio gotcha (recurring theme): the WiFi chip reports `interface combinations are not supported` — it can host the setup AP **or** join a network, never both. This underlies the WiFi-connect handoff and the "ClawBox-Setup not visible" issue.

## Watch-outs

- Working tree has a stray Windows reserved file named `NUL` (untracked) that makes `git add -A` fail — **add specific files**, don't use `-A`.
- `translations.ts` has all keys repeated in **10 locale blocks** — new i18n keys must go in all 10 (anchor each insert on a per-locale unique value line; key names repeat so they're not unique anchors). i18n falls back to English for missing keys.
- The box's `getEthernetStatus` "connected" = link-level NM connection (not internet reachability); the `cable` field = physical carrier.

## Suggested skills (next session)
- **`/simplify`** — run on each branch diff before the PR (the workflow requires it).
- **`code-review`** (or `/code-review`) — correctness pass on the diffs before merge.
- **`verify`** / **`run`** — to drive the wizard on the box and confirm the Step-1 Ethernet/WiFi UX visually.
- The **superpowers** workflow skills if doing more multi-step feature work; **claude-md-management:revise-claude-md** since `CLAUDE.md` still says "7-step wizard / DoneStep" but the live flow is 5 steps (Local-AI step removed).

## Memory references
`~/.claude/projects/C--Users-USER/memory/`: `MEMORY.md` (index), `clawbox-workflow.md` (branch/PR rules — **read this first**), `clawbox-update-mechanism-gotchas.md` (update/deploy + plink SSH), `clawbox-credentials.md` (device password).
