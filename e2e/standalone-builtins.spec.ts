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
    "store",
    "browser",
    "vnc",
    "openclaw",
  ]) {
    await page.goto(`/app/${id}`);
    await expect(page.getByText(`App not found: ${id}`), `${id} should render standalone`).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to Desktop" })).toBeVisible();
  }
});
