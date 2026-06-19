import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("setup skips the Local AI step and goes straight from AI provider to Telegram", async ({ page }) => {
  // There is no separate Local AI step: Gemma 4 is folded into the AI
  // Provider step (see SetupWizard.tsx), so a customer picks a cloud
  // provider or goes local from the same step. This test guards that the
  // wizard goes AI provider -> Telegram with no intervening Local AI step.
  await installClawboxMocks(page);

  await page.goto("/setup");

  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
  await page.getByRole("button", { name: "Continue with Ethernet" }).click();

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
  // Gemma 4 is folded into this step as the local option; Ollama is retired.
  await expect(providerGroup.locator("label", { hasText: "Gemma 4" })).toBeVisible();
  await expect(providerGroup.getByText("Ollama")).toHaveCount(0);

  await providerStep.getByText("OpenAI GPT").click();
  await providerStep.locator("#ai-api-key").fill("sk-test-openai-key");
  await providerStep.getByRole("button", { name: /Connect to OpenAI GPT/i }).click();

  // Wizard should jump straight from AI provider to Telegram, never
  // rendering a Local AI step in the middle.
  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();
  await expect(page.getByTestId("setup-step-local-ai")).toHaveCount(0);
});
