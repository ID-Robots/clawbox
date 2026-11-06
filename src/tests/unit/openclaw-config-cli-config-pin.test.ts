import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import fs from "fs/promises";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

/**
 * Which openclaw.json a `config` child of the web server reads and writes.
 *
 * ClawBox reads `CONFIG_PATH`, which honours `CLAWBOX_OPENCLAW_HOME` and its own
 * meaning of `OPENCLAW_HOME` — the `.openclaw` directory itself. The CLI takes
 * `OPENCLAW_HOME` for the ACCOUNT home and looks one level further down, so a
 * `memory.search` write made through it could land in a file that neither
 * `readConfig` nor the memory status probe reads, and the core went on
 * indexing with no embedder (`provider: "none"`). The memory CLI children are
 * pinned the same way in clawkeep-memory.ts.
 */

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    statSync: vi.fn(() => {
      throw new Error("no edition file");
    }),
    readFileSync: vi.fn(() => {
      throw new Error("no edition file");
    }),
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => {
      throw new Error("no nvm dir");
    }),
  },
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
  },
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const mockFs = vi.mocked(fs);

/** ClawBox's spelling: OPENCLAW_HOME is the `.openclaw` directory itself. */
const STATE_DIR = "/var/tmp/clawbox-test-openclaw-state";

function exitingChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  queueMicrotask(() => child.emit("close", 0));
  return child;
}

function spawnedEnv(call = 0): Record<string, string | undefined> {
  return (mockSpawn.mock.calls[call]?.[2] as { env?: Record<string, string | undefined> } | undefined)?.env ?? {};
}

const saved = {
  edition: process.env.CLAWBOX_EDITION,
  home: process.env.OPENCLAW_HOME,
  clawboxHome: process.env.CLAWBOX_OPENCLAW_HOME,
};
let openclawConfig: typeof import("@/lib/openclaw-config");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.CLAWBOX_EDITION = "openclaw";
  delete process.env.CLAWBOX_OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = STATE_DIR;
  mockFs.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as never);
  mockSpawn.mockImplementation(() => exitingChild());
  openclawConfig = await import("@/lib/openclaw-config");
});

afterEach(() => {
  for (const [name, value] of [
    ["CLAWBOX_EDITION", saved.edition],
    ["OPENCLAW_HOME", saved.home],
    ["CLAWBOX_OPENCLAW_HOME", saved.clawboxHome],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("a `config` child of the web server", () => {
  it("is pointed at the openclaw.json ClawBox reads, with the misread OPENCLAW_HOME dropped", async () => {
    expect(openclawConfig.CONFIG_PATH).toBe(`${STATE_DIR}/openclaw.json`);
    await openclawConfig.runOpenclawConfigSet(["memory.search.provider", "openai-compatible"], { baseBackoffMs: 1 });
    expect(mockSpawn).toHaveBeenCalled();
    const env = spawnedEnv();
    expect(env.OPENCLAW_CONFIG_PATH).toBe(`${STATE_DIR}/openclaw.json`);
    expect(env.OPENCLAW_STATE_DIR).toBe(STATE_DIR);
    expect("OPENCLAW_HOME" in env).toBe(false);
  });

  it("is pinned for a batch and an unset too — every form a memory.search write takes", async () => {
    await openclawConfig.runOpenclawConfigSetBatch(
      [["memory.search.model", "text-embedding-3-small"], ["memory.search.provider", "openai-compatible"]],
      { baseBackoffMs: 1 },
    );
    await openclawConfig.runOpenclawConfigUnset("memory.search.queryInputType", { baseBackoffMs: 1 });
    expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (let call = 0; call < mockSpawn.mock.calls.length; call += 1) {
      expect(spawnedEnv(call).OPENCLAW_CONFIG_PATH).toBe(`${STATE_DIR}/openclaw.json`);
      expect("OPENCLAW_HOME" in spawnedEnv(call)).toBe(false);
    }
  });

  it("keeps a caller's own environment over the pin", async () => {
    await openclawConfig.runOpenclawConfigSet(["gateway.mode", "local"], {
      baseBackoffMs: 1,
      env: { ...process.env, OPENCLAW_STATE_DIR: "/var/tmp/elsewhere", OPENCLAW_HOME: "/var/tmp/account" },
    });
    const env = spawnedEnv();
    expect(env.OPENCLAW_STATE_DIR).toBe("/var/tmp/elsewhere");
    expect(env.OPENCLAW_HOME).toBe("/var/tmp/account");
  });
});

describe("every other child", () => {
  it("keeps the environment it always had", async () => {
    await openclawConfig.listTelegramPairingRequests().catch(() => []);
    expect(mockSpawn).toHaveBeenCalled();
    const env = spawnedEnv();
    expect(env.OPENCLAW_HOME).toBe(STATE_DIR);
    expect(env.OPENCLAW_CONFIG_PATH).toBe(process.env.OPENCLAW_CONFIG_PATH);
  });
});
