import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

test("installed app settings can save configuration and toggle enablement", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
    storeApps: [
      {
        name: "Home Assistant",
        slug: "home-assistant",
        summary: "Control your Home Assistant instance from ClawBox.",
        category: "smart-home",
        rating: 4.9,
        installs: "20K",
        developer: "ClawBox Labs",
        version: "3.2.1",
        url: "https://openclawhardware.dev/store/apps/home-assistant",
        tags: ["home", "automation"],
      },
    ],
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await page.getByTestId("shelf-app-store").click();
  const storeWindow = page.getByTestId("chrome-window-store");
  await storeWindow.getByRole("heading", { name: "Home Assistant" }).click();
  await storeWindow.getByRole("button", { name: "Install" }).click();
  await page.getByRole("button", { name: "Install Anyway" }).click();
  await expect(storeWindow.getByText("Installed").first()).toBeVisible();

  await openLauncher(page);
  await page.getByTestId("app-launcher").getByPlaceholder("Search apps").fill("Home Assistant");
  await page.getByTestId("app-launcher").getByRole("button", { name: "Home Assistant" }).click({ force: true });

  const settingsWindow = page.getByTestId("chrome-window-installed-home-assistant");
  await expect(settingsWindow).toBeVisible();

  await settingsWindow.getByPlaceholder("http://homeassistant.local:8123").fill("http://ha.local:8123");
  await settingsWindow.getByPlaceholder("Enter HA access token").fill("ha-secret-token");
  await settingsWindow.getByRole("switch", { name: "Enable Webhooks" }).click({ force: true });
  await settingsWindow.getByRole("button", { name: "Save Settings" }).click();
  await expect(settingsWindow.getByText("Home Assistant URL")).toBeVisible();
});
