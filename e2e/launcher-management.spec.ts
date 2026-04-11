import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

test("launcher search and context menus can pin apps and add desktop shortcuts", async ({ page }) => {
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
  const launcher = page.getByTestId("app-launcher");
  await launcher.getByPlaceholder("Search apps").fill("Browser");
  const browserButton = launcher.getByRole("button", { name: "Browser" });
  await expect(browserButton).toBeVisible();

  await browserButton.click({ button: "right", force: true });
  await page.getByRole("button", { name: /Pin to shelf/i }).click();
  await expect(page.getByTestId("shelf-app-browser")).toBeVisible();

  await browserButton.click({ button: "right", force: true });
  await page.getByRole("button", { name: /Add to desktop/i }).click();

  await page.mouse.click(20, 20);
  await expect(page.getByText("Browser").first()).toBeVisible();

  await page.getByTestId("shelf-app-browser").click({ button: "right" });
  await page.getByRole("button", { name: /Unpin from shelf/i }).click();
  await expect(page.getByTestId("shelf-app-browser")).toHaveCount(0);
});
