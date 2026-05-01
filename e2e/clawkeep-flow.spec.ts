import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

// FIXME: this test references a redesigned ClawKeep UI ("Back up one
// folder", local/cloud/both toggle, "clawkeep-app" testid) that hasn't
// landed in HEAD yet. Re-enable once src/components/ClawKeepApp.tsx
// gains those affordances.
test.fixme("clawkeep keeps backup setup to one simple local flow", async ({ page }) => {
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
      ff_clawkeep_enabled: 1,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await openLauncher(page);
  await page.getByTestId("app-launcher").getByRole("button", { name: "ClawKeep" }).click();

  const clawKeepWindow = page.getByTestId("chrome-window-clawkeep");
  await expect(clawKeepWindow).toBeVisible();
  await expect(page.getByTestId("clawkeep-app")).toBeVisible();
  await expect(clawKeepWindow.getByRole("heading", { name: "Back up one folder" })).toBeVisible();

  await clawKeepWindow.getByPlaceholder("At least 8 characters").fill("super-secret");
  await clawKeepWindow.getByRole("button", { name: "Turn on backup" }).click();

  await expect(clawKeepWindow.getByText("Backup complete")).toBeVisible();
  await expect(clawKeepWindow.getByRole("button", { name: "Back up now" })).toBeVisible();
  await expect(clawKeepWindow.getByRole("button", { name: "This device" })).toHaveAttribute("aria-pressed", "true");
});

// FIXME: same ClawKeep redesign — see note above.
test.fixme("clawkeep keeps cloud setup lightweight and easy to scan", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: false,
      telegram_configured: true,
    },
    preferences: {
      ff_clawkeep_enabled: 1,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await openLauncher(page);
  await page.getByTestId("app-launcher").getByRole("button", { name: "ClawKeep" }).click();

  const clawKeepWindow = page.getByTestId("chrome-window-clawkeep");
  await expect(clawKeepWindow.getByRole("heading", { name: "Back up one folder" })).toBeVisible();

  await clawKeepWindow.getByRole("button", { name: "Cloud" }).click();
  await expect(clawKeepWindow.getByText("Connect ClawBox AI first.")).toBeVisible();
  await expect(clawKeepWindow.getByRole("button", { name: "Connect ClawBox AI" })).toBeVisible();

  await clawKeepWindow.getByRole("button", { name: "Both" }).click();
  await expect(clawKeepWindow.getByRole("button", { name: "Both" })).toHaveAttribute("aria-pressed", "true");
  await expect(clawKeepWindow.getByPlaceholder("Backups/clawkeep")).toBeVisible();

  await clawKeepWindow.getByRole("button", { name: "Browse" }).first().click();
  await expect(page.getByRole("dialog", { name: "Choose the folder you want to protect" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: "Choose the folder you want to protect" })).toBeHidden();

  await clawKeepWindow.getByRole("button", { name: "Browse" }).nth(1).click();
  await expect(page.getByRole("dialog", { name: "Choose where local backup copies should live" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: "Choose where local backup copies should live" })).toBeHidden();
});
