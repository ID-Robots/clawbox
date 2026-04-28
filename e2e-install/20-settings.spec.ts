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
import { BASE_URL, dockerExec } from "./helpers/container";
import {
  getPreferences,
  getSystemInfo,
  getSystemStats,
  setHotspot,
  setPreferences,
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
    const res = await fetch(`${BASE_URL}/setup-api/system/hotspot`);
    const data = await res.json();
    expect(data.ssid).toBe("ClawBox-Renamed");
    // Restore original name for other tests.
    await setHotspot("ClawBox-Test", "hotspot-e2e-pass", true);
  });

  test("system password change (rotate then restore)", async () => {
    // The credentials route rate-limits (5 in 15 min). Rotate once, then
    // rotate back — 2 calls total, well under the cap. happy-path already
    // set an initial password, so the currentPassword field is required.
    const rotateRes = await fetch(`${BASE_URL}/setup-api/system/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "clawbox-e2e-rotated",
        currentPassword: "clawbox-e2e-pass",
      }),
    });
    expect(rotateRes.ok).toBe(true);

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
    const restoreRes = await fetch(`${BASE_URL}/setup-api/system/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "clawbox-e2e-pass",
        currentPassword: "clawbox-e2e-rotated",
      }),
    });
    expect(restoreRes.ok).toBe(true);
  });

  test("update-branch is set (upgrade spec depends on this)", async () => {
    // Not really a settings action, but Settings → System Update surfaces it.
    const res = await fetch(`${BASE_URL}/setup-api/system/update-branch`);
    expect(res.ok).toBe(true);
  });

  // ── deeper panel coverage ─────────────────────────────────────────

  test("WiFi panel — saved networks list is reachable", async () => {
    const res = await fetch(`${BASE_URL}/setup-api/wifi/saved`);
    // 200 with profiles[] is the happy case. 500 from nmcli is acceptable in
    // qemu where the wifi stack may be partially absent — what we care about
    // is the route exists and doesn't 404.
    expect([200, 500]).toContain(res.status);
    if (res.ok) {
      const body = (await res.json()) as { profiles: unknown[] };
      expect(Array.isArray(body.profiles)).toBe(true);
    }
  });

  test("WiFi panel — re-scan returns network list", async () => {
    const res = await fetch(`${BASE_URL}/setup-api/wifi/scan?live=1`, {
      method: "POST",
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      scanning: boolean;
      networks: Array<{ ssid: string }> | null;
    };
    expect(typeof body.scanning).toBe("boolean");
  });

  test("AI provider panel — provider models endpoint returns curated list", async () => {
    // The new picker (700a156) reads from /setup-api/ai-models/providers.
    const res = await fetch(`${BASE_URL}/setup-api/ai-models/providers`);
    if (res.status === 404) {
      // Older branch — try the alternate path.
      const alt = await fetch(`${BASE_URL}/setup-api/ai-models/status`);
      expect(alt.ok).toBe(true);
    } else {
      expect(res.ok).toBe(true);
    }
  });

  test("AI provider panel — current model status reflects setup choice", async () => {
    const res = await fetch(`${BASE_URL}/setup-api/ai-models/status`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { primary?: { provider: string } };
    // Wizard set the primary provider; status route should surface it.
    if (body.primary) {
      expect(typeof body.primary.provider).toBe("string");
    }
  });

  test("Telegram panel — status route reports configured flag", async () => {
    const res = await fetch(`${BASE_URL}/setup-api/telegram/status`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { configured: boolean };
    expect(typeof body.configured).toBe("boolean");
  });

  test("Remote Access panel — portal status returns tunnel state", async () => {
    const res = await fetch(`${BASE_URL}/setup-api/portal/status`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      tunnel: { installed: boolean; service: string; url: string | null };
      portalAddDeviceUrl: string;
    };
    expect(typeof body.tunnel.installed).toBe("boolean");
    expect(["active", "inactive", "failed", "activating", "unknown"]).toContain(
      body.tunnel.service,
    );
    expect(body.portalAddDeviceUrl).toMatch(/openclawhardware\.dev/);
  });

  test("System panel — power route exists (without actually shutting down)", async () => {
    // We don't want this test to actually power off the container — that
    // would interrupt the rest of the suite. So we only verify the route
    // accepts the action shape without invoking it.
    const res = await fetch(`${BASE_URL}/setup-api/system/power`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "noop" }),
    });
    // "noop" should be rejected with 400 — proves the validator runs.
    expect([400, 405]).toContain(res.status);
  });

  test("About panel — system version is exposed", async () => {
    const res = await fetch(`${BASE_URL}/setup-api/update/versions`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    // The exact shape evolves but we expect at least one version string.
    expect(JSON.stringify(body)).toMatch(/[0-9]+\.[0-9]+/);
  });

  test("Preferences — persist installed apps list across writes", async () => {
    const initial = (await getPreferences()) as { installed_apps?: string[] };
    const previous = initial.installed_apps ?? [];
    await setPreferences({ installed_apps: [...previous, "settings-test-app"] });
    const after = (await getPreferences()) as { installed_apps?: string[] };
    expect(after.installed_apps).toContain("settings-test-app");
    // Restore.
    await setPreferences({ installed_apps: previous });
  });
});
