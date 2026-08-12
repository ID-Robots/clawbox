import { expect, test } from "./helpers/coverage";
import { fillCredentialsStep, installClawboxMocks, pickAiProvider } from "./helpers/clawbox";

test("setup supports the OpenAI API-key path and telegram configuration", async ({ page }) => {
  await installClawboxMocks(page);

  await page.goto("/setup");

  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
  await page.getByRole("button", { name: "Continue with Ethernet" }).click();

  await expect(page.getByTestId("setup-step-credentials")).toBeVisible();
  await fillCredentialsStep(page);
  await page.getByRole("button", { name: /^Connect$/ }).click();

  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();
  await pickAiProvider(page, "OpenAI GPT");
  await page.locator("#ai-api-key").fill("sk-test-openai-key");
  await page.getByRole("button", { name: /Connect to OpenAI GPT/i }).click();

  // Local AI step removed from initial setup — wizard now goes straight
  // from AI provider to Telegram (SetupWizard.tsx).
  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();
  await page.locator("#telegram-bot-token").fill("123456789:ABCdefGHI");
  await page.getByTestId("setup-step-telegram").getByRole("button", { name: /^Connect$/ }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
});
