import { NextResponse } from "next/server";
import os from "os";
import { execSync } from "child_process";
import fs from "fs";

export const dynamic = "force-dynamic";

interface DiskMount {
  filesystem: string;
  size: string;
  used: string;
  avail: string;
  usePercent: number;
  mountpoint: string;
}

interface NetworkInterface {
  name: string;
  ip: string;
  rx: number;
  tx: number;
}

interface ProcessEntry {
  pid: string;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

function getCpuUsage(): number {
  try {
    const stat1 = fs.readFileSync("/proc/stat", "utf-8");
    const line1 = stat1.split("\n")[0];
    const parts1 = line1.trim().split(/\s+/).slice(1).map(Number);
    const idle1 = parts1[3];
    const total1 = parts1.reduce((a, b) => a + b, 0);

    // Sleep 200ms via busy wait isn't ideal — use two reads with a small gap
    const start = Date.now();
    while (Date.now() - start < 200) { /* busy wait */ }

    const stat2 = fs.readFileSync("/proc/stat", "utf-8");
    const line2 = stat2.split("\n")[0];
    const parts2 = line2.trim().split(/\s+/).slice(1).map(Number);
    const idle2 = parts2[3];
    const total2 = parts2.reduce((a, b) => a + b, 0);

    const dIdle = idle2 - idle1;
    const dTotal = total2 - total1;

    if (dTotal === 0) return 0;
    return Math.round(((dTotal - dIdle) / dTotal) * 100);
  } catch {
    // Fallback: use load average approximation
    const cpuCount = os.cpus().length;
    return Math.min(100, Math.round((os.loadavg()[0] / cpuCount) * 100));
  }
}

function getDiskUsage(): DiskMount[] {
  try {
    const output = execSync("df -h -x tmpfs -x devtmpfs -x squashfs 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const lines = output.trim().split("\n").slice(1); // skip header
    const result: DiskMount[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const [filesystem, size, used, avail, usePercentStr, mountpoint] = parts;
      const usePercent = parseInt(usePercentStr.replace("%", ""), 10) || 0;
      // Filter out uninteresting mounts
      if (mountpoint.startsWith("/sys") || mountpoint.startsWith("/proc") || mountpoint.startsWith("/dev/")) continue;
      result.push({ filesystem, size, used, avail, usePercent, mountpoint });
    }
    return result.slice(0, 8); // max 8 mounts
  } catch {
    return [];
  }
}

function getNetworkInterfaces(): NetworkInterface[] {
  const result: NetworkInterface[] = [];
  const osIfaces = os.networkInterfaces();

  try {
    const netDev = fs.readFileSync("/proc/net/dev", "utf-8");
    const lines = netDev.trim().split("\n").slice(2); // skip 2 header lines

    for (const line of lines) {
      const [nameRaw, ...fields] = line.trim().split(/\s+/);
      const name = nameRaw.replace(":", "");
      if (name === "lo") continue;

      const rx = parseInt(fields[0], 10) || 0;  // rx bytes
      const tx = parseInt(fields[8], 10) || 0;  // tx bytes

      // Find IP from os.networkInterfaces()
      let ip = "";
      const addrs = osIfaces[name];
      if (addrs) {
        const v4 = addrs.find((a) => a.family === "IPv4");
        if (v4) ip = v4.address;
        else {
          const v6 = addrs.find((a) => a.family === "IPv6" && !a.internal);
          if (v6) ip = v6.address;
        }
      }

      result.push({ name, ip, rx, tx });
    }
  } catch {
    // Fallback to os module only
    for (const [name, addrs] of Object.entries(osIfaces)) {
      if (!addrs || name === "lo") continue;
      const v4 = addrs.find((a) => a.family === "IPv4");
      if (v4) result.push({ name, ip: v4.address, rx: 0, tx: 0 });
    }
  }

  return result;
}

function getTopProcesses(): ProcessEntry[] {
  try {
    const output = execSync("ps aux --sort=-%cpu 2>/dev/null | head -11", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const lines = output.trim().split("\n").slice(1); // skip header
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      const [user, pid, cpu, mem, , , , , , , ...cmdParts] = parts;
      return {
        pid: pid || "",
        user: user || "",
        cpu: parseFloat(cpu) || 0,
        mem: parseFloat(mem) || 0,
        command: cmdParts.join(" ").slice(0, 60) || parts[10] || "?",
      };
    }).filter((p) => p.pid);
  } catch {
    return [];
  }
}

function getUptime(): string {
  try {
    const raw = fs.readFileSync("/proc/uptime", "utf-8");
    const seconds = parseFloat(raw.split(" ")[0]);
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(" ");
  } catch {
    const s = os.uptime();
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(" ");
  }
}

function getKernelRelease(): string {
  try {
    return execSync("uname -r", { encoding: "utf-8", timeout: 3000 }).trim();
  } catch {
    return os.release();
  }
}

function getSwapUsage(): { used: number; total: number; percent: number } {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf-8");
    const swapTotal = parseInt(meminfo.match(/SwapTotal:\s+(\d+)/)?.[1] || "0", 10) * 1024;
    const swapFree = parseInt(meminfo.match(/SwapFree:\s+(\d+)/)?.[1] || "0", 10) * 1024;
    const swapUsed = swapTotal - swapFree;
    const percent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;
    return { used: swapUsed, total: swapTotal, percent };
  } catch {
    return { used: 0, total: 0, percent: 0 };
  }
}

export async function GET() {
  try {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const stats = {
      overview: {
        hostname: os.hostname(),
        os: `${os.type()} ${os.release()}`,
        kernel: getKernelRelease(),
        uptime: getUptime(),
        arch: os.arch(),
        platform: os.platform(),
      },
      cpu: {
        usage: getCpuUsage(),
        model: cpus[0]?.model || "Unknown",
        cores: cpus.length,
        loadAvg: os.loadavg().map((v) => v.toFixed(2)),
        speed: cpus[0]?.speed || 0,
      },
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        usedPercent: Math.round((usedMem / totalMem) * 100),
        swap: getSwapUsage(),
      },
      storage: getDiskUsage(),
      network: getNetworkInterfaces(),
      processes: getTopProcesses(),
      timestamp: Date.now(),
    };

    return NextResponse.json(stats);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to gather stats" },
      { status: 500 }
    );
  }
}
