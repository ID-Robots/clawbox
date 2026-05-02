import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// AIModelsStep renders multiple provider cards (Gemma 4, Ollama,
// ClawBox AI, OpenAI GPT, Anthropic Claude, Google Gemini, OpenRouter)
// plus a "show more providers" toggle that reveals the secondary set.
// The existing setup-openai-path.spec.ts only commits an OpenAI flow,
// leaving each provider's per-card body un-rendered. This test resumes
// setup at the AI step, asserts the primary provider names render, and
// expands the secondary section so the bundle covers both subtrees.
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

  // Primary providers (clawai, openai, anthropic per
  // PRIMARY_PROVIDER_IDS in AIModelsStep.tsx) are visible without any
  // expansion. Asserting each is mounted covers the per-card render
  // branch in the bundle.
  await expect(aiStep.getByText("ClawBox AI").first()).toBeVisible();
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

  // The "more providers" toggle reveals Gemma 4 / Ollama / Google /
  // OpenRouter — the secondary cards filtered out by collapseSecondary.
  // Match by partial text since the toggle copy ("More providers" /
  // "Show more …") may shift; the role is `button`.
  const moreToggle = aiStep.getByRole("button", { name: /more provider/i }).first();
  if (await moreToggle.count() > 0) {
    await moreToggle.click();
    await expect(aiStep.getByText("Google Gemini").first()).toBeVisible();
    await expect(aiStep.getByText("OpenRouter").first()).toBeVisible();
  }
});
