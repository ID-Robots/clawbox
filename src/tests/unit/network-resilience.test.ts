import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = process.cwd();
const SOURCE_DISPATCHER = path.join(REPO, "scripts/nm-dispatcher-failover.sh");
const GATEWAY_WRAPPER = path.join(REPO, "scripts/run-openclaw-gateway.sh");
const CHANNEL_RECOVERY = path.join(REPO, "scripts/recover-openclaw-channels.sh");
const NETWORK_READINESS = path.join(REPO, "scripts/network-readiness.sh");

function executable(file: string, body: string): void {
  writeFileSync(file, body.replace(/^\n/, ""), { mode: 0o755 });
}

describe("ClawBox network-aware Gateway lifecycle", () => {
  let root: string;
  let bin: string;
  let log: string;
  let state: string;
  let dispatcher: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "clawbox-network-resilience-"));
    bin = path.join(root, "bin");
    log = path.join(root, "calls.log");
    state = path.join(root, "state");
    dispatcher = path.join(root, "nm-dispatcher-failover.sh");
    mkdirSync(bin);

    executable(
      path.join(bin, "logger"),
      `#!/usr/bin/env bash
printf 'logger %s\\n' "$*" >>"$MOCK_LOG"
`,
    );
    executable(
      path.join(bin, "ip"),
      `#!/usr/bin/env bash
[ "\${MOCK_ROUTE_READY:-0}" = "1" ]
`,
    );
    executable(
      path.join(bin, "curl"),
      `#!/usr/bin/env bash
if [ "\${MOCK_ROUTE_READY:-0}" = "1" ]; then printf '204'; exit 0; fi
exit 7
`,
    );
    executable(
      path.join(bin, "systemctl"),
      `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >>"$MOCK_LOG"
exit 0
`,
    );
    executable(
      path.join(bin, "nmcli"),
      `#!/usr/bin/env bash
case "$*" in
  '-t -f TYPE,STATE device status') printf 'ethernet:disconnected\\nwifi:disconnected\\n' ;;
  '-t -f NAME,DEVICE connection show --active') ;;
  '-t -f TYPE,STATE,DEVICE device status') printf 'wifi:disconnected:wlP1p1s0\\n' ;;
  '-t -f NAME,TYPE,AUTOCONNECT-PRIORITY connection show')
    [ "\${MOCK_WIFI_PROFILE:-0}" = "1" ] && printf 'HomeWifi:802-11-wireless:10\\n'
    ;;
  'connection up HomeWifi ifname wlP1p1s0') [ "\${MOCK_WIFI_CONNECTS:-0}" = "1" ] ;;
  *) printf 'unexpected nmcli: %s\\n' "$*" >&2; exit 2 ;;
esac
`,
    );
    executable(
      path.join(bin, "openclaw"),
      `#!/usr/bin/env bash
printf 'openclaw skip=%s %s\\n' "\${OPENCLAW_SKIP_CHANNELS:-}" "$*" >>"$MOCK_LOG"
if [ "\${1:-}" = gateway ] && [ "\${2:-}" != call ]; then exit 0; fi
if [ "\${1:-} \${2:-}" = 'channels status' ]; then
  if [ "\${MOCK_CHANNEL_MODE:-suppressed}" = auth-failure ]; then
    printf '%s\\n' '{"channelAccounts":{"telegram":[{"accountId":"alfred","enabled":true,"configured":true,"running":false,"connected":false,"lastError":"unauthorized","probe":{"ok":true}},{"accountId":"default","enabled":true,"configured":true,"running":true,"connected":true,"lastError":null,"probe":{"ok":true}}]}}'
  elif [ -f "$MOCK_STATE" ]; then
    printf '%s\\n' '{"channelAccounts":{"telegram":[{"accountId":"alfred","enabled":true,"configured":true,"running":true,"connected":true,"lastError":null,"probe":{"ok":true}},{"accountId":"default","enabled":true,"configured":true,"running":true,"connected":true,"lastError":null,"probe":{"ok":true}}]}}'
  else
    printf '%s\\n' '{"channelAccounts":{"telegram":[{"accountId":"alfred","enabled":true,"configured":true,"running":false,"connected":false,"lastError":"gateway restart-loop breaker tripped; suppressing channel auto-start","probe":{"ok":true}},{"accountId":"default","enabled":true,"configured":true,"running":true,"connected":true,"lastError":null,"probe":{"ok":true}}]}}'
  fi
  exit 0
fi
if [ "\${1:-} \${2:-} \${3:-}" = 'gateway call channels.start' ]; then
  : >"$MOCK_STATE"
  printf '%s\\n' '{"started":true}'
  exit 0
fi
exit 2
`,
    );

    copyFileSync(SOURCE_DISPATCHER, dispatcher);
    const dispatcherText = readFileSync(dispatcher, "utf8").replace(
      "/usr/local/libexec/clawbox/network-readiness.sh",
      NETWORK_READINESS,
    );
    writeFileSync(dispatcher, dispatcherText);
    chmodSync(dispatcher, 0o755);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      MOCK_LOG: log,
      MOCK_STATE: state,
      CLAWBOX_NETWORK_READINESS_LIB: NETWORK_READINESS,
      CLAWBOX_OPENCLAW_BIN: path.join(bin, "openclaw"),
      CLAWBOX_CHANNEL_RECOVERY_VERIFY_ATTEMPTS: "1",
      CLAWBOX_CHANNEL_RECOVERY_VERIFY_DELAY_SECONDS: "0",
      ...overrides,
    };
  }

  function run(script: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
    return spawnSync(script, args, { env: env(overrides), encoding: "utf8", timeout: 15_000 });
  }

  function calls(): string {
    try {
      return readFileSync(log, "utf8");
    } catch {
      return "";
    }
  }

  it("does not restart the Gateway when Ethernet drops without a replacement route", () => {
    const result = run(dispatcher, ["enP8p1s0", "down"]);
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).not.toContain("restart clawbox-gateway.service");
  });

  it("restarts only after successful Wi-Fi failover has a public route", () => {
    const result = run(dispatcher, ["enP8p1s0", "down"], {
      MOCK_ROUTE_READY: "1",
      MOCK_WIFI_PROFILE: "1",
      MOCK_WIFI_CONNECTS: "1",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toContain("restart clawbox-gateway.service");
    expect(calls()).toContain("restart clawbox-channel-recovery.timer");
  });

  it("does not restart on Ethernet up until the public route is ready", () => {
    const result = run(dispatcher, ["enP8p1s0", "up"]);
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).not.toContain("restart clawbox-gateway.service");
  });

  it("defers channel autostart when the Gateway starts offline", () => {
    const result = run(GATEWAY_WRAPPER, ["--allow-unconfigured"]);
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toContain("openclaw skip=1 gateway --allow-unconfigured");
  });

  it("starts channels normally when the Gateway has a public route", () => {
    const result = run(GATEWAY_WRAPPER, ["--allow-unconfigured"], { MOCK_ROUTE_READY: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toContain("openclaw skip= gateway --allow-unconfigured");
  });

  it("starts only the breaker-suppressed account and verifies connected state", () => {
    const result = run(CHANNEL_RECOVERY, [], { MOCK_ROUTE_READY: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toContain("gateway call channels.start");
    expect(calls()).toContain('"accountId":"alfred"');
    expect(calls()).not.toContain('"accountId":"default"');
  });

  it("does not override an authentication failure", () => {
    const result = run(CHANNEL_RECOVERY, [], {
      MOCK_ROUTE_READY: "1",
      MOCK_CHANNEL_MODE: "auth-failure",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).not.toContain("gateway call channels.start");
  });
});

describe("network-resilience installation boundary", () => {
  const install = readFileSync(path.join(REPO, "install.sh"), "utf8");
  const dispatcher = readFileSync(SOURCE_DISPATCHER, "utf8");

  it("installs the shared helper outside the clawbox-writable project tree", () => {
    expect(install).toContain('install -o root -g root -m 0644 "$HELPER_SRC" "$HELPER_DEST"');
    expect(dispatcher).toContain('/usr/local/libexec/clawbox/network-readiness.sh');
    expect(dispatcher).toContain("unset CLAWBOX_IP_BIN CLAWBOX_CURL_BIN");
  });

  it("installs and activates channel recovery only for OpenClaw-capable editions", () => {
    expect(install).toContain("if has_openclaw_harness; then\n  EXPECTED_ACTIVE_SERVICES+=(clawbox-channel-recovery.timer)");
    expect(install).toContain("systemctl enable --now clawbox-channel-recovery.timer");
  });
});
