import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fs from "fs/promises";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

// A `config set` that is killed at its timeout is not proof that nothing was
// written. `spawnOpenclaw` SIGKILLs the child and rejects, but the CLI writes
// the config early and then spends seconds validating catalogs, so on a Jetson
// the value lands and the caller still reports a failure.
//
// Measured on the OpenClaw box (TASK-654, core 2026.8.1):
//
//   POST /setup-api/chat/model {"model":"openai/gpt-5.5","provider":"codex"}
//   -> http=500 after 30.04s
//   -> {"error":"... openclaw config set agents.defaults.model.primary
//                <redacted> timed out after 30000ms"}
//   -> and yet: agents.defaults.model.primary == openai/gpt-5.5
//
// The owner is told the switch failed, the box is on the new model, and the
// two disagree until something re-reads the config. That is the "false
// failure" class from CLAUDE.md.

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    // `readEdition()` stats the edition file BEFORE reading it, so a mock
    // without `statSync` makes that call throw a TypeError into its own catch
    // and the edition guard the whole path depends on is never exercised.
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

let openclawConfig: typeof import("@/lib/openclaw-config");

/**
 * A child that runs until it is killed — the caller's deadline is what settles
 * the call, and the SIGKILL is then reaped like a real one. Emitting `close`
 * from `kill` matters twice: the reap wait settles at once instead of paying
 * its full second in every test, and the reaped path is the one a real box
 * takes.
 */
function hangingChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    return true;
  }) as unknown as ChildProcess["kill"];
  return child;
}

/** A child that exits with `code` having written nothing. */
function silentChild(code: number): ChildProcess {
  const child = hangingChild();
  queueMicrotask(() => child.emit("close", code));
  return child;
}

/** What `openclaw.json` holds when the caller re-reads it after the kill. */
function configOnDisk(config: unknown): void {
  mockFs.readFile.mockResolvedValue(JSON.stringify(config) as never);
}

let ambientEdition: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ambientEdition = process.env.CLAWBOX_EDITION;
  process.env.CLAWBOX_EDITION = "openclaw";
  mockFs.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as never);
  openclawConfig = await import("@/lib/openclaw-config");
});

afterEach(() => {
  if (ambientEdition === undefined) delete process.env.CLAWBOX_EDITION;
  else process.env.CLAWBOX_EDITION = ambientEdition;
  vi.clearAllMocks();
});

async function settle(promise: Promise<unknown>): Promise<Error | null> {
  return promise.then(() => null).catch((err: Error) => err);
}

describe("a config set killed at its timeout is verified, not assumed failed", () => {
  it("resolves when the assignment is on disk", async () => {
    mockSpawn.mockImplementation(() => hangingChild());
    configOnDisk({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } });

    const err = await settle(
      openclawConfig.runOpenclawConfigSet(["agents.defaults.model.primary", "openai/gpt-5.5"], {
        timeoutMs: 1,
      }),
    );

    expect(err).toBeNull();
  });

  it("still fails when the assignment is NOT on disk", async () => {
    // The other half. A timeout that wrote nothing is a real failure, and
    // reporting it as success would be the false success this replaces the
    // false failure with.
    mockSpawn.mockImplementation(() => hangingChild());
    configOnDisk({ agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } } });

    const err = await settle(
      openclawConfig.runOpenclawConfigSet(["agents.defaults.model.primary", "openai/gpt-5.5"], {
        timeoutMs: 1,
      }),
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("timed out");
  });

  it("still fails when the config cannot be read back", async () => {
    // An EACCES or a half-written file proves nothing either way, and
    // `readConfig`'s `{}` would read as "not landed" — which is the answer we
    // want, but only because it is reached by throwing rather than by guessing.
    mockSpawn.mockImplementation(() => hangingChild());
    mockFs.readFile.mockRejectedValue(new Error("EACCES: permission denied") as never);

    const err = await settle(
      openclawConfig.runOpenclawConfigSet(["agents.defaults.model.primary", "openai/gpt-5.5"], {
        timeoutMs: 1,
      }),
    );

    expect(err).toBeInstanceOf(Error);
    // The ORIGINAL failure, not the read error: an owner shown "permission
    // denied" for a CLI that timed out goes and fixes the wrong thing.
    expect(err!.message).toContain("timed out");
  });

  it("reads the config back from openclaw.json, not from wherever", async () => {
    mockSpawn.mockImplementation(() => hangingChild());
    configOnDisk({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } });

    await settle(
      openclawConfig.runOpenclawConfigSet(["agents.defaults.model.primary", "openai/gpt-5.5"], {
        timeoutMs: 1,
      }),
    );

    expect(mockFs.readFile).toHaveBeenCalledWith(openclawConfig.CONFIG_PATH, "utf-8");
  });

  it("does not verify a CLI that ran and refused", async () => {
    // Exit 1 is the CLI's own answer — a schema rejection, an unresolvable
    // model reference. It says nothing was written, and a config that happens
    // to already hold the value must not turn that refusal into a success.
    mockSpawn.mockImplementation(() => silentChild(1));
    configOnDisk({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } });

    const err = await settle(
      openclawConfig.runOpenclawConfigSet(["agents.defaults.model.primary", "openai/gpt-5.5"]),
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("exited with code 1");
  });

  it("verifies every assignment of a batch, not just the first", async () => {
    // `--batch-json` is atomic, so a batch that landed landed whole. Checking
    // only the first entry would report a partial write as applied.
    mockSpawn.mockImplementation(() => hangingChild());
    configOnDisk({
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      plugins: { entries: { openai: { enabled: true } } },
    });

    const err = await settle(
      openclawConfig.runOpenclawConfigSetBatch(
        [
          ["agents.defaults.model.primary", "openai/gpt-5.5"],
          ["plugins.entries.openai.enabled", "true"],
          ["agents.defaults.model.fallbacks", JSON.stringify(["llamacpp/gemma4-e2b-it-q4_0"]), "--json"],
        ],
        { timeoutMs: 1 },
      ),
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("timed out");
  });

  it("resolves a batch whose every assignment is on disk", async () => {
    mockSpawn.mockImplementation(() => hangingChild());
    configOnDisk({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5", fallbacks: ["llamacpp/gemma4-e2b-it-q4_0"] },
        },
      },
      plugins: { entries: { openai: { enabled: true } } },
    });

    const err = await settle(
      openclawConfig.runOpenclawConfigSetBatch(
        [
          ["agents.defaults.model.primary", "openai/gpt-5.5"],
          ["plugins.entries.openai.enabled", "true"],
          ["agents.defaults.model.fallbacks", JSON.stringify(["llamacpp/gemma4-e2b-it-q4_0"]), "--json"],
        ],
        { timeoutMs: 1 },
      ),
    );

    expect(err).toBeNull();
  });

  it("resolves an unset whose path is gone from the file", async () => {
    // The sibling: `config unset` is the same spawn with the same deadline, and
    // a removal reported as a failure sends the caller to repair something that
    // is already repaired — the configure route answers 502 and tells the owner
    // to run the command by hand.
    mockSpawn.mockImplementation(() => hangingChild());
    configOnDisk({ models: { providers: { openai: { models: [] } } } });

    const err = await settle(
      openclawConfig.runOpenclawConfigUnset("models.providers.openai.apiKey", { timeoutMs: 1 }),
    );

    expect(err).toBeNull();
  });

  it("still fails an unset whose path is still there", async () => {
    mockSpawn.mockImplementation(() => hangingChild());
    configOnDisk({ models: { providers: { openai: { apiKey: "claw_still_here" } } } });

    const err = await settle(
      openclawConfig.runOpenclawConfigUnset("models.providers.openai.apiKey", { timeoutMs: 1 }),
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("timed out");
  });

  it("still fails an unset when openclaw.json is missing", async () => {
    // The one shape that would otherwise fail OPEN: readConfigStrict answers
    // `{}` for an absent file, and every path reads as removed in `{}`. Without
    // this the guard could be deleted and nothing here would notice.
    mockSpawn.mockImplementation(() => hangingChild());
    const fsSync = vi.mocked((await import("fs")).default);
    fsSync.existsSync.mockReturnValue(false);
    configOnDisk({});

    const err = await settle(
      openclawConfig.runOpenclawConfigUnset("models.providers.openai.apiKey", { timeoutMs: 1 }),
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("timed out");
  });

  it("reads a bracket-quoted segment as one key", async () => {
    // The Codex runtime arm: `agents.defaults.models["openai/gpt-5.5"]
    // .agentRuntime.id`. A path split on "." alone would look for a key
    // `"openai/gpt-5` and never find the value that IS there.
    mockSpawn.mockImplementation(() => hangingChild());
    configOnDisk({
      agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } } },
    });

    const err = await settle(
      openclawConfig.runOpenclawConfigSet(
        ['agents.defaults.models["openai/gpt-5.5"].agentRuntime.id', "codex"],
        { timeoutMs: 1 },
      ),
    );

    expect(err).toBeNull();
  });
});
