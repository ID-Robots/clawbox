import os from "os";
import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  cpus: number;
  memoryTotal: string;
  memoryFree: string;
  uptime: string;
  disk: string;
  diskUsed: string;
  diskFree: string;
  diskTotal: string;
  temperature: string;
  networkInterfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

export async function gather(): Promise<SystemInfo> {
  const [uptimeRes, dfRes, tempRes] = await Promise.allSettled([
    exec("uptime", ["-p"]),
    exec("df", ["-h", "--output=size,used,avail", "/"]),
    fs.readFile("/sys/devices/virtual/thermal/thermal_zone0/temp", "utf-8"),
  ]);

  let diskUsed = "unknown";
  let diskFree = "unknown";
  let diskTotal = "unknown";
  if (dfRes.status === "fulfilled") {
    const lines = dfRes.value.stdout.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].trim().split(/\s+/);
      diskTotal = parts[0] || "unknown";
      diskUsed = parts[1] || "unknown";
      diskFree = parts[2] || "unknown";
    }
  }

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpus: os.cpus().length,
    memoryTotal: Math.round(os.totalmem() / 1024 / 1024) + " MB",
    memoryFree: Math.round(os.freemem() / 1024 / 1024) + " MB",
    uptime:
      uptimeRes.status === "fulfilled"
        ? uptimeRes.value.stdout.trim()
        : "unknown",
    disk:
      dfRes.status === "fulfilled" ? dfRes.value.stdout.trim() : "unknown",
    diskUsed,
    diskFree,
    diskTotal,
    temperature: (() => {
      if (tempRes.status !== "fulfilled") return "unknown";
      const raw = parseInt(tempRes.value.trim(), 10);
      if (!isFinite(raw)) return "unknown";
      return (raw / 1000).toFixed(1) + "°C";
    })(),
    networkInterfaces: os.networkInterfaces(),
  };
}
