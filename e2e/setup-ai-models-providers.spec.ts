import { expect, test } from "./helpers/coverage";
import { expandAiProviderList, installClawboxMocks } from "./helpers/clawbox";

// AIModelsStep renders multiple provider cards (Gemma 4, Ollama,
// ClawBox AI, OpenAI GPT, Anthropic Claude, Google Gemini, OpenRouter)
// behind a "show more providers" toggle — the list itself opens on whichever
// provider is in play. The existing setup-openai-path.spec.ts only commits an
// OpenAI flow, leaving each provider's per-card body un-rendered. This test
// resumes setup at the AI step, opens the list the way a customer does, and
// asserts the provider names render.
test("setup AI step renders the primary provider cards", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
    },
  });

  await page.goto("/setup");
  const aiStep = page.getByTestId("setup-step-ai-models");
  await expect(aiStep).toBeVisible();

  // ClawBox AI is the provider in play, so its row is the one the list
  // opens on. Opening the list puts the others on screen; asserting each is
  // mounted covers the per-card render branch in the bundle.
  await expect(aiStep.getByText("ClawBox AI").first()).toBeVisible();
  await expandAiProviderList(page);
  await expect(aiStep.getByText("OpenAI GPT").first()).toBeVisible();
  await expect(aiStep.getByText("Anthropic Claude").first()).toBeVisible();
});

test("setup AI step expand-more reveals the secondary provider cards", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
    },
  });

  await page.goto("/setup");
  const aiStep = page.getByTestId("setup-step-ai-models");
  await expect(aiStep).toBeVisible();

  // The "more providers" toggle reveals every provider the list is not
  // currently opened on — Gemma 4 / Google / OpenRouter included.
  await expandAiProviderList(page);
  await expect(aiStep.getByText("Google Gemini").first()).toBeVisible();
  await expect(aiStep.getByText("OpenRouter").first()).toBeVisible();
});
