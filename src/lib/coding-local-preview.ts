/** Allow a live run's own loopback app, never arbitrary local services.
 * A listener must belong to the recorded process group AND a cwd within this
 * run's real project. Re-check each navigation; no port grants survive a run.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
const exec = promisify(execFile);
export interface PreviewRun { directory: string; pgid: number | null; status: string }
export async function ownsLocalPreview(url: URL, run: PreviewRun | null): Promise<boolean> {
  if (!run || run.status !== "running" || !run.pgid || run.pgid <= 1) return false;
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || url.username || url.password) return false;
  try {
    const { stdout } = await exec("ss", ["-H", "-ltnp", "sport", "=", String(port)], { timeout: 1500, maxBuffer: 64 * 1024 });
    const pids = [...new Set([...stdout.matchAll(/pid=(\d+)/g)].map((m) => m[1]))];
    if (!pids.length) return false;
    const root = await fs.realpath(run.directory);
    // All visible owners must be this run: no SO_REUSEPORT ambiguity.
    for (const pid of pids) {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
      if (Number(fields[2]) !== run.pgid) return false;
      const cwd = await fs.realpath(`/proc/${pid}/cwd`);
      if (cwd !== root && !cwd.startsWith(root + path.sep)) return false;
    }
    return true;
  } catch { return false; }
}
