import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveEnv } from "@/tests/helpers/env";

/**
 * src/lib/agent-sandbox.ts — what Settings knows about the agent tool sandbox,
 * and how its switch is applied. Pinned: the switch reads exactly as the boot
 * side reads it (scripts/agent-sandbox-config.mjs, run here for real), the
 * posture is the decision (rootless Podman, non-main, 512 MB / 2 GB), the
 * gateway restart is the apply and is read back, and switching on with no
 * runtime starts the root step that installs it AFTER the restart.
 */

type Cb = (err: unknown, out?: { stdout: string; stderr: string }) => void;

const h = vi.hoisted(() => ({
  openclawConfig: {} as Record<string, unknown>,
  readConfigStrict: vi.fn(async (): Promise<Record<string, unknown>> => h.openclawConfig),
  restartGateway: vi.fn(async () => {}),
  startRootStep: vi.fn(async (_step: string, _opts?: unknown) => {}),
  // What `podman image exists` answers: ready, ENOENT (no podman), exit 1 (no image), or a timeout.
  podman: "ready" as "ready" | "enoent" | "absent" | "timeout",
  // The provisioning unit's ActiveState, or null for "systemd could not be asked".
  unit: "inactive" as string | null,
  order: [] as string[],
  podmanArgs: [] as string[][],
  execFile: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("child_process")>();
  return { ...orig, execFile: h.execFile, default: { ...orig, execFile: h.execFile } };
});
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-config")>()),
  readConfigStrict: h.readConfigStrict,
  restartGateway: h.restartGateway,
}));
vi.mock("@/lib/root-step-runner", () => ({ startRootStep: h.startRootStep }));

type Lib = typeof import("@/lib/agent-sandbox");
interface BootHelper {
  switchState(storePath: string): "on" | "off" | "unknown";
  sandboxMode(sw: string, current: Record<string, unknown>): string;
}

const REPO = process.cwd();
const POSTURE = JSON.parse(fs.readFileSync(path.join(REPO, "config", "agent-sandbox.json"), "utf-8"));

let root: string;
let restoreEnv: () => void;
let lib: Lib;
let boot: BootHelper;

const storePath = () => path.join(root, "data", "config.json");
const writeStore = (body: unknown) => fs.writeFileSync(storePath(), typeof body === "string" ? body : JSON.stringify(body));
const withMode = (mode: string) => ({ agents: { defaults: { sandbox: { mode } } } });

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "CLAWBOX_EDITION", "CLAWBOX_EDITION_FILE", "CLAWBOX_AGENT_SANDBOX_DROPIN");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-agent-sandbox-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_EDITION = "openclaw";
  process.env.CLAWBOX_EDITION_FILE = path.join(root, "no-such-edition.env");
  lib = await import("@/lib/agent-sandbox");
  boot = (await import(pathToFileURL(path.join(REPO, "scripts", "agent-sandbox-config.mjs")).href)) as BootHelper;
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

const dropIn = () => path.join(root, "agent-sandbox.conf");

beforeEach(() => {
  process.env.CLAWBOX_EDITION = "openclaw";
  // The gateway has its user session unless a test takes it away.
  process.env.CLAWBOX_AGENT_SANDBOX_DROPIN = dropIn();
  fs.writeFileSync(dropIn(), "[Unit]\nAfter=user@1000.service\n\n[Service]\nEnvironment=XDG_RUNTIME_DIR=/run/user/1000\n");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.rmSync(storePath(), { force: true });
  h.openclawConfig = {};
  h.podman = "ready";
  h.unit = "inactive";
  h.order = [];
  h.podmanArgs = [];
  h.readConfigStrict.mockReset();
  h.readConfigStrict.mockImplementation(async () => h.openclawConfig);
  h.restartGateway.mockReset();
  h.restartGateway.mockImplementation(async () => { h.order.push("restart"); });
  h.startRootStep.mockReset();
  h.startRootStep.mockImplementation(async () => { h.order.push("root-step"); });
  h.execFile.mockReset();
  h.execFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Cb) => {
    if (cmd === "podman") {
      h.podmanArgs.push(args);
      if (h.podman === "ready") return cb(null, { stdout: "", stderr: "" });
      if (h.podman === "enoent") return cb(Object.assign(new Error("spawn podman ENOENT"), { code: "ENOENT" }));
      if (h.podman === "absent") return cb(Object.assign(new Error("Command failed"), { code: 1, killed: false }));
      return cb(Object.assign(new Error("timed out"), { code: null, killed: true, signal: "SIGTERM" }));
    }
    if (cmd === "/usr/bin/systemctl") {
      if (h.unit === null) return cb(new Error("System has not been booted with systemd"));
      return cb(null, { stdout: `ActiveState=${h.unit}\n`, stderr: "" });
    }
    return cb(new Error(`unexpected command ${cmd}`));
  });
});

describe("the decision the posture pins", () => {
  it("is rootless Podman, every session but the main chat, capped at 512 MB of memory and 2 GB of disk", () => {
    expect(lib.AGENT_SANDBOX_MODE_ON).toBe("non-main");
    expect(lib.AGENT_SANDBOX_MODE_OFF).toBe("off");
    expect(POSTURE.sandbox.backend).toBe("podman");
    expect(lib.AGENT_SANDBOX_IMAGE).toBe(POSTURE.sandbox.docker.image);
    expect(lib.AGENT_SANDBOX_BUDGET).toEqual({ memoryBytes: 512 * 1024 ** 2, diskBytes: 2 * 1024 ** 3 });
    // The container's own cap is the memory budget, with no swap on top.
    expect(POSTURE.sandbox.docker.memory).toBe("512m");
    expect(POSTURE.sandbox.docker.memorySwap).toBe("512m");
    expect(lib.AGENT_SANDBOX_ENABLED_KEY).toBe("clawbox_agent_sandbox_enabled");
  });
});

describe("the switch reads as the boot side reads it", () => {
  it.each([
    ["true", true],
    ["false", false],
    ["the string \"true\"", "true"],
    ["1", 1],
    ["null", null],
    ["an object", { on: true }],
  ])("%s", async (_label, value) => {
    writeStore({ [lib.AGENT_SANDBOX_ENABLED_KEY]: value });
    const settings = await lib.readAgentSandboxSwitch();
    expect(settings.known).toBe(true);
    expect(settings.enabled).toBe(lib.isAgentSandboxEnabledValue(value));
    expect(boot.switchState(storePath())).toBe(settings.enabled ? "on" : "off");
    // And "on" means the same mode on both sides.
    expect(boot.sandboxMode(settings.enabled ? "on" : "off", {})).toBe(
      settings.enabled ? lib.AGENT_SANDBOX_MODE_ON : lib.AGENT_SANDBOX_MODE_OFF,
    );
  });

  it("is off, and known, on a box that never touched it", async () => {
    expect(await lib.readAgentSandboxSwitch()).toEqual({ enabled: false, known: true });
    expect(boot.switchState(storePath())).toBe("off");
  });

  it("is not known when the store cannot be read, and never reads as on", async () => {
    writeStore("{torn");
    expect(await lib.readAgentSandboxSwitch()).toEqual({ enabled: false, known: false });
    expect(boot.switchState(storePath())).toBe("unknown");
  });
});

describe("readAgentSandboxMode", () => {
  it("is OpenClaw's own default, off, when the key is absent", async () => {
    expect(await lib.readAgentSandboxMode()).toBe("off");
  });

  it("reads the mode the config holds", async () => {
    h.openclawConfig = withMode("non-main");
    expect(await lib.readAgentSandboxMode()).toBe("non-main");
  });

  it("is null when the config cannot be read, or the box runs Hermes", async () => {
    h.readConfigStrict.mockRejectedValueOnce(new Error("EACCES"));
    expect(await lib.readAgentSandboxMode()).toBeNull();
    process.env.CLAWBOX_EDITION = "hermes";
    expect(await lib.readAgentSandboxMode()).toBeNull();
    expect(lib.agentSandboxAvailable()).toBe(false);
  });
});

describe("readAgentSandboxRuntime", () => {
  it("asks rootless Podman for the posture's image", async () => {
    expect(await lib.readAgentSandboxRuntime()).toBe("ready");
    expect(h.podmanArgs).toEqual([["image", "exists", POSTURE.sandbox.docker.image]]);
  });

  it("is missing with no podman, or no image", async () => {
    h.podman = "enoent";
    expect(await lib.readAgentSandboxRuntime()).toBe("missing");
    h.podman = "absent";
    expect(await lib.readAgentSandboxRuntime()).toBe("missing");
  });

  it("is unknown when podman did not answer", async () => {
    h.podman = "timeout";
    expect(await lib.readAgentSandboxRuntime()).toBe("unknown");
  });
});

describe("agentSandboxProvisioning", () => {
  it.each([
    ["active", true],
    ["activating", true],
    ["inactive", false],
    ["failed", false],
  ])("reads ActiveState=%s as %s", async (state, expected) => {
    h.unit = state;
    expect(await lib.agentSandboxProvisioning()).toBe(expected);
    const call = h.execFile.mock.calls.find(([cmd]) => cmd === "/usr/bin/systemctl");
    expect(call?.[1]).toEqual(["show", "clawbox-root-update@openclaw_config.service", "-p", "ActiveState"]);
  });

  it("is null when systemd could not be asked", async () => {
    h.unit = null;
    expect(await lib.agentSandboxProvisioning()).toBeNull();
  });
});

describe("applyAgentSandboxSwitch", () => {
  it("off: restarts the gateway, reads off back, and installs nothing", async () => {
    h.restartGateway.mockImplementation(async () => { h.openclawConfig = withMode("off"); });
    const r = await lib.applyAgentSandboxSwitch(false);
    expect(r).toEqual({ openclaw: { restarted: true }, provisioning: false, error: null });
    expect(h.startRootStep).not.toHaveBeenCalled();
    expect(h.podmanArgs).toEqual([]);
  });

  it("on with the runtime ready: restart and done", async () => {
    h.restartGateway.mockImplementation(async () => { h.openclawConfig = withMode("non-main"); });
    const r = await lib.applyAgentSandboxSwitch(true);
    expect(r).toEqual({ openclaw: { restarted: true }, provisioning: false, error: null });
    expect(h.startRootStep).not.toHaveBeenCalled();
  });

  it("on with the image but no user session for the gateway: runs the install again", async () => {
    fs.rmSync(dropIn());
    h.restartGateway.mockImplementation(async () => { h.openclawConfig = withMode("non-main"); });
    const r = await lib.applyAgentSandboxSwitch(true);
    expect(r).toEqual({ openclaw: { restarted: true }, provisioning: true, error: null });
    expect(h.startRootStep).toHaveBeenCalledWith("openclaw_config", { noBlock: true });
  });

  it("on with no runtime: starts the install AFTER the restart, so its writes never race the pre-start's", async () => {
    h.podman = "enoent";
    h.restartGateway.mockImplementation(async () => {
      h.order.push("restart");
      h.openclawConfig = withMode("non-main");
    });
    const r = await lib.applyAgentSandboxSwitch(true);
    expect(r).toEqual({ openclaw: { restarted: true }, provisioning: true, error: null });
    expect(h.startRootStep).toHaveBeenCalledWith("openclaw_config", { noBlock: true });
    expect(h.order).toEqual(["restart", "root-step"]);
  });

  it("does not start a second install over one already running", async () => {
    h.podman = "absent";
    h.unit = "active";
    h.openclawConfig = withMode("non-main");
    const r = await lib.applyAgentSandboxSwitch(true);
    expect(r.provisioning).toBe(true);
    expect(h.startRootStep).not.toHaveBeenCalled();
  });

  it("says so when the restart did not apply the mode", async () => {
    h.openclawConfig = withMode("off");
    const r = await lib.applyAgentSandboxSwitch(true);
    expect(r.openclaw).toEqual({ restarted: true });
    expect(r.error).toMatch(/does not show the new mode/);
  });

  it("does not call it applied when the config cannot be read back after the restart", async () => {
    h.restartGateway.mockImplementation(async () => {
      h.readConfigStrict.mockRejectedValueOnce(new Error("EACCES"));
    });
    const r = await lib.applyAgentSandboxSwitch(false);
    expect(r.openclaw).toEqual({ restarted: true });
    expect(r.error).toMatch(/could not be read back/);
  });

  it("says so when the gateway did not come back, and still installs the runtime the switch needs", async () => {
    h.restartGateway.mockRejectedValue(new Error("timeout"));
    h.podman = "enoent";
    const r = await lib.applyAgentSandboxSwitch(true);
    expect(r.openclaw).toEqual({ restarted: false });
    expect(r.error).toMatch(/did not come back/);
    expect(r.provisioning).toBe(true);
  });

  it("passes the launcher's own repair sentence through when no root step can be started", async () => {
    h.podman = "enoent";
    h.openclawConfig = withMode("non-main");
    h.startRootStep.mockRejectedValue(Object.assign(new Error("This ClawBox could not start its root step \"openclaw_config\": …"), { rootStepUnavailable: true }));
    const r = await lib.applyAgentSandboxSwitch(true);
    expect(r.provisioning).toBe(false);
    expect(r.error).toMatch(/could not start its root step/);
  });

  it("asks the owner to retry when the install could not be started for another reason", async () => {
    h.podman = "enoent";
    h.openclawConfig = withMode("non-main");
    h.startRootStep.mockRejectedValue(new Error("unit failed"));
    const r = await lib.applyAgentSandboxSwitch(true);
    expect(r.error).toMatch(/Switch it off and on again/);
  });

  it("does nothing on a Hermes edition", async () => {
    process.env.CLAWBOX_EDITION = "hermes";
    const r = await lib.applyAgentSandboxSwitch(true);
    expect(r).toEqual({ openclaw: null, provisioning: false, error: null });
    expect(h.restartGateway).not.toHaveBeenCalled();
    expect(h.startRootStep).not.toHaveBeenCalled();
  });
});
