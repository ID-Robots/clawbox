/**
 * MemAvailable, in MB, from /proc/meminfo — the kernel's own estimate of
 * what a new allocation can have without swapping. Null where the file
 * cannot be read (tests on another OS), which every caller treats as
 * "no evidence", never as "plenty".
 */
import fs from "fs";

export async function memAvailableMb(): Promise<number | null> {
  try {
    const meminfo = await fs.promises.readFile("/proc/meminfo", "utf8");
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}
