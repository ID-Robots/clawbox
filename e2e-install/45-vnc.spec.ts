/**
 * VNC — Xvfb + x11vnc + websockify run inside the container so the
 * Browser app and the noVNC viewer have something to connect to. This
 * spec verifies the public-facing surface:
 *
 *   - GET /setup-api/vnc returns a structured status payload
 *   - websockify is up and answering on the address it binds (noVNC over
 *     websocket transport upgrades from HTTP, so a plain GET responds with
 *     a 4xx / a noVNC welcome page; either is fine — what we DON'T want is
 *     nothing listening)
 *   - the route the desktop actually uses, /novnc-ws on the app port,
 *     carries the same session requirement as the rest of the desktop
 *
 * Runs at NN=45 between terminal (40) and webapps (50).
 */
import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { CLAWBOX_PORT, dockerExec } from "./helpers/container";
import { getVncStatus } from "./helpers/setup-api";

// The port websockify binds inside the container. install.sh binds it on
// loopback rather than the wildcard: x11vnc runs `-nopw -localhost`, so the
// desktop has no password of its own and the intended route to it is
// production-server.js's /novnc-ws upgrade, which is session-gated (and which
// VNCApp already uses — same-origin, so HTTPS and the tunnel work too).
const VNC_WS_PORT = process.env.VNC_WS_PORT ?? "6080";

test.describe("vnc happy path", () => {
  test("GET /setup-api/vnc returns a status payload", async () => {
    const status = await getVncStatus();
    // The shape includes available + ports — actual `available: true`
    // depends on x11vnc being up; in the test container Xvfb is
    // bootstrapped, but if a prior spec exited Chromium uncleanly the
    // session might churn briefly. We accept either, but require a
    // defined response with port info.
    expect(typeof status.available).toBe("boolean");
    if (status.available) {
      expect(status.vncPort).toBeGreaterThan(0);
      expect(status.wsPort).toBeGreaterThan(0);
    }
  });

  test("websockify answers on its loopback bind", async () => {
    // Probe websockify where it actually listens — inside the container — so
    // this still proves "websockify is up and answering" rather than "the
    // port is reachable from off-box", which it deliberately is not.
    // `%{http_code}` is `000` when curl never got an HTTP response at all,
    // which is the case this test exists to catch.
    const out = await dockerExec(
      [
        "bash",
        "-lc",
        `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${VNC_WS_PORT}/ || true`,
      ],
      { user: "clawbox", timeoutMs: 30_000 },
    );
    const code = out.trim();
    expect(
      code,
      `nothing answered on 127.0.0.1:${VNC_WS_PORT} — websockify is not listening`,
    ).not.toBe("000");
    expect(Number(code), `unexpected websockify status ${code}`).toBeLessThan(500);
  });

  test("/novnc-ws upgrade without a session does not open", async () => {
    // The desktop reaches the remote desktop through this same-origin route,
    // and it is the only route in from off-box. Assert the session
    // requirement is applied on the upgrade, since websockify itself has no
    // auth of its own to fall back on.
    const ws = new WebSocket(`ws://localhost:${CLAWBOX_PORT}/novnc-ws`);

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

    expect(outcome, "an anonymous upgrade should not reach websockify").not.toBe(
      "opened",
    );
    expect(outcome).toMatch(/401/);
  });
});
