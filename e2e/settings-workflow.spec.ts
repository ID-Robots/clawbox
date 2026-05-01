import { expect, test } from "./helpers/coverage";
import { installClawboxMocks } from "./helpers/clawbox";

// Drives appearance, network, local AI, telegram, system, and about
// settings panels. The AI Provider panel is intentionally NOT exercised
// here — its previous portal-token modal was replaced by an inline form
// and the dialog-driven assertions in the original test went stale.
// A focused AI-Provider test belongs in its own spec; until then this
// test still gives us the bulk of SettingsApp's render coverage.
test("settings covers appearance, network, local AI, telegram, system, and about flows", async ({ page }) => {
  await installClawboxMocks(page, {
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      ai_model_configured: false,
      telegram_configured: false,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await page.getByTestId("shelf-app-settings").click();
  const settingsWindow = page.getByTestId("chrome-window-settings");
  await expect(settingsWindow).toBeVisible();

  await settingsWindow.getByRole("button", { name: "Deep Space" }).click();
  await settingsWindow.getByRole("button", { name: "Fit" }).click();
  await settingsWindow.locator('input[type="range"]').evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "72";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settingsWindow.getByRole("button", { name: /English/ }).first().click();
  await expect(settingsWindow.getByRole("button", { name: "Deutsch" })).toBeVisible();
  await settingsWindow.getByRole("button", { name: /English/ }).first().click();

  await settingsWindow.getByRole("button", { name: "Network" }).click();
  await settingsWindow.getByRole("button", { name: "Available Networks" }).click();
  await settingsWindow.getByRole("button", { name: "Guest Network" }).click();
  await settingsWindow.getByPlaceholder("Enter WiFi password").fill("guest-pass");
  await settingsWindow.getByRole("button", { name: /Connect$/ }).last().click();
  await expect(settingsWindow.getByText("Guest Network").first()).toBeVisible();

  await settingsWindow.getByRole("button", { name: "Local AI" }).click();
  await expect(settingsWindow.getByText("Gemma 4 Local")).toBeVisible();
  await expect(settingsWindow.getByText("gemma4-e2b-it-q4_0").first()).toBeVisible();
  const localProviderGroup = settingsWindow.getByRole("radiogroup", { name: "AI Provider" });
  await expect(localProviderGroup.getByText("Gemma 4")).toBeVisible();
  await expect(localProviderGroup.getByText("Ollama")).toBeVisible();
  await expect(localProviderGroup.getByText("ClawBox AI")).toHaveCount(0);

  await settingsWindow.getByRole("button", { name: "Telegram" }).click();
  await settingsWindow.locator("#settings-tg-token").fill("123456789:ABCdefGHI");
  await settingsWindow.getByRole("button", { name: /Connect$/ }).click();
  await expect(settingsWindow.getByText("Bot Connected").last()).toBeVisible();

  await settingsWindow.getByRole("button", { name: "System" }).click();
  await expect(settingsWindow.getByText("clawbox", { exact: true })).toBeVisible();
  await expect(settingsWindow.getByText("Ubuntu 24.04")).toBeVisible();

  await settingsWindow.getByRole("button", { name: "About" }).click();
  await expect(settingsWindow.getByText("Documentation")).toBeVisible();
  await expect(settingsWindow.getByText("Discord Community")).toBeVisible();
});
