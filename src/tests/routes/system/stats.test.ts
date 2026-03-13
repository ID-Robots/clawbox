import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs";
import { execSync } from "child_process";

// Mock the dependencies
vi.mock("os");
vi.mock("fs");
vi.mock("child_process");

const mockOs = vi.mocked(os);
const mockFs = vi.mocked(fs);
const mockExecSync = vi.mocked(execSync);

describe("GET /setup-api/system/stats", () => {
  let systemStatsGet: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();

    // Setup OS mocks
    mockOs.cpus.mockReturnValue([{} as os.CpuInfo, {} as os.CpuInfo, {} as os.CpuInfo, {} as os.CpuInfo]);
    mockOs.totalmem.mockReturnValue(8 * 1024 * 1024 * 1024);
    mockOs.freemem.mockReturnValue(4 * 1024 * 1024 * 1024);
    mockOs.loadavg.mockReturnValue([2.0, 1.5, 1.0]);
    mockOs.hostname.mockReturnValue("clawbox");
    mockOs.type.mockReturnValue("Linux");
    mockOs.release.mockReturnValue("5.15.0");
    mockOs.arch.mockReturnValue("arm64");
    mockOs.uptime.mockReturnValue(432000); // 5 days
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

    // Mock fs.readFileSync for /proc files
    let readCount = 0;
    mockFs.readFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
      const pathStr = path.toString();
      if (pathStr === "/proc/stat") {
        readCount++;
        if (readCount === 1) {
          return "cpu  100 50 100 800 10 5 5 0 0 0\n";
        }
        return "cpu  110 55 110 810 12 6 6 0 0 0\n";
      }
      if (pathStr === "/proc/net/dev") {
        return `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000000 1000 0 0 0 0 0 0 1000000 1000 0 0 0 0 0 0
  eth0: 5000000000 4000000 0 0 0 0 0 0 2000000000 3000000 0 0 0 0 0 0`;
      }
      if (pathStr === "/proc/meminfo") {
        return `MemTotal:        8000000 kB
MemFree:         2000000 kB
MemAvailable:    4000000 kB
Buffers:          500000 kB
Cached:          1500000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB`;
      }
      if (pathStr.includes("/sys/devices/virtual/thermal/thermal_zone")) {
        return "55000";
      }
      throw new Error(`File not found: ${pathStr}`);
    });

    // Mock execSync for df and ps
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("df")) {
        return `Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1       128G   64G   64G  50% /
/dev/sda2       500G  250G  250G  50% /home`;
      }
      if (cmd.startsWith("ps")) {
        return `  PID USER      %CPU %MEM COMMAND
    1 root       0.1  0.2 /sbin/init
  100 user       5.0  2.0 /usr/bin/node
  200 user      10.0  5.0 /usr/bin/python3`;
      }
      return "";
    });

    const mod = await import("@/app/setup-api/system/stats/route");
    systemStatsGet = mod.GET;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns system stats with CPU usage", async () => {
    const res = await systemStatsGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cpu).toBeDefined();
    expect(typeof body.cpu.usage).toBe("number");
    expect(body.cpu.usage).toBeGreaterThanOrEqual(0);
    expect(body.cpu.usage).toBeLessThanOrEqual(100);
  });

  it("returns memory stats", async () => {
    const res = await systemStatsGet();
    const body = await res.json();

    expect(body.memory).toBeDefined();
    expect(body.memory.total).toBeDefined();
    expect(body.memory.free).toBeDefined();
    expect(body.memory.usedPercent).toBeDefined();
  });

  it("returns storage mounts", async () => {
    const res = await systemStatsGet();
    const body = await res.json();

    expect(body.storage).toBeDefined();
    expect(Array.isArray(body.storage)).toBe(true);
  });

  it("returns network interfaces", async () => {
    const res = await systemStatsGet();
    const body = await res.json();

    expect(body.network).toBeDefined();
    expect(Array.isArray(body.network)).toBe(true);
  });

  it("returns processes list", async () => {
    const res = await systemStatsGet();
    const body = await res.json();

    expect(body.processes).toBeDefined();
    expect(Array.isArray(body.processes)).toBe(true);
  });

  it("returns load averages in cpu object", async () => {
    const res = await systemStatsGet();
    const body = await res.json();

    expect(body.cpu).toBeDefined();
    expect(body.cpu.loadAvg).toBeDefined();
    expect(body.cpu.loadAvg).toHaveLength(3);
  });

  it("returns system overview", async () => {
    const res = await systemStatsGet();
    const body = await res.json();

    expect(body.overview).toBeDefined();
    expect(body.overview.hostname).toBe("clawbox");
    expect(body.overview.kernel).toBeDefined();
    expect(body.overview.uptime).toBeDefined();
  });

  it("handles /proc/stat read failure gracefully", async () => {
    mockFs.readFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
      const pathStr = path.toString();
      if (pathStr === "/proc/stat") {
        throw new Error("Permission denied");
      }
      if (pathStr === "/proc/net/dev") {
        return "Inter-|   Receive                                                |  Transmit\n face |bytes\neth0: 1000 100 0 0 0 0 0 0 500 50 0 0 0 0 0 0";
      }
      throw new Error("File not found");
    });

    const res = await systemStatsGet();
    const body = await res.json();

    // Should fall back to load average calculation
    expect(res.status).toBe(200);
    expect(body.cpu).toBeDefined();
  });

  it("handles df command failure gracefully", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("df")) {
        throw new Error("Command failed");
      }
      if (cmd.startsWith("ps")) {
        return "PID USER %CPU %MEM COMMAND\n1 root 0.1 0.2 init";
      }
      return "";
    });

    const res = await systemStatsGet();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.storage).toEqual([]);
  });
});
