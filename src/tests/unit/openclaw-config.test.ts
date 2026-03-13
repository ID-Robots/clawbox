import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import * as fs from "fs/promises";

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

const mockExecFile = vi.mocked(childProcess.execFile);
const mockFs = vi.mocked(fs.default);

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

      expect(mockFs.mkdir).toHaveBeenCalled();
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
  });

  describe("restartGateway", () => {
    it("restarts gateway service", async () => {
      await openclawConfig.restartGateway();

      expect(mockExecFile).toHaveBeenCalledWith(
        "systemctl",
        ["restart", "clawbox-gateway.service"],
        expect.objectContaining({ timeout: 15000 }),
        expect.any(Function)
      );
    });

    it("throws when restart fails", async () => {
      setupExecFileMock({
        systemctl: new Error("Service not found"),
      });

      await expect(openclawConfig.restartGateway()).rejects.toThrow("Service not found");
    });
  });
});
