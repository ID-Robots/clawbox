import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

// `openclaw config set <path> <value>` carries a live secret in argv — the
// ClawBox AI portal token, a provider API key, the Telegram bot token, the
// gateway token. The two errors spawnOpenclaw can reject with name the process
// they came from, and every caller of runOpenclawConfigSet logs that message,
// so an unredacted label writes a working credential into the journal
// (CWE-532). These tests pin the redaction at the source, where it covers all
// of those callers rather than one catch block.

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(() => {
      throw new Error("no edition file");
    }),
    existsSync: vi.fn(() => false),
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

let openclawConfig: typeof import("@/lib/openclaw-config");

const TOKEN = "claw_live_portal_token_do_not_log";

/** A child that never exits, so the caller's timeout is what settles the call. */
function hangingChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  child.kill = vi.fn() as unknown as ChildProcess["kill"];
  return child;
}

/** A child that exits with `code` having written nothing — no stderr to report. */
function silentChild(code: number): ChildProcess {
  const child = hangingChild();
  queueMicrotask(() => child.emit("close", code));
  return child;
}

/**
 * Whatever the test runner's shell held before this file pinned the edition.
 * Deleting unconditionally instead would hand every later file in the worker a
 * different environment than it started with.
 */
let ambientEdition: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ambientEdition = process.env.CLAWBOX_EDITION;
  process.env.CLAWBOX_EDITION = "openclaw";
  openclawConfig = await import("@/lib/openclaw-config");
});

afterEach(() => {
  if (ambientEdition === undefined) delete process.env.CLAWBOX_EDITION;
  else process.env.CLAWBOX_EDITION = ambientEdition;
  vi.clearAllMocks();
});

describe("configSetLabelArgs", () => {
  it("names the config path and elides the value", () => {
    expect(openclawConfig.configSetLabelArgs(["models.providers.openai.apiKey", TOKEN])).toEqual([
      "config",
      "set",
      "models.providers.openai.apiKey",
      "<redacted>",
    ]);
  });

  it("keeps flags legible — they are the command's shape, not its payload", () => {
    // A reader has to be able to tell a `--json` blob write from a scalar one.
    expect(
      openclawConfig.configSetLabelArgs(["models.providers.openai.models", '[{"id":"x"}]', "--json"]),
    ).toEqual(["config", "set", "models.providers.openai.models", "<redacted>", "--json"]);
  });

  it("redacts every non-flag argument, not just the first", () => {
    expect(openclawConfig.configSetLabelArgs(["a.path", "one", "two"])).toEqual([
      "config",
      "set",
      "a.path",
      "<redacted>",
      "<redacted>",
    ]);
  });

  it("survives an empty argument list", () => {
    expect(openclawConfig.configSetLabelArgs([])).toEqual(["config", "set"]);
  });
});

describe("runOpenclawConfigSet error messages", () => {
  it("does not put the value in the timeout message", async () => {
    mockSpawn.mockImplementation(() => hangingChild());

    const err = await openclawConfig
      .runOpenclawConfigSet(["models.providers.openai.apiKey", TOKEN], { timeoutMs: 1 })
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(TOKEN);
    expect(err!.message).toContain("models.providers.openai.apiKey");
    expect(err!.message).toContain("<redacted>");
    expect(err!.message).toContain("timed out");
  });

  it("does not put the value in the message for a failure that wrote no output", async () => {
    mockSpawn.mockImplementation(() => silentChild(1));

    const err = await openclawConfig
      .runOpenclawConfigSet(["models.providers.openai.apiKey", TOKEN])
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(TOKEN);
    expect(err!.message).toContain("models.providers.openai.apiKey");
    expect(err!.message).toContain("exited with code 1");
  });

  it("still spawns the real, unredacted argv", async () => {
    // The redaction is about what gets *written down*. Redacting the argv itself
    // would write the literal "<redacted>" into the config.
    mockSpawn.mockImplementation(() => silentChild(0));

    await openclawConfig.runOpenclawConfigSet(["models.providers.openai.apiKey", TOKEN]);

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      ["config", "set", "models.providers.openai.apiKey", TOKEN],
      expect.any(Object),
    );
  });
});

describe("configSetBatchLabelArgs", () => {
  // Batch mode puts every value in ONE argv element, so the eliding
  // configSetLabelArgs does per-argument has to be redone for the payload as a
  // whole — otherwise batching first-run setup would take the portal token, the
  // provider API key and the gateway token that were previously kept out of the
  // journal and write all three into a single error message.
  it("names every path and carries no value at all", () => {
    const label = openclawConfig.configSetBatchLabelArgs([
      ["models.providers.openai.apiKey", TOKEN],
      ["agents.defaults.model.primary", "deepseek/deepseek-v4-pro"],
      ["models.providers.openai.models", '[{"id":"x"}]', "--json"],
    ]);

    expect(label.slice(0, 3)).toEqual(["config", "set", "--batch-json"]);
    expect(label.join(" ")).not.toContain(TOKEN);
    expect(label.join(" ")).not.toContain("deepseek/deepseek-v4-pro");
    expect(label[3]).toContain("models.providers.openai.apiKey=<redacted>");
    expect(label[3]).toContain("agents.defaults.model.primary=<redacted>");
    expect(label[3]).toContain("models.providers.openai.models=<redacted>");
  });

  it("survives an entry with no path rather than mislabelling one", () => {
    expect(openclawConfig.configSetBatchLabelArgs([["--json"]])[3]).toBe("[<no path>=<redacted>]");
  });
});

describe("runOpenclawConfigSetBatch", () => {
  const BATCH: string[][] = [
    ["models.providers.openai.apiKey", TOKEN],
    ["agents.defaults.compaction.reserveTokensFloor", "24000"],
    ["gateway.controlUi.allowInsecureAuth", "true", "--json"],
  ];

  it("writes every assignment in ONE spawn, typed the way the CLI would type them", async () => {
    // The whole point: N keys for one CLI cold start. `--json` values are
    // parsed as JSON; a bare value is parsed if it can be (so "24000" is the
    // number 24000, exactly as `openclaw config set` stores it) and left as a
    // string when it cannot be.
    mockSpawn.mockImplementation(() => silentChild(0));

    await openclawConfig.runOpenclawConfigSetBatch(BATCH);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const argv = mockSpawn.mock.calls[0][1] as string[];
    expect(argv.slice(0, 3)).toEqual(["config", "set", "--batch-json"]);
    expect(JSON.parse(argv[3])).toEqual([
      { path: "models.providers.openai.apiKey", value: TOKEN },
      { path: "agents.defaults.compaction.reserveTokensFloor", value: 24000 },
      { path: "gateway.controlUi.allowInsecureAuth", value: true },
    ]);
  });

  it("does not put any value in the timeout message", async () => {
    mockSpawn.mockImplementation(() => hangingChild());

    const err = await openclawConfig
      .runOpenclawConfigSetBatch(BATCH, { timeoutMs: 1 })
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(TOKEN);
    expect(err!.message).toContain("models.providers.openai.apiKey=<redacted>");
    expect(err!.message).toContain("timed out");
  });

  it("does not put any value in the message for a failure that wrote no output", async () => {
    mockSpawn.mockImplementation(() => silentChild(1));

    const err = await openclawConfig
      .runOpenclawConfigSetBatch(BATCH)
      .then(() => null)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(TOKEN);
    expect(err!.message).toContain("exited with code 1");
  });

  it("spawns nothing at all for an empty batch", async () => {
    mockSpawn.mockImplementation(() => silentChild(0));

    await openclawConfig.runOpenclawConfigSetBatch([]);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("sends a single assignment the plain way — there is nothing to batch", async () => {
    mockSpawn.mockImplementation(() => silentChild(0));

    await openclawConfig.runOpenclawConfigSetBatch([["gateway.auth.mode", "token"]]);

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      ["config", "set", "gateway.auth.mode", "token"],
      expect.any(Object),
    );
  });

  it("retries the whole batch on a config-mutation conflict", async () => {
    // Same race the single form survives: the gateway touches the config while
    // we write. A batch is one read-modify-write, so the retry re-reads the
    // fresh hash and converges exactly as a single set does.
    let attempts = 0;
    mockSpawn.mockImplementation(() => {
      attempts += 1;
      const child = hangingChild();
      queueMicrotask(() => {
        if (attempts === 1) {
          child.stderr!.emit("data", Buffer.from("ConfigMutationConflictError: config changed"));
          child.emit("close", 1);
        } else {
          child.emit("close", 0);
        }
      });
      return child;
    });

    await openclawConfig.runOpenclawConfigSetBatch(BATCH, { baseBackoffMs: 0 });

    expect(attempts).toBe(2);
  });

  it("does not retry a failure that repeating cannot fix", async () => {
    let attempts = 0;
    mockSpawn.mockImplementation(() => {
      attempts += 1;
      const child = hangingChild();
      queueMicrotask(() => {
        child.stderr!.emit("data", Buffer.from("Config validation failed: bad value"));
        child.emit("close", 1);
      });
      return child;
    });

    await expect(
      openclawConfig.runOpenclawConfigSetBatch(BATCH, { baseBackoffMs: 0 }),
    ).rejects.toThrow(/Config validation failed/);
    expect(attempts).toBe(1);
  });
});

describe("parseConfigSetArgs", () => {
  // These have to match the CLI's own two value modes or a batched write would
  // store a different config than the same sequence of single writes did.
  it("parses a --json value as JSON", () => {
    expect(openclawConfig.parseConfigSetArgs(["a.b", '{"primary":"x"}', "--json"])).toEqual({
      path: "a.b",
      value: { primary: "x" },
    });
  });

  it("falls back to the raw string when a bare value is not JSON", () => {
    expect(openclawConfig.parseConfigSetArgs(["agents.defaults.model.primary", "deepseek/deepseek-v4-pro"]))
      .toEqual({ path: "agents.defaults.model.primary", value: "deepseek/deepseek-v4-pro" });
    expect(openclawConfig.parseConfigSetArgs(["gateway.auth.mode", "token"]))
      .toEqual({ path: "gateway.auth.mode", value: "token" });
  });

  it("types a bare numeric value as a number, as the CLI does", () => {
    expect(openclawConfig.parseConfigSetArgs(["agents.defaults.compaction.reserveTokensFloor", "24000"]))
      .toEqual({ path: "agents.defaults.compaction.reserveTokensFloor", value: 24000 });
  });

  it("refuses an entry with no value rather than writing undefined", () => {
    expect(() => openclawConfig.parseConfigSetArgs(["a.b"])).toThrow(/missing a value/);
    expect(() => openclawConfig.parseConfigSetArgs([])).toThrow(/missing a path/);
  });

  it("rejects a --json value that is not JSON instead of storing the text", () => {
    expect(() => openclawConfig.parseConfigSetArgs(["a.b", "not json", "--json"])).toThrow();
  });
});
