import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

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

  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();
  await page.getByText("Anthropic Claude").click();
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

  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();

  // Google is in the secondary set, hidden behind the "more providers"
  // toggle. Expanding it covers the showMoreProviders=true branch and
  // mounts the Google card body.
  const moreToggle = page.getByRole("button", { name: /more provider/i }).first();
  if (await moreToggle.count() > 0) {
    await moreToggle.click();
  }
  await page.getByText("Google Gemini").click();
  await page.locator("#ai-api-key").fill("test-gemini-key");
  await page.getByRole("button", { name: /Connect to Google Gemini/i }).click();

  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();
});
