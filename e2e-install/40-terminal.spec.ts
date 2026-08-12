/**
 * Terminal — connect to the real /terminal-ws WebSocket, which
 * production-server.js proxies to the node-pty backed terminal-server.ts.
 * Types a command into the PTY and asserts its output shows up on the wire.
 *
 * This exercises:
 *   - node-pty native rebuild (install.sh's ensure_node_pty)
 *   - production-server.js WebSocket upgrade routing, including the session
 *     check it applies to the single-service sockets
 *   - the standalone terminal-server.ts on port 3006 inside the container
 *
 * The upgrade carries a `clawbox_session` cookie because that is what the
 * desktop's Terminal app sends. A WebSocket upgrade never passes through the
 * Next.js middleware that gates ordinary requests, so production-server.js
 * checks the cookie itself and the client has to supply it — the browser does
 * so automatically from the document's cookie jar, and a raw socket must set
 * the header by hand.
 */
import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { CLAWBOX_PORT } from "./helpers/container";
import { getStatus, loginSessionCookie } from "./helpers/setup-api";

const TERMINAL_WS_URL = `ws://localhost:${CLAWBOX_PORT}/terminal-ws`;

test.describe("terminal app happy path", () => {
  let sessionCookie = "";

  test.beforeAll(async () => {
    const status = await getStatus();
    test.skip(
      !status.setup_complete,
      "setup did not complete — no password to log in with yet",
    );
    sessionCookie = await loginSessionCookie();
  });

  test("echo round-trip via /terminal-ws", async () => {
    const ws = new WebSocket(TERMINAL_WS_URL, {
      headers: { cookie: sessionCookie },
    });

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

  test("/terminal-ws upgrade without a session does not open", async () => {
    // The PTY backend listens on loopback with no auth of its own, so the
    // session check on the upgrade is the only thing standing between a
    // caller and a shell. Assert it is actually applied — otherwise the test
    // above would keep passing if the cookie stopped being required.
    const ws = new WebSocket(TERMINAL_WS_URL);

    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("timed-out"), 15_000);
      ws.on("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve("opened");
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        resolve(String(err instanceof Error ? err.message : err));
      });
    });

    expect(outcome, "an anonymous upgrade should not reach the PTY").not.toBe(
      "opened",
    );
    expect(outcome).toMatch(/401/);
  });
});
