import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs/promises";
import * as childProcess from "child_process";

// Mock the modules
vi.mock("os");
vi.mock("fs/promises");
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

const mockOs = vi.mocked(os);
const mockFs = vi.mocked(fs);
const mockExecFile = vi.mocked(childProcess.execFile);

// Helper to create execFile mock that works with promisify
function setupExecFileMock(results: Record<string, { stdout: string; stderr: string } | Error>) {
  mockExecFile.mockImplementation(((
    cmd: string,
    _args: string[],
    callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    const result = results[cmd];
    if (callback) {
      if (result instanceof Error) {
        callback(result, { stdout: "", stderr: "" });
      } else if (result) {
        callback(null, result);
      } else {
        callback(new Error("Unknown command"), { stdout: "", stderr: "" });
      }
    }
    return {} as ReturnType<typeof childProcess.execFile>;
  }) as typeof childProcess.execFile);
}

describe("system-info", () => {
  let systemInfo: typeof import("@/lib/system-info");

  beforeEach(async () => {
    vi.resetModules();

    // Setup default mocks
    mockOs.hostname.mockReturnValue("test-host");
    mockOs.type.mockReturnValue("Linux");
    mockOs.release.mockReturnValue("5.15.0");
    mockOs.arch.mockReturnValue("arm64");
    mockOs.cpus.mockReturnValue([{} as os.CpuInfo, {} as os.CpuInfo]);
    mockOs.totalmem.mockReturnValue(4 * 1024 * 1024 * 1024); // 4GB
    mockOs.freemem.mockReturnValue(2 * 1024 * 1024 * 1024); // 2GB
    mockOs.loadavg.mockReturnValue([1.0, 0.5, 0.25]);
    mockOs.networkInterfaces.mockReturnValue({
      eth0: [
        {
          address: "192.168.1.100",
          family: "IPv4",
          internal: false,
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: "192.168.1.100/24",
        },
      ],
    });

    // Default execFile mock
    setupExecFileMock({
      uptime: { stdout: "up 2 days, 3 hours", stderr: "" },
      df: { stdout: "Size   Used   Avail\n 50G    25G    25G", stderr: "" },
    });

    // Mock fs.readFile for temperature and GPU
    mockFs.readFile.mockImplementation(async (path: Parameters<typeof fs.readFile>[0]) => {
      const pathStr = path.toString();
      if (pathStr.includes("thermal_zone0/temp")) {
        return "45000"; // 45°C
      }
      if (pathStr.includes("gpu/load")) {
        return "500"; // 50%
      }
      if (pathStr.includes("statistics/rx_bytes")) {
        return "1234567890";
      }
      if (pathStr.includes("statistics/tx_bytes")) {
        return "987654321";
      }
      throw new Error("File not found");
    });

    systemInfo = await import("@/lib/system-info");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("gather", () => {
    it("returns SystemInfo object with all fields", async () => {
      const info = await systemInfo.gather();

      expect(info).toHaveProperty("hostname");
      expect(info).toHaveProperty("platform");
      expect(info).toHaveProperty("arch");
      expect(info).toHaveProperty("cpus");
      expect(info).toHaveProperty("memoryTotal");
      expect(info).toHaveProperty("memoryFree");
      expect(info).toHaveProperty("memoryUsedPercent");
      expect(info).toHaveProperty("cpuLoadPercent");
      expect(info).toHaveProperty("uptime");
      expect(info).toHaveProperty("disk");
      expect(info).toHaveProperty("diskUsed");
      expect(info).toHaveProperty("diskFree");
      expect(info).toHaveProperty("diskTotal");
      expect(info).toHaveProperty("diskUsedPercent");
      expect(info).toHaveProperty("temperature");
      expect(info).toHaveProperty("temperatureValue");
      expect(info).toHaveProperty("gpuLoadPercent");
      expect(info).toHaveProperty("networkIp");
      expect(info).toHaveProperty("networkInterface");
      expect(info).toHaveProperty("networkRxBytes");
      expect(info).toHaveProperty("networkTxBytes");
    });

    it("returns correct hostname", async () => {
      const info = await systemInfo.gather();
      expect(info.hostname).toBe("test-host");
    });

    it("returns correct platform string", async () => {
      const info = await systemInfo.gather();
      expect(info.platform).toBe("Linux 5.15.0");
    });

    it("returns correct architecture", async () => {
      const info = await systemInfo.gather();
      expect(info.arch).toBe("arm64");
    });

    it("returns correct CPU count", async () => {
      const info = await systemInfo.gather();
      expect(info.cpus).toBe(2);
    });

    it("formats memory correctly", async () => {
      const info = await systemInfo.gather();
      expect(info.memoryTotal).toBe("4096 MB");
      expect(info.memoryFree).toBe("2048 MB");
      expect(info.memoryUsedPercent).toBe(50);
    });

    it("calculates CPU load percentage correctly", async () => {
      const info = await systemInfo.gather();
      // loadavg[0] = 1.0, cpus = 2, so (1.0 / 2) * 100 = 50%
      expect(info.cpuLoadPercent).toBe(50);
    });

    it("caps CPU load at 100%", async () => {
      mockOs.loadavg.mockReturnValue([10.0, 5.0, 2.5]); // Very high load
      const info = await systemInfo.gather();
      expect(info.cpuLoadPercent).toBeLessThanOrEqual(100);
    });

    it("returns uptime from uptime command", async () => {
      const info = await systemInfo.gather();
      expect(info.uptime).toBe("up 2 days, 3 hours");
    });

    it("parses disk info from df output", async () => {
      const info = await systemInfo.gather();
      expect(info.diskTotal).toBe("50G");
      expect(info.diskUsed).toBe("25G");
      expect(info.diskFree).toBe("25G");
      expect(info.diskUsedPercent).toBe(50);
    });

    it("parses temperature from thermal zone", async () => {
      const info = await systemInfo.gather();
      expect(info.temperature).toBe("45.0°C");
      expect(info.temperatureValue).toBe(45);
    });

    it("calculates GPU load percentage", async () => {
      const info = await systemInfo.gather();
      expect(info.gpuLoadPercent).toBe(50);
    });

    it("returns network information", async () => {
      const info = await systemInfo.gather();
      expect(info.networkIp).toBe("192.168.1.100");
      expect(info.networkInterface).toBe("eth0");
      expect(info.networkRxBytes).toBe(1234567890);
      expect(info.networkTxBytes).toBe(987654321);
    });

    it("handles missing network gracefully", async () => {
      mockOs.networkInterfaces.mockReturnValue({});
      const info = await systemInfo.gather();
      expect(info.networkIp).toBe("No connection");
      expect(info.networkInterface).toBe("—");
      expect(info.networkRxBytes).toBe(0);
      expect(info.networkTxBytes).toBe(0);
    });

    it("skips internal interfaces", async () => {
      mockOs.networkInterfaces.mockReturnValue({
        lo: [
          {
            address: "127.0.0.1",
            family: "IPv4",
            internal: true,
            netmask: "255.0.0.0",
            mac: "00:00:00:00:00:00",
            cidr: "127.0.0.1/8",
          },
        ],
      });
      const info = await systemInfo.gather();
      expect(info.networkIp).toBe("No connection");
    });

    it("handles thermal file read failure gracefully", async () => {
      mockFs.readFile.mockImplementation(async (path: Parameters<typeof fs.readFile>[0]) => {
        const pathStr = path.toString();
        if (pathStr.includes("thermal_zone0/temp")) {
          throw new Error("ENOENT");
        }
        if (pathStr.includes("gpu/load")) {
          return "500";
        }
        if (pathStr.includes("statistics")) {
          return "0";
        }
        throw new Error("File not found");
      });

      const info = await systemInfo.gather();
      expect(info.temperature).toBe("unknown");
      expect(info.temperatureValue).toBeNull();
    });

    it("handles GPU file read failure gracefully", async () => {
      mockFs.readFile.mockImplementation(async (path: Parameters<typeof fs.readFile>[0]) => {
        const pathStr = path.toString();
        if (pathStr.includes("thermal_zone0/temp")) {
          return "45000";
        }
        if (pathStr.includes("gpu/load")) {
          throw new Error("ENOENT");
        }
        if (pathStr.includes("statistics")) {
          return "0";
        }
        throw new Error("File not found");
      });

      const info = await systemInfo.gather();
      expect(info.gpuLoadPercent).toBe(0);
    });

    it("handles uptime command failure gracefully", async () => {
      setupExecFileMock({
        uptime: new Error("Command failed"),
        df: { stdout: "Size   Used   Avail\n 50G    25G    25G", stderr: "" },
      });

      const info = await systemInfo.gather();
      expect(info.uptime).toBe("unknown");
    });

    it("handles df command failure gracefully", async () => {
      setupExecFileMock({
        uptime: { stdout: "up 1 day", stderr: "" },
        df: new Error("Command failed"),
      });

      const info = await systemInfo.gather();
      expect(info.diskTotal).toBe("unknown");
      expect(info.diskUsed).toBe("unknown");
      expect(info.diskFree).toBe("unknown");
      expect(info.diskUsedPercent).toBe(0);
    });
  });

  describe("parseSizeToMB (internal)", () => {
    // These test the disk parsing behavior through gather()
    it("parses gigabytes correctly", async () => {
      setupExecFileMock({
        uptime: { stdout: "up 1 day", stderr: "" },
        df: { stdout: "Size   Used   Avail\n100G    75G    25G", stderr: "" },
      });

      const info = await systemInfo.gather();
      expect(info.diskUsedPercent).toBe(75); // 75G / 100G = 75%
    });

    it("parses terabytes correctly", async () => {
      setupExecFileMock({
        uptime: { stdout: "up 1 day", stderr: "" },
        df: { stdout: "Size   Used   Avail\n1T    0.5T    0.5T", stderr: "" },
      });

      const info = await systemInfo.gather();
      expect(info.diskUsedPercent).toBe(50); // 0.5T / 1T = 50%
    });

    it("parses megabytes correctly", async () => {
      setupExecFileMock({
        uptime: { stdout: "up 1 day", stderr: "" },
        df: { stdout: "Size   Used   Avail\n1000M    250M    750M", stderr: "" },
      });

      const info = await systemInfo.gather();
      expect(info.diskUsedPercent).toBe(25); // 250M / 1000M = 25%
    });
  });

  describe("parseTemperature (internal)", () => {
    it("converts millidegrees to Celsius", async () => {
      mockFs.readFile.mockImplementation(async (path: Parameters<typeof fs.readFile>[0]) => {
        const pathStr = path.toString();
        if (pathStr.includes("thermal_zone0/temp")) {
          return "72500"; // 72.5°C
        }
        if (pathStr.includes("gpu/load")) {
          return "0";
        }
        if (pathStr.includes("statistics")) {
          return "0";
        }
        throw new Error("File not found");
      });

      const info = await systemInfo.gather();
      expect(info.temperature).toBe("72.5°C");
      expect(info.temperatureValue).toBe(72.5);
    });

    it("handles invalid temperature value", async () => {
      mockFs.readFile.mockImplementation(async (path: Parameters<typeof fs.readFile>[0]) => {
        const pathStr = path.toString();
        if (pathStr.includes("thermal_zone0/temp")) {
          return "not-a-number";
        }
        if (pathStr.includes("gpu/load")) {
          return "0";
        }
        if (pathStr.includes("statistics")) {
          return "0";
        }
        throw new Error("File not found");
      });

      const info = await systemInfo.gather();
      expect(info.temperature).toBe("unknown");
      expect(info.temperatureValue).toBeNull();
    });
  });

  describe("getNetBytes (internal)", () => {
    it("returns 0 when stats file is unreadable", async () => {
      mockFs.readFile.mockImplementation(async (path: Parameters<typeof fs.readFile>[0]) => {
        const pathStr = path.toString();
        if (pathStr.includes("statistics")) {
          throw new Error("ENOENT");
        }
        if (pathStr.includes("thermal")) {
          return "45000";
        }
        if (pathStr.includes("gpu")) {
          return "0";
        }
        throw new Error("File not found");
      });

      const info = await systemInfo.gather();
      expect(info.networkRxBytes).toBe(0);
      expect(info.networkTxBytes).toBe(0);
    });
  });
});
