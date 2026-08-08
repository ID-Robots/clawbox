import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openLauncher } from "./helpers/clawbox";
import { mockTerminalWebSocket } from "./helpers/mock-backends";

test("terminal can open and connect to the websocket backend", async ({ page }) => {
  // Fake the /terminal-ws handshake in-browser — CI and the standalone e2e
  // server have no PTY backend behind that proxy. See helpers/mock-backends.
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

  await openLauncher(page);
  const terminalButton = page.getByTestId("app-launcher").getByRole("button", { name: "Terminal" });
  await terminalButton.focus();
  await terminalButton.press("Enter");

  const terminalWindow = page.getByTestId("chrome-window-terminal");
  await expect(terminalWindow).toBeVisible();
  await expect(terminalWindow.locator(".xterm")).toBeVisible();
  await expect(terminalWindow.getByRole("button", { name: "Reconnect" })).toHaveCount(0);
});
