import { expect, test } from "./helpers/coverage";
import {
  expandAiProviderList,
  fillCredentialsStep,
  installClawboxMocks,
  pickAiProvider,
} from "./helpers/clawbox";

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
  await fillCredentialsStep(page);
  await page.getByRole("button", { name: /^Connect$/ }).click();

  const providerStep = page.getByTestId("setup-step-ai-models");
  const providerGroup = providerStep.getByRole("radiogroup", { name: "AI Provider" });
  await expect(providerStep).toBeVisible();
  // The list opens on ClawBox AI, the default; the rest are one tap behind
  // its toggle. Open it and the whole offer is still on one screen.
  await expect(providerGroup.locator("label", { hasText: "ClawBox AI" })).toBeVisible();
  await expandAiProviderList(page);
  await expect(providerGroup.locator("label", { hasText: "OpenAI GPT" })).toBeVisible();
  // Gemma 4 is folded into this step as the local option; Ollama is retired.
  await expect(providerGroup.locator("label", { hasText: "Gemma 4" })).toBeVisible();
  await expect(providerGroup.getByText("Ollama")).toHaveCount(0);

  await pickAiProvider(page, "OpenAI GPT");
  await providerStep.locator("#ai-api-key").fill("sk-test-openai-key");
  await providerStep.getByRole("button", { name: /Connect to OpenAI GPT/i }).click();

  // Wizard should jump straight from AI provider to Telegram, never
  // rendering a Local AI step in the middle.
  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();
  await expect(page.getByTestId("setup-step-local-ai")).toHaveCount(0);
});
