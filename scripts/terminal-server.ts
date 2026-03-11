#!/usr/bin/env node
/**
 * Standalone WebSocket Terminal Server
 * Runs on port 3006, spawns a PTY (zsh) per connection and bridges it over WebSocket.
 *
 * Usage:
 *   npx ts-node scripts/terminal-server.ts
 *   # or compile and run with node
 *
 * Protocol:
 *   Client → Server:
 *     { type: "input", data: string }       — raw keyboard input
 *     { type: "resize", cols: N, rows: N }  — terminal resize event
 *   Server → Client:
 *     { type: "output", data: string }      — raw PTY output
 *     { type: "exit", code: number }        — PTY exited
 */

import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import * as os from "os";

const PORT = parseInt(process.env.TERMINAL_WS_PORT || "3006", 10);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ClawBox Terminal WebSocket Server\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`[terminal-server] New connection from ${remote}`);

  // Spawn a PTY
  const shell = process.env.SHELL || "/bin/zsh";
  const term = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    } as { [key: string]: string },
  });

  console.log(`[terminal-server] Spawned PTY pid=${term.pid} shell=${shell}`);

  // PTY → WebSocket
  term.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  term.onExit(({ exitCode }: { exitCode: number }) => {
    console.log(`[terminal-server] PTY exited pid=${term.pid} code=${exitCode}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      ws.close();
    }
  });

  // WebSocket → PTY
  ws.on("message", (raw: Buffer | string) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "input" && typeof msg.data === "string") {
        term.write(msg.data);
      } else if (msg.type === "resize" && msg.cols && msg.rows) {
        term.resize(Number(msg.cols), Number(msg.rows));
      }
    } catch (e) {
      console.warn("[terminal-server] Bad message:", e);
    }
  });

  ws.on("close", () => {
    console.log(`[terminal-server] Connection closed, killing PTY pid=${term.pid}`);
    try {
      term.kill();
    } catch {}
  });

  ws.on("error", (err) => {
    console.error("[terminal-server] WebSocket error:", err);
    try {
      term.kill();
    } catch {}
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[terminal-server] Listening on ws://0.0.0.0:${PORT}`);
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
