import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

// FIXME: the global-setup warmup (#114) removed the cold-compile flake, but
// this spec still times out on GitHub Actions at its first DOM interaction — a
// deeper post-mount/hydration lag under `bun run dev` workers:1 that the warmup
// doesn't touch. Passes on the Jetson; still tracked in #114.
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
