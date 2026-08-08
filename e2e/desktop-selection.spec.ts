import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// FIXME: the "Terminal" locator is now scoped correctly (via the
// desktop-context-menu testid), but launching the terminal still fails against
// the bare standalone e2e server — it lacks the /terminal-ws proxy that
// production-server.js provides, so the terminal app can't come up. Closing
// this needs the e2e server to expose the interactive backends. Tracked in #114.
test.fixme("desktop background context menu can launch the terminal", async ({ page }) => {
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
      ui_mascot_hidden: 0,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  // Scope to the context menu: "Terminal" also appears as a shelf/taskbar
  // control, so an unscoped getByRole matched two elements (strict-mode
  // violation) once both mounted under the production build. Retry the whole
  // right-click -> Terminal gesture until the window opens: the menu item's
  // onClick fires only once its client island has hydrated, and each pre-
  // hydration attempt is a no-op (opening a fresh menu, never a window).
  const terminalWindow = page.getByTestId("chrome-window-terminal");
  await expect(async () => {
    if (!(await terminalWindow.isVisible())) {
      await page.getByTestId("desktop-root").click({ button: "right", position: { x: 40, y: 40 } });
      const contextMenu = page.getByTestId("desktop-context-menu");
      await expect(contextMenu).toBeVisible({ timeout: 2000 });
      await contextMenu.getByRole("button", { name: "Terminal" }).click();
    }
    await expect(terminalWindow).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000, intervals: [500, 500, 1000] });
});
