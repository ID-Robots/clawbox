import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
