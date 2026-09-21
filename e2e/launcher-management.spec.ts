import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

const COMPLETE_SETUP = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: true,
  telegram_configured: true,
};

test("launcher search and context menus can pin apps and add desktop shortcuts", async ({ page }) => {
  await installClawboxMocks(page, { initialSetup: COMPLETE_SETUP });

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

// The launcher names an installed app `installed-<id>`, while "Remove from
// desktop" stores the raw id in hidden_installed. "Add to desktop" used to
// filter for the prefixed id (un-hiding nothing) and push it into
// desktop_apps, the built-in shortcut list, where it drew an empty grid slot.
test("launcher 'Add to desktop' brings back an installed app hidden from the desktop", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: COMPLETE_SETUP,
    preferences: {
      installed_apps: ["notes"],
      installed_meta: { notes: { name: "Notes", color: "#f97316", iconUrl: "", webappUrl: "/setup-api/webapps?app=notes" } },
      hidden_installed: ["notes"],
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  const icon = page.locator('[data-desktop-icon-id="notes"]');
  await expect(icon).toHaveCount(0);

  await openLauncher(page);
  const launcher = page.getByTestId("app-launcher");
  await launcher.getByPlaceholder("Search apps").fill("Notes");
  const entry = launcher.getByRole("button", { name: "Notes" });
  await expect(entry).toBeVisible();
  await entry.click({ button: "right", force: true });
  await page.getByRole("button", { name: /Add to desktop/i }).click();
  await page.mouse.click(20, 20);

  await expect(icon).toBeVisible();
  const readPrefs = () =>
    page.evaluate(async () => {
      const res = await fetch("/setup-api/preferences?keys=hidden_installed,desktop_apps");
      return (await res.json()) as { hidden_installed: string[]; desktop_apps: string[] };
    });
  // The write is debounced; the un-hide reaches the store within a second.
  await expect.poll(async () => (await readPrefs()).hidden_installed).toEqual([]);
  expect((await readPrefs()).desktop_apps).not.toContain("installed-notes");
});
