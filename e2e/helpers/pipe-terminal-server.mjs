// @ts-check
/**
 * The e2e fallback for scripts/terminal-server.mjs on a machine where node-pty
 * was never built (see terminal-backend.ts): the same session protocol —
 * scripts/terminal-sessions.mjs, unchanged — over bash on pipes. No TTY, so
 * nothing is echoed and there is no prompt, but a command runs, prints and
 * keeps running across a page reload exactly as it does on the box.
 *
 * Usage: TERMINAL_WS_PORT=<port> node e2e/helpers/pipe-terminal-server.mjs
 */

import { spawn } from "node:child_process";
import * as http from "node:http";
import { WebSocketServer } from "ws";
import { OWNER_KEY, createSessionRegistry, handleConnection } from "../../scripts/terminal-sessions.mjs";

const PORT = Number(process.env.TERMINAL_WS_PORT);

function pipeShell() {
  const child = spawn("bash", ["--norc", "--noprofile"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C.UTF-8" },
    stdio: "pipe",
  });
  return {
    pid: child.pid,
    // A terminal's Enter is CR; a PTY's line discipline would make it LF.
    write: (/** @type {string} */ data) => { child.stdin.write(data.replace(/\r/g, "\n")); },
    resize: () => {},
    kill: () => { child.kill("SIGKILL"); },
    onData: (/** @type {(data: string) => void} */ cb) => {
      const forward = (/** @type {Buffer} */ chunk) => cb(chunk.toString("utf8").replace(/\r?\n/g, "\r\n"));
      child.stdout.on("data", forward);
      child.stderr.on("data", forward);
    },
    onExit: (/** @type {(e: { exitCode: number }) => void} */ cb) => { child.on("exit", (code) => cb({ exitCode: code ?? 0 })); },
  };
}

const registry = createSessionRegistry({ idleMs: 10 * 60_000 });
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ClawBox Terminal WebSocket Server (e2e pipe fallback)\n");
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws, req) => {
  handleConnection(registry, ws, {
    owner: OWNER_KEY,
    params: new URL(req.url ?? "/", "http://terminal.invalid").searchParams,
    spawn: () => ({ pty: pipeShell(), info: { shell: "bash", cwd: process.cwd() } }),
  });
});
server.listen(PORT, "127.0.0.1");

process.on("SIGTERM", () => {
  registry.shutdown();
  wss.close();
  server.close();
  process.exit(0);
});
