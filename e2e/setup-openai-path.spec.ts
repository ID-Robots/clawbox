import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

test("setup supports the OpenAI API-key path and telegram configuration", async ({ page }) => {
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

  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();
  await page.getByText("OpenAI GPT").click();
  await page.locator("#ai-api-key").fill("sk-test-openai-key");
  await page.getByRole("button", { name: /Connect to OpenAI GPT/i }).click();

  await expect(page.getByTestId("setup-step-local-ai")).toBeVisible();
  await page.getByRole("button", { name: /Enable Gemma 4/i }).click();

  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();
  await page.locator("#telegram-bot-token").fill("123456789:ABCdefGHI");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
});
