# ClawBox full-install e2e harness

Runs the real `install.sh` + setup wizard + in-app updater inside a Docker
container that simulates JetPack 6.2 (L4T R36.4) as closely as is possible
without a Jetson Orin Nano Super board in the loop.

## What it covers

- **Fresh install** (`happy-path.spec.ts`): boots a clean Ubuntu 22.04 arm64
  container, runs `install.sh`, walks through every step of the setup wizard
  via the real `/setup-api/*` routes, and verifies the desktop loads after
  `setup/complete`.
- **In-app upgrade** (`upgrade-main-to-beta.spec.ts`): pins `.update-branch`
  to `beta`, triggers the updater, waits for the service restart that
  replaces the Jetson `reboot`, and verifies git HEAD advanced and prior
  setup state was preserved.

## What it *doesn't* cover (and why)

Paths guarded by `CLAWBOX_TEST_MODE=1` because they need real hardware:

| Skipped step             | Reason |
| ------------------------ | ------ |
| `nvidia_jetpack`         | Jetson-only APT repo |
| `performance_mode`       | `nvpmodel` / `jetson_clocks` need Tegra |
| `jtop_install`           | Jetson-stats probes Tegra sysfs |
| `llamacpp_install`       | 20-30 min CUDA compile; no GPU in container |
| `chromium_install`       | `snap` won't run inside a standard container |
| `vnc_install`            | x11vnc needs a DRM device |
| `ai_tools_install`       | Claude/Codex/Gemini CLIs pull huge binaries |
| `cloudflared_install`    | tunneling needs real DNS |
| WiFi AP start/stop       | needs wireless radio |
| WiFi scan (`iw scan`)    | stubbed to a fixture network list |
| `nmcli` connect          | stubbed to always succeed |

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
