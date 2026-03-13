import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs/promises";
import * as childProcess from "child_process";

// Mock the dependencies
vi.mock("os");
vi.mock("fs/promises");
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

const mockOs = vi.mocked(os);
const mockFs = vi.mocked(fs);
const mockExecFile = vi.mocked(childProcess.execFile);

describe("GET /setup-api/system/info", () => {
  let systemInfoGet: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();

    // Setup OS mocks
    mockOs.hostname.mockReturnValue("clawbox");
    mockOs.type.mockReturnValue("Linux");
    mockOs.release.mockReturnValue("5.15.0");
    mockOs.arch.mockReturnValue("arm64");
    mockOs.cpus.mockReturnValue([{} as os.CpuInfo, {} as os.CpuInfo, {} as os.CpuInfo, {} as os.CpuInfo]);
    mockOs.totalmem.mockReturnValue(8 * 1024 * 1024 * 1024);
    mockOs.freemem.mockReturnValue(4 * 1024 * 1024 * 1024);
    mockOs.loadavg.mockReturnValue([2.0, 1.5, 1.0]);
    mockOs.networkInterfaces.mockReturnValue({
      eth0: [{
        address: "192.168.1.100",
        family: "IPv4",
        internal: false,
        netmask: "255.255.255.0",
        mac: "00:00:00:00:00:00",
        cidr: "192.168.1.100/24",
      }],
    });

    // Setup execFile mock
    mockExecFile.mockImplementation(((
      cmd: string,
      _args: string[],
      callback?: (error: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      if (callback) {
        if (cmd === "uptime") {
          callback(null, { stdout: "up 5 days, 2 hours", stderr: "" });
        } else if (cmd === "df") {
          callback(null, { stdout: "Size   Used   Avail\n128G    64G    64G", stderr: "" });
        }
      }
      return {} as ReturnType<typeof childProcess.execFile>;
    }) as typeof childProcess.execFile);

    // Setup fs.readFile mock
    mockFs.readFile.mockImplementation(async (path: Parameters<typeof fs.readFile>[0]) => {
      const pathStr = path.toString();
      if (pathStr.includes("thermal_zone0/temp")) return "55000";
      if (pathStr.includes("gpu/load")) return "300";
      if (pathStr.includes("statistics/rx_bytes")) return "1000000000";
      if (pathStr.includes("statistics/tx_bytes")) return "500000000";
      throw new Error("File not found");
    });

    const mod = await import("@/app/setup-api/system/info/route");
    systemInfoGet = mod.GET;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns system information", async () => {
    const res = await systemInfoGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.hostname).toBe("clawbox");
    expect(body.platform).toBe("Linux 5.15.0");
    expect(body.arch).toBe("arm64");
    expect(body.cpus).toBe(4);
  });

  it("returns memory information", async () => {
    const res = await systemInfoGet();
    const body = await res.json();

    expect(body.memoryTotal).toBe("8192 MB");
    expect(body.memoryFree).toBe("4096 MB");
    expect(body.memoryUsedPercent).toBe(50);
  });

  it("returns CPU load information", async () => {
    const res = await systemInfoGet();
    const body = await res.json();

    // loadavg[0] = 2.0, cpus = 4, so (2.0 / 4) * 100 = 50%
    expect(body.cpuLoadPercent).toBe(50);
  });

  it("returns disk information", async () => {
    const res = await systemInfoGet();
    const body = await res.json();

    expect(body.diskTotal).toBe("128G");
    expect(body.diskUsed).toBe("64G");
    expect(body.diskFree).toBe("64G");
    expect(body.diskUsedPercent).toBe(50);
  });

  it("returns temperature information", async () => {
    const res = await systemInfoGet();
    const body = await res.json();

    expect(body.temperature).toBe("55.0°C");
    expect(body.temperatureValue).toBe(55);
  });

  it("returns network information", async () => {
    const res = await systemInfoGet();
    const body = await res.json();

    expect(body.networkIp).toBe("192.168.1.100");
    expect(body.networkInterface).toBe("eth0");
    expect(body.networkRxBytes).toBe(1000000000);
    expect(body.networkTxBytes).toBe(500000000);
  });

  it("returns uptime", async () => {
    const res = await systemInfoGet();
    const body = await res.json();

    expect(body.uptime).toBe("up 5 days, 2 hours");
  });

  it("returns GPU load", async () => {
    const res = await systemInfoGet();
    const body = await res.json();

    expect(body.gpuLoadPercent).toBe(30); // 300 / 10 = 30
  });
});
