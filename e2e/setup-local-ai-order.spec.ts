import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("setup skips the Local AI step and goes straight from AI provider to Telegram", async ({ page }) => {
  // The Local AI step was deliberately removed from the initial setup
  // wizard (see SetupWizard.tsx — owners now reach Gemma/Ollama via
  // Settings → Local AI on demand). This test guards that decision so a
  // re-introduction would have to update the test along with the wizard.
  await installClawboxMocks(page);

  await page.goto("/setup");

  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
  await page.getByRole("button", { name: "Connect to WiFi" }).click();
  await page.getByRole("button", { name: "Clawbox Lab" }).click();
  await page.locator("#wifi-password").fill("wireless-pass");
  await page.getByRole("button", { name: "Connect" }).click();

  await expect(page.getByTestId("setup-step-credentials")).toBeVisible();
  await page.locator("#cred-password").fill("clawbox-pass");
  await page.locator("#cred-confirm").fill("clawbox-pass");
  await page.locator("#hotspot-password").fill("hotspot-pass");
  await page.locator("#hotspot-confirm").fill("hotspot-pass");
  await page.getByRole("button", { name: /^Connect$/ }).click();

  const providerStep = page.getByTestId("setup-step-ai-models");
  const providerGroup = providerStep.getByRole("radiogroup", { name: "AI Provider" });
  await expect(providerStep).toBeVisible();
  await expect(providerGroup.locator("label", { hasText: "ClawBox AI" })).toBeVisible();
  await expect(providerGroup.locator("label", { hasText: "OpenAI GPT" })).toBeVisible();
  // Local-only providers must NOT appear in the cloud-providers radiogroup.
  await expect(providerGroup.getByText("Gemma 4")).toHaveCount(0);
  await expect(providerGroup.getByText("Ollama")).toHaveCount(0);

  await providerStep.getByText("OpenAI GPT").click();
  await providerStep.locator("#ai-api-key").fill("sk-test-openai-key");
  await providerStep.getByRole("button", { name: /Connect to OpenAI GPT/i }).click();

  // Wizard should jump straight from AI provider to Telegram, never
  // rendering a Local AI step in the middle.
  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();
  await expect(page.getByTestId("setup-step-local-ai")).toHaveCount(0);
});
