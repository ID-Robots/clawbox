import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "fs/promises";

// F-15. Every writer in openclaw-config.ts is a read-modify-write of the whole
// file: it reads openclaw.json, sets its one block, and saves the object back.
// The read half used to be readConfig(), which answers `{}` to EVERY failure —
// a missing file, an EACCES, a file caught half-written by a concurrent
// `openclaw config set`. A writer that starts from that `{}` and saves has just
// replaced the whole file with the one block it was asked to add: every model
// provider, auth profile and gateway setting gone, and the route answers 200.
//
// The four writers here must refuse an unreadable or unparseable file instead
// (the route answers 500, the file is untouched), while still honouring the two
// shapes that are genuinely safe to start from: no file at all (first run) and
// a parseable non-object root (`[]`, `3`, ...), which OpenClaw cannot load
// anyway and which the writers repair — see the MALFORMED_ROOT cases in
// discord-openclaw-config.test.ts.

vi.mock("child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    // `stat` and `chmod`: writeConfig preserves the mode of the file it
    // replaces (rename swaps the inode), so a mocked filesystem has to
    // answer both or every write here fails on the stat.
    stat: vi.fn(async () => ({ mode: 0o600 })),
    chmod: vi.fn(),
  },
}));

vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

const mockFs = vi.mocked(fs);

const TOKEN = "clawbox-test-not-a-real-bot-token-000000";

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: mock`), { code });
}

type Lib = typeof import("@/lib/openclaw-config");

// name, writer — one row per read-modify-write the finding names.
const WRITERS: ReadonlyArray<[string, (lib: Lib) => Promise<void>]> = [
  ["setTelegramToken", (lib) => lib.setTelegramToken(TOKEN)],
  ["setDiscordToken", (lib) => lib.setDiscordToken(TOKEN)],
  ["setTelegramProgressStreaming", (lib) => lib.setTelegramProgressStreaming(false)],
  ["setControlUiAllowedOrigins", (lib) => lib.setControlUiAllowedOrigins("clawbox-test")],
];

const UNREADABLE: ReadonlyArray<[string, () => void]> = [
  ["the file is not JSON", () => mockFs.readFile.mockResolvedValue("{ not json")],
  ["the file is half-written", () => mockFs.readFile.mockResolvedValue('{"gateway":{"port":1')],
  ["the file cannot be read (EACCES)", () => mockFs.readFile.mockRejectedValue(fsError("EACCES"))],
  ["the read fails with EIO", () => mockFs.readFile.mockRejectedValue(fsError("EIO"))],
];

let lib: Lib;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockFs.readFile.mockResolvedValue("{}");
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.rename.mockResolvedValue(undefined);
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.chmod.mockResolvedValue(undefined);
  lib = await import("@/lib/openclaw-config");
});

describe("config writers refuse an unreadable openclaw.json (F-15)", () => {
  describe.each(WRITERS)("%s", (_name, write) => {
    it.each(UNREADABLE)("throws and writes nothing when %s", async (_why, arrange) => {
      arrange();

      await expect(write(lib)).rejects.toThrow();

      // Nothing reaches disk: no tmp file, no rename over the real one, and
      // for Discord no env file either — a token on disk for a channel the
      // config no longer names is its own failure mode.
      expect(mockFs.writeFile).not.toHaveBeenCalled();
      expect(mockFs.rename).not.toHaveBeenCalled();
    });

    it("still treats a missing file as a fresh config", async () => {
      mockFs.readFile.mockRejectedValue(fsError("ENOENT"));

      await write(lib);

      expect(mockFs.rename).toHaveBeenCalledWith(
        expect.stringContaining("openclaw.json.tmp"),
        expect.stringContaining("openclaw.json"),
      );
    });

    it("keeps every unrelated key of a readable config", async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          gateway: { port: 18789 },
          models: { providers: { openai: { apiKey: "sk-test" } } },
          auth: { profiles: { "openai:default": { mode: "api_key" } } },
        }),
      );

      await write(lib);

      const call = mockFs.writeFile.mock.calls.find((c) =>
        String(c[0]).endsWith("openclaw.json.tmp"),
      );
      const written = JSON.parse(String(call?.[1]));
      expect(written.gateway).toMatchObject({ port: 18789 });
      expect(written.models.providers.openai.apiKey).toBe("sk-test");
      expect(written.auth.profiles["openai:default"].mode).toBe("api_key");
    });
  });
});

describe("readConfigForWrite", () => {
  it("returns {} for a missing file (first-run contract)", async () => {
    mockFs.readFile.mockRejectedValue(fsError("ENOENT"));
    await expect(lib.readConfigForWrite()).resolves.toEqual({});
  });

  // The message is what the Telegram routes answer as the 500 body, so it has
  // to read as a sentence for the owner: what happened, what was not done —
  // not the parser's internals and not the file's absolute path.
  it("throws on any other read error, in the owner's words", async () => {
    const cause = fsError("EACCES");
    mockFs.readFile.mockRejectedValue(cause);
    const err = await lib.readConfigForWrite().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(lib.OpenclawConfigUnreadableError);
    expect((err as Error).message).toMatch(/could not be read \(EACCES\), so nothing was saved/);
    expect((err as Error).message).not.toMatch(/\/home\//);
    expect((err as Error).cause).toBe(cause);
  });

  it("throws on a file that does not parse, in the owner's words", async () => {
    mockFs.readFile.mockResolvedValue("{ not json");
    const err = await lib.readConfigForWrite().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(lib.OpenclawConfigUnreadableError);
    expect((err as Error).message).toMatch(/not valid JSON/);
    expect((err as Error).message).not.toMatch(/Unexpected token|position \d/);
    expect((err as Error).cause).toBeInstanceOf(SyntaxError);
  });

  // Unlike readConfigStrict: a parseable non-object root is not a config the
  // gateway can load, so there is nothing to protect and the writers repair it.
  it.each([
    ["an array", "[]"],
    ["a string", '"nope"'],
    ["a number", "3"],
    ["null", "null"],
  ])("returns {} when the root is %s so the writer can repair it", async (_why, raw) => {
    mockFs.readFile.mockResolvedValue(raw);
    await expect(lib.readConfigForWrite()).resolves.toEqual({});
  });

  it("returns a well-formed config as-is", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ gateway: { port: 18789 } }));
    await expect(lib.readConfigForWrite()).resolves.toEqual({ gateway: { port: 18789 } });
  });
});
