/**
 * VNC — Xvfb + x11vnc + websockify run inside the container so the
 * Browser app and the noVNC viewer have something to connect to. This
 * spec verifies the public-facing surface:
 *
 *   - GET /setup-api/vnc returns a structured status payload
 *   - websockify on port 6080 accepts an HTTP GET (noVNC over websocket
 *     transport upgrades from HTTP, so a plain GET responds with 4xx /
 *     a noVNC welcome page; either is fine — what we DON'T want is
 *     ECONNREFUSED).
 *
 * Runs at NN=45 between terminal (40) and webapps (50).
 */
import { test, expect } from "@playwright/test";
import { getVncStatus } from "./helpers/setup-api";

const VNC_PORT = process.env.CLAWBOX_VNC_PORT ?? "6080";

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

  test("websockify port responds (no ECONNREFUSED)", async ({ request }) => {
    // noVNC's websockify accepts plain HTTP GET on the wsPort and serves
    // a tiny welcome page or a 4xx "websocket only" — both prove it's
    // listening.
    const res = await request.get(`http://localhost:${VNC_PORT}/`, {
      failOnStatusCode: false,
      timeout: 5_000,
    });
    expect(res.status(), "websockify should respond on port 6080").toBeLessThan(
      500,
    );
  });
});
