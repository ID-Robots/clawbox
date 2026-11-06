"use strict";
// A project's own server under /apps/<id>/ (src/lib/app-proxy.ts), resolved
// in CommonJS for the two readers that never reach Next.js: the WebSocket
// upgrade proxy in production-server.js and the public app links
// (scripts/public-app-links.js). The port and the project folder are in the
// app's data/webapps/<id>/meta.json, written when the app was registered, and
// nothing is forwarded until the port's LISTENER is the project's own — a
// process of this user running from inside the project folder — exactly the
// check src/lib/app-proxy.ts makes for HTTP.

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const APP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const APP_LISTENER_TTL_MS = 30_000;
const APP_LISTENER_REFUSAL_TTL_MS = 3_000;
const appListenerVerdicts = new Map();

function readJsonSync(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

function isProxyablePort(port) {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function cwdInside(pid, real) {
  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    // A folder removed under the process reads `<path> (deleted)`: lexically
    // inside a folder made again under the same name, and not in it. A link
    // count of 0 is the proof; the suffix alone is not (processCwd in
    // src/lib/app-proxy.ts).
    if (cwd.endsWith(" (deleted)") && fs.statSync(`/proc/${pid}/cwd`).nlink === 0) return false;
    const rel = path.relative(real, cwd);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/** Is the socket with this inode still LISTENing on `port`? Two small /proc reads, no process spawned. */
function socketStillListening(port, inode) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text;
    try { text = fs.readFileSync(table, "utf-8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const f = line.trim().split(/\s+/);
      // sl local_address rem_address st … inode (field 9); 0A = LISTEN
      if (f[3] === "0A" && f[1] && f[1].endsWith(`:${hexPort}`) && f[9] === inode) return true;
    }
  }
  return false;
}

function appListenerOwned(port, directory) {
  const key = `${port}:${directory}`;
  const cached = appListenerVerdicts.get(key);
  if (cached && !cached.owned && Date.now() - cached.at < APP_LISTENER_REFUSAL_TTL_MS) return false;
  // A "yes" is only reused while it is provably still the same socket of the
  // same project process: the app may exit and something else bind its port,
  // and a cached yes would hand that process the app's traffic — on a public
  // link, the internet's. Checked on every use, without spawning `ss`.
  if (cached && cached.owned && Date.now() - cached.at < APP_LISTENER_TTL_MS
    && cached.inode && socketStillListening(port, cached.inode) && cwdInside(cached.pid, cached.real)) return true;
  let verdict = { owned: false, at: Date.now() };
  try {
    const out = execFileSync("ss", ["-H", "-l", "-t", "-n", "-p", "-e", `sport = :${port}`], { encoding: "utf-8", timeout: 5000, env: { PATH: process.env.PATH || "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } });
    let real = directory;
    try { real = fs.realpathSync(directory); } catch {}
    // Only a row bound where 127.0.0.1 reaches it vouches for the port.
    const reachable = out.split("\n").filter((row) => {
      const local = row.trim().split(/\s+/)[3] || "";
      const host = local.slice(0, local.lastIndexOf(":"));
      return ["127.0.0.1", "0.0.0.0", "*", "[::]", "::", "[::1]"].includes(host);
    });
    for (const row of reachable) {
      const inode = (/\bino:(\d+)/.exec(row) || [])[1] || null;
      const pid = [...row.matchAll(/pid=(\d+)/g)].map((m) => m[1]).find((p) => cwdInside(p, real));
      if (pid) { verdict = { owned: true, at: Date.now(), pid, inode, real }; break; }
    }
  } catch {
    verdict = { owned: false, at: Date.now() };
  }
  appListenerVerdicts.set(key, verdict);
  return verdict.owned;
}

/**
 * The owner's project folder from config.json: the one they chose, else the
 * ~/Projects default — src/lib/project-folder.ts's `projectFolderFrom`, which
 * every TypeScript reader resolves, so the proxy and the public links look in
 * the same place the Store installed into.
 */
function projectFolderOf(config) {
  const chosen = config && typeof config.coding_agent_default_directory === "string" ? config.coding_agent_default_directory.trim() : "";
  return chosen && path.isAbsolute(chosen) ? chosen : path.join(os.homedir(), "Projects");
}

/**
 * The registered server app `id` under `root`, or null: no registration, no
 * port, or a listener that is not the project's own.
 */
function resolveRegisteredApp(root, id, opts = {}) {
  if (!APP_ID_RE.test(id)) return null;
  const meta = readJsonSync(path.join(root, "data", "webapps", id, "meta.json"));
  if (!meta || !isProxyablePort(meta.port)) return null;
  // The project folder: on the registration, or — for one that predates the
  // field — the folder of that id under the owner's project folder or the
  // code projects, the way src/lib/app-proxy.ts's projectFolderFor answers.
  let directory = typeof meta.directory === "string" && path.isAbsolute(meta.directory) ? meta.directory : null;
  if (!directory) {
    const config = readJsonSync(path.join(root, "data", "config.json"));
    for (const candidate of [path.join(projectFolderOf(config), id), path.join(root, "data", "code-projects", id)]) {
      try { if (fs.statSync(candidate).isDirectory()) { directory = candidate; break; } } catch {}
    }
  }
  const owned = opts.listenerOwned || appListenerOwned;
  if (!directory || !owned(meta.port, directory)) return null;
  return { port: meta.port, strip: meta.stripBasePath === true, id };
}

module.exports = { APP_ID_RE, readJsonSync, isProxyablePort, appListenerOwned, projectFolderOf, resolveRegisteredApp };
