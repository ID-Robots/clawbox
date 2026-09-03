/**
 * Terminal — connect to the real /terminal-ws WebSocket, which
 * production-server.js proxies to the node-pty backed terminal-server.mjs.
 * Types a command into the PTY and asserts its output shows up on the wire.
 *
 * This exercises:
 *   - node-pty native rebuild (install.sh's ensure_node_pty)
 *   - production-server.js WebSocket upgrade routing, including the session
 *     check it applies to the single-service sockets
 *   - the standalone terminal-server.mjs on port 3006 inside the container
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
  /**
   * Run one command in a real PTY through /terminal-ws and return everything
   * the shell wrote.
   *
   * The end marker is SPLIT in the line we type. A pty echoes what you type
   * before the shell has run any of it, so a helper that waits for a plain
   * marker is satisfied by its own echo — the first version of this waited on
   * a pattern that appeared in the command itself and then asserted against
   * output the shell had not produced yet. `"__CB_TERM""_END__"` is two string
   * literals on the wire and one word on the screen, so only the shell's own
   * `echo` can end the wait.
   */
  const END_MARKER = "__CB_TERM_END__";

  async function runInTerminal(command: string): Promise<string> {
    const ws = new WebSocket(TERMINAL_WS_URL, { headers: { cookie: sessionCookie } });
    const output: string[] = [];
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`timed out running: ${command}\n--- saw ---\n${output.join("")}`));
      }, 30_000);
      ws.on("open", () => {
        setTimeout(
          () => ws.send(JSON.stringify({ type: "input", data: `${command}; echo "__CB_TERM""_END__"\n` })),
          500,
        );
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string; data?: string };
        if (msg.type !== "output" || !msg.data) return;
        output.push(msg.data);
        const joined = output.join("");
        if (joined.includes(END_MARKER)) {
          clearTimeout(timer);
          ws.close();
          resolve(joined);
        }
      });
      ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }

  test("the coding harness is on the terminal's PATH", async () => {
    // TASK-378's acceptance is deliberately typed into THIS terminal and not
    // into ssh: a non-interactive ssh session skips ~/.bashrc, so `command -v`
    // over ssh answers "missing" on a box where the harness works fine. The
    // in-UI terminal spawns a login shell, which is the environment the owner
    // actually gets.
    const out = await runInTerminal("command -v claude-ds");
    expect(out, "install.sh must put claude-ds on the login shell's PATH").toContain(
      "/home/clawbox/.local/bin/claude-ds",
    );
  });

  test("the harness refuses clearly when ClawBox AI is not connected", async () => {
    // The container has no portal token, which is also the state of a box
    // whose owner has not signed in yet. The failure must name the screen that
    // fixes it rather than dumping a stack trace into the terminal — and it
    // must be the wrapper answering, not the shell saying it does not exist.
    const out = await runInTerminal("claude-ds --version 2>&1 | head -5");
    expect(out).not.toMatch(/command not found/);
    expect(out).toMatch(/ClawBox AI is not connected|Claude Code is not installed/);
  });
});
