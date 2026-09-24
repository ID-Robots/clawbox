import { test } from "@playwright/test";
import { installClawboxMocks } from "../e2e/helpers/clawbox";
test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
test("diag", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", m => logs.push(`[${m.type()}] ${m.text()}`.slice(0, 300)));
  page.on("pageerror", e => logs.push(`[pageerror] ${e.message}`.slice(0, 300)));
  page.on("requestfailed", r => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`.slice(0, 300)));
  await installClawboxMocks(page, {
    timeoutCapMs: 300_000,
    chatFacts: { hasClawaiToken: true, onboardingArmed: false },
    initialSetup: { setup_complete: true, wifi_configured: true, update_completed: true, password_configured: true, ai_model_configured: true, telegram_configured: true },
    preferences: { desktop_apps: ["clawbox", "files", "settings"], wp_id: "clawbox" },
  });
  await page.goto("/");
  await page.waitForTimeout(25_000);
  await page.screenshot({ path: `${process.env.CLAWBOX_RUN_ARTIFACTS_DIR}/diag.png` });
  console.log(logs.slice(0, 40).join("\n"));
  console.log("URL", page.url());
  console.log((await page.content()).slice(0, 600));
});
