import { NextResponse } from "next/server";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import fsP from "fs/promises";
import { getCpuUsage } from "@/lib/cpu-usage";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

/**
 * Remember one async answer for a few seconds, and let concurrent callers share
 * the read that is already in flight.
 *
 * Two surfaces poll this route every 3 s while their panel is open — Settings >
 * System (`SettingsApp.tsx`) and the System app (`SystemApp.tsx`) — and each
 * request spawned its own `df` and `ps aux --sort=-%cpu`. Measured on an Orin
 * Nano: 2.8 ms and 28.5 ms per run, four processes every three seconds for two
 * answers that barely move.
 *
 * ONE window for both, and a short one. A longer window for the disk buys
 * almost nothing — `ps` is 91% of the cost — and it would make the payload's
 * own `timestamp` a lie: the System app draws it as "last updated", and a disk
 * figure half a minute old under a stamp that says "now" is how a `disk_cleanup`
 * that worked reads as one that did nothing. Five seconds is inside the jitter
 * of the 3 s poll that reads it.
 *
 * A FAILURE is remembered too, but for less. Caching only successes means the
 * harder the box is struggling — a `fork` refused with EAGAIN under memory
 * pressure is exactly when this matters — the more often it is asked to spawn,
 * which is the wrong way round. Same success/failure split, and the same
 * reasoning, as the memos in `hermes-telegram.ts` and `openclaw-channels.ts`.
 *
 * Callers share the value rather than a copy; nothing here mutates it, the
 * route only serialises it.
 */
const STATS_TTL_MS = 5_000;
const STATS_FAILURE_TTL_MS = 3_000;

function memoAsync<T>(read: () => Promise<T>): () => Promise<T> {
  let cached: { at: number; ok: true; value: T } | { at: number; ok: false; err: unknown } | null = null;
  let inFlight: Promise<T> | null = null;

  return () => {
    // `age >= 0` because Date.now() is wall-clock: an RTC corrected BACKWARDS
    // by NTP would otherwise pin the entry until the clock caught up.
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age >= 0 && age < (cached.ok ? STATS_TTL_MS : STATS_FAILURE_TTL_MS)) {
      return cached.ok ? Promise.resolve(cached.value) : Promise.reject(cached.err);
    }
    if (inFlight) return inFlight;

    const promise = read().then(
      (value) => {
        cached = { at: Date.now(), ok: true, value };
        inFlight = null;
        return value;
      },
      (err) => {
        cached = { at: Date.now(), ok: false, err };
        inFlight = null;
        throw err;
      },
    );
    inFlight = promise;
    return promise;
  };
}

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

async function readDiskUsage(): Promise<DiskMount[]> {
  const { stdout: output } = await execFileAsync(
    "df",
    ["-h", "-x", "tmpfs", "-x", "devtmpfs", "-x", "squashfs"],
    { encoding: "utf-8", timeout: 5000 },
  );
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
}

const diskUsage = memoAsync(readDiskUsage);

async function getDiskUsage(): Promise<DiskMount[]> {
  try {
    return await diskUsage();
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

async function readTopProcesses(): Promise<ProcessEntry[]> {
  const { stdout: output } = await execFileAsync("ps", ["aux", "--sort=-%cpu"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  // Skip the header, keep the top 10 by CPU (the old `| head -11` limit).
  const lines = output.trim().split("\n").slice(1, 11);
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
}

const topProcesses = memoAsync(readTopProcesses);

async function getTopProcesses(): Promise<ProcessEntry[]> {
  try {
    return await topProcesses();
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

async function getTemperature(): Promise<{ value: number | null; display: string }> {
  try {
    const raw = await fsP.readFile("/sys/devices/virtual/thermal/thermal_zone0/temp", "utf-8");
    const millideg = parseInt(raw.trim(), 10);
    if (!isFinite(millideg)) return { value: null, display: "unknown" };
    const celsius = millideg / 1000;
    return { value: celsius, display: celsius.toFixed(1) + "°C" };
  } catch {
    return { value: null, display: "unknown" };
  }
}

async function getGpuUsage(): Promise<number> {
  try {
    const raw = await fsP.readFile("/sys/devices/platform/bus@0/17000000.gpu/load", "utf-8");
    return Math.round((parseInt(raw.trim(), 10) || 0) / 10);
  } catch {
    return 0;
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

    // CPU usage is a cached-delta read now (src/lib/cpu-usage.ts) — no sleep, no
    // await. Everything below it still touches the event loop (temp/gpu reads,
    // promisified execFile shells) so it stays in one Promise.all.
    const cpuUsage = getCpuUsage();
    const [temp, gpuUsage, storage, processes] = await Promise.all([
      getTemperature(),
      getGpuUsage(),
      getDiskUsage(),
      getTopProcesses(),
    ]);

    const stats = {
      overview: {
        hostname: os.hostname(),
        os: `${os.type()} ${os.release()}`,
        // `uname -r` and os.release() are the same string — both are the
        // `release` field of the utsname the kernel answers with (verified on
        // an Orin Nano: 5.15.185-tegra from each). Spawning a process for it,
        // two lines under a call that already has the answer, was pure cost.
        kernel: os.release(),
        uptime: getUptime(),
        arch: os.arch(),
        platform: os.platform(),
      },
      cpu: {
        usage: cpuUsage,
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
      temperature: temp,
      gpu: { usage: gpuUsage },
      storage,
      network: getNetworkInterfaces(),
      processes,
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
