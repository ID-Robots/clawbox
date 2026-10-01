import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import type { Page } from "@playwright/test";
import { WebSocket } from "ws";

/**
 * A REAL terminal backend for the specs that need a shell to keep running
 * across a page reload (TASK-1306) — which the in-browser fake of
 * mock-backends.ts cannot be, since a reload wipes it.
 *
 * `scripts/terminal-server.mjs` itself, on a free loopback port, when node-pty
 * works on this machine. Where it does not (a CI image that never built the
 * native module), `pipe-terminal-server.mjs` beside this file: the same
 * session protocol — scripts/terminal-sessions.mjs — over bash on pipes. No
 * TTY, so nothing is echoed, but a command runs, prints and keeps running
 * exactly the same. Both are child processes, so a restart is a reboot.
 *
 * The standalone e2e server has no /terminal-ws proxy, so `routeTerminalToBackend`
 * bridges the page's socket to the backend from the test process with
 * Playwright's routeWebSocket. That bridge lives outside the page, which is
 * the point: a reload closes the page's socket and the shell stays up.
 */

export interface TerminalBackend {
  /** Which backend this run got — the real PTY server or the pipe fallback. */
  kind: "pty-server" | "pipe-fallback";
  port: number;
  /** Stop the backend: every session goes with it, as on a reboot. */
  stop(): Promise<void>;
  /** Stop and start again on the same port — the box rebooted. */
  restart(): Promise<void>;
  /** What the backend answers a reattach to `id` with first (`attached`, `gone`). */
  probe(id: string): Promise<string>;
}

/** Playwright runs from the repository root. */
const REPO = process.cwd();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function nodePtyWorks(): boolean {
  const check = spawnSync(process.execPath, [
    "-e",
    "const p=require('node-pty').spawn('/bin/sh',['-c','exit 0'],{});p.onExit(()=>process.exit(0));setTimeout(()=>process.exit(1),5000)",
  ], { cwd: REPO, stdio: "ignore", timeout: 10_000 });
  return check.status === 0;
}

async function waitForListener(port: number, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`terminal-server exited with ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`terminal backend did not come up on ${port}`);
}

export async function startTerminalBackend(): Promise<TerminalBackend> {
  const port = await freePort();
  // CLAWBOX_E2E_TERMINAL_BACKEND=pipe runs the fallback on a machine that has node-pty too.
  const kind: TerminalBackend["kind"] = process.env.CLAWBOX_E2E_TERMINAL_BACKEND !== "pipe" && nodePtyWorks() ? "pty-server" : "pipe-fallback";
  let stopCurrent: () => Promise<void>;

  const start = async () => {
    const script = kind === "pty-server" ? "scripts/terminal-server.mjs" : "e2e/helpers/pipe-terminal-server.mjs";
    const env: NodeJS.ProcessEnv = { ...process.env, TERMINAL_WS_PORT: String(port) };
    // No token: the loopback-only rule a dev server runs under.
    delete env.CLAWBOX_TERMINAL_TOKEN;
    const child = spawn(process.execPath, [script], { cwd: REPO, env, stdio: "ignore" });
    await waitForListener(port, child);
    stopCurrent = () => new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  };

  await start();
  return {
    kind,
    port,
    stop: () => stopCurrent(),
    restart: async () => {
      await stopCurrent();
      await start();
    },
    probe: (id: string) => new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?session=${encodeURIComponent(id)}`);
      ws.once("message", (data) => {
        resolve(String(JSON.parse(String(data)).type));
        ws.close();
      });
      ws.once("error", reject);
    }),
  };
}

/** Everything the backend sent the page, per page-side socket, for the wire-level checks. */
export interface TerminalWire {
  frames: Array<{ url: string; msg: Record<string, unknown> }>;
}

/** Bridge the page's /terminal-ws sockets to `backend`. */
export async function routeTerminalToBackend(page: Page, backend: TerminalBackend, wire: TerminalWire = { frames: [] }): Promise<TerminalWire> {
  await page.routeWebSocket(/\/terminal-ws(\?|$)/, (route) => {
    const search = new URL(route.url()).search;
    const upstream = new WebSocket(`ws://127.0.0.1:${backend.port}/${search}`);
    const queued: string[] = [];
    upstream.on("open", () => {
      for (const message of queued.splice(0)) upstream.send(message);
    });
    upstream.on("message", (data) => {
      const text = String(data);
      try {
        wire.frames.push({ url: search, msg: JSON.parse(text) as Record<string, unknown> });
      } catch {
        // not JSON: passed on as it is
      }
      route.send(text);
    });
    // 1005/1006 describe a close; they cannot be SENT as one.
    upstream.on("close", (code) => route.close({ code: code === 1005 || code === 1006 ? 1000 : code }));
    upstream.on("error", () => route.close({ code: 1011 }));
    route.onMessage((message) => {
      const text = typeof message === "string" ? message : message.toString("utf8");
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else queued.push(text);
    });
    route.onClose(() => upstream.close());
  });
  return wire;
}
