/**
 * Happy-path full-install e2e test.
 *
 * Contract: after `global-setup.ts` finishes, install.sh has already run
 * successfully inside the container. This test drives the setup wizard end
 * to end via /setup-api/*, verifies each step flips the expected flag, and
 * finishes by opening the desktop in a browser to confirm the post-setup
 * shell loads without authentication (setup/complete sets a session cookie).
 *
 * Real AI providers are opt-in: keys come from e2e-install/.env.test. When a
 * key is absent, that provider step is skipped (not failed) so the suite
 * still makes forward progress on a clean checkout.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
  BASE_URL,
  dockerExec,
  readInstallLog,
  waitForHttpReady,
} from "./helpers/container";
import {
  configureAiModel,
  configureTelegram,
  connectWifi,
  getStatus,
  scanWifi,
  setHotspot,
  setSystemPassword,
} from "./helpers/setup-api";

// Tests may run with or without credentials. `.env.test` is loaded by the
// compose harness into the container; here we read the same file from the
// host so the orchestrator can decide which steps to run.
const env = loadEnvTest();

test.describe.configure({ mode: "serial" });

test.describe("fresh-install happy path", () => {
  test("install.sh finished cleanly", async () => {
    const log = await readInstallLog(20);
    expect(log).toMatch(/ClawBox Setup Complete|Rebuilding|services started/i);
    // Sanity check: the sentinel file is gone.
    await expect(
      dockerExec(["test", "!", "-f", "/home/clawbox/clawbox/.needs-install"]),
    ).resolves.toBeDefined();
  });

  test("setup status starts empty", async () => {
    const status = await getStatus();
    expect(status.setup_complete).toBe(false);
    expect(status.wifi_configured).toBe(false);
  });

  test("wifi scan returns fixture networks in test mode", async () => {
    const result = await scanWifi();
    expect(result.networks ?? []).toContainEqual(
      expect.objectContaining({ ssid: "TestNet-Home" }),
    );
  });

  test("wifi connect marks wifi_configured", async () => {
    await connectWifi("TestNet-Home", "wireless-pass");
    const status = await getStatus();
    expect(status.wifi_configured).toBe(true);
  });

  test("system password + hotspot", async () => {
    await setSystemPassword("clawbox-e2e-pass");
    await setHotspot("ClawBox-Test", "hotspot-e2e-pass", true);
    const status = await getStatus();
    expect(status.password_configured).toBe(true);
  });

  test("configure primary AI model", async () => {
    test.skip(!env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY && !env.GEMINI_API_KEY,
      "no AI keys in .env.test — skipping provider step");

    if (env.ANTHROPIC_API_KEY) {
      await configureAiModel("anthropic", env.ANTHROPIC_API_KEY, "primary");
    } else if (env.OPENAI_API_KEY) {
      await configureAiModel("openai", env.OPENAI_API_KEY, "primary");
    } else if (env.GEMINI_API_KEY) {
      await configureAiModel("google", env.GEMINI_API_KEY, "primary");
    }

    const status = await getStatus();
    expect(status.ai_model_configured).toBe(true);
  });

  test("configure telegram (if token provided)", async () => {
    test.skip(!env.TELEGRAM_BOT_TOKEN, "no TELEGRAM_BOT_TOKEN in .env.test");
    await configureTelegram(env.TELEGRAM_BOT_TOKEN!);
    const status = await getStatus();
    expect(status.telegram_configured).toBe(true);
  });

  test("complete setup + session cookie issued", async ({ page }) => {
    const res = await fetch(`${BASE_URL}/setup-api/setup/complete`, { method: "POST" });
    expect(res.ok).toBe(true);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/clawbox_session=/);

    // Extract the session cookie value and inject into the Playwright context
    // so the subsequent page.goto('/') lands on the desktop, not /login.
    const match = setCookie.match(/clawbox_session=([^;]+)/);
    const sessionValue = match?.[1] ?? "";
    expect(sessionValue).not.toEqual("");

    await page.context().addCookies([
      {
        name: "clawbox_session",
        value: sessionValue,
        domain: "localhost",
        path: "/",
      },
    ]);

    // Re-verify the server-side status.
    const status = await getStatus();
    expect(status.setup_complete).toBe(true);
  });

  test("desktop shell loads after setup", async ({ page }) => {
    await waitForHttpReady(30_000);
    await page.goto("/");
    // Chromium app shelf is the most stable anchor across screen sizes.
    await expect(page.locator('[data-testid="shelf-launcher-button"], [data-testid="app-launcher"]'))
      .toBeVisible({ timeout: 30_000 });
  });
});

// ── Env file loader (avoids bringing dotenv in as a dep) ────────────────────

function loadEnvTest(): Record<string, string | undefined> {
  const envPath = path.resolve(__dirname, ".env.test");
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (val) out[m[1]] = val;
  }
  return out;
}
