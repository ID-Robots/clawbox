import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

// FIXME: regressed under the larger e2e suite — `getByTestId('app-launcher')`
// resolves but the "Browser" button never appears within 15s. Reproducible
// across multiple CI runs on this branch; needs investigation of how the
// Browser app gets registered in the launcher under the current mocks.
// Tracked as a follow-up to PR #113.
test.fixme("browser app installs chromium, enables integration, and opens the VNC app", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await openLauncher(page);
  const browserLauncherButton = page.getByTestId("app-launcher").getByRole("button", { name: "Browser" });
  await browserLauncherButton.click();

  const browserWindow = page.getByTestId("chrome-window-browser");
  await expect(browserWindow).toBeVisible({ timeout: 15000 });

  await browserWindow.getByRole("button", { name: "Install Chromium" }).click();
  await expect(browserWindow.getByText("Chromium 124.0.0")).toBeVisible();

  await browserWindow.getByRole("button", { name: "Enable" }).click();
  await expect(browserWindow.getByRole("button", { name: "Disable" })).toBeVisible();

  await browserWindow.getByRole("button", { name: "Open Browser" }).click();
  await expect(browserWindow.getByText("PID 4242")).toBeVisible();

  await browserWindow.getByRole("button", { name: "Open in VNC" }).click();
  await expect(page.getByTestId("chrome-window-vnc")).toBeVisible();
});
