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

function appListenerOwned(port, directory) {
  const key = `${port}:${directory}`;
  const cached = appListenerVerdicts.get(key);
  if (cached && Date.now() - cached.at < (cached.owned ? APP_LISTENER_TTL_MS : APP_LISTENER_REFUSAL_TTL_MS)) return cached.owned;
  let owned = false;
  try {
    const out = execFileSync("ss", ["-H", "-l", "-t", "-n", "-p", `sport = :${port}`], { encoding: "utf-8", timeout: 5000, env: { PATH: process.env.PATH || "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } });
    let real = directory;
    try { real = fs.realpathSync(directory); } catch {}
    // Only a row bound where 127.0.0.1 reaches it vouches for the port.
    const reachable = out.split("\n").filter((row) => {
      const local = row.trim().split(/\s+/)[3] || "";
      const host = local.slice(0, local.lastIndexOf(":"));
      return ["127.0.0.1", "0.0.0.0", "*", "[::]", "::", "[::1]"].includes(host);
    }).join("\n");
    for (const m of reachable.matchAll(/pid=(\d+)/g)) {
      try {
        const cwd = fs.readlinkSync(`/proc/${m[1]}/cwd`);
        const rel = path.relative(real, cwd);
        if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) { owned = true; break; }
      } catch {}
    }
  } catch {
    owned = false;
  }
  appListenerVerdicts.set(key, { owned, at: Date.now() });
  return owned;
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
    const projects = config && typeof config.coding_agent_default_directory === "string" && path.isAbsolute(config.coding_agent_default_directory) ? config.coding_agent_default_directory : null;
    for (const candidate of [...(projects ? [path.join(projects, id)] : []), path.join(root, "data", "code-projects", id)]) {
      try { if (fs.statSync(candidate).isDirectory()) { directory = candidate; break; } } catch {}
    }
  }
  const owned = opts.listenerOwned || appListenerOwned;
  if (!directory || !owned(meta.port, directory)) return null;
  return { port: meta.port, strip: meta.stripBasePath === true, id };
}

module.exports = { APP_ID_RE, readJsonSync, isProxyablePort, appListenerOwned, resolveRegisteredApp };
