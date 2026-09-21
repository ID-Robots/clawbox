/**
 * Who is on the CDP port — ClawBox's own Chromium, somebody else's, or nobody.
 *
 * `/json/version` answering is NOT proof the browser is ours. Seen on a real
 * box (2026-08-29): the OpenClaw gateway had launched its own snap Chromium
 * on 18800 hours earlier; ClawBox's readiness check saw a healthy
 * /json/version, never started its service, and every attach then died with
 * "403 Forbidden — rejected an incoming WebSocket connection from the
 * http://127.0.0.1:18800 origin", because that Chromium was not launched
 * with our --remote-allow-origins. Every coding run's browser tools were
 * down for the afternoon while the check said "ready".
 *
 * The only honest readiness test is the upgrade itself, with the same Origin
 * the route sends. A 101 is ours; a 403 is a foreign Chromium; anything else
 * is down. Dependency-free: a raw HTTP upgrade request, no ws library.
 */
import { execFile } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { promisify } from "util";

const exec = promisify(execFile);

export type CdpState = "ours" | "foreign" | "down";

/** The status a WebSocket upgrade to `wsUrl` gets with `origin`; null on no answer. */
export function upgradeStatus(wsUrl: string, origin: string, timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(wsUrl);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        Origin: origin,
      },
      timeout: timeoutMs,
    });
    req.on("upgrade", (_res, socket) => { socket.destroy(); done(101); });
    req.on("response", (res) => { res.resume(); done(res.statusCode ?? null); });
    req.on("timeout", () => { req.destroy(); done(null); });
    req.on("error", () => done(null));
    req.end();
  });
}

/** Classify what answers on `endpoint` (http://host:port) for a client sending `origin`. */
export async function probeCdp(endpoint: string, origin: string): Promise<CdpState> {
  let wsUrl: string;
  try {
    const res = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return "down";
    const v = await res.json() as { webSocketDebuggerUrl?: unknown };
    if (typeof v.webSocketDebuggerUrl !== "string") return "down";
    wsUrl = v.webSocketDebuggerUrl;
  } catch {
    return "down";
  }
  const status = await upgradeStatus(wsUrl, origin);
  if (status === 101) return "ours";
  if (status === 403) return "foreign";
  return "down";
}

/**
 * "pid 67257 (chrome), started by openclaw-gateway" — from `ss -tlnp` and
 * `ps`, for the error message; "" when it cannot be told.
 */
export function parsePortOwner(ssOutput: string, port: number): { pid: number; comm: string } | null {
  // The port ends the address column: ":18800" followed by whitespace or the
  // end of the line, so :18800 never matches a listener on :188001.
  const listener = new RegExp(`:${port}(?=\\s|$)`);
  const line = ssOutput.split("\n").find((l) => listener.test(l));
  if (!line) return null;
  const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
  if (!m) return null;
  return { comm: m[1], pid: Number(m[2]) };
}

export async function describePortOwner(port: number): Promise<string> {
  try {
    const ss = await exec("ss", ["-tlnp"], { timeout: 3000 });
    const owner = parsePortOwner(ss.stdout, port);
    if (!owner) return "";
    let parent = "";
    try {
      const ppid = (await exec("ps", ["-o", "ppid=", "-p", String(owner.pid)], { timeout: 3000 })).stdout.trim();
      if (ppid) {
        const pcomm = (await exec("ps", ["-o", "comm=", "-p", ppid], { timeout: 3000 })).stdout.trim();
        if (pcomm) parent = `, started by ${pcomm}`;
      }
    } catch {
      // the pid alone is still useful
    }
    return ` (pid ${owner.pid}, ${owner.comm}${parent})`;
  } catch {
    return "";
  }
}

// Playwright 1.50+ ships Chrome-for-Testing under chrome-linux64/ on amd64
// and chrome-linux-arm64/ on arm64; older builds used chrome-linux/. The
// headless shell has only ever shipped under the first and last of those.
const HEADLESS_SHELLS = ["chrome-linux/headless_shell", "chrome-linux-arm64/headless_shell"];
const FULL_CHROMES = ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-linux-arm64/chrome"];

export interface FindChromiumOptions {
  /**
   * true (the default): a headless shell of any revision before a full chrome
   * of any revision — it is what a screenshot needs and what the runs already
   * use. false: full chrome ONLY, because the caller is reporting on the
   * browser the owner can see, and a headless shell cannot open that window —
   * "installed" there must never name one.
   */
  preferHeadless?: boolean;
}

/**
 * Playwright's Chromium on this box, found the way scripts/launch-browser.sh
 * finds it: under ~/.cache/ms-playwright, whichever revision is installed,
 * newest first. Playwright's own executablePath() has come back empty inside
 * the standalone server, so the callers hand it the path explicitly. The ONE
 * finder: the browser route (headless, for its own fallback browser) and the
 * manage route (the desktop window) used to carry a copy each.
 */
export function findPlaywrightChromium(
  root = path.join(os.homedir(), ".cache", "ms-playwright"),
  { preferHeadless = true }: FindChromiumOptions = {},
): string | null {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  // Numeric, so chromium-1234 sorts after chromium-999 and comes out first.
  const revisions = dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
  const kinds = preferHeadless ? [HEADLESS_SHELLS, FULL_CHROMES] : [FULL_CHROMES];
  for (const layouts of kinds) {
    for (const revision of revisions) {
      for (const rel of layouts) {
        const candidate = path.join(root, revision, rel);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          // next
        }
      }
    }
  }
  return null;
}
