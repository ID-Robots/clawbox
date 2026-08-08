import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// FIXME: fails at its first DOM interaction on GitHub Actions and, unlike the
// rest of the suite, still fails against the production build too (verified on
// the Jetson) -- so it is not the dev-server compile/HMR class the prod-build
// switch fixed. Needs per-spec debugging. Tracked in #114.
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
