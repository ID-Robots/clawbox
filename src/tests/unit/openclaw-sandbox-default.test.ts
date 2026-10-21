import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts real processes (bash, node, python3): vitest's 5 s default is not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The agent tool sandbox default: OpenClaw's `agents.defaults.sandbox`.
//
// The decision this pins: rootless Podman as the backend, every session except
// the owner's main chat sandboxed ("non-main") once the owner turns the switch
// on, and the switch OFF until the cost has been measured on a Nano. The
// container gets 512 MB of memory and no swap on top. ClawBox's own MCP tools
// stay usable inside the sandbox through `tools.sandbox.tools`.
//
// Every writer of the key runs here out of the SHIPPED scripts, not copies:
//   install.sh step_openclaw_config      a fresh install and every update;
//   install-x64.sh step_openclaw_config  the same on an x64 PC;
//   gateway-pre-start.sh                 every gateway start, which is how a
//                                        box already in the field gets the key.

const REPO = process.cwd();
const INSTALL = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const INSTALL_X64 = readFileSync(path.join(REPO, "install-x64.sh"), "utf-8");
const PRE_START = readFileSync(path.join(REPO, "scripts", "gateway-pre-start.sh"), "utf-8");

const STORE_KEY = "clawbox_agent_sandbox_enabled";
const MODE_ON = "non-main";
const MODE_OFF = "off";
const MCP_GLOB = "clawbox__*";

const canRun =
  process.platform !== "win32"
  && spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0
  && spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const d = canRun ? describe : describe.skip;

/**
 * A top-level shell function out of a script, from its `name() {` line to its
 * closing `}`. Heredoc-aware: step_openclaw_config carries a node heredoc whose
 * JavaScript has lines that are a lone `}` too.
 */
function shellFunction(src: string, name: string, file: string): string {
  const lines = src.split("\n");
  const first = lines.indexOf(`${name}() {`);
  if (first < 0) throw new Error(`${name}() is not in ${file}`);
  let heredoc: string | null = null;
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i];
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const opened = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (opened) heredoc = opened[1];
    else if (line === "}") return lines.slice(first, i + 1).join("\n");
  }
  throw new Error(`${name}() in ${file} has no closing brace`);
}

/** The pre-start's sandbox section, up to the section after it. */
function preStartBlock(): string {
  const from = "# ── The agent tool sandbox ";
  const to = "# ── Installing a ClawBox hook plugin into ~/.openclaw/extensions ";
  const start = PRE_START.indexOf(from);
  if (start < 0) throw new Error("the agent tool sandbox section is not in gateway-pre-start.sh");
  const end = PRE_START.indexOf(to, start);
  if (end < 0) throw new Error("the section after the agent tool sandbox is not in gateway-pre-start.sh");
  return PRE_START.slice(start, end);
}

const q = (s: string) => JSON.stringify(s);

let dir: string;
let projectDir: string;
let home: string;
let configPath: string;
let storePath: string;
let logPath: string;
let fakeOpenclaw: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-sandbox-default-"));
  projectDir = path.join(dir, "clawbox");
  home = path.join(dir, "home");
  configPath = path.join(home, ".openclaw", "openclaw.json");
  storePath = path.join(projectDir, "data", "config.json");
  logPath = path.join(dir, "openclaw.log");
  fakeOpenclaw = path.join(dir, "bin", "openclaw");
  mkdirSync(path.dirname(configPath), { recursive: true });
  mkdirSync(path.dirname(storePath), { recursive: true });
  mkdirSync(path.dirname(fakeOpenclaw), { recursive: true });
  // The CLI, as far as step_openclaw_config talks to it: every call is logged
  // with its argv intact; `config get` answers "unset"; a `config set` whose
  // argv contains FAKE_FAIL is refused, the way a schema refusal exits 1.
  writeFileSync(
    fakeOpenclaw,
    [
      "#!/usr/bin/env node",
      "const argv = process.argv.slice(2);",
      "require('fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify(argv) + '\\n');",
      "if (argv[0] === 'config' && argv[1] === 'get') process.exit(1);",
      "if (process.env.FAKE_FAIL && argv.includes(process.env.FAKE_FAIL)) process.exit(1);",
    ].join("\n"),
  );
  chmodSync(fakeOpenclaw, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeStore(body: string | undefined): void {
  if (body === undefined) rmSync(storePath, { force: true });
  else writeFileSync(storePath, body);
}

function writeOpenclawConfig(cfg: unknown): void {
  writeFileSync(configPath, typeof cfg === "string" ? cfg : JSON.stringify(cfg, null, 2));
}

function readOpenclawConfig(): Record<string, any> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

/** Every `openclaw` argv the step issued, in order. */
function calls(): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.startsWith("["))
    .map((line) => JSON.parse(line) as string[]);
}

function configSet(key: string): string[] | undefined {
  return calls().find((argv) => argv[0] === "config" && argv[1] === "set" && argv[2] === key);
}

function runInstallStep(opts: { v2?: boolean; failOn?: string } = {}) {
  const program = [
    "set -euo pipefail",
    `PROJECT_DIR=${q(projectDir)}`,
    `SRC_DIR=${q(REPO)}`,
    `CLAWBOX_HOME=${q(home)}`,
    `CLAWBOX_USER=${q(userInfo().username)}`,
    `OPENCLAW_BIN=${q(fakeOpenclaw)}`,
    "is_hermes_edition() { return 1; }",
    `openclaw_is_v2() { return ${opts.v2 === false ? 1 : 0}; }`,
    // sudo -u clawbox [-H], minus the sudo.
    'as_clawbox() { if [ "${1:-}" = "-H" ]; then shift; fi; "$@"; }',
    // The runtime install (apt, subordinate IDs, image build) is its own
    // function and needs root; here it only has to be asked for, or not.
    'agent_sandbox_provision() { echo "PROVISION" >> "$FAKE_LOG"; }',
    shellFunction(INSTALL, "oc_config_set", "install.sh"),
    shellFunction(INSTALL, "step_openclaw_config", "install.sh"),
    "step_openclaw_config",
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FAKE_LOG: logPath,
      ...(opts.failOn ? { FAKE_FAIL: opts.failOn } : {}),
    }),
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function provisioned(): boolean {
  return existsSync(logPath) && readFileSync(logPath, "utf-8").includes("PROVISION");
}

function installedSandbox(): Record<string, any> {
  const argv = configSet("agents.defaults.sandbox");
  expect(argv, "install.sh never set agents.defaults.sandbox").toBeDefined();
  expect(argv).toContain("--strict-json");
  return JSON.parse(argv![3]);
}

/**
 * install-x64.sh's step_openclaw_config on the gen-2 path. The x64 installer
 * keeps code and data in ONE project dir, so the test's project gets the
 * shipped scripts/ and config/ linked in beside a data/ of its own.
 */
function runX64Step(opts: { failOn?: string } = {}) {
  for (const sub of ["scripts", "config"]) {
    if (!existsSync(path.join(projectDir, sub))) symlinkSync(path.join(REPO, sub), path.join(projectDir, sub));
  }
  // An installed ClawHub, so the step does not reach for npm.
  const npmPrefix = path.join(dir, "npm");
  mkdirSync(path.join(npmPrefix, "bin"), { recursive: true });
  writeFileSync(path.join(npmPrefix, "bin", "clawhub"), "#!/bin/sh\n");
  chmodSync(path.join(npmPrefix, "bin", "clawhub"), 0o755);
  const program = [
    "set -euo pipefail",
    `PROJECT_DIR=${q(projectDir)}`,
    `CLAWBOX_HOME=${q(home)}`,
    `OPENCLAW_HOME=${q(path.dirname(configPath))}`,
    `CLAWBOX_USER=${q(userInfo().username)}`,
    `OPENCLAW_BIN=${q(fakeOpenclaw)}`,
    `NPM_PREFIX=${q(npmPrefix)}`,
    `NODE_DIST_ROOT=${q(path.join(dir, "no-node-dist"))}`,
    "PORT=80",
    "openclaw_is_v2() { return 0; }",
    // sudo -u <user> [env …], minus the sudo.
    'as_user() { "$@"; }',
    'as_user_runtime() { "$@"; }',
    "chown() { :; }",
    'agent_sandbox_provision() { echo "PROVISION" >> "$FAKE_LOG"; }',
    shellFunction(INSTALL_X64, "agent_sandbox_config", "install-x64.sh"),
    shellFunction(INSTALL_X64, "step_openclaw_config", "install-x64.sh"),
    "step_openclaw_config",
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FAKE_LOG: logPath,
      ...(opts.failOn ? { FAKE_FAIL: opts.failOn } : {}),
    }),
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runPreStart(opts: { v2?: boolean } = {}) {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${q(REPO)}`,
    `OPENCLAW_BIN=${q(path.join(dir, "no-such-dir", "openclaw"))}`,
    `OPENCLAW_CONFIG=${q(configPath)}`,
    `CLAWBOX_DEVICE_STORE=${q(storePath)}`,
    `CLAWBOX_OPENCLAW_V2=${opts.v2 === false ? 0 : 1}`,
    shellFunction(PRE_START, "clawbox_node_bin", "gateway-pre-start.sh"),
    preStartBlock(),
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" }),
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The posture both writers must agree on, whatever the switch says. */
function expectApprovedPosture(sandbox: Record<string, any>): void {
  expect(sandbox.backend).toBe("podman");
  expect(sandbox.docker?.image).toBe("openclaw-sandbox:bookworm-slim");
  expect(sandbox.docker?.network).toBe("none");
  expect(sandbox.docker?.readOnlyRoot).toBe(true);
  expect(sandbox.docker?.capDrop).toEqual(["ALL"]);
  // 512 MB of memory, and no swap beyond it: memorySwap is memory + swap.
  expect(sandbox.docker?.memory).toBe("512m");
  expect(sandbox.docker?.memorySwap).toBe("512m");
  // Podman cannot run the sandbox browser, and the owner's browser stays on the host.
  expect(sandbox.browser?.enabled).toBe(false);
}

d("the ClawBox MCP glob", () => {
  it("names the server the pre-start registers", () => {
    // OpenClaw prefixes an MCP server's tools with its id and two underscores;
    // the sandbox tool policy needs that prefix, not the tool names one by one.
    const registered = /mcp_servers\["([A-Za-z0-9_-]+)"\] = desired/.exec(PRE_START)?.[1];
    expect(registered).toBe("clawbox");
    expect(MCP_GLOB).toBe(`${registered}__*`);
  });
});

d("install.sh step_openclaw_config — agents.defaults.sandbox", () => {
  it("writes the approved posture with the sandbox OFF when the owner has not switched it on", () => {
    writeStore(undefined);
    const r = runInstallStep();
    expect(r.status, r.stderr).toBe(0);
    const sandbox = installedSandbox();
    expect(sandbox.mode).toBe(MODE_OFF);
    expectApprovedPosture(sandbox);
    expect(provisioned()).toBe(false);
  });

  it("sandboxes every non-main session and provisions the runtime once the owner switched it on", () => {
    writeStore(JSON.stringify({ [STORE_KEY]: true }));
    const r = runInstallStep();
    expect(r.status, r.stderr).toBe(0);
    const sandbox = installedSandbox();
    expect(sandbox.mode).toBe(MODE_ON);
    expectApprovedPosture(sandbox);
    expect(provisioned()).toBe(true);
  });

  it.each([
    ["false", false],
    ["the string \"true\"", "true"],
    ["1", 1],
    ["null", null],
  ])("treats %s as off: only the boolean true switches the sandbox on", (_label, value) => {
    writeStore(JSON.stringify({ [STORE_KEY]: value }));
    expect(runInstallStep().status).toBe(0);
    expect(installedSandbox().mode).toBe(MODE_OFF);
    expect(provisioned()).toBe(false);
  });

  it("keeps the mode the box already runs when the device store cannot be read", () => {
    writeOpenclawConfig({ agents: { defaults: { sandbox: { mode: MODE_ON } } } });
    writeStore("{torn");
    expect(runInstallStep().status).toBe(0);
    expect(installedSandbox().mode).toBe(MODE_ON);
    // A store this run cannot read is not a reason to install packages.
    expect(provisioned()).toBe(false);
  });

  it("lets the ClawBox MCP tools through the sandbox tool policy", () => {
    writeStore(undefined);
    expect(runInstallStep().status).toBe(0);
    const argv = configSet("tools.sandbox.tools.alsoAllow");
    expect(argv, "install.sh never set tools.sandbox.tools.alsoAllow").toBeDefined();
    expect(JSON.parse(argv![3])).toContain(MCP_GLOB);
  });

  it("adds the glob to an allow list the owner wrote instead of a second, invalid alsoAllow", () => {
    // OpenClaw refuses `allow` and `alsoAllow` in the same scope.
    writeOpenclawConfig({ tools: { sandbox: { tools: { allow: ["exec", "read"] } } } });
    writeStore(undefined);
    expect(runInstallStep().status).toBe(0);
    expect(configSet("tools.sandbox.tools.alsoAllow")).toBeUndefined();
    const argv = configSet("tools.sandbox.tools.allow");
    expect(argv).toBeDefined();
    expect(JSON.parse(argv![3])).toEqual(["exec", "read", MCP_GLOB]);
  });

  it("never fails the install over a refused sandbox write", () => {
    writeStore(undefined);
    const r = runInstallStep({ failOn: "agents.defaults.sandbox" });
    expect(r.status, r.stderr).toBe(0);
    // The refusal's own warning: a helper that printed nothing warns too.
    expect(`${r.stdout}${r.stderr}`).toMatch(/OpenClaw refused agents\.defaults\.sandbox/);
  });

  it("leaves a gen-1 core alone", () => {
    writeStore(JSON.stringify({ [STORE_KEY]: true }));
    expect(runInstallStep({ v2: false }).status).toBe(0);
    expect(configSet("agents.defaults.sandbox")).toBeUndefined();
    expect(provisioned()).toBe(false);
  });
});

d("gateway-pre-start.sh — agents.defaults.sandbox on a box already in the field", () => {
  it("adds the approved posture with the sandbox OFF and keeps everything else", () => {
    writeOpenclawConfig({
      agents: { defaults: { model: { primary: "deepseek/deepseek-chat" } } },
      tools: { sandbox: { tools: { deny: ["browser"] } } },
    });
    writeStore(undefined);
    const r = runPreStart();
    expect(r.status, r.stderr).toBe(0);
    const cfg = readOpenclawConfig();
    expect(cfg.agents.defaults.sandbox.mode).toBe(MODE_OFF);
    expectApprovedPosture(cfg.agents.defaults.sandbox);
    expect(cfg.agents.defaults.model.primary).toBe("deepseek/deepseek-chat");
    expect(cfg.tools.sandbox.tools.alsoAllow).toContain(MCP_GLOB);
    expect(cfg.tools.sandbox.tools.deny).toEqual(["browser"]);
    // openclaw.json holds the gateway token: the rewrite keeps it private.
    expect(statSync(configPath).mode & 0o077).toBe(0);
  });

  it("follows the owner's switch both ways", () => {
    writeOpenclawConfig({});
    writeStore(JSON.stringify({ [STORE_KEY]: true }));
    expect(runPreStart().status).toBe(0);
    expect(readOpenclawConfig().agents.defaults.sandbox.mode).toBe(MODE_ON);
    writeStore(JSON.stringify({ [STORE_KEY]: false }));
    expect(runPreStart().status).toBe(0);
    expect(readOpenclawConfig().agents.defaults.sandbox.mode).toBe(MODE_OFF);
  });

  it("puts the 512 MB cap back over a hand edit and keeps the owner's other container settings", () => {
    writeOpenclawConfig({
      agents: { defaults: { sandbox: { mode: MODE_OFF, docker: { memory: "4g", env: { LANG: "C.UTF-8" } }, prune: { idleHours: 4 } } } },
    });
    writeStore(undefined);
    expect(runPreStart().status).toBe(0);
    const sandbox = readOpenclawConfig().agents.defaults.sandbox;
    expect(sandbox.docker.memory).toBe("512m");
    expect(sandbox.docker.env).toEqual({ LANG: "C.UTF-8" });
    expect(sandbox.prune).toEqual({ idleHours: 4 });
  });

  it("leaves the mode exactly as it is when the device store cannot be read", () => {
    writeOpenclawConfig({ agents: { defaults: { sandbox: { mode: MODE_ON } } } });
    writeStore("{torn");
    const r = runPreStart();
    expect(r.status).toBe(0);
    expect(readOpenclawConfig().agents.defaults.sandbox.mode).toBe(MODE_ON);
  });

  it("adds the glob to an allow list the owner wrote instead of a second, invalid alsoAllow", () => {
    writeOpenclawConfig({ tools: { sandbox: { tools: { allow: ["exec"] } } } });
    writeStore(undefined);
    expect(runPreStart().status).toBe(0);
    const policy = readOpenclawConfig().tools.sandbox.tools;
    expect(policy.allow).toEqual(["exec", MCP_GLOB]);
    expect(policy.alsoAllow).toBeUndefined();
  });

  it("does not rewrite a config that is already current", () => {
    writeOpenclawConfig({});
    writeStore(undefined);
    expect(runPreStart().status).toBe(0);
    const first = readFileSync(configPath, "utf-8");
    const r = runPreStart();
    expect(r.status).toBe(0);
    expect(readFileSync(configPath, "utf-8")).toBe(first);
    expect(r.stdout).toContain("already current");
  });

  it("never stops the gateway over a config it cannot parse, and does not write over it", () => {
    writeOpenclawConfig("{ broken");
    writeStore(undefined);
    const r = runPreStart();
    expect(r.status).toBe(0);
    expect(readFileSync(configPath, "utf-8")).toBe("{ broken");
    expect(`${r.stdout}${r.stderr}`).toMatch(/WARN.*sandbox/i);
  });

  it("leaves a gen-1 core alone", () => {
    writeOpenclawConfig({});
    writeStore(JSON.stringify({ [STORE_KEY]: true }));
    expect(runPreStart({ v2: false }).status).toBe(0);
    expect(readOpenclawConfig().agents).toBeUndefined();
  });

  it("writes what install.sh writes for the same box", () => {
    writeOpenclawConfig({ agents: { defaults: { sandbox: { docker: { env: { A: "1" } } } } } });
    writeStore(JSON.stringify({ [STORE_KEY]: true }));
    expect(runInstallStep().status).toBe(0);
    const fromInstaller = installedSandbox();
    expect(runPreStart().status).toBe(0);
    expect(readOpenclawConfig().agents.defaults.sandbox).toEqual(fromInstaller);
  });
});

d("install-x64.sh step_openclaw_config — agents.defaults.sandbox on an x64 PC", () => {
  it("writes the approved posture with the sandbox OFF and lets the ClawBox MCP tools through", () => {
    writeStore(undefined);
    const r = runX64Step();
    expect(r.status, r.stderr).toBe(0);
    const sandbox = installedSandbox();
    expect(sandbox.mode).toBe(MODE_OFF);
    expectApprovedPosture(sandbox);
    const policy = configSet("tools.sandbox.tools.alsoAllow");
    expect(policy, "install-x64.sh never set tools.sandbox.tools.alsoAllow").toBeDefined();
    expect(JSON.parse(policy![3])).toContain(MCP_GLOB);
    expect(provisioned()).toBe(false);
    // The gateway envelope the step seeds first is still there to read.
    expect(readOpenclawConfig().gateway.mode).toBe("local");
  });

  it("sandboxes every non-main session and provisions the runtime once the owner switched it on", () => {
    writeStore(JSON.stringify({ [STORE_KEY]: true }));
    expect(runX64Step().status).toBe(0);
    expect(installedSandbox().mode).toBe(MODE_ON);
    expect(provisioned()).toBe(true);
  });

  it("never fails the install over a refused sandbox write", () => {
    writeStore(undefined);
    const r = runX64Step({ failOn: "agents.defaults.sandbox" });
    expect(r.status, r.stderr).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/OpenClaw refused agents\.defaults\.sandbox/);
  });

  it("still writes the key when the project dir is reached through a symlink", () => {
    // runX64Step links scripts/ in, so the helper runs from a path node
    // resolves differently; it once exited 0 having printed nothing there.
    writeStore(undefined);
    const r = runX64Step();
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/settings were not written/);
    expect(configSet("agents.defaults.sandbox")).toBeDefined();
  });

  it("writes what install.sh writes for the same box", () => {
    writeStore(JSON.stringify({ [STORE_KEY]: true }));
    writeOpenclawConfig({});
    expect(runInstallStep().status).toBe(0);
    const fromInstaller = installedSandbox();
    rmSync(logPath, { force: true });
    writeOpenclawConfig({});
    expect(runX64Step().status).toBe(0);
    expect(installedSandbox()).toEqual(fromInstaller);
  });

  it("runs the user-writable helper, posture and image script as the user, never as root", () => {
    // The x64 root step runs a single-file copy of the installer, while these
    // sit in the user's project: run as root, a user's edit would be root's.
    const lines = INSTALL_X64.split("\n").filter((line) =>
      !line.trimStart().startsWith("#")
      && /\$PROJECT_DIR\/(scripts\/agent-sandbox-config\.mjs|scripts\/agent-sandbox-image\.sh|config\/agent-sandbox\.json)/.test(line));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(line, line).toContain("as_user_runtime ");
  });
});

d("the runtime is rootless Podman, never Docker", () => {
  it("gives the clawbox user no docker group", () => {
    const body = shellFunction(INSTALL, "step_ensure_user", "install.sh")
      .split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(body).toContain("useradd");
    expect(body).not.toMatch(/docker/);
  });

  it("keeps Podman and Docker off the base package lists: only a switched-on box installs a runtime", () => {
    for (const [src, file] of [[INSTALL, "install.sh"], [INSTALL_X64, "install-x64.sh"]] as const) {
      const body = shellFunction(src, "step_apt_update", file)
        .split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
      expect(body, file).toContain("apt-get install");
      expect(body, file).not.toMatch(/\b(podman|docker(\.io)?|docker-ce|containerd)\b/);
    }
  });

  it("installs the runtime rootless in both installers: Podman, catatonit for --init, subordinate IDs, no daemon", () => {
    for (const [src, file] of [[INSTALL, "install.sh"], [INSTALL_X64, "install-x64.sh"]] as const) {
      const body = shellFunction(src, "agent_sandbox_provision", file);
      expect(body, file).toMatch(/apt-get install[^\n]*\bpodman\b[^\n]*\bcatatonit\b/);
      expect(body, file).toContain("agent_sandbox_subids subuid");
      expect(body, file).toContain("agent_sandbox_subids subgid");
      expect(body, file).not.toMatch(/usermod[^\n]*docker|systemctl[^\n]*(docker|podman\.socket)/);
    }
  });
});

// The gateway is what starts the sandbox containers, and on the Jetson and a
// fresh x64 install it is a SYSTEM unit running as the clawbox user: no
// XDG_RUNTIME_DIR, so rootless Podman finds no systemd user session, falls back
// to the cgroupfs manager and cannot hold a container to its 512 MB. A login
// shell has the session, so a check run from one passes either way; these run
// the shipped functions instead.
const INSTALLERS = [
  { src: INSTALL, file: "install.sh", unit: "clawbox-gateway.service" },
  { src: INSTALL_X64, file: "install-x64.sh", unit: "clawbox-gateway.service" },
] as const;

function logLines(): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
}

function dropInDir(): string {
  return path.join(dir, "systemd", "clawbox-gateway.service.d");
}

function runGatewaySession(src: string, file: string, unit: string, opts: { active?: boolean } = {}) {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_USER=${q(userInfo().username)}`,
    // systemctl, as far as the function talks to it: every call logged, and
    // is-active answering for a gateway that is running, or not.
    `systemctl() { echo "systemctl $*" >> "$FAKE_LOG"; if [ "$1" = is-active ]; then return ${opts.active === false ? 3 : 0}; fi; }`,
    shellFunction(src, "agent_sandbox_gateway_session", file),
    `agent_sandbox_gateway_session ${q(unit)} ${q(dropInDir())}`,
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_LOG: logPath }),
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const canGetUid = typeof process.getuid === "function";
(canGetUid ? d : describe.skip)("the gateway gets the user's session rootless Podman needs", () => {
  for (const { src, file, unit } of INSTALLERS) {
    it(`${file}: hands the gateway the user's runtime dir and restarts a running gateway once`, () => {
      const uid = process.getuid!();
      const r = runGatewaySession(src, file, unit);
      expect(r.status, r.stderr).toBe(0);
      const conf = readFileSync(path.join(dropInDir(), "agent-sandbox.conf"), "utf-8");
      expect(conf).toBe(`[Unit]\nAfter=user@${uid}.service\n\n[Service]\nEnvironment=XDG_RUNTIME_DIR=/run/user/${uid}\n`);
      expect(logLines()).toEqual([
        "systemctl daemon-reload",
        `systemctl is-active --quiet ${unit}`,
        `systemctl restart ${unit}`,
      ]);

      // Unchanged on the next update or switch press: nothing reloaded, no restart.
      rmSync(logPath, { force: true });
      expect(runGatewaySession(src, file, unit).status).toBe(0);
      expect(logLines()).toEqual([]);
    });

    it(`${file}: rewrites a stale drop-in, and leaves a stopped gateway stopped`, () => {
      const uid = process.getuid!();
      mkdirSync(dropInDir(), { recursive: true });
      writeFileSync(path.join(dropInDir(), "agent-sandbox.conf"), "[Service]\nEnvironment=XDG_RUNTIME_DIR=/run/user/1\n");
      const r = runGatewaySession(src, file, unit, { active: false });
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(path.join(dropInDir(), "agent-sandbox.conf"), "utf-8"))
        .toContain(`Environment=XDG_RUNTIME_DIR=/run/user/${uid}\n`);
      expect(logLines()).toEqual(["systemctl daemon-reload", `systemctl is-active --quiet ${unit}`]);
    });
  }

  function runProvision(src: string, file: string): { status: number; stderr: string } {
    const program = [
      "set -euo pipefail",
      `SRC_DIR=${q(REPO)}`,
      `PROJECT_DIR=${q(REPO)}`,
      `CLAWBOX_USER=${q(userInfo().username)}`,
      "GATEWAY_SERVICE=clawbox-gateway.service",
      // Everything that needs root or the network, logged in the order asked.
      "wait_for_apt() { :; }",
      'apt-get() { echo "apt-get $*" >> "$FAKE_LOG"; }',
      'agent_sandbox_subids() { echo "subids $1" >> "$FAKE_LOG"; }',
      'loginctl() { echo "loginctl $*" >> "$FAKE_LOG"; }',
      'agent_sandbox_gateway_session() { echo "gateway-session $*" >> "$FAKE_LOG"; }',
      'as_clawbox() { echo "as-user $*" >> "$FAKE_LOG"; }',
      // install-x64.sh reads the image name through it as well: node runs.
      'as_user_runtime() { if [ "$1" = node ]; then "$@"; else echo "as-user $*" >> "$FAKE_LOG"; fi; }',
      shellFunction(src, "agent_sandbox_provision", file),
      "agent_sandbox_provision",
    ].join("\n");
    const r = spawnSync("bash", ["-c", program], {
      encoding: "utf-8",
      env: testEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_LOG: logPath }),
      timeout: 60_000,
    });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  }

  for (const { src, file, unit } of INSTALLERS) {
    it(`${file}: provisioning points the gateway at the session after lingering starts it, before the image`, () => {
      const r = runProvision(src, file);
      expect(r.status, r.stderr).toBe(0);
      const lines = logLines();
      expect(lines[0]).toMatch(/^apt-get install .*\bpodman\b.*\bcatatonit\b.*\buidmap\b.*\bdbus-user-session\b/);
      const linger = lines.findIndex((l) => l.startsWith("loginctl enable-linger "));
      const session = lines.indexOf(`gateway-session ${unit}`);
      const image = lines.findIndex((l) => l.startsWith("as-user ") && l.includes("agent-sandbox-image.sh"));
      expect(linger, lines.join("\n")).toBeGreaterThan(0);
      expect(session, lines.join("\n")).toBeGreaterThan(linger);
      expect(image, lines.join("\n")).toBeGreaterThan(session);
    });
  }
});
