import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// AIModelsStep coverage stayed at ~12% even after committing the
// Anthropic and Google flows because most of the bundle's bytes are
// in conditional render branches that fire on provider state change,
// not on submit. This test resumes setup at the AI step and clicks
// each PRIMARY provider card in sequence so the per-card auth body
// + model picker + OAuth-button branches all render.

test("setup AI step walks each primary provider card and exposes auth fields", async ({ page }) => {
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

  // Click each primary provider in turn. The state change
  // (selectedProvider) re-renders the auth column, which mounts a
  // different subtree per provider (model picker / OAuth buttons /
  // portal-token input).
  await aiStep.getByText("ClawBox AI").click();
  // ClawBox AI shows a portal token field rather than the generic
  // #ai-api-key — assert the heading rather than tying to the input id.
  await expect(aiStep.getByText("ClawBox AI", { exact: true }).first()).toBeVisible();

  await aiStep.getByText("OpenAI GPT").click();
  await expect(aiStep.locator("#ai-api-key")).toBeVisible();

  await aiStep.getByText("Anthropic Claude").click();
  await expect(aiStep.locator("#ai-api-key")).toBeVisible();

  // Walk back to the first primary so the radio-flip path on
  // userSelectedProviderRef is exercised once more.
  await aiStep.getByText("ClawBox AI").click();
});

test("setup AI step expand-more walks Gemma 4, Ollama, and OpenRouter", async ({ page }) => {
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

  const moreToggle = aiStep.getByRole("button", { name: /more provider/i }).first();
  if (await moreToggle.count() > 0) {
    await moreToggle.click();
  }

  // Cycle through the secondary set's per-card branches.
  await aiStep.getByText("Gemma 4").click();
  await aiStep.getByText("Ollama").click();
  await aiStep.getByText("OpenRouter").click();
  await expect(aiStep.locator("#ai-api-key")).toBeVisible();
});
