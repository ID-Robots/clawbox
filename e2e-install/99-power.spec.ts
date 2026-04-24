/**
 * Power action (reboot) — /setup-api/system/power with action=restart runs
 * `sudo systemctl reboot`, which in a container tears down systemd (PID 1)
 * and exits the container. This spec exercises that full path, then
 * explicitly starts the container again and verifies prior setup state
 * survived the "reboot".
 *
 * The compose file intentionally doesn't set a restart policy, so the
 * container stays down until `dockerStart()` brings it back — the test
 * controls the timing.
 *
 * Shutdown is *not* tested here: `systemctl poweroff` in this container
 * behaves identically to reboot from our perspective (both exit PID 1),
 * and running it would leave the container stopped for subsequent specs.
 */
import { test, expect } from "@playwright/test";
import {
  dockerStart,
  waitForContainerStopped,
  waitForHttpReady,
} from "./helpers/container";
import { getStatus, systemPower } from "./helpers/setup-api";

test.describe.configure({ mode: "serial" });

test.describe("power restart", () => {
  test("trigger reboot, container exits, comes back with state intact", async () => {
    test.setTimeout(10 * 60_000);

    // Snapshot the state we expect to survive the restart.
    const before = await getStatus();
    expect(before.setup_complete).toBe(true);

    // Fire and forget — the server responds before the reboot executes
    // (1.5s delay in the route handler).
    await systemPower("restart").catch(() => {
      // The fetch may also fail if systemd tears down during the response
      // write. Either outcome is fine.
    });

    // systemd takes a moment to cascade the unit stops; allow up to 2 min.
    await waitForContainerStopped(120_000);

    // Explicitly restart. entrypoint.sh runs again but sees the volume is
    // populated and skips the initial seed. clawbox-bootstrap.service sees
    // .needs-install is missing and no-ops.
    await dockerStart();
    await waitForHttpReady(5 * 60_000);

    // Everything we configured before the reboot should still be true.
    const after = await getStatus();
    expect(after.setup_complete).toBe(true);
    expect(after.wifi_configured).toBe(true);
    expect(after.password_configured).toBe(true);
  });
});
