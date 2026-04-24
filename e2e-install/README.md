# ClawBox full-install e2e harness

Runs the real `install.sh` + setup wizard + in-app updater inside a Docker
container that simulates JetPack 6.2 (L4T R36.4) as closely as is possible
without a Jetson Orin Nano Super board in the loop.

## What it covers

Spec files are numerically prefixed to enforce execution order — later
specs depend on state set up by earlier ones:

| Spec | Covers |
| ---- | ------ |
| `10-happy-path.spec.ts`       | `install.sh` → setup wizard end to end → desktop loads |
| `20-settings.spec.ts`         | System info/stats, preferences, hotspot, password rotate, update-branch |
| `30-files.spec.ts`            | mkdir, upload, list, read, delete — verified both via API and on-disk |
| `40-terminal.spec.ts`         | `/terminal-ws` PTY round-trip (`uname -a`) |
| `50-webapps.spec.ts`          | Code-assistant init → file write → build → `/setup-api/webapps` serves |
| `60-app-store.spec.ts`        | Live search against `openclawhardware.dev`, install + uninstall one skill |
| `70-browser.spec.ts`          | Real Chromium on Xvfb :99 via CDP; navigate to youtube.com, screenshot |
| `80-chat.spec.ts`             | Gateway health + ws-config + real chat round-trip (needs AI key) |
| `90-upgrade-main-to-beta.spec.ts` | In-app updater: pin `beta`, run, wait through restart, verify HEAD |
| `99-power.spec.ts`            | `/setup-api/system/power restart` — container exits, comes back with state |

## What it *doesn't* cover (and why)

Paths guarded by `CLAWBOX_TEST_MODE=1` because they need real hardware:

| Skipped step             | Reason |
| ------------------------ | ------ |
| `nvidia_jetpack`         | Jetson-only APT repo |
| `performance_mode`       | `nvpmodel` / `jetson_clocks` need Tegra |
| `jtop_install`           | Jetson-stats probes Tegra sysfs |
| `llamacpp_install`       | 20-30 min CUDA compile; no GPU in container |
| `chromium_install` (snap)| snap falls back to the Playwright-managed Chromium in test mode |
| `ai_tools_install`       | Claude/Codex/Gemini CLIs pull huge binaries |
| `cloudflared_install`    | tunneling needs real DNS |
| `ollama_install`         | 400 MB+ download; no GPU for local inference anyway |
| WiFi AP start/stop       | needs wireless radio |
| WiFi scan (`iw scan`)    | stubbed to a fixture network list |
| `nmcli` connect          | stubbed to always succeed |

VNC (`x11vnc` + `Xvfb` + `websockify`) **is** installed in test mode — it
runs fine in a `--privileged` container and is needed for browser automation
tests. Point a VNC/noVNC client at `localhost:6080` while tests run to watch
the container's virtual desktop.

Everything else runs for real: apt packages, git clone, bun install, next
build, OpenClaw npm install + patches, systemd service install, polkit, the
config store, and every setup-api route.

## Running

```bash
# One-time on an x86 host: register qemu for arm64 emulation
docker run --privileged --rm tonistiigi/binfmt --install arm64

# Full run (build + install + tests + teardown)
bash scripts/e2e-install.sh

# Reuse an already-booted container (skip global setup)
CLAWBOX_E2E_SKIP_SETUP=1 bash scripts/e2e-install.sh

# Force image rebuild
CLAWBOX_E2E_REBUILD=1 bash scripts/e2e-install.sh

# Keep the container up for inspection after tests
KEEP=1 bash scripts/e2e-install.sh
```

Expect ~15-25 min for the first run on x86 (qemu slowdown dominates).
Subsequent runs with `CLAWBOX_E2E_SKIP_SETUP=1` are fast.

On real Jetson hardware (arm64 host), no emulation is needed and the full
run finishes in ~3-5 min.

## Real AI providers

Copy `e2e-install/.env.test.example` to `e2e-install/.env.test` and fill in
any keys you want to exercise:

```ini
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
TELEGRAM_BOT_TOKEN=1234:...
```

Missing keys cause the matching test cases to skip rather than fail, so you
can iterate on one provider at a time.

## Debugging a failed install

```bash
# Tail the install log
docker compose -f e2e-install/docker-compose.test.yml exec clawbox \
  tail -f /var/log/clawbox-install.log

# Inspect systemd services
docker compose -f e2e-install/docker-compose.test.yml exec clawbox \
  systemctl status clawbox-setup.service clawbox-gateway.service

# Shell into the container
docker compose -f e2e-install/docker-compose.test.yml exec --user clawbox clawbox bash
```

## Restart simulation

`install.sh` contains `reboot` inside `step_rebuild_reboot`. When
`CLAWBOX_TEST_MODE=1` is set, that call is replaced by
`systemctl restart clawbox-setup.service` — the Next.js process goes down,
the updater's post-reboot `checkContinuation` fires on the next
`/setup-api/update/status` poll, and `post_update` runs. This is how the
upgrade test exercises the same "cross-restart" code path that would run on
a real reboot without actually stopping the container.

For tests that want to simulate a full container reboot, call
`composeRestart()` from `helpers/container.ts` — the `clawbox-home` volume
persists `data/`, `.next/standalone/`, `.update-branch`, etc., so state
survives the bounce just like a real power cycle.
