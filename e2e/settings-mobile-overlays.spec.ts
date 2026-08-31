import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("mobile Settings renders account and password confirmation overlays", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: false,
      telegram_configured: false,
    },
  });

  await page.goto("/app/settings");
  await page.getByRole("button", { name: /Remote Control/ }).click();
  await expect(page.getByRole("dialog", { name: "Sign in to use Remote Control" })).toBeVisible();
  await page.getByRole("button", { name: "Maybe later" }).click();

  await page.getByRole("button", { name: /System/ }).click();
  await page.getByPlaceholder("Current password").fill("existing-password");
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByRole("textbox", { name: "New password", exact: true }).fill("new-password-123");
  await page.getByRole("textbox", { name: "Confirm new password", exact: true }).fill("new-password-123");
  await page.getByRole("button", { name: "Update password" }).click();

  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByRole("alertdialog")).toContainText("New password");
});
