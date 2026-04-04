import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import * as fs from "fs/promises";
import * as fsSync from "fs";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  },
}));

const mockExecFile = vi.mocked(childProcess.execFile);
const mockFs = vi.mocked(fs.default);
const mockFsSync = vi.mocked(fsSync.default);

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
    return returnObj as ReturnType<typeof childProcess.execFile>;
  }) as typeof childProcess.execFile);
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
    it("sets Telegram token in config", async () => {
      await openclawConfig.setTelegramToken("123:abc");

      expect(mockFs.writeFile).toHaveBeenCalled();
      const writeCall = mockFs.writeFile.mock.calls[0];
      const writtenConfig = JSON.parse(writeCall[1] as string);

      expect(writtenConfig.channels.telegram.botToken).toBe("123:abc");
      expect(writtenConfig.channels.telegram.enabled).toBe(true);
      expect(writtenConfig.channels.telegram.dmPolicy).toBe("open");
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
      mockFs.readFile.mockRejectedValue(new Error("ENOENT"));

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

    it("writes to temp file and renames atomically", async () => {
      await openclawConfig.setTelegramToken("123:abc");

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.any(String),
        "utf-8"
      );
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

    it("sets allowFrom to wildcard", async () => {
      await openclawConfig.setTelegramToken("123:abc");

      const writeCall = mockFs.writeFile.mock.calls[0];
      const writtenConfig = JSON.parse(writeCall[1] as string);

      expect(writtenConfig.channels.telegram.allowFrom).toEqual(["*"]);
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
        } as ReturnType<typeof childProcess.execFile>;
      }) as typeof childProcess.execFile);

      await expect(openclawConfig.restartGateway()).rejects.toBe("not an Error object");
      expect(errorSpy).toHaveBeenCalledWith(
        "[openclaw-config] Failed to restart gateway:",
        "not an Error object"
      );
      errorSpy.mockRestore();
    });
  });

  describe("reloadGateway", () => {
    let originalKill: typeof process.kill;

    beforeEach(() => {
      originalKill = process.kill;
      process.kill = vi.fn() as unknown as typeof process.kill;
    });

    afterEach(() => {
      process.kill = originalKill;
    });

    it("sends SIGUSR1 to the gateway process", async () => {
      setupExecFileMock({
        "pgrep -f openclaw-gateway": { stdout: "12345\n", stderr: "" },
      });

      await openclawConfig.reloadGateway();

      expect(process.kill).toHaveBeenCalledWith(12345, "SIGUSR1");
    });

    it("uses first PID when pgrep returns multiple", async () => {
      setupExecFileMock({
        "pgrep -f openclaw-gateway": { stdout: "12345\n67890\n", stderr: "" },
      });

      await openclawConfig.reloadGateway();

      expect(process.kill).toHaveBeenCalledWith(12345, "SIGUSR1");
    });

    it("does not throw when pgrep finds no process (ESRCH)", async () => {
      const error = new Error("No process found") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      setupExecFileMock({
        pgrep: error,
      });

      // Should not throw - ESRCH is silently ignored
      await expect(openclawConfig.reloadGateway()).resolves.toBeUndefined();
    });

    it("does not call process.kill when pgrep returns empty output", async () => {
      setupExecFileMock({
        "pgrep -f openclaw-gateway": { stdout: "", stderr: "" },
      });

      await openclawConfig.reloadGateway();

      expect(process.kill).not.toHaveBeenCalled();
    });

    it("does not call process.kill when PID is NaN", async () => {
      setupExecFileMock({
        "pgrep -f openclaw-gateway": { stdout: "not-a-number\n", stderr: "" },
      });

      await openclawConfig.reloadGateway();

      expect(process.kill).not.toHaveBeenCalled();
    });

    it("warns on non-ESRCH errors", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = new Error("Unexpected error") as NodeJS.ErrnoException;
      error.code = "EPERM";
      setupExecFileMock({
        pgrep: error,
      });

      await openclawConfig.reloadGateway();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("reloadGateway failed"),
        expect.any(String)
      );
      warnSpy.mockRestore();
    });

    it("warns with raw value when non-Error is thrown", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      // Simulate a non-Error rejection with a code property (not ESRCH)
      mockExecFile.mockImplementation(((
        _cmd: string,
        _args: string[],
        _opts: object,
        callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
      ) => {
        const nonError = { code: "EPERM", message: "not an Error" };
        if (callback) {
          callback(nonError as unknown as Error, { stdout: "", stderr: "" });
        }
        return {
          then: (_resolve: unknown, reject: (err: unknown) => void) => {
            reject(nonError);
            return { catch: () => ({}) };
          },
          catch: (reject: (err: unknown) => void) => {
            reject(nonError);
            return {};
          },
        } as ReturnType<typeof childProcess.execFile>;
      }) as typeof childProcess.execFile);

      await openclawConfig.reloadGateway();

      expect(warnSpy).toHaveBeenCalledWith(
        "[openclaw-config] reloadGateway failed:",
        expect.objectContaining({ code: "EPERM" })
      );
      warnSpy.mockRestore();
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

    it("falls back to .openclaw/workspace when it exists", () => {
      mockFsSync.readFileSync.mockReturnValue(JSON.stringify({}));
      mockFsSync.existsSync.mockReturnValue(true);

      const result = openclawConfig.getSkillsDir();

      expect(result).toMatch(/\.openclaw\/workspace$/);
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
      const originalHome = process.env.HOME;
      process.env.HOME = "/test/home";
      try {
        // Reset modules so getSkillsDir picks up new HOME
        mockFsSync.readFileSync.mockReturnValue(JSON.stringify({}));
        mockFsSync.existsSync.mockReturnValue(false);

        const result = openclawConfig.getSkillsDir();

        // getSkillsDir reads HOME at call time
        expect(result).toBe("/test/home/clawd");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });
});
