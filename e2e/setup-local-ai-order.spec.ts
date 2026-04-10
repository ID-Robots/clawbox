import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("setup configures Local AI before the primary AI provider step", async ({ page }) => {
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
  await page.getByRole("button", { name: "Save" }).click();

  const localAiStep = page.getByTestId("setup-step-local-ai");
  const localProviderGroup = localAiStep.getByRole("radiogroup", { name: "AI Provider" });
  await expect(localAiStep).toBeVisible();
  await expect(localProviderGroup.getByText("Gemma 4")).toBeVisible();
  await expect(localProviderGroup.getByText("Ollama")).toBeVisible();
  await expect(localAiStep.getByRole("button", { name: /Enable Gemma 4/i })).toBeVisible();
  await expect(localProviderGroup.getByText("ClawBox AI")).toHaveCount(0);
  await expect(localProviderGroup.getByText("OpenAI GPT")).toHaveCount(0);

  await localAiStep.getByRole("button", { name: /Enable Gemma 4/i }).click();

  const providerStep = page.getByTestId("setup-step-ai-models");
  const providerGroup = providerStep.getByRole("radiogroup", { name: "AI Provider" });
  await expect(providerStep).toBeVisible();
  await expect(providerGroup.getByText("ClawBox AI")).toBeVisible();
  await expect(providerGroup.getByText("OpenAI GPT")).toBeVisible();
  await expect(providerGroup.getByText("Gemma 4")).toHaveCount(0);
  await expect(providerGroup.getByText("Ollama")).toHaveCount(0);
});
