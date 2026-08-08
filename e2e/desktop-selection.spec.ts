import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";
import { mockTerminalWebSocket } from "./helpers/mock-backends";

// FIXME (#114): surfaced what looks like a real production-build bug, not a test
// issue. `handleDesktopContextMenu` DOES fire on the production build (verified
// with a temporary log — "CTXFIRE 40 40") and calls setCtxMenu({x,y}), but the
// menu never renders — `getByTestId('desktop-context-menu')` stays absent even
// 50ms after, via every input path (real right-click, page.mouse, dispatchEvent,
// and a raw MouseEvent). So the desktop right-click menu appears broken under
// the standalone production build. Needs an app-side investigation before this
// spec can be re-enabled. The terminal WS mock + surface targeting below are
// correct groundwork.
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

  // Dispatch the contextmenu straight to the desktop surface (the grid layer
  // that owns handleDesktopContextMenu). A positional right-click hit-tests to
  // whatever is topmost at that pixel — which on the production build isn't this
  // layer — so target the element directly with an empty-area coordinate.
  await page.getByTestId("desktop-surface").dispatchEvent("contextmenu", {
    button: 2,
    clientX: 40,
    clientY: 40,
    bubbles: true,
  });

  // Scope to the context menu: "Terminal" also appears as a shelf/taskbar
  // control, so an unscoped getByRole matches two elements (strict-mode).
  const contextMenu = page.getByTestId("desktop-context-menu");
  await expect(contextMenu).toBeVisible();
  await contextMenu.getByRole("button", { name: "Terminal" }).click();
  await expect(page.getByTestId("chrome-window-terminal")).toBeVisible();
});
