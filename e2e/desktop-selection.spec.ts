import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";
import { mockTerminalWebSocket } from "./helpers/mock-backends";

// FIXME (#114): two compounding prod-build issues remain beyond the locator fix
// (which is done — the "Terminal" match is scoped to the desktop-context-menu
// testid). 1) The right-click at (40,40) does not open the desktop context menu
// on the production build — desktop-root's own onContextMenu only
// preventDefault()s; the menu is opened by an inner grid layer, and the corner
// position isn't reaching it (a layout/hit-testing difference from dev).
// 2) The terminal also needs its /terminal-ws handshake mocked (mockTerminalWebSocket,
// wired below). Needs a reliable empty-desktop right-click target before it can
// be re-enabled.
test.fixme("desktop background context menu can launch the terminal", async ({ page }) => {
  // The terminal app connects to /terminal-ws, which only production-server.js
  // proxies — not the standalone e2e server or a CI runner. Fake the handshake
  // in-browser (same as terminal-reconnect) so the window mounts and stays up.
  await mockTerminalWebSocket(page);

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
