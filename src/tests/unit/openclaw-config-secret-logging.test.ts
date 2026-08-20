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

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.CLAWBOX_EDITION = "openclaw";
  openclawConfig = await import("@/lib/openclaw-config");
});

afterEach(() => {
  delete process.env.CLAWBOX_EDITION;
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
