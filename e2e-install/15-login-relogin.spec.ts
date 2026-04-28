/**
 * Login flow — once setup completes, the session cookie is the only thing
 * keeping a tab on the desktop. This spec verifies:
 *
 *   1. Cleared cookie → / redirects to /login
 *   2. Submitting the password set during setup mints a fresh session
 *   3. The new session can hit the desktop without re-redirecting
 *
 * Runs at NN=15 so it executes right after the setup wizard while the
 * password is fresh in our memory but before later specs change state.
 */
import { test, expect } from "@playwright/test";
import { BASE_URL } from "./helpers/container";
import { getStatus } from "./helpers/setup-api";

// Same password the wizard sets in 10-setup-wizard.spec.ts.
const SETUP_PASSWORD = "clawbox-e2e-pass";

test.describe("login round-trip", () => {
  test.beforeAll(async () => {
    const status = await getStatus();
    test.skip(
      !status.setup_complete,
      "setup did not complete — cannot log in until 10-setup-wizard runs",
    );
  });

  test("clearing cookies sends / → /login then back to /", async ({
    browser,
  }) => {
    // Brand-new context = no inherited cookies.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Step 1: anonymous request to the desktop should be redirected.
    const homeResponse = await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    expect(homeResponse, "no response from /").not.toBeNull();
    expect(page.url()).toMatch(/\/login/);

    // Step 2: submit the password.
    await page.fill('input[type="password"]', SETUP_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/login"), {
        timeout: 15_000,
      }),
      page.click('button[type="submit"]'),
    ]);

    // Step 3: /me path should now serve the desktop, not redirect.
    const desktopResponse = await page.goto(BASE_URL, {
      waitUntil: "domcontentloaded",
    });
    expect(desktopResponse?.status(), "desktop fetch should be 200").toBe(200);
    expect(page.url()).not.toMatch(/\/login/);

    await ctx.close();
  });

  test("wrong password is rejected without minting a session", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="password"]', "definitely-not-the-password");
    await page.click('button[type="submit"]');

    // Either the page stays on /login or it surfaces an error message.
    // We give it a short window to potentially redirect (which it shouldn't).
    await page.waitForTimeout(2_000);
    expect(page.url()).toMatch(/\/login/);
    await ctx.close();
  });
});
