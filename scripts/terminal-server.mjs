// @ts-check
/**
 * Standalone WebSocket Terminal Server
 * Runs on port 3006, spawns a login PTY (/bin/bash) per connection and bridges
 * it over WebSocket.
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
 *   Client → Server:
 *     { type: "input", data: string }       — raw keyboard input
 *     { type: "resize", cols: N, rows: N }  — terminal resize event
 *   Server → Client:
 *     { type: "output", data: string }      — raw PTY output
 *     { type: "exit", code: number }        — PTY exited
 */

import * as http from "node:http";
import * as os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";

const PORT = parseInt(process.env.TERMINAL_WS_PORT || "3006", 10);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ClawBox Terminal WebSocket Server\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`[terminal-server] New connection from ${remote}`);

  // Spawn a PTY as the user running the ClawBox UI (clawbox on Jetson,
  // whatever user installed on x64). Derive from $USER/$HOME with the
  // historical clawbox/clawbox values as a final fallback.
  const targetUser = process.env.USER || process.env.LOGNAME || os.userInfo().username || "clawbox";
  const targetHome = process.env.HOME || os.homedir() || `/home/${targetUser}`;
  const shell = "/bin/bash";
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
    term = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: targetHome,
      env: cleanEnv,
    });

    console.log(`[terminal-server] Spawned PTY pid=${term.pid} shell=${shell}`);

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
