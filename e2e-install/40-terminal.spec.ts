/**
 * Terminal — connect to the real /terminal-ws WebSocket, which
 * production-server.js proxies to the node-pty backed terminal-server.ts.
 * Types a command into the PTY and asserts its output shows up on the wire.
 *
 * This exercises:
 *   - node-pty native rebuild (install.sh's ensure_node_pty)
 *   - production-server.js WebSocket upgrade routing
 *   - the standalone terminal-server.ts on port 3006 inside the container
 */
import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { CLAWBOX_PORT } from "./helpers/container";

test.describe("terminal app happy path", () => {
  test("echo round-trip via /terminal-ws", async () => {
    const ws = new WebSocket(`ws://localhost:${CLAWBOX_PORT}/terminal-ws`);

    const output: string[] = [];
    let opened = false;

    const result = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("terminal timed out")), 30_000);

      ws.on("open", () => {
        opened = true;
        // Give the shell a beat to write its prompt, then send `uname -a`
        // which should reliably produce `Linux` in output.
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "input", data: "uname -a\n" }));
        }, 500);
      });

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string; data?: string };
        if (msg.type === "output" && msg.data) {
          output.push(msg.data);
          const joined = output.join("");
          if (/\bLinux\b/.test(joined) && /\bx86_64|aarch64|armv/.test(joined)) {
            clearTimeout(timer);
            ws.close();
            resolve(joined);
          }
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.on("close", () => {
        if (!opened) {
          clearTimeout(timer);
          reject(new Error("terminal closed before open"));
        }
      });
    });

    expect(result).toMatch(/\bLinux\b/);
    expect(result).toMatch(/aarch64|x86_64|armv/);
  });
});
