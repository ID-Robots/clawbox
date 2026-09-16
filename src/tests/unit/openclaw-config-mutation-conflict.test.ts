import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fs from "fs/promises";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

// A `config set` that loses OpenClaw's optimistic-concurrency check is the box
// racing itself, and the next attempt against the freshly loaded file settles
// it. ClawBox has retried that since TASK-483 — but only when the CLI named its
// own error class. It also words the same refusal for a human:
//
//   The config file changed while this command was writing (config changed
//   since last load), so nothing was changed. Re-run the same command to pick
//   up the new file and try again.
//
// No class name, so the retry did not fire, the write failed for good, and that
// sentence is what a freshly set-up box put in the chat panel as the first
// thing its owner ever read from it — while the ClawBox AI connect was still
// restarting the gateway and the desktop was adopting the browser's timezone.

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    // `readEdition()` stats the edition file before reading it; a mock without
    // `statSync` makes that call throw into its own catch and the edition guard
    // is never exercised.
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

const HUMANIZED_CONFLICT =
  "The config file changed while this command was writing (config changed since last load), so nothing was changed. Re-run the same command to pick up the new file and try again.";
const CLASS_NAMED_CONFLICT = "ConfigMutationConflictError: config changed since last load";

/**
 * A child that writes `stderr` and exits with `code`.
 *
 * The events are queued rather than emitted inline because `spawnOpenclaw`
 * attaches its listeners after the factory returns — a real child cannot have
 * closed before the caller is listening either.
 */
function scriptedChild(code: number, stderr = ""): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  queueMicrotask(() => {
    if (stderr) child.stderr?.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

/** Fail the first `failures` spawns with `stderr`, then succeed. */
function failThenSucceed(failures: number, stderr: string): void {
  let spawned = 0;
  mockSpawn.mockImplementation(() => {
    spawned += 1;
    return spawned <= failures ? scriptedChild(1, stderr) : scriptedChild(0);
  });
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

describe("a config set that loses the config-mutation race is retried", () => {
  it("retries the CLI's humanized refusal, which names no error class", async () => {
    failThenSucceed(1, HUMANIZED_CONFLICT);

    const err = await settle(
      openclawConfig.runOpenclawConfigSet(
        ["agents.defaults.model.primary", "deepseek/deepseek-v4-flash"],
        { baseBackoffMs: 1 },
      ),
    );

    expect(err).toBeNull();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("retries the class-named refusal exactly as before", async () => {
    failThenSucceed(1, CLASS_NAMED_CONFLICT);

    const err = await settle(
      openclawConfig.runOpenclawConfigSet(["agents.defaults.model.primary", "x/y"], {
        baseBackoffMs: 1,
      }),
    );

    expect(err).toBeNull();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("retries a batched write too — that is the form the chat model switch uses", async () => {
    failThenSucceed(1, HUMANIZED_CONFLICT);

    const err = await settle(
      openclawConfig.runOpenclawConfigSetBatch(
        [
          ["plugins.entries.deepseek.enabled", "true", "--json"],
          ["agents.defaults.model.primary", "deepseek/deepseek-v4-flash"],
        ],
        { baseBackoffMs: 1 },
      ),
    );

    expect(err).toBeNull();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget and keeps the failure a failure", async () => {
    // A collision that outlives four attempts is a state to report, not one to
    // paper over: the caller must still learn the write did not land.
    mockSpawn.mockImplementation(() => scriptedChild(1, HUMANIZED_CONFLICT));

    const err = await settle(
      openclawConfig.runOpenclawConfigSet(["agents.defaults.model.primary", "x/y"], {
        baseBackoffMs: 1,
      }),
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("config changed since last load");
    expect(mockSpawn).toHaveBeenCalledTimes(4);
  });

  it("does not retry a refusal the CLI means to be final", async () => {
    // The other direction. A rejected model reference does not become valid by
    // being repeated, and four ~10 s CLI start-ups would be spent proving it.
    mockSpawn.mockImplementation(() =>
      scriptedChild(1, "Invalid model reference: openai/nope is not in any enabled catalog"),
    );

    const err = await settle(
      openclawConfig.runOpenclawConfigSet(["agents.defaults.model.primary", "openai/nope"], {
        baseBackoffMs: 1,
      }),
    );

    expect(err).toBeInstanceOf(Error);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
