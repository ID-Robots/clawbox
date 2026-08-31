import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

const COMPLETE_SETUP = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: true,
  telegram_configured: true,
};

test("store supports searching, viewing details, and installing an app", async ({ page }) => {
  await installClawboxMocks(page, { initialSetup: COMPLETE_SETUP });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await page.getByTestId("shelf-app-store").click();
  const storeWindow = page.getByTestId("chrome-window-store");
  await expect(storeWindow).toBeVisible();
  await expect(storeWindow.getByTestId("app-store")).toBeVisible();

  await storeWindow.getByPlaceholder("Search apps").fill("Weather");
  await expect(storeWindow.getByText("Weather Deck")).toBeVisible();
  await storeWindow.getByText("Weather Deck").click();

  await expect(storeWindow.getByText("Forecast cards and travel alerts tuned for the desktop shell.")).toBeVisible();
  await storeWindow.getByRole("button", { name: "Install" }).click();
  await page.getByRole("button", { name: "Install skill" }).click();

  await expect(storeWindow.getByText("Installed").first()).toBeVisible();
  await storeWindow.getByRole("button", { name: "arrow_back" }).click();
  await storeWindow.getByRole("button", { name: "Installed" }).click();
  await expect(storeWindow.getByText("Weather Deck")).toBeVisible();

  // A store skill's desktop icon: its window is its settings, so the context
  // menu offers no "Open in new tab" (that used to open an empty 404 frame),
  // and Uninstall raises a real dialog — role, focus on Cancel, Escape closes.
  // The freshly-installed icon animates in, so the events go straight to it.
  const icon = page.locator('[data-desktop-icon-id="weather-deck"] button');
  await expect(icon).toBeVisible();
  await icon.dispatchEvent("contextmenu");
  const menu = page.getByTestId("desktop-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button", { name: /Open in new tab/i })).toHaveCount(0);
  await menu.getByRole("button", { name: /Uninstall/i }).click();

  const dialog = page.getByRole("dialog", { name: /Uninstall Weather Deck\?/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-desktop-icon-id="weather-deck"]')).toBeVisible();
});

// A store API failure is its own state — the error panel with Retry, never
// "No apps found" — and Retry recovers once the store is reachable again.
test("an unreachable store shows the error panel, and Retry recovers", async ({ page }) => {
  await installClawboxMocks(page, { initialSetup: COMPLETE_SETUP });
  // Registered after the mocks, so it wins (Playwright routes are LIFO).
  await page.route("**/setup-api/apps/store**", (route) => route.fulfill({ status: 502, body: "Bad Gateway" }));

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await page.getByTestId("shelf-app-store").click();
  const storeWindow = page.getByTestId("chrome-window-store");
  await expect(storeWindow.getByText("Couldn't reach the ClawBox Store. Check the internet connection and try again.")).toBeVisible();
  const retry = storeWindow.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();

  await page.unroute("**/setup-api/apps/store**");
  await retry.click();
  await expect(storeWindow.getByText("Weather Deck")).toBeVisible();
});

// The frame a webapp runs in must never carry allow-same-origin: the app is
// HTML the agent wrote, and with the desktop's origin it ran with the owner's
// session. The standalone /app route had this right; the desktop did not.
test("a webapp opened from the desktop never runs in the desktop's origin", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: COMPLETE_SETUP,
    preferences: {
      installed_apps: ["notes"],
      installed_meta: { notes: { name: "Notes", color: "#f97316", iconUrl: "", webappUrl: "/setup-api/webapps?app=notes" } },
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  const icon = page.locator('[data-desktop-icon-id="notes"] button');
  await expect(icon).toBeVisible();
  await icon.dispatchEvent("click");

  const frame = page.getByTestId("chrome-window-installed-notes").locator("iframe");
  await expect(frame).toHaveAttribute("data-webapp-id", "notes");
  const sandbox = await frame.getAttribute("sandbox");
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");

  // A webapp keeps "Open in new tab"; only skills lose it.
  await icon.dispatchEvent("contextmenu");
  const menu = page.getByTestId("desktop-context-menu");
  await expect(menu.getByRole("button", { name: /Open in new tab/i })).toBeVisible();
});
