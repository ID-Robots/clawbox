import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

const READY_SETUP = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: true,
  telegram_configured: true,
};

test("every OpenClaw built-in exposed by Open in new tab has a standalone surface", async ({ page }) => {
  await installClawboxMocks(page, { initialSetup: READY_SETUP });

  for (const id of [
    "clawbox",
    "clawkeep",
    "system_update",
    "setup",
    "settings",
    "terminal",
    "coding",
    "files",
    "memory-shard",
    "prime-radiant",
    "store",
    "browser",
    "vnc",
    "openclaw",
  ]) {
    // On a box whose setup is finished the wizard has nothing to show: once it
    // has READ the setup state it sends the tab back to the desktop
    // (`window.location.href = "/"` in SetupWizard). That navigation is the
    // page's own, and it raced this test both ways. Early, it took the page
    // away before "Back to Desktop" was looked for. Late, it landed on top of
    // the next `goto` and aborted it — net::ERR_ABORTED at whichever id came
    // after `setup`. So the setup state is held back until the surface has
    // been seen, and the wizard's own navigation is let land before the next
    // one starts.
    const leavesByItself = id === "setup";
    let showSetupState = () => {};
    if (leavesByItself) {
      const surfaceSeen = new Promise<void>((resolve) => { showSetupState = resolve; });
      await page.route("**/setup-api/setup/status", async (route) => {
        await surfaceSeen;
        await route.fallback();
      });
    }

    await page.goto(`/app/${id}`);
    await expect(page.getByText(`App not found: ${id}`), `${id} should render standalone`).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to Desktop" })).toBeVisible();

    if (leavesByItself) {
      showSetupState();
      await page.waitForURL((url) => !url.pathname.startsWith(`/app/${id}`));
      await page.unroute("**/setup-api/setup/status");
    }
  }
});
