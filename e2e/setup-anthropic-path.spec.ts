import { expect, test } from "./helpers/coverage";
import {
  fillCredentialsStep,
  installClawboxMocks,
  pickAiProvider,
  submitCredentialsStep,
} from "./helpers/clawbox";

// AIModelsStep coverage was at ~12% because the existing setup-openai-path
// test only commits the OpenAI-via-API-key flow, leaving every other
// provider's per-card auth body, the configuring overlay's success
// path, and the model picker un-rendered. This test commits an
// Anthropic API-key flow end-to-end (mirrors setup-openai-path's
// shape) so the bundle covers a second provider's render + submit
// branches plus the post-submit configuring overlay.
test("setup commits an Anthropic API-key flow through to the desktop", async ({ page }) => {
  await installClawboxMocks(page);

  await page.goto("/setup");

  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
  await page.getByRole("button", { name: "Continue with Ethernet" }).click();

  await expect(page.getByTestId("setup-step-credentials")).toBeVisible();
  await fillCredentialsStep(page);
  await submitCredentialsStep(page);

  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();
  await pickAiProvider(page, "Anthropic Claude");
  await page.locator("#ai-api-key").fill("sk-ant-test-key");
  await page.getByRole("button", { name: /Connect to Anthropic Claude/i }).click();

  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();
  await page.locator("#telegram-bot-token").fill("123456789:ABCdefGHI");
  await page.getByTestId("setup-step-telegram").getByRole("button", { name: /^Connect$/ }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
});

test("setup commits a Google Gemini API-key flow after expanding more providers", async ({ page }) => {
  await installClawboxMocks(page);

  await page.goto("/setup");

  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
  await page.getByRole("button", { name: "Continue with Ethernet" }).click();

  await expect(page.getByTestId("setup-step-credentials")).toBeVisible();
  await fillCredentialsStep(page);
  await submitCredentialsStep(page);

  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();

  // Anything other than the provider already in play is behind the "more
  // providers" toggle. Expanding it covers the showMoreProviders=true branch
  // and mounts the Google card body.
  await pickAiProvider(page, "Google Gemini");
  await page.locator("#ai-api-key").fill("test-gemini-key");
  await page.getByRole("button", { name: /Connect to Google Gemini/i }).click();

  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();
});
