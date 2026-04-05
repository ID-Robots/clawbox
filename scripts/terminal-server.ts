#!/usr/bin/env npx tsx
/**
 * Standalone WebSocket Terminal Server
 * Runs on port 3006, spawns a PTY (zsh) per connection and bridges it over WebSocket.
 *
 * Usage:
 *   bun run scripts/terminal-server.ts
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

  // Spawn a PTY as the clawbox user (not root)
  const targetUser = "clawbox";
  const targetHome = `/home/${targetUser}`;
  const shell = "/bin/bash";
  const cleanEnv: Record<string, string> = {
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

  const term = pty.spawn(shell, ["-l"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: targetHome,
    env: cleanEnv,
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
