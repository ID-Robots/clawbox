import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fs from "fs/promises";
import fsSync from "fs";
import { saveEnv } from "../helpers/env";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

// `restartGateway()` is not finished until :18789 is listening again. These
// cases are about which unit it touches, so the readiness wait answers yes;
// gateway-restart-readiness.test.ts is where the wait itself is pinned.
vi.mock("@/lib/port-probe", async (orig) => ({
  ...(await orig<typeof import("@/lib/port-probe")>()),
  waitForPortOpen: vi.fn(async () => true),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
    // `stat` and `chmod`: writeConfig preserves the mode of the file it
    // replaces (rename swaps the inode), so a mocked filesystem has to
    // answer both or every write here fails on the stat.
    chmod: vi.fn(),
    stat: vi.fn(async () => ({ mode: 0o600 })),
  },
}));

vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  },
}));

const mockExecFile = vi.mocked(childProcess.execFile);
const mockFs = vi.mocked(fs);
const mockFsSync = vi.mocked(fsSync);

function setupExecFileMock(results: Record<string, { stdout: string; stderr: string } | Error> = {}) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    optsOrCallback?: object | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
    maybeCallback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    const key = `${cmd} ${args.join(" ")}`;

    let result = results[key];
    if (!result) {
      for (const k of Object.keys(results)) {
        if (key.includes(k) || k.includes(cmd)) {
          result = results[k];
          break;
        }
      }
    }

    const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;

    if (callback) {
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else if (result) {
        callback(null, result);
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }

    // For promisified version
    const returnObj = {
      then: (resolve: (value: { stdout: string; stderr: string }) => void, reject: (err: Error) => void) => {
        if (result instanceof Error) {
          reject(result);
        } else {
          resolve(result || { stdout: "", stderr: "" });
        }
        return returnObj;
      },
      catch: (reject: (err: Error) => void) => {
        if (result instanceof Error) {
          reject(result);
        }
        return returnObj;
      },
    };
    return returnObj as unknown as ReturnType<typeof childProcess.execFile>;
  }) as unknown as typeof childProcess.execFile);
}

describe("openclaw-config", () => {
  let openclawConfig: typeof import("@/lib/openclaw-config");

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockFs.readFile.mockResolvedValue("{}");
    mockFs.writeFile.mockResolvedValue();
    mockFs.rename.mockResolvedValue();
    mockFs.mkdir.mockResolvedValue(undefined);
    setupExecFileMock({
      systemctl: { stdout: "", stderr: "" },
    });

    openclawConfig = await import("@/lib/openclaw-config");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("edition guard (openclawIsAbsent / spawn chokepoint)", () => {
    const savedEdition = process.env.CLAWBOX_EDITION;
    afterEach(() => {
      if (savedEdition === undefined) delete process.env.CLAWBOX_EDITION;
      else process.env.CLAWBOX_EDITION = savedEdition;
    });

    it("reports the openclaw binary as absent on the hermes edition", () => {
      process.env.CLAWBOX_EDITION = "hermes";
      expect(openclawConfig.openclawIsAbsent()).toBe(true);
    });

    it("reports the openclaw binary as present on the openclaw and dual editions", () => {
      process.env.CLAWBOX_EDITION = "openclaw";
      expect(openclawConfig.openclawIsAbsent()).toBe(false);
      process.env.CLAWBOX_EDITION = "dual";
      expect(openclawConfig.openclawIsAbsent()).toBe(false);
    });

    it("refuses `openclaw config set` with a typed error on hermes instead of spawning", async () => {
      process.env.CLAWBOX_EDITION = "hermes";
      await expect(
        openclawConfig.runOpenclawConfigSet(["model.provider", "clawai"]),
      ).rejects.toBeInstanceOf(openclawConfig.OpenclawUnavailableError);
    });
  });

  describe("setSkillEnabled", () => {
    it("refuses prototype-chain skill ids before touching anything", async () => {
      // The route guards these too, but the invariant lives here so a second
      // caller (an MCP tool, a CLI path) cannot write `enabled` onto
      // Object.prototype through ensurePlainObject.
      for (const skillId of ["__proto__", "constructor", "prototype"]) {
        await expect(openclawConfig.setSkillEnabled(skillId, true)).rejects.toThrow("Invalid skill id");
      }
      // The hazard the guard exists for: nothing landed on Object.prototype.
      expect(({} as Record<string, unknown>).enabled).toBeUndefined();
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it("writes skills.entries.<id>.enabled for a normal id", async () => {
      await openclawConfig.setSkillEnabled("home-assistant", false);
      const written = JSON.parse(String(mockFs.writeFile.mock.calls[0][1]));
      expect(written.skills.entries["home-assistant"].enabled).toBe(false);
    });
  });

  describe("compactionReserveFloorForContext", () => {
    it("scales the reserve down for small local windows (Ollama 32K → 8192)", () => {
      expect(openclawConfig.compactionReserveFloorForContext(32768)).toBe(8192);
    });

    it("keeps the full default for large/unbounded windows (llama.cpp 128K, cloud)", () => {
      expect(openclawConfig.compactionReserveFloorForContext(131072)).toBe(24000);
      expect(openclawConfig.compactionReserveFloorForContext(Number.POSITIVE_INFINITY)).toBe(24000);
    });

    it("never drops below the 4096 floor and guards invalid input", () => {
      expect(openclawConfig.compactionReserveFloorForContext(8000)).toBe(4096);
      expect(openclawConfig.compactionReserveFloorForContext(0)).toBe(24000);
      expect(openclawConfig.compactionReserveFloorForContext(Number.NaN)).toBe(24000);
    });
  });

  describe("CONFIG_PATH", () => {
    it("exports CONFIG_PATH pointing to openclaw.json", () => {
      expect(openclawConfig.CONFIG_PATH).toMatch(/openclaw\.json$/);
    });

    it("uses OPENCLAW_HOME env var when set", async () => {
      vi.resetModules();
      process.env.OPENCLAW_HOME = "/custom/path";
      try {
        const mod = await import("@/lib/openclaw-config");
        expect(mod.CONFIG_PATH).toBe("/custom/path/openclaw.json");
      } finally {
        delete process.env.OPENCLAW_HOME;
      }
    });

    it("falls back to /home/clawbox when HOME is present but empty", async () => {
      const savedHome = process.env.HOME;
      const savedOpenclawHome = process.env.OPENCLAW_HOME;
      const savedClawboxOpenclawHome = process.env.CLAWBOX_OPENCLAW_HOME;
      vi.resetModules();
      process.env.HOME = "";
      delete process.env.OPENCLAW_HOME;
      delete process.env.CLAWBOX_OPENCLAW_HOME;
      try {
        const mod = await import("@/lib/openclaw-config");
        expect(mod.OPENCLAW_HOME).toBe("/home/clawbox/.openclaw");
        expect(mod.CONFIG_PATH).toBe("/home/clawbox/.openclaw/openclaw.json");
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        if (savedOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
        else process.env.OPENCLAW_HOME = savedOpenclawHome;
        if (savedClawboxOpenclawHome === undefined) delete process.env.CLAWBOX_OPENCLAW_HOME;
        else process.env.CLAWBOX_OPENCLAW_HOME = savedClawboxOpenclawHome;
        vi.resetModules();
      }
    });
  });

  describe("readConfig", () => {
    it("returns parsed JSON from config file", async () => {
      const configData = { agents: { defaults: { model: { primary: "gpt-4" } } } };
      mockFs.readFile.mockResolvedValue(JSON.stringify(configData));

      const result = await openclawConfig.readConfig();

      expect(result).toEqual(configData);
      expect(mockFs.readFile).toHaveBeenCalledWith(
        openclawConfig.CONFIG_PATH,
        "utf-8"
      );
    });

    it("returns empty object when file does not exist", async () => {
      mockFs.readFile.mockRejectedValue(new Error("ENOENT: no such file or directory"));

      const result = await openclawConfig.readConfig();

      expect(result).toEqual({});
    });

    it("returns empty object when file contains invalid JSON", async () => {
      mockFs.readFile.mockRejectedValue(new SyntaxError("Unexpected token"));

      const result = await openclawConfig.readConfig();

      expect(result).toEqual({});
    });

    it("returns empty object for any read error", async () => {
      mockFs.readFile.mockRejectedValue(new Error("EACCES: permission denied"));

      const result = await openclawConfig.readConfig();

      expect(result).toEqual({});
    });

    it("returns config with channels", async () => {
      const config = {
        channels: {
          telegram: { enabled: true, botToken: "abc:123", dmPolicy: "open" },
        },
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(config));

      const result = await openclawConfig.readConfig();

      expect(result.channels?.telegram?.enabled).toBe(true);
      expect(result.channels?.telegram?.botToken).toBe("abc:123");
    });

    it("returns config with tools section", async () => {
      const config = {
        tools: { profile: "default", web: { search: { enabled: true } } },
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(config));

      const result = await openclawConfig.readConfig();

      expect(result.tools?.profile).toBe("default");
      expect(result.tools?.web?.search?.enabled).toBe(true);
    });
  });

  describe("setTelegramToken", () => {
    it("sets Telegram token in config without overriding dmPolicy/allowFrom", async () => {
      await openclawConfig.setTelegramToken("123:abc");

      expect(mockFs.writeFile).toHaveBeenCalled();
      const writeCall = mockFs.writeFile.mock.calls[0];
      const writtenConfig = JSON.parse(writeCall[1] as string);

      expect(writtenConfig.channels.telegram.botToken).toBe("123:abc");
      expect(writtenConfig.channels.telegram.enabled).toBe(true);
      // Security: do NOT override OpenClaw's default dmPolicy ("pairing"),
      // and do NOT wildcard-allow every Telegram user. `not.toHaveProperty`
      // (stricter than toBeUndefined) catches a future write of `undefined`
      // which would still change the key's presence in the config object.
      expect(writtenConfig.channels.telegram).not.toHaveProperty("dmPolicy");
      expect(writtenConfig.channels.telegram).not.toHaveProperty("allowFrom");
    });

    it("preserves existing config", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        gateway: { port: 18789 },
        channels: {
          discord: { enabled: true },
        },
      }));

      await openclawConfig.setTelegramToken("123:abc");

      const writeCall = mockFs.writeFile.mock.calls[0];
      const writtenConfig = JSON.parse(writeCall[1] as string);

      expect(writtenConfig.gateway.port).toBe(18789);
      expect(writtenConfig.channels.discord.enabled).toBe(true);
      expect(writtenConfig.channels.telegram.botToken).toBe("123:abc");
    });

    it("creates channels object if missing", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ gateway: {} }));

      await openclawConfig.setTelegramToken("123:abc");

      const writeCall = mockFs.writeFile.mock.calls[0];
      const writtenConfig = JSON.parse(writeCall[1] as string);

      expect(writtenConfig.channels).toBeDefined();
      expect(writtenConfig.channels.telegram).toBeDefined();
    });

    it("handles missing config file", async () => {
      mockFs.readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

      await openclawConfig.setTelegramToken("123:abc");

      const writeCall = mockFs.writeFile.mock.calls[0];
      const writtenConfig = JSON.parse(writeCall[1] as string);

      expect(writtenConfig.channels.telegram.botToken).toBe("123:abc");
    });

    it("creates config directory if missing", async () => {
      await openclawConfig.setTelegramToken("123:abc");

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
    });

    // The mode goes with the write and again as an explicit chmod: `rename`
    // replaces the inode, so the temp file's mode is the one openclaw.json ends
    // up with, and `writeFile`'s own `mode` is ignored for a stale temp that
    // already exists.
    it("writes to temp file at the config's own mode and renames atomically", async () => {
      await openclawConfig.setTelegramToken("123:abc");

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.any(String),
        { mode: 0o600, encoding: "utf-8" },
      );
      expect(mockFs.chmod).toHaveBeenCalledWith(expect.stringContaining(".tmp"), 0o600);
      expect(mockFs.rename).toHaveBeenCalled();
    });

    it("preserves existing telegram channel properties", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        channels: {
          telegram: {
            enabled: false,
            botToken: "old:token",
            customField: "keep-me",
          },
        },
      }));

      await openclawConfig.setTelegramToken("new:token");

      const writeCall = mockFs.writeFile.mock.calls[0];
      const writtenConfig = JSON.parse(writeCall[1] as string);

      expect(writtenConfig.channels.telegram.botToken).toBe("new:token");
      expect(writtenConfig.channels.telegram.enabled).toBe(true);
      expect(writtenConfig.channels.telegram.customField).toBe("keep-me");
    });

    it("strips insecure dmPolicy/allowFrom left over from older configs", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        channels: {
          telegram: {
            enabled: true,
            botToken: "old:token",
            dmPolicy: "open",
            allowFrom: ["*"],
          },
        },
      }));

      await openclawConfig.setTelegramToken("new:token");

      const writeCall = mockFs.writeFile.mock.calls[0];
      const writtenConfig = JSON.parse(writeCall[1] as string);

      expect(writtenConfig.channels.telegram.botToken).toBe("new:token");
      // Reconfiguring a token must re-secure the channel by removing the
      // old wildcard bypass, not merely no-op on top of it.
      expect(writtenConfig.channels.telegram).not.toHaveProperty("dmPolicy");
      expect(writtenConfig.channels.telegram).not.toHaveProperty("allowFrom");
    });

    it("writes pretty-printed JSON", async () => {
      await openclawConfig.setTelegramToken("123:abc");

      const writeCall = mockFs.writeFile.mock.calls[0];
      const written = writeCall[1] as string;

      // Pretty-printed JSON has newlines and indentation
      expect(written).toContain("\n");
      expect(written).toContain("  ");
    });
  });

  describe("getTelegramProgressStreaming", () => {
    it("defaults to ON (true) when no streaming override is set", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        channels: { telegram: { enabled: true, botToken: "123:abc" } },
      }));
      expect(await openclawConfig.getTelegramProgressStreaming()).toBe(true);
    });

    it("returns false when streaming is explicitly disabled (mode off)", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        channels: { telegram: { botToken: "123:abc", streaming: { mode: "off" } } },
      }));
      expect(await openclawConfig.getTelegramProgressStreaming()).toBe(false);
    });

    it("defaults to ON when the config is missing entirely", async () => {
      mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
      expect(await openclawConfig.getTelegramProgressStreaming()).toBe(true);
    });
  });

  describe("setTelegramProgressStreaming", () => {
    it("disabling writes streaming.mode=off and preserves botToken/enabled", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        channels: { telegram: { enabled: true, botToken: "123:abc", customField: "keep-me" } },
      }));

      await openclawConfig.setTelegramProgressStreaming(false);

      const writtenConfig = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(writtenConfig.channels.telegram.streaming).toEqual({ mode: "off" });
      expect(writtenConfig.channels.telegram.botToken).toBe("123:abc");
      expect(writtenConfig.channels.telegram.enabled).toBe(true);
      expect(writtenConfig.channels.telegram.customField).toBe("keep-me");
    });

    it("enabling removes the streaming override but keeps the rest", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        channels: { telegram: { enabled: true, botToken: "123:abc", streaming: { mode: "off" } } },
      }));

      await openclawConfig.setTelegramProgressStreaming(true);

      const writtenConfig = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(writtenConfig.channels.telegram).not.toHaveProperty("streaming");
      expect(writtenConfig.channels.telegram.botToken).toBe("123:abc");
      expect(writtenConfig.channels.telegram.enabled).toBe(true);
    });

    it("never writes dmPolicy/allowFrom", async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        channels: { telegram: { botToken: "123:abc" } },
      }));

      await openclawConfig.setTelegramProgressStreaming(false);

      const writtenConfig = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
      expect(writtenConfig.channels.telegram).not.toHaveProperty("dmPolicy");
      expect(writtenConfig.channels.telegram).not.toHaveProperty("allowFrom");
    });
  });

  describe("restartGateway", () => {
    it("restarts gateway service", async () => {
      await openclawConfig.restartGateway();

      expect(mockExecFile).toHaveBeenCalledWith(
        "/usr/bin/sudo",
        ["/usr/bin/systemctl", "restart", "clawbox-gateway.service"],
        expect.objectContaining({ timeout: 60000 }),
        expect.any(Function)
      );
    });

    it("falls back to the standalone OpenClaw user gateway when the ClawBox unit is missing", async () => {
      setupExecFileMock({
        "/usr/bin/sudo /usr/bin/systemctl restart clawbox-gateway.service": new Error("Failed to restart clawbox-gateway.service: Unit clawbox-gateway.service not found."),
        "systemctl --user restart openclaw-gateway.service": { stdout: "", stderr: "" },
      });

      await openclawConfig.restartGateway();

      expect(mockExecFile).toHaveBeenCalledWith(
        "systemctl",
        ["--user", "restart", "openclaw-gateway.service"],
        expect.objectContaining({ timeout: 60000 }),
        expect.any(Function)
      );
    });

    it("does not bypass a runtime mask by starting the standalone user gateway", async () => {
      const masked = new Error(
        "Failed to restart clawbox-gateway.service: Unit clawbox-gateway.service is masked.",
      );
      setupExecFileMock({
        "/usr/bin/sudo /usr/bin/systemctl restart clawbox-gateway.service": masked,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(openclawConfig.restartGateway()).rejects.toBe(masked);

      expect(mockExecFile).not.toHaveBeenCalledWith(
        "systemctl",
        ["--user", "restart", "openclaw-gateway.service"],
        expect.anything(),
        expect.any(Function),
      );
      errorSpy.mockRestore();
    });

    it("throws when restart fails", async () => {
      setupExecFileMock({
        systemctl: new Error("Service not found"),
      });

      await expect(openclawConfig.restartGateway()).rejects.toThrow("Service not found");
    });

    it("logs non-Error thrown values in error message", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      // Simulate a non-Error rejection (string thrown)
      const errString = "string error";
      setupExecFileMock({
        systemctl: Object.assign(errString as unknown as Error),
      });

      // The mock will reject with a string-like value
      // Since our mock wraps it, let's test via a direct approach
      mockExecFile.mockImplementation(((
        _cmd: string,
        _args: string[],
        _opts: object,
        callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        if (callback) {
          callback("not an Error object" as unknown as Error, { stdout: "", stderr: "" });
        }
        return {
          then: (_resolve: unknown, reject: (err: unknown) => void) => {
            reject("not an Error object");
            return { catch: () => ({}) };
          },
          catch: (reject: (err: unknown) => void) => {
            reject("not an Error object");
            return {};
          },
        } as unknown as ReturnType<typeof childProcess.execFile>;
      }) as unknown as typeof childProcess.execFile);

      await expect(openclawConfig.restartGateway()).rejects.toBe("not an Error object");
      expect(errorSpy).toHaveBeenCalledWith(
        "[openclaw-config] Failed to restart gateway:",
        "not an Error object"
      );
      errorSpy.mockRestore();
    });
  });

  describe("getSkillsDir", () => {
    it("returns workspace from openclaw config when set", () => {
      mockFsSync.readFileSync.mockReturnValue(
        JSON.stringify({
          agents: { defaults: { workspace: "/custom/workspace" } },
        })
      );

      const result = openclawConfig.getSkillsDir();

      expect(result).toBe("/custom/workspace");
    });

    it("falls back to <OpenClaw home>/workspace when it exists", () => {
      // Named explicitly rather than matched as `/\.openclaw\/workspace$/`:
      // the well-known workspace is a child of the home the CONFIG was read
      // from (`CLAWBOX_OPENCLAW_HOME` / `OPENCLAW_HOME` / `$HOME/.openclaw`),
      // and a `$HOME`-shaped assertion passed whichever of the two the code
      // used. This is the delete target `openclawSkillRoot()` appends `skills`
      // to, so the two spellings must not be interchangeable here.
      // `CLAWBOX_OPENCLAW_HOME` outranks `OPENCLAW_HOME`, so a suite that
      // happened to carry one would decide this assertion instead of the code.
      const restore = saveEnv("CLAWBOX_OPENCLAW_HOME", "OPENCLAW_HOME");
      delete process.env.CLAWBOX_OPENCLAW_HOME;
      process.env.OPENCLAW_HOME = "/custom/openclaw-home";
      try {
        mockFsSync.readFileSync.mockReturnValue(JSON.stringify({}));
        mockFsSync.existsSync.mockReturnValue(true);

        const result = openclawConfig.getSkillsDir();

        expect(result).toBe("/custom/openclaw-home/workspace");
      } finally {
        restore();
      }
    });

    it("expands a ~ workspace against HOME", () => {
      // The same rule `gateway-pre-start.sh` (expanduser) and
      // `openclawWorkspaceDir()` in src/lib/language-persona.ts already apply
      // to this key. Left literal, `~/clawd` resolved to a `~` directory under
      // the server's own working directory — a delete target no configuration
      // on the box names.
      // Through `saveEnv` like the rest of the file: `process.env` coerces an
      // assignment to a string, so restoring an UNSET `HOME` by assignment
      // would write the literal "undefined" — truthy — and every later
      // `process.env.HOME || …` in this worker would resolve under a directory
      // of that name, far from the file that caused it.
      const restore = saveEnv("HOME");
      process.env.HOME = "/test/home";
      try {
        mockFsSync.readFileSync.mockReturnValue(
          JSON.stringify({ agents: { defaults: { workspace: "~/clawd" } } }),
        );

        const result = openclawConfig.getSkillsDir();

        expect(result).toBe("/test/home/clawd");
      } finally {
        restore();
      }
    });

    it("falls back to ~/clawd when workspace dir does not exist", () => {
      mockFsSync.readFileSync.mockReturnValue(JSON.stringify({}));
      mockFsSync.existsSync.mockReturnValue(false);

      const result = openclawConfig.getSkillsDir();

      expect(result).toMatch(/\/clawd$/);
    });

    it("falls back to ~/clawd when config file cannot be read", () => {
      mockFsSync.readFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockFsSync.existsSync.mockReturnValue(false);

      const result = openclawConfig.getSkillsDir();

      expect(result).toMatch(/\/clawd$/);
    });

    it("falls back when workspace is empty string", () => {
      mockFsSync.readFileSync.mockReturnValue(
        JSON.stringify({
          agents: { defaults: { workspace: "" } },
        })
      );
      mockFsSync.existsSync.mockReturnValue(false);

      const result = openclawConfig.getSkillsDir();

      expect(result).toMatch(/\/clawd$/);
    });

    it("falls back when workspace is not a string", () => {
      mockFsSync.readFileSync.mockReturnValue(
        JSON.stringify({
          agents: { defaults: { workspace: 42 } },
        })
      );
      mockFsSync.existsSync.mockReturnValue(false);

      const result = openclawConfig.getSkillsDir();

      expect(result).toMatch(/\/clawd$/);
    });

    it("falls back when agents.defaults is missing", () => {
      mockFsSync.readFileSync.mockReturnValue(
        JSON.stringify({ agents: {} })
      );
      mockFsSync.existsSync.mockReturnValue(false);

      const result = openclawConfig.getSkillsDir();

      expect(result).toMatch(/\/clawd$/);
    });

    it("falls back when config has invalid JSON", () => {
      mockFsSync.readFileSync.mockReturnValue("not valid json {{{");
      mockFsSync.existsSync.mockReturnValue(false);

      const result = openclawConfig.getSkillsDir();

      expect(result).toMatch(/\/clawd$/);
    });

    it("uses HOME env var for path resolution", () => {
      // Through `saveEnv` for the reason spelled out on the case above: an
      // assignment restore writes the string "undefined" for an unset HOME.
      const restore = saveEnv("HOME");
      process.env.HOME = "/test/home";
      try {
        // Reset modules so getSkillsDir picks up new HOME
        mockFsSync.readFileSync.mockReturnValue(JSON.stringify({}));
        mockFsSync.existsSync.mockReturnValue(false);

        const result = openclawConfig.getSkillsDir();

        // getSkillsDir reads HOME at call time
        expect(result).toBe("/test/home/clawd");
      } finally {
        restore();
      }
    });
  });

  describe("inferConfiguredLocalModel", () => {
    it("prefers a local fallback model when present", () => {
      const result = openclawConfig.inferConfiguredLocalModel({
        agents: {
          defaults: {
            model: {
              primary: "deepseek/deepseek-chat",
              fallbacks: ["llamacpp/gemma4-e2b-it-q4_0"],
            },
          },
        },
      });

      expect(result).toEqual({
        provider: "llamacpp",
        model: "llamacpp/gemma4-e2b-it-q4_0",
      });
    });

    it("falls back to local provider definitions when config-store style state is missing", () => {
      const result = openclawConfig.inferConfiguredLocalModel({
        agents: {
          defaults: {
            model: {
              primary: "deepseek/deepseek-chat",
              fallbacks: ["deepseek/deepseek-chat"],
            },
          },
        },
        models: {
          providers: {
            llamacpp: {
              models: [{ id: "gemma4-e2b-it-q4_0" }],
            },
          },
        },
      });

      expect(result).toEqual({
        provider: "llamacpp",
        model: "llamacpp/gemma4-e2b-it-q4_0",
      });
    });
  });

  describe("ensureLocalAiProxyUrls", () => {
    it("rewrites legacy local runtime URLs to the ClawBox proxy", async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({
        models: {
          providers: {
            llamacpp: { baseUrl: "http://127.0.0.1:8080/v1" },
            ollama: { baseUrl: "http://127.0.0.1:11434" },
          },
        },
      }) as never);

      const changed = await openclawConfig.ensureLocalAiProxyUrls();

      expect(changed).toBe(true);
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("openclaw.json.tmp"),
        expect.stringContaining('"baseUrl": "http://127.0.0.1/setup-api/local-ai/llamacpp/v1"'),
        { mode: 0o600, encoding: "utf-8" },
      );
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("openclaw.json.tmp"),
        expect.stringContaining('"baseUrl": "http://127.0.0.1/setup-api/local-ai/ollama"'),
        { mode: 0o600, encoding: "utf-8" },
      );
    });

    it("skips writes when local AI providers already point at the proxy", async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify({
        models: {
          providers: {
            llamacpp: { baseUrl: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1" },
            ollama: { baseUrl: "http://127.0.0.1/setup-api/local-ai/ollama" },
          },
        },
      }) as never);

      const changed = await openclawConfig.ensureLocalAiProxyUrls();

      expect(changed).toBe(false);
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });
  });
});
