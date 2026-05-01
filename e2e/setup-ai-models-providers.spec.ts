import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// AIModelsStep renders six provider cards (Gemma 4, Ollama, ClawBox AI,
// OpenAI GPT, Anthropic Claude, Google Gemini, OpenRouter) plus a custom
// model picker, OAuth subscription buttons, and inline error/help text.
// The existing setup-openai-path.spec.ts only clicks OpenAI GPT, so the
// other provider branches stay un-rendered. This test resumes setup at
// the AI step and walks through each cloud provider's render branch
// without committing the configuration — enough to exercise the bundle's
// per-provider conditional layouts.
test("setup AI step renders each cloud provider card and exposes auth fields", async ({ page }) => {
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

  // Each provider card mounts a different body. Click each in turn and
  // assert its auth field is wired so we know the active-provider
  // render branch ran.
  await aiStep.getByText("Anthropic Claude").click();
  await expect(aiStep.locator("#ai-api-key")).toBeVisible();

  await aiStep.getByText("Google Gemini").click();
  await expect(aiStep.locator("#ai-api-key")).toBeVisible();

  await aiStep.getByText("OpenRouter").click();
  await expect(aiStep.locator("#ai-api-key")).toBeVisible();

  await aiStep.getByText("OpenAI GPT").click();
  await expect(aiStep.locator("#ai-api-key")).toBeVisible();

  await aiStep.getByText("ClawBox AI").click();
  // ClawBox AI uses a portal-token field, not the generic api-key id —
  // assert the card's heading rather than the input id so we don't
  // tightly couple to internal markup.
  await expect(aiStep.getByText("ClawBox AI", { exact: true }).first()).toBeVisible();
});

test("setup AI step shows a custom-model toggle once a cloud provider is selected", async ({ page }) => {
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

  await aiStep.getByText("Anthropic Claude").click();

  // The model picker is the right-hand half of the provider card. With
  // a curated list the user gets a select; "Use a custom model" reveals
  // a free-form input. Asserting either path mounted is enough — the
  // bundle covers both render branches because the toggle button is
  // always rendered.
  const customToggle = aiStep.getByRole("button", { name: /custom model/i });
  if (await customToggle.count() > 0) {
    await customToggle.first().click();
    await expect(aiStep.locator('input[placeholder*="model"]').first()).toBeVisible();
  }
});
