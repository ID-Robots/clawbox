import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

test("browser app installs chromium, enables integration, and opens the VNC app", async ({ page }) => {
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
  // The launcher paginates its apps; "Browser" sits past the first page. Search
  // to filter it onto the current page instead of relying on page order.
  const launcher = page.getByTestId("app-launcher");
  await launcher.getByRole("textbox").fill("Browser");
  const browserLauncherButton = launcher.getByRole("button", { name: "Browser" });
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
