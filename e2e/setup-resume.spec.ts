import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("setup resumes on the ai models step for partially configured devices", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    },
  });

  await page.goto("/setup");

  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();

  await page.reload();

  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();
});
