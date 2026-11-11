import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import {
  fillCredentialsStep,
  installClawboxMocks,
  submitCredentialsStep,
} from "./helpers/clawbox";

/**
 * The first-boot wizard on a box whose external AI engine is already
 * connected (TASK-2376). The AI step offers the engine, selected; Continue
 * makes it the chat's model through /setup-api/local-ai/external/select and
 * goes on to Telegram — no llama.cpp or Ollama install, no configure, no
 * Local AI switch. Without an engine the step is the one every Jetson has.
 */

const ENGINE = {
  configured: true,
  providerId: "clawext",
  modelRef: "clawext/nano-ci/echo-1",
  displayName: "echo-1",
  modelId: "nano-ci/echo-1",
  contextWindow: 131072,
  maxTokens: 4096,
  imageInput: false,
  apiKeySet: true,
  activeHarness: "openclaw",
  localOnlyMode: false,
  hermesMinContextWindow: 64000,
  unsupported: [],
};

/** Every POST the page sends to /setup-api, by path. */
function recordPosts(page: Page): string[] {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/setup-api/")) posts.push(path);
  });
  return posts;
}

async function toTheAiStep(page: Page) {
  await page.goto("/setup");
  await expect(page.getByTestId("setup-step-wifi")).toBeVisible();
  await page.getByRole("button", { name: "Continue with Ethernet" }).click();
  await expect(page.getByTestId("setup-step-credentials")).toBeVisible();
  await fillCredentialsStep(page);
  await submitCredentialsStep(page);
  await expect(page.getByTestId("setup-step-ai-models")).toBeVisible();
}

test("an external engine already connected: the wizard keeps it selected and Continue installs nothing", async ({ page }) => {
  await installClawboxMocks(page);
  const posts = recordPosts(page);
  // Registered after the shared mocks, so these answer first.
  await page.route("**/setup-api/local-ai/external", (route) => route.fulfill({ json: ENGINE }));
  await page.route("**/setup-api/local-ai/external/select", (route) =>
    route.fulfill({ json: { success: true, modelRef: ENGINE.modelRef, harness: "openclaw" } }));
  await page.route("**/setup-api/providers/status", (route) => route.fulfill({
    json: {
      harness: "openclaw",
      defaultProvider: "clawext",
      degraded: false,
      unrunnable: [],
      providers: [
        { id: "clawext", label: "echo-1 (external engine)", state: "connected", isDefault: true, enabled: true, section: "localAi" },
      ],
    },
  }));

  await toTheAiStep(page);
  const step = page.getByTestId("setup-step-ai-models");
  const choice = step.getByTestId("setup-external-engine-choice");
  await expect(choice).toBeVisible();
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await expect(choice).toContainText("echo-1 (external engine)");
  // The only choice on screen: Gemma is not pre-selected, nor offered as the way on.
  await expect(step.getByRole("radio")).toHaveCount(1);
  await expect(step.getByText("Skip — I'll use only local AI")).toHaveCount(0);

  await step.getByTestId("setup-external-engine-continue").click();
  await expect(page.getByTestId("setup-step-telegram")).toBeVisible();

  expect(posts).toContain("/setup-api/local-ai/external/select");
  expect(posts.filter((path) => /llamacpp|ollama|ai-models\/configure|\/local-ai(\/exclusive)?$|local-models/.test(path))).toEqual([]);
});

test("an external engine already connected: another provider is one tap away, and back", async ({ page }) => {
  await installClawboxMocks(page);
  await page.route("**/setup-api/local-ai/external", (route) => route.fulfill({ json: ENGINE }));

  await toTheAiStep(page);
  const step = page.getByTestId("setup-step-ai-models");
  await step.getByTestId("setup-external-engine-use-other").click();
  await expect(step.getByRole("radiogroup", { name: "AI Provider" }).locator("label", { hasText: "ClawBox AI" })).toBeVisible();
  // Its way forward is the engine, not llama.cpp's "use only local AI".
  await expect(step.getByText("Skip — I'll use only local AI")).toHaveCount(0);
  await step.getByTestId("setup-external-engine-back").click();
  await expect(step.getByTestId("setup-external-engine-choice")).toHaveAttribute("aria-checked", "true");
});

test("no external engine: the AI step is the one every box has (Gemma's skip, no engine choice)", async ({ page }) => {
  await installClawboxMocks(page);
  await toTheAiStep(page);
  const step = page.getByTestId("setup-step-ai-models");
  await expect(step.getByRole("radiogroup", { name: "AI Provider" }).locator("label", { hasText: "ClawBox AI" })).toBeVisible();
  await expect(step.getByText("Skip — I'll use only local AI")).toBeVisible();
  await expect(step.getByTestId("setup-external-engine-choice")).toHaveCount(0);
});
