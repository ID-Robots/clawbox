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

  // An entry in the folder listing, by its exact name. The page also says
  // "Projects" elsewhere — the Files sidebar's Projects heading and the
  // desktop's Projects icon — so a bare getByText is ambiguous.
  const entry = (name: string) =>
    filesWindow.locator('[data-testid="files-grid"], [data-testid="files-list"]').getByText(name, { exact: true });

  await filesWindow.getByRole("button", { name: "New Folder" }).click();
  await page.getByRole("textbox").fill("Projects");
  await page.getByRole("button", { name: "OK" }).click();
  await expect(entry("Projects")).toBeVisible();

  await filesWindow.getByRole("button", { name: "Switch to list" }).click();
  await filesWindow.getByRole("button", { name: "Switch to grid" }).click();

  await entry("Projects").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox").fill("Projects 2026");
  await page.getByRole("button", { name: "OK" }).click();
  await expect(entry("Projects 2026")).toBeVisible();

  await entry("Projects 2026").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(entry("Projects 2026")).toHaveCount(0);
});
