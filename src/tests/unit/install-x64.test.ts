import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
//
// It covers the tests and their hooks, not the `spawnSync` on the module line
// below: that one runs during COLLECTION, which neither ceiling governs.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const INSTALLER = path.resolve(process.cwd(), "install-x64.sh");
const SOURCE = readFileSync(INSTALLER, "utf8");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

function v2SeedProgram(): string {
  const start = SOURCE.indexOf("import json, os, re, secrets, tempfile");
  const end = SOURCE.indexOf("\nPY", start);
  if (start < 0 || end < 0) throw new Error("OpenClaw 2 seed block not found");
  return SOURCE.slice(start, end);
}

/**
 * `step_openclaw_install`'s pin read, from its `local PIN_FILE=` line down to
 * the fallback that defines the empty case. Sliced rather than retyped so the
 * test cannot drift from the shipped line.
 */
function pinReadBlock(): string {
  const start = SOURCE.indexOf('  local PIN_FILE="$PROJECT_DIR/config/openclaw-target.txt"');
  const marker = 'TARGET="${TARGET:-$OPENCLAW_VERSION}"';
  const end = SOURCE.indexOf(marker, start);
  if (start < 0 || end < 0) throw new Error("OpenClaw pin read not found");
  return SOURCE.slice(start, end + marker.length);
}

function openclawPatchFunction(): string {
  const start = SOURCE.indexOf("step_openclaw_patch() {");
  const end = SOURCE.indexOf("\n}\n\nstep_openclaw_config()", start);
  if (start < 0 || end < 0) throw new Error("OpenClaw patch function not found");
  return SOURCE.slice(start, end + 2);
}

describe("install-x64.sh safety contracts", () => {
  it("refuses an unresolved or explicit root service user", () => {
    expect(SOURCE).toContain('[ -z "$CLAWBOX_USER" ] || [ "$CLAWBOX_USER" = "root" ]');
    expect(SOURCE).toContain("could not resolve an unprivileged install user");
  });

  it("refuses to overlay the managed Node symlink onto a real directory", () => {
    expect(SOURCE.match(/\[ -e "\$NODE_DIST_ROOT" \] && \[ ! -L "\$NODE_DIST_ROOT" \]/g)).toHaveLength(2);
  });

  it("downloads NodeSource before executing it and quotes the project directory", () => {
    expect(SOURCE).not.toMatch(/setup_22\.x\s*\|\s*bash/);
    expect(SOURCE).toContain('curl -fsSL -o "$nodesource_script"');
    expect(SOURCE).toContain(String.raw`cd \"$PROJECT_DIR\" && \"$BUN\" install`);
    expect(SOURCE).toContain(String.raw`PLAYWRIGHT_BROWSERS_PATH=\"$PLAYWRIGHT_PATH\" \"$BUN\" x playwright install chromium`);
  });

  it("grants the updater exact runtime gateway mask and unmask commands", () => {
    expect(SOURCE).toContain("/usr/bin/systemctl --runtime mask $GATEWAY_SERVICE");
    expect(SOURCE).toContain("/usr/bin/systemctl --runtime unmask $GATEWAY_SERVICE");
    expect(SOURCE).not.toMatch(/systemctl --runtime (?:mask|unmask) \*/);
  });

  it("patches every gateway file when the configured home contains spaces", () => {
    const root = mkdtempSync(path.join(tmpdir(), "clawbox-x64-spaced-path-"));
    try {
      const clawboxHome = path.join(root, "owner home");
      const gatewayDist = path.join(clawboxHome, ".npm global", "openclaw", "gateway dist");
      mkdirSync(gatewayDist, { recursive: true });
      const gatewayFile = path.join(gatewayDist, "gateway runtime.js");
      writeFileSync(gatewayFile, [
        "if (scopes.length > 0) {",
        'const reason = "reject-device-required";',
        'if (roleCanSkipDeviceIdentity(params.role, params.sharedAuthOk)) return { kind: "allow" };',
      ].join("\n"));

      execFileSync("bash", ["-c", [
        "openclaw_is_v2() { return 1; }",
        "as_user_runtime() { :; }",
        openclawPatchFunction(),
        "step_openclaw_patch",
      ].join("\n")], {
        env: {
          ...process.env,
          CLAWBOX_HOME: clawboxHome,
          GATEWAY_DIST: gatewayDist,
          OPENCLAW_BIN: "/bin/true",
        },
      });

      const patched = readFileSync(gatewayFile, "utf8");
      expect(patched).toContain("scopes.length > 0 && !(isControlUi && allowControlUiBypass)");
      expect(patched).toContain("controlUiAuthPolicy.allowBypass) return");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The read-only host preflight, from `unit_user() {` down to (not including)
 * the `--preflight` dispatch. Sliced so the test runs the shipped code.
 */
function preflightBlock(): string {
  const start = SOURCE.indexOf("unit_user() {");
  const end = SOURCE.indexOf('if [ "${1:-}" = "--preflight" ]; then', start);
  if (start < 0 || end < 0) throw new Error("preflight block not found");
  return SOURCE.slice(start, end);
}

describe("install-x64.sh shared-host preflight", () => {
  /**
   * Run `preflight_host` with the host probes replaced by stubs. Bash resolves
   * a function before a command of the same name, so `pgrep` and `stat` are
   * shadowed the same way as the script's own helpers.
   */
  function runPreflight(stubs: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
    const r = spawnSync("bash", ["-c", [
      "set -uo pipefail",
      "CLAWBOX_USER=clawbox",
      "CLAWBOX_HOME=/home/clawbox",
      'OPENCLAW_HOME="${OPENCLAW_HOME:-/home/clawbox/.openclaw}"',
      "PROJECT_DIR=/nonexistent/clawbox",
      "UI_SERVICE=clawbox-setup.service",
      "GATEWAY_SERVICE=clawbox-gateway.service",
      'PORT="${PORT:-3005}"',
      'GATEWAY_PORT="${GATEWAY_PORT:-18789}"',
      'TERMINAL_WS_PORT="${TERMINAL_WS_PORT:-3006}"',
      'SKIP_DESKTOP_SERVICES="${SKIP_DESKTOP_SERVICES:-0}"',
      preflightBlock(),
      // Clean-host defaults; a case overrides what it needs.
      "port_listener_pids() { :; }",
      "pid_in_unit() { return 1; }",
      "unit_user() { :; }",
      "pgrep() { :; }",
      "stat() { echo clawbox; }",
      ...stubs,
      "preflight_host",
    ].join("\n")], { encoding: "utf-8", timeout: 30_000, env: { ...process.env, ...env } });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("passes on a clean host and reports the effective ports", () => {
    const r = runPreflight([], { GATEWAY_PORT: "18795", TERMINAL_WS_PORT: "3016", SKIP_DESKTOP_SERVICES: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("Preflight OK");
    expect(r.out).toContain("gateway=18795");
    expect(r.out).toContain("desktop-units=skip");
  });

  it("refuses a port held by a process outside the ClawBox units and names the knob", () => {
    const r = runPreflight(['port_listener_pids() { [ "$1" = "18789" ] && echo 4242 || true; }']);
    expect(r.status).toBe(1);
    expect(r.out).toContain("port 18789 is already taken by PID 4242");
    expect(r.out).toContain("CLAWBOX_GATEWAY_PORT=<port>");
    expect(r.out).toContain("nothing was changed");
  });

  it("accepts a port held by our own unit", () => {
    const r = runPreflight([
      'port_listener_pids() { [ "$1" = "18789" ] && echo 4242 || true; }',
      'pid_in_unit() { [ "$1" = "4242" ] && [ "$2" = "clawbox-gateway.service" ]; }',
    ]);
    expect(r.status).toBe(0);
  });

  it("refuses to reconfigure a user whose OpenClaw gateway runs outside clawbox-gateway.service", () => {
    const r = runPreflight(["pgrep() { echo 777; }"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("already runs an OpenClaw gateway (PID 777) outside clawbox-gateway.service");
    expect(r.out).toContain("CLAWBOX_USER=clawbox");
  });

  it("refuses an openclaw.json owned by another user", () => {
    const home = mkdtempSync(path.join(tmpdir(), "clawbox-x64-foreign-home-"));
    try {
      writeFileSync(path.join(home, "openclaw.json"), "{}\n");
      const r = runPreflight(["stat() { echo nexus0; }"], { OPENCLAW_HOME: home });
      expect(r.status).toBe(1);
      expect(r.out).toContain("owned by 'nexus0', not 'clawbox'");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to re-point a unit that runs as another user, and lets the desktop units be skipped", () => {
    const owned = 'unit_user() { case "$1" in clawbox-vnc.service|clawbox-setup.service) echo nexus0 ;; esac; }';
    const managed = runPreflight([owned]);
    expect(managed.status).toBe(1);
    expect(managed.out).toContain("clawbox-setup.service currently runs as 'nexus0'");
    expect(managed.out).toContain("clawbox-vnc.service runs as 'nexus0'");
    expect(managed.out).toContain("CLAWBOX_SKIP_DESKTOP_SERVICES=1");

    const skipped = runPreflight([owned], { SKIP_DESKTOP_SERVICES: "1" });
    expect(skipped.status).toBe(1);
    expect(skipped.out).toContain("clawbox-setup.service currently runs as 'nexus0'");
    expect(skipped.out).not.toContain("clawbox-vnc.service runs as");
  });

  it("refuses three ports that are not distinct", () => {
    const r = runPreflight([], { PORT: "3005", GATEWAY_PORT: "3005" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("must be three different ports");
  });

  it("runs before the first counted step and exposes --preflight", () => {
    expect(SOURCE).toContain('if [ "${1:-}" = "--preflight" ]; then');
    const preflightCall = SOURCE.indexOf("\npreflight_host\n");
    const firstLog = SOURCE.indexOf('\nlog "');
    expect(preflightCall).toBeGreaterThan(0);
    expect(preflightCall).toBeLessThan(firstLog);
  });

  it("threads the configured ports into the units and the readiness wait", () => {
    expect(SOURCE).toContain("Environment=OPENCLAW_GATEWAY_PORT=$GATEWAY_PORT");
    expect(SOURCE).toContain("Environment=GATEWAY_PORT=$GATEWAY_PORT");
    expect(SOURCE).toContain("Environment=TERMINAL_WS_PORT=$TERMINAL_WS_PORT");
    expect(SOURCE).toContain('wait_for_http "http://127.0.0.1:$GATEWAY_PORT"');
    expect(SOURCE).not.toContain('wait_for_http "http://127.0.0.1:18789"');
  });
});

describe("install-x64.sh pinned-target read", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "clawbox-x64-pin-"));
  });
  afterEach(() => {
    try {
      chmodSync(path.join(root, "config", "openclaw-target.txt"), 0o644);
    } catch {
      /* not every case writes one */
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** Run the shipped slice under the installer's own `set -euo pipefail`. */
  function readPin(): { status: number | null; out: string } {
    const file = path.join(root, "pin-block.sh");
    writeFileSync(
      file,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "step_openclaw_install() {",
        pinReadBlock(),
        '  echo "TARGET=$TARGET"',
        "}",
        "step_openclaw_install",
        'echo "REACHED_END=1"',
      ].join("\n"),
    );
    const r = spawnSync("bash", [file], {
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        PROJECT_DIR: root,
        OPENCLAW_VERSION: "2026.8.1",
        OPENCLAW_PIN_VERSION: "",
      },
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it("reads the pin when it can", () => {
    mkdirSync(path.join(root, "config"), { recursive: true });
    writeFileSync(path.join(root, "config", "openclaw-target.txt"), "2026.7.4\n");
    const r = readPin();
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("TARGET=2026.7.4");
  });

  it.skipIf(isRoot)("carries on when the pin file exists but cannot be read", () => {
    // The third copy of the read `install.sh:2245` and `gateway-pre-start.sh:45`
    // both guard. Under `set -euo pipefail` (install-x64.sh:16) an unreadable
    // pin file makes `head` fail, pipefail carries it into the assignment, and
    // the installer aborts — from `step_openclaw_setup`, which is called in
    // plain command position, so errexit is NOT suppressed. An unknown pin is
    // already a defined state here (the fallback on the next line); an aborted
    // install is not.
    mkdirSync(path.join(root, "config"), { recursive: true });
    const pin = path.join(root, "config", "openclaw-target.txt");
    writeFileSync(pin, "2026.7.4\n");
    chmodSync(pin, 0o000);
    const r = readPin();
    expect(r.status, `the installer aborted:\n${r.out}`).toBe(0);
    expect(r.out).toContain("REACHED_END=1");
    // And it falls back to the hardcoded version rather than an empty target.
    expect(r.out).toContain("TARGET=2026.8.1");
    // Not silently: the operator is told the pin did not apply.
    expect(r.out).toMatch(/WARN/);
  });
});

describe.skipIf(!hasPython3)("install-x64.sh OpenClaw 2 token seeding", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clawbox-x64-seed-"));
    configPath = path.join(dir, "openclaw.json");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seed(token: unknown): unknown {
    writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token } } }));
    execFileSync("python3", ["-c", v2SeedProgram()], {
      env: { ...process.env, OPENCLAW_CONFIG: configPath, CLAWBOX_PORT: "3005" },
    });
    return JSON.parse(readFileSync(configPath, "utf8")).gateway.auth.token;
  }

  it("preserves environment interpolation", () => {
    expect(seed("${GW}")).toBe("${GW}");
  });

  it("preserves canonical SecretRef objects", () => {
    const ref = { source: "file", provider: "default", id: "gateway-token" };
    expect(seed(ref)).toEqual(ref);
  });

  it("rotates the public legacy literal", () => {
    expect(seed("clawbox")).toMatch(/^[a-f0-9]{64}$/);
  });
});
