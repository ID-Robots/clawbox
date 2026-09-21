#!/usr/bin/env node
/**
 * Serve a coding run's own work on a loopback port, so the review pass can LOOK
 * at it.
 *
 * WHY THIS EXISTS. A run works in a git worktree, not in the running app, and
 * the box's own web server owns port 80 and must not be disturbed. Until now
 * the review pass had no rendered page to open at all, so it reviewed the diff
 * and reported on code it had never seen. This is the missing half: one command
 * that turns the folder into a URL the device browser can be pointed at.
 *
 * WHAT IT GUARANTEES, because a review pass is unattended:
 *   - The port is ALWAYS ephemeral and ALWAYS on 127.0.0.1. There is no --port
 *     flag: binding 0 is what makes "never port 80, never the LAN" structural
 *     rather than a rule somebody has to remember.
 *   - The build is capped (--build-timeout). A project whose build never
 *     returns fails the preview instead of hanging the review for ever.
 *   - It stops by itself (--ttl). A pass that crashes, is stopped or simply
 *     forgets leaves nothing listening: the clock is inside this process, not
 *     in the caller's good intentions.
 *   - Its children stay in the CALLER's process group on purpose. The browser
 *     route only opens a loopback port whose listeners belong to the live run's
 *     own group and working folder (src/lib/coding-local-preview.ts), so
 *     detaching would produce a URL the device then refuses to open. Teardown
 *     therefore walks /proc for descendants and signals those by pid, never the
 *     group — the group is the run itself.
 *
 * HOW IT DECIDES WHAT TO DO
 *   command mode — the project declares how to start itself (clawbox.json
 *     `start`, or a `dev`/`start` npm script). The command chooses its own port
 *     however it likes and this DISCOVERS it by reading the listening sockets of
 *     the command's own descendants, which is the only approach that works for
 *     every dev server without knowing its flags.
 *   static mode — no start command. An existing build script is run once
 *     (bounded), and the first build output folder that exists, or the project
 *     itself, is served by the tiny static server below.
 *
 * OUTPUT CONTRACT (stdout, one fact per line):
 *   PREVIEW_PID <pid>          this process — stop it with `kill <pid>`
 *   PREVIEW_MODE <mode>        command | static
 *   PREVIEW_URL <url>          the address to open
 *   PREVIEW_FAILED <code> …    could not serve; exits non-zero
 *   PREVIEW_STOPPED <reason>   ttl | signal
 * Everything else — build output, the command's own logs — goes to stderr.
 *
 * Plain ESM run by the box's own Node, like scripts/terminal-server.mjs: no
 * dependencies, because it runs inside a run's worktree where npm install may
 * never have happened.
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const DEFAULTS = {
  ttl: 900,
  buildTimeout: 300,
  startTimeout: 90,
};

/** Build output folders, in the order a project is likely to mean them. */
const BUILD_OUTPUTS = ["dist", "build", "out", "public", "_site"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

function say(line) {
  process.stdout.write(`${line}\n`);
}

function log(line) {
  process.stderr.write(`[preview] ${line}\n`);
}

function fail(code, detail) {
  say(`PREVIEW_FAILED ${code} ${detail}`);
  return 1;
}

function parseArgs(argv) {
  const opts = { dir: process.cwd(), ...DEFAULTS, build: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      i += 1;
      return value;
    };
    if (arg === "--dir") opts.dir = next() ?? opts.dir;
    else if (arg === "--ttl") opts.ttl = Number(next());
    else if (arg === "--build-timeout") opts.buildTimeout = Number(next());
    else if (arg === "--start-timeout") opts.startTimeout = Number(next());
    else if (arg === "--no-build") opts.build = false;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else return { error: `unknown argument ${arg}` };
  }
  for (const key of ["ttl", "buildTimeout", "startTimeout"]) {
    if (!Number.isFinite(opts[key]) || opts[key] <= 0) return { error: `--${key} must be a positive number of seconds` };
  }
  // An unattended preview that could outlive the review it serves is the leak
  // this clock exists to prevent; an hour is already generous for either.
  if (opts.ttl > 3600) opts.ttl = 3600;
  return opts;
}

const USAGE = [
  "Usage: node clawbox-preview.mjs [--dir <folder>] [--ttl <seconds>] [--build-timeout <seconds>]",
  "                                [--start-timeout <seconds>] [--no-build]",
  "",
  "Serves the folder (or starts its own dev server) on an ephemeral 127.0.0.1 port",
  "and prints PREVIEW_URL. Stops itself after --ttl seconds; `kill <PREVIEW_PID>` ends it sooner.",
].join("\n");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** How this project says it starts itself, or how to make something to serve. */
function decidePlan(dir) {
  const manifest = readJson(path.join(dir, "clawbox.json"));
  const pkg = readJson(path.join(dir, "package.json"));
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};

  if (manifest && typeof manifest.start === "string" && manifest.start.trim()) {
    return { mode: "command", command: manifest.start.trim(), source: "clawbox.json start" };
  }
  if (typeof scripts.dev === "string") {
    return { mode: "command", command: "npm run dev", source: "package.json dev script" };
  }
  if (typeof scripts.start === "string") {
    return {
      mode: "command",
      command: "npm run start",
      source: "package.json start script",
      // `start` on a built project serves whatever `build` last produced, so the
      // build has to have happened; `dev` compiles as it serves and needs none.
      build: typeof scripts.build === "string" ? "npm run build" : null,
    };
  }
  return {
    mode: "static",
    build: typeof scripts.build === "string" ? "npm run build" : null,
    source: typeof scripts.build === "string" ? "package.json build script" : "the folder as it is",
  };
}

/** Run one shell command in the folder, bounded. Output goes to stderr. */
function runBounded(dir, command, timeoutMs, label) {
  return new Promise((resolve) => {
    log(`${label}: ${command}`);
    const child = spawn("sh", ["-c", command], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const relay = (chunk) => process.stderr.write(chunk);
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    // The flag is set BEFORE the kill, because killing the build makes it
    // close with a null code — and "the build exited with null" is exactly the
    // wrong thing to tell a review pass that ran out of build time.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`${label} exceeded ${Math.round(timeoutMs / 1000)}s — stopping it`);
      void killTree(child.pid);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, timedOut });
    });
  });
}

/** Every process descended from `root`, `root` included. */
async function descendants(root) {
  const children = new Map();
  let names;
  try {
    names = await fsp.readdir("/proc");
  } catch {
    return new Set([root]);
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = await fsp.readFile(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    // The comm field is parenthesised and may itself contain spaces or ')',
    // so the fields after it are read from the LAST ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(Number(name));
    children.set(ppid, list);
  }
  const out = new Set([root]);
  const queue = [root];
  while (queue.length) {
    for (const pid of children.get(queue.shift()) ?? []) {
      if (out.has(pid)) continue;
      out.add(pid);
      queue.push(pid);
    }
  }
  return out;
}

/**
 * SIGTERM, then SIGKILL, to a command's own process tree — never to the process
 * GROUP, which belongs to the coding run that started this (see the header).
 */
async function killTree(root) {
  if (!root) return;
  const pids = [...await descendants(root)].reverse();
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    let alive = false;
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
        alive = true;
      } catch {
        // already gone
      }
    }
    if (!alive || signal === "SIGKILL") return;
    await new Promise((r) => { setTimeout(r, 1500); });
  }
}

/** The loopback ports the command's own processes are listening on. */
async function listeningPorts(pids) {
  let stdout;
  try {
    ({ stdout } = await exec("ss", ["-H", "-ltnp"], { timeout: 3000, maxBuffer: 512 * 1024 }));
  } catch {
    return [];
  }
  const ports = [];
  for (const line of stdout.split("\n")) {
    const owners = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    if (!owners.some((pid) => pids.has(pid))) continue;
    // Local Address:Port is the 4th column of `ss -ltn`, minus the header.
    const columns = line.trim().split(/\s+/);
    const local = columns[3] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    // Below 1024 cannot be one of ours (this runs unprivileged) and is exactly
    // what must never be reported as a preview address.
    if (Number.isInteger(port) && port >= 1024) ports.push(port);
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

/** Wait for the started command to listen somewhere, or give up. */
async function discoverPort(rootPid, deadline) {
  while (Date.now() < deadline) {
    const ports = await listeningPorts(await descendants(rootPid));
    if (ports.length) return ports[0];
    await new Promise((r) => { setTimeout(r, 500); });
  }
  return null;
}

/** Serve `root` read-only on an ephemeral loopback port. */
function serveStatic(root) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = "text/plain; charset=utf-8") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Method not allowed");
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    } catch {
      return send(400, "Bad request");
    }
    // Resolved and then contained: a request path is a caller's string, and the
    // only thing that may be served is what is actually inside the folder.
    const target = path.resolve(root, `.${path.posix.normalize(rel)}`);
    if (target !== root && !target.startsWith(root + path.sep)) return send(403, "Forbidden");
    let file = target;
    try {
      const stat = await fsp.stat(file);
      if (stat.isDirectory()) file = path.join(file, "index.html");
      const real = await fsp.realpath(file);
      if (real !== root && !real.startsWith(root + path.sep)) return send(403, "Forbidden");
      const body = await fsp.readFile(real);
      const type = MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      send(404, `Not found: ${rel}`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Port 0 on loopback: the ephemeral high port is the OS's to choose, and
    // there is no code path here that can bind anything else.
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    log(opts.error);
    log(USAGE);
    return fail("bad_argument", opts.error);
  }
  if (opts.help) {
    say(USAGE);
    return 0;
  }

  let dir;
  try {
    dir = await fsp.realpath(opts.dir);
  } catch {
    return fail("no_folder", `${opts.dir} does not exist`);
  }

  say(`PREVIEW_PID ${process.pid}`);
  const plan = decidePlan(dir);
  log(`serving ${dir} — ${plan.mode} mode, from ${plan.source}`);

  let child = null;
  let server = null;
  let stopped = false;
  const shutdown = async (reason) => {
    if (stopped) return;
    stopped = true;
    say(`PREVIEW_STOPPED ${reason}`);
    server?.close();
    await killTree(child?.pid);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => { void shutdown("signal").then(() => process.exit(0)); });
  }

  if (plan.build && opts.build) {
    const built = await runBounded(dir, plan.build, opts.buildTimeout * 1000, "build");
    if (!built.ok) {
      return fail(
        built.timedOut ? "build_timeout" : "build_failed",
        built.timedOut
          ? `the build did not finish within ${opts.buildTimeout}s (raise --build-timeout, or use --no-build)`
          : `the build failed (${built.error ?? `exit ${built.code}`}) — its output is above`,
      );
    }
  }

  if (plan.mode === "command") {
    log(`starting: ${plan.command}`);
    child = spawn("sh", ["-c", plan.command], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const relay = (chunk) => process.stderr.write(chunk);
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    let exited = null;
    child.on("close", (code) => { exited = code; });
    const port = await discoverPort(child.pid, Date.now() + opts.startTimeout * 1000);
    if (!port) {
      await killTree(child.pid);
      return fail(
        exited === null ? "no_port" : "start_failed",
        exited === null
          ? `${plan.command} did not listen on a port within ${opts.startTimeout}s — its output is above`
          : `${plan.command} exited with ${exited} before it listened — its output is above`,
      );
    }
    say(`PREVIEW_MODE command`);
    say(`PREVIEW_URL http://127.0.0.1:${port}/`);
  } else {
    let root = dir;
    for (const candidate of BUILD_OUTPUTS) {
      const abs = path.join(dir, candidate);
      if (fs.existsSync(path.join(abs, "index.html"))) { root = abs; break; }
    }
    try {
      ({ server } = await serveStatic(root));
    } catch (err) {
      return fail("no_listener", `could not open a loopback port (${err.message})`);
    }
    say(`PREVIEW_MODE static`);
    say(`PREVIEW_URL http://127.0.0.1:${server.address().port}/`);
    log(`document root: ${root}`);
  }

  // Deliberately not unref'd: this timer IS the preview's lifetime, and a
  // process that slipped out of it early would take the URL with it.
  await new Promise((resolve) => {
    setTimeout(resolve, opts.ttl * 1000);
    if (child) child.on("close", resolve);
  });
  await shutdown(child && child.exitCode !== null ? "command_exited" : "ttl");
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  log(err?.stack ?? String(err));
  process.exit(fail("crashed", err?.message ?? "unknown error"));
});
