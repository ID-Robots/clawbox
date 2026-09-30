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
 * Protocol:
 *   Connect: /?shell=/usr/bin/zsh&cwd=~/projects  — both optional
 *   Client → Server:
 *     { type: "input", data: string }       — raw keyboard input
 *     { type: "resize", cols: N, rows: N }  — terminal resize event
 *   Server → Client:
 *     { type: "started", shell, cwd, shellRefused?, cwdRefused? }
 *                                           — what was spawned, and which
 *                                             request was not honoured
 *     { type: "output", data: string }      — raw PTY output
 *     { type: "exit", code: number }        — PTY exited
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
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { readEtcShells, resolveCwd, resolveShell } from "./terminal-launch.mjs";

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

wss.on("connection", (ws, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`[terminal-server] New connection from ${remote}`);
  const asUser = scopedUser(req);

  // Spawn a PTY as the user running the ClawBox UI (clawbox on Jetson,
  // whatever user installed on x64). Derive from $USER/$HOME with the
  // historical clawbox/clawbox values as a final fallback.
  const targetUser = process.env.USER || process.env.LOGNAME || os.userInfo().username || "clawbox";
  const targetHome = process.env.HOME || os.homedir() || `/home/${targetUser}`;
  // What the Terminal's settings asked for, checked: a shell /etc/shells
  // lists and that is installed, a folder that exists. Otherwise bash in the
  // home folder, as it always was — and the client is told which it got.
  const requested = new URL(req.url ?? "/", "http://terminal.invalid").searchParams;
  const { shell, refused: shellRefused } = resolveShell(requested.get("shell"), readEtcShells());
  const { cwd, refused: cwdRefused } = resolveCwd(requested.get("cwd"), targetHome);
  const cleanEnv = {
    HOME: targetHome,
    USER: targetUser,
    LOGNAME: targetUser,
    SHELL: shell,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: process.env.LANG || "en_US.UTF-8",
    POWERLEVEL9K_INSTANT_PROMPT: "quiet",
  };

  // Spawning the PTY can fail (EAGAIN/ENOMEM under load, a missing shell,
  // node-pty ABI mismatch). Without a guard here one bad spawn throws out of
  // the 'connection' handler and crashes the whole :3006 server, dropping
  // every other live terminal session. Contain the failure to this one socket:
  // tell the client and close, leaving the server up.
  /** @type {import("node-pty").IPty} */
  let term;
  try {
    if (asUser) {
      // A ClawBox user other than the owner: their own login shell, as them,
      // in their own home — never the owner's account, shell or folder.
      term = pty.spawn("/usr/bin/sudo", ["-n", "/usr/local/libexec/clawbox/clawbox-user-helper.sh", "shell", asUser], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: "/",
        env: { TERM: "xterm-256color", LANG: cleanEnv.LANG, PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      });
      console.log(`[terminal-server] Spawned PTY pid=${term.pid} for ClawBox user ${asUser}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "started", shell: "login shell", cwd: "~", user: asUser }));
      }
    } else {
      term = pty.spawn(shell, ["-l"], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: cleanEnv,
      });

      console.log(`[terminal-server] Spawned PTY pid=${term.pid} shell=${shell}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "started",
          shell,
          cwd,
          ...(shellRefused ? { shellRefused } : {}),
          ...(cwdRefused ? { cwdRefused } : {}),
        }));
      }
    }

    // PTY → WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    term.onExit(({ exitCode }) => {
      console.log(`[terminal-server] PTY exited pid=${term.pid} code=${exitCode}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close();
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[terminal-server] Failed to spawn PTY:", err);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "output", data: `\r\n[terminal-server] Failed to start shell: ${message}\r\n` }));
      ws.send(JSON.stringify({ type: "exit", code: 1 }));
    }
    try {
      ws.close();
    } catch {
      /* socket already gone */
    }
    return;
  }

  // WebSocket → PTY
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "input" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "resize") {
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0) {
          term.resize(cols, rows);
        } else {
          console.warn(`[terminal-server] Ignoring invalid resize cols=${msg.cols} rows=${msg.rows}`);
        }
      }
    } catch (e) {
      console.warn("[terminal-server] Bad message:", e);
    }
  });

  ws.on("close", () => {
    console.log(`[terminal-server] Connection closed, killing PTY pid=${term.pid}`);
    try {
      term.kill();
    } catch (err) {
      console.error(`[terminal-server] Failed to kill PTY pid=${term.pid} on close:`, err);
    }
  });

  ws.on("error", (err) => {
    console.error("[terminal-server] WebSocket error:", err);
    try {
      term.kill();
    } catch (killErr) {
      console.error(`[terminal-server] Failed to kill PTY pid=${term.pid} on error:`, killErr);
    }
  });
});

// Bind loopback only. This PTY server spawns an unauthenticated shell per
// connection, so it must never be reachable directly from the LAN (SEC-1).
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
  wss.close();
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[terminal-server] SIGINT received, shutting down");
  wss.close();
  server.close();
  process.exit(0);
});
