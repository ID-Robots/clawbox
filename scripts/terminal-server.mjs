// @ts-check
/**
 * Standalone WebSocket Terminal Server
 * Runs on port 3006, spawns a login PTY per connection and bridges it over
 * WebSocket. The shell is bash unless the connection asks for another one
 * /etc/shells lists, and it starts in the home folder unless the connection
 * names another folder that exists (`?shell=…&cwd=…`, the Terminal's
 * settings — scripts/terminal-launch.mjs decides).
 *
 * Plain ESM JavaScript on purpose, NOT TypeScript. The boot hook
 * (src/instrumentation-node.ts) starts this with the Node that is already
 * running the web server, so the Terminal app needs nothing fetched, resolved
 * or transpiled at boot. It used to be started with `npx tsx`, and `tsx` is not
 * a dependency of this project: it only ever resolved because the box had once
 * been online and npm had left a copy in ~/.npm/_npx. On a freshly flashed box
 * whose first boot is AP mode with no internet there is no copy to find.
 *
 * Usage:
 *   node scripts/terminal-server.mjs
 *
 * Protocol: scripts/terminal-sessions.mjs, which also keeps the sessions.
 *   Connect: /?shell=/usr/bin/zsh&cwd=~/projects  — both optional
 *            /?session=new | /?session=<id> | /?end=<id> — a shell that
 *            outlives the page, reattached by id (TASK-1306)
 *   Client → Server:
 *     { type: "input", data: string }       — raw keyboard input
 *     { type: "resize", cols: N, rows: N }  — terminal resize event
 *   Server → Client:
 *     { type: "started", session?, shell, cwd, shellRefused?, cwdRefused? }
 *                                           — what was spawned, and which
 *                                             request was not honoured
 *     { type: "attached", session, … }      — reattached; the scrollback follows
 *     { type: "output", data: string, replay? } — raw PTY output
 *     { type: "exit", code: number }        — PTY exited
 *     { type: "gone" }                      — no such session (any more)
 *
 * A session nobody is attached to is ended after CLAWBOX_TERMINAL_IDLE_MINUTES
 * (default 720), keeps the last CLAWBOX_TERMINAL_SCROLLBACK_KB thousand
 * characters of output (default 512) for a reattach, and lives in this
 * process's memory: a reboot, or a restart of this server, ends them all.
 *
 * Who the shell runs as (multi-user ClawBox OS, TASK-1256): the owner — the
 * account this server runs as — unless production-server.js, having checked
 * the session cookie, names another ClawBox user in `x-clawbox-terminal-user`.
 * That user's shell is started through the root-owned helper
 * (`sudo -n clawbox-user-helper.sh shell <user>`, config/clawbox-user-helper.sh),
 * which re-checks the name and its `clawbox-users` membership and runs the
 * login shell AS that user in their home folder. Their Terminal settings
 * (shell, folder) are not applied: those are paths on the owner's side.
 *
 * And every connection must carry `x-clawbox-terminal-token`, the per-boot
 * secret production-server.js puts in CLAWBOX_TERMINAL_TOKEN before this
 * process is spawned. Loopback alone was the fence while the box had one human
 * account; with ClawBox users, any of them could otherwise dial 127.0.0.1:3006
 * and be handed the owner's shell. Without the variable (a dev server started
 * with `next dev`, which has no proxy in front) the old loopback-only rule
 * applies and no other user's shell can be requested.
 */

import * as http from "node:http";
import * as os from "node:os";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import * as pty from "node-pty";
import { readEtcShells, resolveCwd, resolveShell } from "./terminal-launch.mjs";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_DETACHED_PER_USER,
  DEFAULT_SCROLLBACK_CHARS,
  OWNER_KEY,
  createSessionRegistry,
  envInt,
  handleConnection,
} from "./terminal-sessions.mjs";

// Same rule as envPort() in src/lib/port-probe.ts, written out because this
// script is standalone ESM and cannot import the TypeScript helper: an integer
// in 1-65535, or the default. `parseInt` alone yields NaN on a typo, and
// `listen(NaN)` binds a RANDOM free port — while production-server.js still
// proxies /terminal-ws to 3006, so the two ends disagree with nothing logged.
// src/tests/unit/port-probe.test.ts runs the same table against every copy.
/**
 * @param {string | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function envPort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

const PORT = envPort(process.env.TERMINAL_WS_PORT, 3006);

const TERMINAL_TOKEN = process.env.CLAWBOX_TERMINAL_TOKEN || "";
const TOKEN_HEADER = "x-clawbox-terminal-token";
const USER_HEADER = "x-clawbox-terminal-user";
// Same rule as src/lib/username-rules.ts; the helper checks it again as root.
const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
function hasTerminalToken(req) {
  if (!TERMINAL_TOKEN) return true;
  const sent = req.headers[TOKEN_HEADER];
  if (typeof sent !== "string" || !sent) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(TERMINAL_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The ClawBox user (not the owner) this connection's shell must run as, `null`
 * for the owner, or `false` for a request that names a user it may not.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {string | null | false}
 */
function scopedUser(req) {
  const named = req.headers[USER_HEADER];
  if (named === undefined) return null;
  // Only the proxy can name a user, and only when it proved itself with the
  // token; a dev server with no token takes no one's word for it.
  if (!TERMINAL_TOKEN) return false;
  if (typeof named !== "string" || !USERNAME_RE.test(named)) return false;
  return named;
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ClawBox Terminal WebSocket Server\n");
});

const wss = new WebSocketServer({
  server,
  verifyClient: (info, done) => {
    if (!hasTerminalToken(info.req)) {
      console.warn(`[terminal-server] Refused a connection without the terminal token from ${info.req.socket.remoteAddress}`);
      done(false, 401, "Unauthorized");
      return;
    }
    if (scopedUser(info.req) === false) {
      console.warn("[terminal-server] Refused a connection naming a user it may not start a shell for");
      done(false, 403, "Forbidden");
      return;
    }
    done(true);
  },
});

const registry = createSessionRegistry({
  idleMs: envInt(process.env.CLAWBOX_TERMINAL_IDLE_MINUTES, DEFAULT_IDLE_MS / 60000, 1, 7 * 24 * 60) * 60000,
  scrollbackChars: envInt(process.env.CLAWBOX_TERMINAL_SCROLLBACK_KB, DEFAULT_SCROLLBACK_CHARS / 1024, 16, 8192) * 1024,
  maxDetachedPerUser: DEFAULT_MAX_DETACHED_PER_USER,
  log: (line) => console.log(line),
});

/**
 * Start the shell a connection asked for.
 *
 * @param {string | null} asUser the ClawBox user (not the owner) it runs as
 * @param {URLSearchParams} requested the connection's `shell`/`cwd`
 * @returns {{ pty: import("node-pty").IPty, info: Record<string, unknown> }}
 */
function spawnShell(asUser, requested) {
  // Spawn a PTY as the user running the ClawBox UI (clawbox on Jetson,
  // whatever user installed on x64). Derive from $USER/$HOME with the
  // historical clawbox/clawbox values as a final fallback.
  const targetUser = process.env.USER || process.env.LOGNAME || os.userInfo().username || "clawbox";
  const targetHome = process.env.HOME || os.homedir() || `/home/${targetUser}`;
  const lang = process.env.LANG || "en_US.UTF-8";

  if (asUser) {
    // A ClawBox user other than the owner: their own login shell, as them,
    // in their own home — never the owner's account, shell or folder.
    const term = pty.spawn("/usr/bin/sudo", ["-n", "/usr/local/libexec/clawbox/clawbox-user-helper.sh", "shell", asUser], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: "/",
      env: { TERM: "xterm-256color", LANG: lang, PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    });
    console.log(`[terminal-server] Spawned PTY pid=${term.pid} for ClawBox user ${asUser}`);
    return { pty: term, info: { shell: "login shell", cwd: "~", user: asUser } };
  }

  // What the Terminal's settings asked for, checked: a shell /etc/shells
  // lists and that is installed, a folder that exists. Otherwise bash in the
  // home folder, as it always was — and the client is told which it got.
  const { shell, refused: shellRefused } = resolveShell(requested.get("shell"), readEtcShells());
  const { cwd, refused: cwdRefused } = resolveCwd(requested.get("cwd"), targetHome);
  const term = pty.spawn(shell, ["-l"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: {
      HOME: targetHome,
      USER: targetUser,
      LOGNAME: targetUser,
      SHELL: shell,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: lang,
      POWERLEVEL9K_INSTANT_PROMPT: "quiet",
    },
  });
  console.log(`[terminal-server] Spawned PTY pid=${term.pid} shell=${shell}`);
  return {
    pty: term,
    info: {
      shell,
      cwd,
      ...(shellRefused ? { shellRefused } : {}),
      ...(cwdRefused ? { cwdRefused } : {}),
    },
  };
}

wss.on("connection", (ws, req) => {
  console.log(`[terminal-server] New connection from ${req.socket.remoteAddress}`);
  const asUser = scopedUser(req) || null;
  // Sessions are the user's own: another ClawBox user's session id is
  // answered exactly as one that never existed.
  handleConnection(registry, ws, {
    owner: asUser ?? OWNER_KEY,
    params: new URL(req.url ?? "/", "http://terminal.invalid").searchParams,
    spawn: (params) => spawnShell(asUser, params),
    log: (line) => console.log(line),
  });
});

// Bind loopback only. This PTY server spawns a shell per connection, so it must never be reachable directly from the LAN (SEC-1).
// The port-80 production-server proxy reaches it via 127.0.0.1 and enforces a
// ClawBox session cookie on the /terminal-ws upgrade.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[terminal-server] Listening on ws://127.0.0.1:${PORT}`);
});

// Last-resort backstop: an unforeseen throw anywhere in an async callback (a
// node-pty native fault, a socket write race) must NOT take the whole terminal
// server down and drop every session. Log it and keep running; per-connection
// handlers already contain their own failures.
process.on("uncaughtException", (err) => {
  console.error("[terminal-server] Uncaught exception (kept alive):", err);
});

process.on("SIGTERM", () => {
  console.log("[terminal-server] SIGTERM received, shutting down");
  registry.shutdown();
  wss.close();
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[terminal-server] SIGINT received, shutting down");
  registry.shutdown();
  wss.close();
  server.close();
  process.exit(0);
});
