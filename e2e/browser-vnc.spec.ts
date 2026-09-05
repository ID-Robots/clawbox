import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";

test("browser app walks its setup once, then shows the device's screen", async ({ page }) => {
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
  // The launcher paginates its apps; "Browser" sits past the first page. Search
  // to filter it onto the current page instead of relying on page order.
  const launcher = page.getByTestId("app-launcher");
  await launcher.getByRole("textbox").fill("Browser");
  const browserLauncherButton = launcher.getByRole("button", { name: "Browser" });
  await browserLauncherButton.click();

  const browserWindow = page.getByTestId("chrome-window-browser");
  await expect(browserWindow).toBeVisible({ timeout: 15000 });

  // A box that has never been set up gets the wizard, not the browser screen.
  await expect(browserWindow.getByTestId("browser-wizard")).toBeVisible();
  await browserWindow.getByTestId("browser-wizard-start").click();

  await browserWindow.getByTestId("browser-wizard-install").click();
  await expect(browserWindow.getByText("Chromium 124.0.0")).toBeVisible();
  await browserWindow.getByTestId("browser-wizard-next").click();

  await browserWindow.getByTestId("browser-wizard-link").click();
  await browserWindow.getByTestId("browser-wizard-next-open").click();

  // Opening it IS finishing: the wizard hands the owner straight to the screen.
  await browserWindow.getByTestId("browser-wizard-open").click();
  await expect(browserWindow.getByTestId("browser-state")).toContainText("4242");
  await expect(browserWindow.getByTestId("browser-wizard")).toBeHidden();

  // The screen also has a window of its own, for a second monitor.
  // One header holds every control: the state, Close, Paste to VNC, Open in
  // VNC and Settings — and the title bar that used to sit above it is gone.
  const header = browserWindow.getByTestId("browser-header");
  for (const id of ["browser-state", "browser-close", "browser-paste", "browser-open-vnc", "browser-open-settings"]) {
    await expect(header.getByTestId(id)).toBeVisible();
  }
  await expect(browserWindow.getByRole("heading", { name: "Browser Integration" })).toHaveCount(0);
  await browserWindow.getByTestId("browser-paste").click();
  await expect(browserWindow.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(browserWindow.getByRole("dialog")).toHaveCount(0);
  await browserWindow.getByTestId("browser-open-vnc").click();
  await expect(page.getByTestId("chrome-window-vnc")).toBeVisible();
});

test("the browser settings are reachable from inside the app", async ({ page }) => {
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

  await page.goto("/app/browser");

  const wizard = page.getByTestId("browser-wizard");
  await expect(wizard).toBeVisible({ timeout: 15000 });
  // "Not now" finishes setup without touching the device — nobody is trapped
  // in a front door.
  await page.getByTestId("browser-wizard-skip").click();

  await page.getByTestId("browser-open-settings").click();
  await expect(page.getByTestId("browser-settings-panel")).toBeVisible();

  await page.getByTestId("browser-settings-start-url").fill("https://example.com/");
  await page.getByTestId("browser-settings-start-url-save").click();
  await expect(page.getByTestId("browser-settings-start-url")).toHaveValue("https://example.com/");

  await page.getByTestId("browser-settings-back").click();
  await expect(page.getByTestId("browser-state")).toBeVisible();
});
