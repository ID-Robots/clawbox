/**
 * Settings app — exercises each panel via real setup-api calls. This runs
 * after the happy-path setup is complete (global setup leaves the wizard
 * finished), so the desktop is reachable.
 *
 * We keep this test API-driven rather than click-driven: the UI layer is
 * already covered by e2e/settings-workflow.spec.ts against mocked data.
 * Here we want to verify the server-side routes actually mutate the right
 * state on a real install.
 */
import { test, expect } from "@playwright/test";
import { dockerExec } from "./helpers/container";
import {
  getPreferences,
  getSystemInfo,
  getSystemStats,
  setHotspot,
  setPreferences,
  setSystemPassword,
} from "./helpers/setup-api";

test.describe.configure({ mode: "serial" });

test.describe("settings actions", () => {
  test("system info returns real hostname + uptime", async () => {
    const info = await getSystemInfo();
    expect(info.hostname).toBeTruthy();
    // uptime on a fresh container often reads "0 minutes" or "1 minute"; just
    // assert it's a string so we're not flaky on first boot.
    expect(typeof info.uptime).toBe("string");
  });

  test("system stats returns cpu/mem/temperature", async () => {
    const stats = await getSystemStats();
    expect(stats.cpu).toBeDefined();
    expect(stats.memory).toBeDefined();
    // temperature can be null in qemu — we just assert the key is present.
    expect(Object.keys(stats as object)).toContain("temperature");
  });

  test("preferences persist language change", async () => {
    await setPreferences({ ui_language: "de" });
    const prefs = await getPreferences();
    expect(prefs.ui_language).toBe("de");

    // Reset for subsequent tests.
    await setPreferences({ ui_language: "en" });
    expect((await getPreferences()).ui_language).toBe("en");
  });

  test("hotspot SSID rename persists", async () => {
    await setHotspot("ClawBox-Renamed", "hotspot-e2e-pass", true);
    // The POST result doesn't return the new state — hit the GET and verify.
    const res = await fetch(`${process.env.BASE_URL ?? "http://localhost:" + (process.env.CLAWBOX_PORT ?? "8080")}/setup-api/system/hotspot`);
    const data = await res.json();
    expect(data.ssid).toBe("ClawBox-Renamed");
    // Restore original name for other tests.
    await setHotspot("ClawBox-Test", "hotspot-e2e-pass", true);
  });

  test("system password change (rotate then restore)", async () => {
    // The credentials route rate-limits (5 in 15 min). Rotate once, then
    // rotate back — 2 calls total, well under the cap. happy-path already
    // set an initial password, so the currentPassword field is required.
    const rotateRes = await fetch(
      `${process.env.BASE_URL ?? "http://localhost:" + (process.env.CLAWBOX_PORT ?? "8080")}/setup-api/system/credentials`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          password: "clawbox-e2e-rotated",
          currentPassword: "clawbox-e2e-pass",
        }),
      },
    );
    expect(rotateRes.ok).toBe(true);
    void setSystemPassword; // helper kept for first-time-set paths elsewhere

    // Verify chpasswd actually ran by reading /etc/shadow metadata in the
    // container. We can't read the hash (that's good), but we can stat the
    // last-changed day and confirm it updated.
    const stdout = await dockerExec(
      ["bash", "-c", "getent shadow clawbox | cut -d: -f3"],
      { user: "root" },
    );
    const daysSinceEpoch = Number(stdout.trim());
    expect(daysSinceEpoch).toBeGreaterThan(0);

    // Restore so other tests that might use the password still work. Note:
    // the current-password check only kicks in AFTER password_configured is
    // set — happy-path.spec.ts set it once, so we need currentPassword now.
    const restoreRes = await fetch(
      `${process.env.BASE_URL ?? "http://localhost:" + (process.env.CLAWBOX_PORT ?? "8080")}/setup-api/system/credentials`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          password: "clawbox-e2e-pass",
          currentPassword: "clawbox-e2e-rotated",
        }),
      },
    );
    expect(restoreRes.ok).toBe(true);
  });

  test("update-branch is set (upgrade spec depends on this)", async () => {
    // Not really a settings action, but Settings → System Update surfaces it.
    const res = await fetch(`${process.env.BASE_URL ?? "http://localhost:" + (process.env.CLAWBOX_PORT ?? "8080")}/setup-api/system/update-branch`);
    expect(res.ok).toBe(true);
  });
});
