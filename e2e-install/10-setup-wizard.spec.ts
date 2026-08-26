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
import { getStatus, getStatusAuthed } from "./helpers/setup-api";

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

    // ── Step 1: WiFi / Ethernet ──────────────────────────────────
    await expect(page.getByTestId("setup-step-wifi")).toBeVisible({ timeout: 30_000 });

    // CLAWBOX_TEST_MODE reports Ethernet connected (getEthernetStatus), so take
    // the Ethernet-first happy path: "Continue with Ethernet" advances the
    // wizard in-page. The WiFi path tears down the hotspot and redirects to the
    // box's new home-network address — untestable in a container (no real box
    // to probe), tracked in #167.
    await page.getByRole("button", { name: /Continue with Ethernet/i }).click();

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

    // Connect no longer saves: the system password this step sets is
    // write-only afterwards, so the wizard reads it back and waits for a
    // deliberate acknowledgement first (CredentialsWriteDownDialog.tsx).
    // The hotspot is off above, so only the system password is on the card.
    const writeDown = page.getByTestId("credentials-writedown-dialog");
    await expect(writeDown).toBeVisible({ timeout: 15_000 });
    await expect(writeDown.getByTestId("writedown-system-value")).toHaveText("clawbox-e2e-pass");
    await expect(writeDown.getByTestId("writedown-hotspot-value")).toHaveCount(0);
    await writeDown.getByTestId("writedown-ack").check();
    await writeDown.getByTestId("writedown-continue").click();

    // ── Step 4: Primary AI Models ────────────────────────────────
    // Credentials step Connects by posting to
    // /setup-api/system/credentials (which spawns the chpasswd systemd
    // unit; cold start is slow) + /setup-api/system/hotspot. 60s covers
    // both on a container whose chpasswd service hasn't been hit before.
    await expect(page.getByTestId("setup-step-ai-models")).toBeVisible({ timeout: 90_000 });
    // Pick "OpenAI GPT" with a placeholder key: the configure route saves
    // the profile without validating the key. 80-chat's beforeAll swaps
    // in the real CLAWBOX_AI_API_KEY later, so this placeholder only has
    // to flip ai_model_configured for the wizard to advance. The ClawBox
    // AI tile opens an owner-portal modal rather than accepting a raw
    // token, so it's not usable for fully-automated wizard flow.
    // The provider list opens on whichever provider is in play (ClawBox AI by
    // default) and keeps the rest behind its "more providers" toggle, so open
    // it before reaching for OpenAI.
    //
    // Both async beats have to land before the toggle can be counted, and on a
    // real device they land slower than anywhere else: the edition resolves
    // (until then the step's testid sits on a skeleton that renders no
    // radiogroup), and then the provider in play lands, which is what collapses
    // the list onto one row. Counting in between reads an uncollapsed list,
    // skips the expansion, and the list then collapses over the row we came
    // for. The checked radio is the second beat's signal.
    const aiStep = page.getByTestId("setup-step-ai-models");
    const providerGroup = aiStep.getByRole("radiogroup", { name: "AI Provider" });
    await expect(providerGroup).toBeVisible();
    await expect(providerGroup.locator("input[type=radio]:checked")).toHaveCount(1);
    const moreProviders = providerGroup.getByRole("button", { name: /more provider/i });
    if (await moreProviders.count() > 0) {
      await moreProviders.first().click();
      await expect(moreProviders).toHaveCount(0);
    }
    await page.getByText("OpenAI GPT").click();
    // OpenAI defaults to the "Subscription" tab (ChatGPT Plus / Pro OAuth).
    // We need the "API Key" tab for the plain-token path.
    await page.getByRole("button", { name: /^API Key$/ }).click();
    await expect(page.locator("#ai-api-key")).toBeVisible({ timeout: 5_000 });
    await page.locator("#ai-api-key").fill("sk-e2e-placeholder-key");
    await page.getByRole("button", { name: /Connect to OpenAI GPT/i }).click();

    // ── Step 5: (Local AI removed — owners reach it via Settings → Local AI
    //   on demand. AIModelsStep still shows a multi-phase "Setting up OpenAI
    //   GPT" overlay before the wizard advances to Telegram, animating at
    //   0/2/5/12/22s + a gateway readiness poll. Budget 2 min for the
    //   overlay even on slow runners.) ───────────────────────────────
    const telegramStep = page.getByTestId("setup-step-telegram");
    await expect(telegramStep).toBeVisible({ timeout: 120_000 });
    if (env.TELEGRAM_BOT_TOKEN) {
      await page.getByRole("textbox", { name: /Bot Token/i })
        .fill(env.TELEGRAM_BOT_TOKEN);
      await page.getByRole("button", { name: /Connect|Save/i }).click();
    } else {
      await page.getByRole("button", { name: /Skip for now/i }).click();
    }

    // ── Step 7: Completion overlay → desktop ─────────────────────
    // The wizard's final step posts to /setup-api/setup/complete which
    // sets the session cookie + redirects to `/`. The completion overlay
    // is a transient intermediate state — may flash by too quickly to
    // assert on — so we just wait for the URL to land on `/`.
    await page.waitForURL("/", { timeout: 2 * 60_000 });

    // Confirm the shelf launcher renders on the desktop. ChromeShelf
    // includes a mobile-only + desktop-only variant with tailwind
    // responsive classes; filter to the visible one.
    await expect(
      page.locator('[data-testid="shelf-launcher-button"]').filter({ visible: true }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("setup is complete after the wizard", async () => {
    // The wizard's progress flags are public — /login reads them with no
    // session to decide whether to bounce an unfinished setup to /setup.
    const status = await getStatus();
    expect(status.setup_complete).toBe(true);
    expect(status.wifi_configured).toBe(true);
    expect(status.password_configured).toBe(true);

    // Which provider the box got wired to is NOT public, so ask the way the
    // desktop asks: with a session.
    const authed = await getStatusAuthed();
    expect(authed.ai_model_configured).toBe(true);
  });

  test("setup status does not leak provider detail to an anonymous caller", async () => {
    // /setup-api/setup/status is public by design and is also served through
    // the cloudflared tunnel, so whatever it returns unauthenticated is
    // readable by anyone holding that URL. It must carry the wizard's progress
    // and nothing else. The wizard above configured OpenAI, so if the trim
    // regressed, `ai_model_provider` is sitting right here. TASK-446.
    const anonymous = (await getStatus()) as unknown as Record<string, unknown>;

    for (const field of [
      "local_ai_configured",
      "local_ai_provider",
      "local_ai_model",
      "ai_model_configured",
      "ai_model_provider",
      "telegram_configured",
    ]) {
      expect(anonymous, `${field} must not be readable without a session`).not.toHaveProperty(field);
    }
    expect(JSON.stringify(anonymous)).not.toContain("openai");

    // ...and the same box does hand all of it back once you authenticate, so
    // this is a gate, not a removed feature.
    const authed = await getStatusAuthed();
    expect(authed.ai_model_configured).toBe(true);
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

