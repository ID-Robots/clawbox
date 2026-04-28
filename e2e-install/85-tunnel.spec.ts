/**
 * Cloudflare quick-tunnel — exposes the local web UI through a
 * trycloudflare.com URL so a remote operator can reach the device
 * without port-forwarding.
 *
 * Real cloudflared is not installed in CLAWBOX_TEST_MODE (saves ~50MB
 * + an unnecessary outbound connection during CI). To exercise the
 * happy path without leaving CI sandboxed networking, we drop a
 * fake `cloudflared` shim into /usr/local/bin that prints the
 * trycloudflare URL and then sleeps. It satisfies both
 * `which cloudflared` and the URL-extraction regex in src/lib/tunnel.ts.
 *
 *   1. Stub cloudflared
 *   2. POST /setup-api/tunnel/enable     → { success, tunnelUrl }
 *   3. GET  /setup-api/tunnel/status     → enabled + matching url
 *   4. POST /setup-api/tunnel/disable    → { success: true }
 *   5. GET  /setup-api/tunnel/status     → not running
 *
 * Runs at NN=85 between chat (80) and upgrade (90).
 */
import { test, expect } from "@playwright/test";
import { dockerExec } from "./helpers/container";
import {
  disableTunnel,
  enableTunnel,
  getTunnelStatus,
} from "./helpers/setup-api";

const FAKE_URL = "https://e2e-fake-tunnel-stub.trycloudflare.com";

const STUB_SCRIPT = `#!/bin/bash
# Test-mode cloudflared stub.
# Real cloudflared, when given --url, writes a "Visit it at: https://..."
# line to stderr and stays running. This stub mimics that just enough
# for src/lib/tunnel.ts to extract the URL and persist a PID.
echo "Visit it at (it may take some time to be reachable): ${FAKE_URL}" >&2
# Keep the process alive — startTunnel writes the PID and expects the
# process to still be running when isTunnelRunning checks process.kill.
exec sleep 600
`;

test.describe.configure({ mode: "serial" });

test.describe("tunnel happy path", () => {
  test.beforeAll(async () => {
    // Drop the stub. Pass the script via base64 so newlines survive the
    // double-shell hop (`docker exec` → `bash -lc` → `sudo tee`). echo with
    // unescaped \n would otherwise produce a one-line file with literal
    // backslash-n bytes, leaving cloudflared not actually executable.
    const b64 = Buffer.from(STUB_SCRIPT).toString("base64");
    await dockerExec(
      [
        "bash",
        "-lc",
        `echo ${b64} | base64 -d | sudo tee /usr/local/bin/cloudflared > /dev/null && sudo chmod +x /usr/local/bin/cloudflared`,
      ],
      { user: "clawbox", timeoutMs: 15_000 },
    );
  });

  test.afterAll(async () => {
    // Best-effort cleanup — stop any running stub + remove it.
    await disableTunnel().catch(() => {});
    await dockerExec(
      [
        "bash",
        "-lc",
        "sudo rm -f /usr/local/bin/cloudflared || true; sudo pkill -f 'cloudflared' || true; sudo pkill -f 'sleep 600' || true",
      ],
      { user: "clawbox", timeoutMs: 15_000 },
    ).catch(() => {});
  });

  test("status reports cloudflared as installed", async () => {
    const status = await getTunnelStatus();
    expect(status.cloudflaredInstalled).toBe(true);
    expect(status.running).toBe(false); // hasn't been enabled yet
  });

  test("enable returns tunnel URL", async () => {
    const result = await enableTunnel();
    expect(result.success).toBe(true);
    expect(result.tunnelUrl).toBe(FAKE_URL);
  });

  test("status reflects running tunnel + URL", async () => {
    // Tiny grace period — startTunnel writes pid + url asynchronously.
    await new Promise((r) => setTimeout(r, 500));
    const status = await getTunnelStatus();
    expect(status.running).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.tunnelUrl).toBe(FAKE_URL);
  });

  test("enable while already running returns the existing URL", async () => {
    const result = await enableTunnel();
    expect(result.success).toBe(true);
    expect(result.tunnelUrl).toBe(FAKE_URL);
  });

  test("disable shuts the tunnel down", async () => {
    const result = await disableTunnel();
    expect(result.success).toBe(true);
    const status = await getTunnelStatus();
    expect(status.running).toBe(false);
    expect(status.tunnelUrl).toBeNull();
  });
});
