import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";
import { mockTerminalWebSocket } from "./helpers/mock-backends";

test("desktop background context menu can launch the terminal", async ({ page }) => {
  // The terminal app connects to /terminal-ws, which only production-server.js
  // proxies — not the standalone e2e server. Fake the handshake in-browser so
  // the launched terminal window mounts and stays up.
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
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  // Dispatch the contextmenu straight to the desktop surface — the grid layer
  // that owns handleDesktopContextMenu. A positional right-click hit-tests to
  // whatever overlay is topmost at that pixel, which isn't this layer.
  await page.getByTestId("desktop-surface").dispatchEvent("contextmenu", {
    button: 2,
    clientX: 200,
    clientY: 400,
    bubbles: true,
  });

  // Scope "Terminal" to the context menu — it also appears as a shelf control.
  const menu = page.getByTestId("desktop-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: "Terminal" }).click();
  await expect(page.getByTestId("chrome-window-terminal")).toBeVisible();
});
