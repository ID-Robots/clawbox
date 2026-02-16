import os from "os";
import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

const BYTES_PER_MB = 1024 * 1024;

const SIZE_MULTIPLIERS: Record<string, number> = {
  T: 1024 * 1024,
  G: 1024,
  M: 1,
  K: 1 / 1024,
};

export interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  cpus: number;
  memoryTotal: string;
  memoryFree: string;
  memoryUsedPercent: number;
  cpuLoadPercent: number;
  uptime: string;
  disk: string;
  diskUsed: string;
  diskFree: string;
  diskTotal: string;
  diskUsedPercent: number;
  temperature: string;
  temperatureValue: number | null;
  gpuLoadPercent: number;
  networkIp: string;
  networkInterface: string;
  networkRxBytes: number;
  networkTxBytes: number;
}

function parseSizeToMB(s: string): number {
  const match = s.match(/^([\d.]+)([GMKT]?)$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] || "M").toUpperCase();
  return value * (SIZE_MULTIPLIERS[unit] ?? 1);
}

function parseDfOutput(stdout: string): {
  diskUsed: string;
  diskFree: string;
  diskUsedPercent: number;
} {
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) {
    return { diskUsed: "unknown", diskFree: "unknown", diskUsedPercent: 0 };
  }

  const [size, used, avail] = lines[1].trim().split(/\s+/);
  const diskUsed = used || "unknown";
  const diskFree = avail || "unknown";

  const totalMB = parseSizeToMB(size || "0");
  const usedMB = parseSizeToMB(diskUsed);
  const diskUsedPercent =
    totalMB > 0 ? Math.round((usedMB / totalMB) * 100) : 0;

  return { diskUsed, diskFree, diskUsedPercent };
}

function parseTemperature(raw: string): {
  temperature: string;
  temperatureValue: number | null;
} {
  const millidegrees = parseInt(raw.trim(), 10);
  if (!isFinite(millidegrees)) {
    return { temperature: "unknown", temperatureValue: null };
  }
  const celsius = millidegrees / 1000;
  return {
    temperature: celsius.toFixed(1) + "°C",
    temperatureValue: celsius,
  };
}

function settledValue<T>(
  result: PromiseSettledResult<T>,
): T | undefined {
  return result.status === "fulfilled" ? result.value : undefined;
}

async function getNetBytes(iface: string, dir: "rx" | "tx"): Promise<number> {
  try {
    const raw = await fs.readFile(`/sys/class/net/${iface}/statistics/${dir}_bytes`, "utf-8");
    return parseInt(raw.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function getPrimaryNetwork(): Promise<{
  networkIp: string;
  networkInterface: string;
  networkRxBytes: number;
  networkTxBytes: number;
}> {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        const [rx, tx] = await Promise.all([
          getNetBytes(name, "rx"),
          getNetBytes(name, "tx"),
        ]);
        return { networkIp: addr.address, networkInterface: name, networkRxBytes: rx, networkTxBytes: tx };
      }
    }
  }
  return { networkIp: "No connection", networkInterface: "—", networkRxBytes: 0, networkTxBytes: 0 };
}

export async function gather(): Promise<SystemInfo> {
  const [uptimeRes, dfRes, tempRes, gpuRes] = await Promise.allSettled([
    exec("uptime", ["-p"]),
    exec("df", ["-h", "--output=size,used,avail", "/"]),
    fs.readFile("/sys/devices/virtual/thermal/thermal_zone0/temp", "utf-8"),
    fs.readFile("/sys/devices/platform/bus@0/17000000.gpu/load", "utf-8"),
  ]);

  const dfOutput = settledValue(dfRes);
  const disk = dfOutput
    ? parseDfOutput(dfOutput.stdout)
    : { diskUsed: "unknown", diskFree: "unknown", diskUsedPercent: 0 };

  const tempRaw = settledValue(tempRes);
  const temp = tempRaw
    ? parseTemperature(tempRaw)
    : { temperature: "unknown", temperatureValue: null };

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpuCount = os.cpus().length;

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpus: cpuCount,
    memoryTotal: Math.round(totalMem / BYTES_PER_MB) + " MB",
    memoryFree: Math.round(freeMem / BYTES_PER_MB) + " MB",
    memoryUsedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    cpuLoadPercent: Math.min(
      100,
      Math.round((os.loadavg()[0] / cpuCount) * 100),
    ),
    uptime: settledValue(uptimeRes)?.stdout.trim() ?? "unknown",
    disk: dfOutput?.stdout.trim() ?? "unknown",
    diskUsed: disk.diskUsed,
    diskFree: disk.diskFree,
    diskTotal: "512 GB",
    diskUsedPercent: disk.diskUsedPercent,
    temperature: temp.temperature,
    temperatureValue: temp.temperatureValue,
    gpuLoadPercent: Math.round((parseInt(settledValue(gpuRes)?.trim() ?? "0", 10) || 0) / 10),
    ...(await getPrimaryNetwork()),
  };
}
