// What the box itself paid: CPU time, RSS and bytes written by the web server
// and the gateway, read from /proc (the bench runs ON the box as the same user
// the services run as), plus system memory and load.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const HZ = 100;

function mainPid(unit) {
  try {
    const out = execFileSync("systemctl", ["show", "-p", "MainPID", "--value", unit], { encoding: "utf8", timeout: 5000 }).trim();
    const pid = Number(out);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidByCmd(re) {
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (re.test(fs.readFileSync(`/proc/${d}/cmdline`, "utf8"))) return Number(d);
    } catch { /* gone */ }
  }
  return null;
}

export function findServicePids() {
  return {
    web: mainPid("clawbox-setup.service") ?? pidByCmd(/production-server\.js|clawbox-web/),
    gateway: mainPid("clawbox-gateway.service") ?? pidByCmd(/openclaw-gateway/),
  };
}

function procSample(pid) {
  if (!pid) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cpuSec = (Number(after[11]) + Number(after[12])) / HZ; // utime + stime
    let writeBytes = null, readBytes = null;
    try {
      const io = fs.readFileSync(`/proc/${pid}/io`, "utf8");
      writeBytes = Number(/write_bytes:\s*(\d+)/.exec(io)?.[1]);
      readBytes = Number(/read_bytes:\s*(\d+)/.exec(io)?.[1]);
    } catch { /* io needs same user */ }
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const rssKb = Number(/VmRSS:\s*(\d+)/.exec(status)?.[1]);
    const threads = Number(/Threads:\s*(\d+)/.exec(status)?.[1]);
    return { pid, cpuSec, writeBytes, readBytes, rssKb, threads };
  } catch {
    return null;
  }
}

function systemSample() {
  const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
  const kb = (k) => Number(new RegExp(`${k}:\\s*(\\d+)`).exec(meminfo)?.[1]);
  const cpu = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const total = cpu.reduce((a, b) => a + b, 0);
  const idle = cpu[3] + (cpu[4] || 0);
  const load = fs.readFileSync("/proc/loadavg", "utf8").trim().split(" ").slice(0, 3).map(Number);
  return { memTotalKb: kb("MemTotal"), memAvailableKb: kb("MemAvailable"), swapUsedKb: kb("SwapTotal") - kb("SwapFree"), cpuTotalTicks: total, cpuIdleTicks: idle, load };
}

export function snapshot() {
  const pids = findServicePids();
  return { at: Date.now(), web: procSample(pids.web), gateway: procSample(pids.gateway), system: systemSample() };
}

/** Deltas between two snapshots, per second of wall clock. */
export function delta(a, b) {
  const sec = Math.max(0.001, (b.at - a.at) / 1000);
  const proc = (x, y) => {
    if (!x || !y || x.pid !== y.pid) return { restarted: !!(x && y && x.pid !== y.pid), cpuPct: null, writeBytesPerSec: null, rssKb: y?.rssKb ?? null };
    return {
      restarted: false,
      cpuPct: Math.round(((y.cpuSec - x.cpuSec) / sec) * 1000) / 10,
      writeBytesPerSec: y.writeBytes != null && x.writeBytes != null ? Math.round((y.writeBytes - x.writeBytes) / sec) : null,
      rssKb: y.rssKb,
      rssDeltaKb: y.rssKb - x.rssKb,
    };
  };
  const busy = (b.system.cpuTotalTicks - a.system.cpuTotalTicks) - (b.system.cpuIdleTicks - a.system.cpuIdleTicks);
  const totalTicks = b.system.cpuTotalTicks - a.system.cpuTotalTicks;
  return {
    seconds: Math.round(sec * 10) / 10,
    web: proc(a.web, b.web),
    gateway: proc(a.gateway, b.gateway),
    system: {
      cpuBusyPct: totalTicks ? Math.round((busy / totalTicks) * 1000) / 10 : null,
      memAvailableKb: b.system.memAvailableKb,
      swapUsedKb: b.system.swapUsedKb,
      load1: b.system.load[0],
    },
  };
}

/** Recent gateway journal lines matching `re`, newest last (empty when journalctl is unavailable). */
export function gatewayJournal(sinceIso, re) {
  try {
    const out = execFileSync("journalctl", ["-u", "clawbox-gateway.service", "--no-pager", "-o", "short-iso", "--since", sinceIso], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").filter((l) => re.test(l));
  } catch {
    return [];
  }
}
