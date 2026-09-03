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

  // "System" and not "System Update": the row's name also carries the icon glyph,
  // the status subtitle and the chevron, so an exact match never lands.
  await page.getByRole("button", { name: /\bSystem\b(?! Update)/ }).click();
  await page.getByPlaceholder("Current password").fill("existing-password");
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByRole("textbox", { name: "New password", exact: true }).fill("new-password-123");
  await page.getByRole("textbox", { name: "Confirm new password", exact: true }).fill("new-password-123");
  const updatePassword = page.getByRole("button", { name: "Update password" });
  await updatePassword.click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("New password");

  const reveal = dialog.getByRole("button", { name: "Reveal password" });
  const confirm = dialog.getByRole("button", { name: "I’ve written it down — change" });
  await expect(reveal).toBeFocused();
  await reveal.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await confirm.press("Tab");
  await expect(reveal).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(updatePassword).toBeFocused();
});
