import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// FIXME: regressed under the larger e2e suite. Right-click context menu
// reliably mounts on small suites but times out finding the "Terminal"
// option under the new test load. Needs investigation; tracked as a
// follow-up to PR #113.
test.fixme("desktop background context menu can launch the terminal", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
    preferences: {
      ui_mascot_hidden: 0,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await page.getByTestId("desktop-root").click({ button: "right", position: { x: 40, y: 40 } });
  await page.getByRole("button", { name: "Terminal" }).click();
  await expect(page.getByTestId("chrome-window-terminal")).toBeVisible();
});
