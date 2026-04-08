import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("files app supports creating, renaming, and deleting folders", async ({ page }) => {
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

  await page.getByTestId("shelf-app-files").click();
  const filesWindow = page.getByTestId("chrome-window-files");
  await expect(filesWindow).toBeVisible();
  await expect(page.getByTestId("files-app")).toBeVisible();

  await filesWindow.getByRole("button", { name: "New Folder" }).click();
  await page.getByRole("textbox").fill("Projects");
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.getByText("Projects")).toBeVisible();

  await filesWindow.getByRole("button", { name: "Switch to list" }).click();
  await filesWindow.getByRole("button", { name: "Switch to grid" }).click();

  await page.getByText("Projects").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox").fill("Projects 2026");
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.getByText("Projects 2026")).toBeVisible();

  await page.getByText("Projects 2026").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Projects 2026")).toHaveCount(0);
});
