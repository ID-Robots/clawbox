/**
 * Full initial-setup wizard walkthrough.
 *
 * Drives the real SetupWizard React component through every step in a live
 * browser session:
 *   WiFi → (Update → auto-skip) → Credentials → AI Models → Local AI →
 *   Telegram → Completion overlay → desktop.
 *
 * This replaces the earlier API-driven happy-path smoke test. It covers:
 *   - Every step's UI renders + transitions correctly
 *   - /setup-api/* routes under each step respond as the UI expects
 *   - Middleware flips setup-complete users off /setup onto /
 *   - Session cookie issued by /setup-api/setup/complete lands us on
 *     the desktop shell without a separate login round-trip
 *
 * Runs first so the container starts with a clean setup state. Every
 * downstream spec (settings/files/terminal/webapps/app-store/browser/
 * chat/upgrade/power) assumes setup is already complete by the time
 * it runs, which is exactly the state this test leaves behind.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
  dockerExec,
  readInstallLog,
  waitForHttpReady,
} from "./helpers/container";
import { getStatus } from "./helpers/setup-api";

const env = loadEnvTest();

test.describe.configure({ mode: "serial" });

test.describe("fresh-install setup wizard (UI)", () => {
  test("install.sh finished cleanly", async () => {
    const log = await readInstallLog(20);
    expect(log).toMatch(/ClawBox Setup Complete|Rebuilding|services started/i);
    await expect(
      dockerExec(["test", "!", "-f", "/home/clawbox/clawbox/.needs-install"]),
    ).resolves.toBeDefined();
  });

  test("setup status starts empty", async () => {
    const status = await getStatus();
    expect(status.setup_complete).toBe(false);
    expect(status.wifi_configured).toBe(false);
    expect(status.password_configured).toBe(false);
  });

  // One big browser-driven walk. Per-step tests would need shared
  // session/storage state across tests, which Playwright doesn't do by
  // default. A single test keeps the flow readable and lets the error
  // point straight at whichever step broke.
  test("walk through wizard end-to-end", async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await waitForHttpReady(60_000);
    await page.goto("/setup");

    // ── Step 1: WiFi ─────────────────────────────────────────────
    await expect(page.getByTestId("setup-step-wifi")).toBeVisible({ timeout: 30_000 });

    // Dismiss the Ethernet shortcut — we want to exercise the real WiFi
    // flow (scan → pick SSID → password → connect) since that's the path
    // end users hit on first boot. The Ethernet button is listed first,
    // so target the WiFi button by its translated label.
    const connectWifiBtn = page.getByRole("button", { name: /Connect to WiFi/i });
    await expect(connectWifiBtn).toBeVisible();
    await connectWifiBtn.click();

    // The fixture network list comes from scanWifiLive() under
    // CLAWBOX_TEST_MODE=1 in src/lib/network.ts.
    const wifiNetwork = page.getByRole("button", { name: "TestNet-Home" });
    await expect(wifiNetwork).toBeVisible({ timeout: 15_000 });
    await wifiNetwork.click();

    await page.locator("#wifi-password").fill("wireless-pass");
    await page.getByRole("button", { name: /^Connect$/ }).click();

    // ── Step 2: Update (frequently auto-advances) ─────────────────
    const updateStep = page.getByTestId("setup-step-update");
    const credentialsStep = page.getByTestId("setup-step-credentials");

    // UpdateStep auto-advances to credentials when update_completed is
    // already set (which happens as soon as we hit /setup-api/update/status
    // once). Race the two — whichever shows first wins.
    const credVisibleFast = await credentialsStep
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!credVisibleFast) {
      await expect(updateStep).toBeVisible({ timeout: 10_000 });
      const continueBtn = updateStep.getByRole("button", { name: /Continue/i });
      await continueBtn.click();
    }

    // ── Step 3: Credentials ──────────────────────────────────────
    await expect(credentialsStep).toBeVisible({ timeout: 30_000 });
    await page.locator("#cred-password").fill("clawbox-e2e-pass");
    await page.locator("#cred-confirm").fill("clawbox-e2e-pass");

    // Hotspot is a switch — turn it OFF for this test so the subsequent
    // fields aren't required. 20-settings later exercises the hotspot
    // config path explicitly, so we're not losing coverage here.
    const hotspotSwitch = page.getByRole("switch", { name: /Enable hotspot/i });
    await expect(hotspotSwitch).toBeVisible({ timeout: 10_000 });
    const hotspotChecked = await hotspotSwitch.getAttribute("aria-checked");
    if (hotspotChecked === "true") {
      await hotspotSwitch.click();
      await expect(hotspotSwitch).toHaveAttribute("aria-checked", "false");
    }
    await page.getByRole("button", { name: /^Connect$/ }).click();

    // ── Step 4: Primary AI Models ────────────────────────────────
    await expect(page.getByTestId("setup-step-ai-models")).toBeVisible({ timeout: 30_000 });
    // Pick "OpenAI GPT" with a placeholder key: the configure route saves
    // the profile without validating the key. We overwrite with a real
    // provider in 80-chat's beforeAll if CLAWBOX_AI_API_KEY is set, so
    // this placeholder only has to flip ai_model_configured for the
    // wizard to advance. The ClawBox AI tile opens an owner-portal modal
    // rather than accepting a raw token, so it's not suitable as the
    // wizard-driven default.
    await page.getByText("OpenAI GPT").click();
    await page.locator("#ai-api-key").fill("sk-e2e-placeholder-key");
    await page.getByRole("button", { name: /Connect to OpenAI GPT/i }).click();

    // ── Step 5: Local AI ─────────────────────────────────────────
    await expect(page.getByTestId("setup-step-local-ai")).toBeVisible({ timeout: 30_000 });
    // llama-server / ollama aren't installed in test mode, so clicking
    // "Enable Gemma 4" would fail. Skip to the next step — local AI is
    // optional in production too.
    await page.getByRole("button", { name: /^Skip$/ }).click();

    // ── Step 6: Telegram ─────────────────────────────────────────
    const telegramStep = page.getByTestId("setup-step-telegram");
    await expect(telegramStep).toBeVisible({ timeout: 30_000 });
    if (env.TELEGRAM_BOT_TOKEN) {
      await page.locator('input[placeholder*="bot token" i], input[name*="token" i]')
        .first()
        .fill(env.TELEGRAM_BOT_TOKEN);
      await page.getByRole("button", { name: /Connect|Save/i }).click();
    } else {
      await page.getByRole("button", { name: /Skip for now/i }).click();
    }

    // ── Step 7: Completion overlay → desktop ─────────────────────
    // The completion overlay does a gateway health poll + redirects to
    // `/` once OpenClaw is reachable. The overlay may be skipped entirely
    // on fast paths, so we tolerate either: overlay visible, OR direct
    // navigation to the desktop.
    await page.waitForURL((url) => url.pathname === "/" || url.pathname === "/setup", {
      timeout: 2 * 60_000,
    });
    // If the wizard lingered on /setup, wait for the completion overlay
    // to clear. Otherwise we're already home.
    if (new URL(page.url()).pathname === "/setup") {
      await expect(page.getByTestId("setup-completion-overlay")).toBeVisible({ timeout: 10_000 });
      await page.waitForURL("/", { timeout: 60_000 });
    }

    // Confirm the shelf launcher renders on the desktop. ChromeShelf
    // includes a mobile-only + desktop-only variant with tailwind
    // responsive classes; filter to the visible one.
    await expect(
      page.locator('[data-testid="shelf-launcher-button"]').filter({ visible: true }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("setup is complete after the wizard", async () => {
    const status = await getStatus();
    expect(status.setup_complete).toBe(true);
    expect(status.wifi_configured).toBe(true);
    expect(status.password_configured).toBe(true);
    expect(status.ai_model_configured).toBe(true);
  });
});

// ── Env loader (shared with other specs; kept local to avoid a helper
//    import cycle when specs evolve independently) ─────────────────────

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

