# System Update on a PC installed with `install-x64.sh`

These notes cover Settings → System Update (`src/lib/updater.ts`, `src/app/setup-api/update/*`) on an x86_64
desktop installed with `install-x64.sh` and **without** the `clawbox-x64-integration` .deb. The commands
below assume the default checkout, `~/clawbox`; use your own path if it differs.

## Root cause

1. **The updater could not tell this PC was a desktop.** It recognised only the .deb's
   `/etc/clawbox/x64-integration.env` (`hasX64DesktopIntegration`). `install-x64.sh` writes
   `/etc/clawbox/x64.env` instead (root:root 0644, with `CLAWBOX_USER`, `PROJECT_DIR` and `ROOT_INSTALLER`).
   So the updater took the Jetson appliance path.
2. **The appliance path relies on root steps this PC's dispatcher does not have.**
   `clawbox-root-update@<step>` runs `scripts/x64-migration/clawbox-x64-root-step.sh`. It implements
   `chpasswd`, `set_hostname`, and no-ops for `restart_ap` and `performance_mode`. It also forwards a fixed
   list of steps (`INSTALLER_STEPS`) to the root-owned installer copy. Any other step exits 64 with
   "has no implementation on the x64 install".
3. **The forwarded steps could not work either** (found by reading the code; not reproduced on the PC).
   The dispatcher never exported `CLAWBOX_USER`. `install-x64.sh` takes its user from `logname` or
   `SUDO_USER`, and a unit started by systemd has neither. So the installer stops at its first check:
   "could not resolve an unprivileged install user".
4. **Other Jetson-only machinery.** `openclaw_install` and `post_update` run under `withGatewayQuiesced`.
   That calls `sudo -n /usr/local/libexec/clawbox/clawbox-gateway-maintenance.sh`, which `install-x64.sh`
   neither installs nor grants. The appliance's gateway recovery also runs the legacy-state quarantine,
   which hard-codes `/home/clawbox`. The restart step's root unit (`rebuild_reboot`) **reboots** the
   machine.
5. **The repeated `set_timezone` failure.** The desktop's `TimezoneAdopter` posts the browser's zone on
   every desktop load. The route starts the `set_timezone` root step, and the x64 dispatcher had no such
   step. A failed OS leg leaves the "applied" marker unset on purpose, so it is retried. Result: an exit-64
   line in the journal at every boot or desktop load, even when the clock was already on the right zone.

`nvpmodel`, `nvidia_jetpack`, `performance_mode` and the Jetson apt repositories are not reached by an
update on any host. They are not in `UPDATE_STEPS`; that Jetson apt work lives inside `install.sh`, which
this PC never runs. The only reboot is in `install.sh`'s `step_rebuild_reboot`.

## Step by step

"Root" means `sudo -n clawbox-run-root-step.sh <step>`, which starts `clawbox-root-update@<step>.service`.

| Step | Jetson appliance (unchanged) | install-x64.sh PC, before | install-x64.sh PC, now |
|---|---|---|---|
| `bootstrap_updater` | root: install.sh fetches, resets and redeploys root files | exit 64; failFast, so **every update died here** | **owner**: `git fetch <remote> +refs/heads/<b>:refs/remotes/<remote>/<b>` (with retries), save local edits, `reset`/`checkout`/`reset`/`clean`. No root. |
| `apt_update` | root | forwarded; installer cannot resolve its user | root, best-effort (see below) |
| `chromium_install`, `vnc_install` | root | same as `apt_update` | root, best-effort |
| `openclaw_install` | root, gateway quiesced through the maintenance helper | quiesce refused (helper missing), and forwarded step fails | root, best-effort, **no outer quiesce** (install-x64.sh's own step stops and starts the gateway around its doctor run). A real failure still fails the update (failFast). |
| `openclaw_patch` | root | forwarded; fails | root, best-effort |
| `gateway_setup` | root (failFast) | exit 64 | root, best-effort. The new dispatcher checks the unit is installed, runs `daemon-reload` and clears a start-limit latch. It never rewrites the unit, because ports are chosen at install time. |
| `restart` | root `fix_git_perms`, owner git sync, root `rebuild_reboot` (do_rebuild, then **reboot**) | `fix_git_perms` fails; `rebuild_reboot` exits 64 | **owner**: the same git sync, then the continuation flag (old BUILD_ID), `bun install`, node-pty check, `.next` moved to `.next-old`, `bun run build` (one retry on the traced-file race), check BUILD_ID, `standalone/server.js` and `verify-build-identity.sh`, and **put the old build back on any failure**. Then the UI process sends itself SIGTERM; `clawbox-setup.service` (`Restart=always`) comes back on the new build. **Only the UI restarts; the PC never reboots.** No `fix_git_perms`: all Git work runs as the owner. |
| `post_update` | root (quiesced) | exit 64 | root, best-effort. The new dispatcher applies the recorded timezone and is never fatal; a failure is reported as a `CLAWBOX-WARN` card. |
| `hermes_edition` (Hermes only) | root | exit 64 | root, best-effort |
| `gateway_verify` | maintenance mask, pre-start, `doctor --fix`, legacy quarantine, plugin retry | worked only if the gateway was already up | wait for the gateway. If it is down, `restartGateway` (the restart is granted by install-x64.sh's sudoers rule), then wait again. If it stays down, report why from the gateway journal and the OpenClaw config check. The appliance repairs and the plugin retry are skipped: they need the maintenance helper. |
| continuation after restart | requires the `rebuild_reboot` unit not failed **and** a new BUILD_ID | — | requires a new BUILD_ID only. A failed `rebuild_reboot` result left by an older updater is ignored, because no root unit built this time. |

**Best-effort root steps.** The step runs through the launcher as before. If the installed root helper
**could not run it at all**, the step is marked done and one warning card (`x64-root-steps-skipped`) lists
the skipped steps and the command that installs a newer helper. "Could not run it at all" means one of
these, read from this run's journal (or, if the journal is unreadable, exit codes 64 and 69):

- no implementation (exit 64)
- installer copy missing (exit 69)
- installer could not resolve its user
- `Unknown step:`
- the launcher itself unreachable

A step that ran and failed is still a failure, reported with the same journal reading as on the appliance.
The half of the update after the restart gets its own card (`x64-root-steps-skipped:after-restart`).

**Settings → OpenClaw-only update** uses the same best-effort root steps. Its final gateway restart uses
the granted unit restart instead of the maintenance mask.

**Timezone.** On an install-x64.sh PC whose `/etc/localtime` already names the offered zone, the route
records the zone as applied without a root call. This is the usual case, so the failure at every
boot/load stops even before the root helper is updated. Any other zone still goes to root. If root refuses,
the message names the repair command. The new dispatcher implements `set_timezone` for real:

- the request is read **as the owner** (`runuser`), with `O_NOFOLLOW|O_NONBLOCK` and a plain-file check
- the same shape rule as install.sh
- `timedatectl list-timezones` decides what counts as a zone
- nothing is changed when the clock is already on that zone

**Detection.** `hasX64Install(projectDir)` in `src/lib/x64-integration.ts` uses the same gate as the
integration check:

- opened with `O_NOFOLLOW|O_NONBLOCK`
- regular file, uid 0, no group/other write, at most 4 KiB
- exactly one `PROJECT_DIR=<absolute path>`, which must match this checkout; the file is parsed, never
  sourced

The integration package wins when both are present. A missing file means "appliance". A file that fails
the gate stops the update with a repair message, as an unsafe integration file already does.
`rootStepRepairCommand` now also names `install-x64.sh --step root_step_contract` when `x64.env` exists.
Before, it pointed this PC at the appliance's `install.sh --step systemd_services`, which would install
Jetson units.

**Jetson behaviour is unchanged.** It makes the same calls in the same order. The restart step was split
into helpers without reordering anything, and a test pins it: `bootstrap_updater`, `fix_git_perms` and
`--no-block rebuild_reboot` still go to root, and the owner rebuild is never called.

## Files

- `src/lib/x64-integration.ts`: `hasX64Install`, and the shared root-owned reader.
- `src/lib/x64-install-update.ts` (new): journal classifier, warning card, owner rebuild with
  restore-on-failure, UI restart.
- `src/lib/updater.ts`: host routing in `runUpdate`, owner-run `bootstrap_updater`/`restart`, best-effort
  root steps, x64 gateway check, and a continuation that no longer reads the `rebuild_reboot` result.
- `src/lib/root-step-runner.ts`: repair command for install-x64.sh PCs.
- `src/app/setup-api/system/timezone/route.ts`: skips the root call when the clock is already on the
  zone (install-x64.sh PCs only).
- `scripts/x64-migration/clawbox-x64-root-step.sh`: `set_timezone`, `gateway_setup`, `post_update`, and
  exports `CLAWBOX_USER`/`CLAWBOX_DIR` to forwarded installer steps.
- `install-x64.sh` itself needed no change: `--step root_step_contract` already installs the dispatcher
  from `scripts/x64-migration`, and the web launcher's `WEB_ROOT_STEPS` already permits all three new
  steps.
- Tests:
  - `src/tests/unit/x64-integration.test.ts`
  - `src/tests/unit/x64-install-update.test.ts` (rebuild run for real against a scratch checkout)
  - `src/tests/unit/x64-root-step-dispatcher.test.ts` (dispatcher run for real in a sandbox copy)
  - `src/tests/unit/updater.test.ts` (x64 routing, plus "appliance path is unchanged")
  - `src/tests/routes/system/timezone-x64-install.test.ts`
  - `src/tests/unit/root-step-runner.test.ts`
  - two suites' mocks extended with `hasX64Install`

## What the owner has to do (once)

1. **Bring this release in by hand, once.** The fix is inside the updater, and the updater running now is
   the old one. It still dies at step 1, so it cannot install its own replacement. From the Terminal, once
   this branch is merged to the branch the PC follows (`.update-branch`):

   ```bash
   cd ~/clawbox
   git fetch origin && git reset --hard "origin/$(cat .update-branch)"
   bun install && bun run build
   sudo systemctl restart clawbox-setup
   ```

   `sudo bash install-x64.sh --step git_pull` followed by `--step build` does the same as the git and bun
   lines. `git reset --hard` discards uncommitted edits in the checkout, as the updater does after saving
   them.
2. **Install the new root helper:**

   ```bash
   sudo bash ~/clawbox/install-x64.sh --step root_step_contract
   ```

   This copies the new `clawbox-x64-root-step.sh` to `/usr/local/libexec/clawbox/clawbox-root-step.sh`
   and refreshes the root-owned installer copy and `/etc/clawbox/x64.env`. Until it is run:
   - **System Update still works.** The steps the old helper cannot run are skipped, with one card that
     names this command.
   - `set_timezone` still fails, but only when the clock is **not** already on the requested zone.
   - The forwarded installer steps (apt, Chromium, VNC, OpenClaw) keep being skipped, because the old
     dispatcher does not pass them a user.
3. Re-run step 2 whenever a future release changes `scripts/x64-migration/clawbox-x64-root-step.sh`. Root
   never runs the checkout's copy, so a newer dispatcher arrives only this way.

## Not verified here / left alone

- **Nothing was run on the live system.** No `sudo`, no `bun run build`, no service restarts, no reads
  of `/etc` beyond confirming that `x64.env` exists. The logname/SUDO_USER failure of forwarded steps
  comes from reading the code, not from this PC's journal. If that PC's journal shows exit 64 for every
  step, its installed dispatcher is older than this checkout's; both cases are handled the same way.
- While the owner build runs, the old server keeps serving the update screen. Pages it has not loaded yet
  may fail until the restart. On the appliance the dashboard is fully down for the build.
- Pre-existing, not changed: after the restart, the continuation marks every step before `restart` as
  completed without reading which ones failed earlier. `docs/x64-ui-qa.md` still says install-x64.sh
  installs no root-update template, which is no longer true. No test pins the x64 launcher's
  `WEB_ROOT_STEPS` against `src/lib/root-steps.ts`.
