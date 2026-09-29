import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openChatPopup } from "./helpers/clawbox";
import { installFakeGatewaySocket } from "./helpers/fake-gateway";

test("chat popup connects, streams a reply, and supports panel docking", async ({ page }) => {
  await installFakeGatewaySocket(page);

  await installClawboxMocks(page, {
    // Keep the real startup deadline: the default 50 ms cap expires it
    // before this spec's asynchronous gateway handshake can complete.
    timeoutCapMs: 300_000,
    // Hiding the mascot writes both its KV state and desktop preference.
    kvEntries: { "clawbox-mascot-hidden": "1" },
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
    preferences: {
      ui_mascot_hidden: 1,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await openChatPopup(page);
  await expect(page.getByTestId("chat-popup")).toBeVisible();

  const chatInput = page.locator("textarea").last();
  await chatInput.fill("What changed?");
  await page.getByTitle("Send").click();
  // Exact: the reply below quotes the question, and a substring match would
  // find both bubbles.
  await expect(page.getByText("What changed?", { exact: true })).toBeVisible();
  await expect(page.getByText("Fake gateway heard: What changed?", { exact: true })).toBeVisible();

  await page.getByTitle("Dock to right").click();
  await expect(page.getByTitle("Undock panel")).toBeVisible();
  await page.getByTitle("Undock panel").click();
  await expect(page.getByTitle("Dock to right")).toBeVisible();
});

test("chat popup stays silent on a box whose agent has been introduced", async ({ page }) => {
  // The common case on a real box, and the one the greet used to get wrong: an
  // empty transcript is not a first conversation. A cleared conversation, a
  // reset session and a box introduced months ago all look identical, and every
  // one of them used to be answered with an unasked-for "hi" that spent a model
  // turn and put a word in the owner's mouth.
  await installFakeGatewaySocket(page);

  await installClawboxMocks(page, {
    timeoutCapMs: 300_000,
    kvEntries: { "clawbox-mascot-hidden": "1" },
    // No introduction waiting: BOOTSTRAP.md is gone because the ritual finished.
    chatFacts: { onboardingArmed: false },
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
    },
    preferences: { ui_mascot_hidden: 1 },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await openChatPopup(page);

  // The composer is usable and the transcript is empty: nothing was sent, so
  // the fake gateway — which answers "hi" and nothing else with that line —
  // never replied. Asserted against the gateway's OWN reply rather than a
  // generic empty check, so a turn that went out under any other text still
  // fails this.
  await expect(page.getByTestId("chat-composer-row")).toBeVisible();

  // Wait for the transcript read to have HAPPENED before claiming nothing was
  // sent. `toHaveCount(0)` on its own succeeds the moment the composer renders,
  // which is before the greeting path has had its chance — so a regression that
  // still greets would sail past it. The read is the input the greet decision
  // waits on, so once it has landed, a box that was going to greet has.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __chatHistoryReads?: number }).__chatHistoryReads ?? 0))
    .toBeGreaterThan(0);

  // A settle window, because this is a NEGATIVE assertion: polling for an empty
  // array succeeds on its first evaluation, so without a pause it proves only
  // that nothing had been sent yet. The greet waits on two inputs — the read
  // above and the capabilities fetch — and this covers the gap between them.
  await page.waitForTimeout(1000);

  // Asserted on what reached the WIRE, not on what is painted: a turn that went
  // out and whose reply merely had not rendered yet would still fail this.
  expect(
    await page.evaluate(() => (window as unknown as { __chatSends?: string[] }).__chatSends ?? []),
  ).toEqual([]);
  await expect(page.getByText("Hello from the fake gateway")).toHaveCount(0);
});

test("chat popup lets you switch to Local AI when it is configured", async ({ page }) => {
  await installFakeGatewaySocket(page);

  await installClawboxMocks(page, {
    // Keep the real startup deadline: the default 50 ms cap expires it
    // before this spec's asynchronous gateway handshake can complete.
    timeoutCapMs: 300_000,
    // Hiding the mascot writes both its KV state and desktop preference.
    kvEntries: { "clawbox-mascot-hidden": "1" },
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      telegram_configured: true,
    },
    preferences: {
      ui_mascot_hidden: 1,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await openChatPopup(page);
  await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

  // Provider dropdown is a custom popover (HeaderDropdown), not a
  // native <select>. Open via click on the trigger, pick the option
  // by accessible name. The previous Escape sanity-check was native-
  // select-specific (to confirm the browser's built-in dropdown
  // dismissed) — for the popover, Escape is a closer-of-popover-AND-
  // close-of-chat-popup ambiguity since the chat panel also handles
  // Escape, so we just exercise the open/select flow that users hit.
  const providerTrigger = page.getByRole("button", { name: "Chat provider" });
  await expect(providerTrigger).toBeVisible();
  await providerTrigger.click();
  await page.getByRole("option", { name: /Gemma 4 Local/ }).click();
  await expect(page.getByText(/Switched chat to Gemma 4 Local/)).toBeVisible();
});

test("chat popup provider dropdown stays visible at viewport edges", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 260 });
  await installFakeGatewaySocket(page);

  await installClawboxMocks(page, {
    // Keep the real startup deadline: the default 50 ms cap expires it
    // before this spec's asynchronous gateway handshake can complete.
    timeoutCapMs: 300_000,
    // Hiding the mascot writes both its KV state and desktop preference.
    kvEntries: { "clawbox-mascot-hidden": "1" },
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      local_ai_configured: true,
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      telegram_configured: true,
    },
    preferences: {
      ui_mascot_hidden: 1,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  // 640px is a phone-sized viewport, so the page lands in the chat on its own
  // (src/lib/mobile-chat-first.ts) — pressing the crab now would close it.
  await expect(page.getByTestId("chat-popup")).toHaveCSS("pointer-events", "auto");
  await expect(page.getByText("Hello from the fake gateway")).toBeVisible();
  // A phone opens in fullscreen chat, with the pickers folded behind one
  // control (TASK-1157) — unfold them first.
  await page.getByTestId("composer-options-toggle").click();

  // Push the popup into the bottom-right corner of a viewport that is barely
  // taller than the popup itself. The provider pill sits in the composer row
  // under the textarea, so with the popup's bottom edge 20px above the
  // viewport's there is no room for a list to drop DOWN from it — the popover
  // has to flip upward, and stay inside the viewport when it does. (The popup
  // must stay on screen for the pill to be clickable at all: a popup placed
  // any lower would put the composer, and the pill, below the fold.)
  await page.getByTestId("chat-popup").evaluate((el) => {
    Object.assign(el.style, {
      left: "216px",
      top: "20px",
      right: "auto",
      bottom: "auto",
      width: "416px",
      height: "220px",
    });
  });

  const providerTrigger = page.getByRole("button", { name: "Chat provider" });
  await expect(providerTrigger).toBeInViewport();
  const triggerBox = await providerTrigger.boundingBox();
  await providerTrigger.click();

  const listbox = page.getByRole("listbox", { name: "Chat provider" });
  await expect(listbox).toBeVisible();
  await expect(providerTrigger).toHaveAttribute("aria-controls", await listbox.getAttribute("id") ?? "");
  await page.waitForTimeout(150);

  const bounds = await listbox.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });

  expect(bounds.left).toBeGreaterThanOrEqual(8);
  expect(bounds.top).toBeGreaterThanOrEqual(8);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth - 8);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight - 8);
  // Inside the viewport BECAUSE it flipped: the list sits above the pill it
  // opened from, not squeezed into the 20px under it.
  expect(triggerBox).not.toBeNull();
  expect(bounds.bottom).toBeLessThanOrEqual(triggerBox!.y);
});

test("chat popup opens Local AI settings when local AI is not configured", async ({ page }) => {
  await installFakeGatewaySocket(page);

  await installClawboxMocks(page, {
    // Keep the real startup deadline: the default 50 ms cap expires it
    // before this spec's asynchronous gateway handshake can complete.
    timeoutCapMs: 300_000,
    // Hiding the mascot writes both its KV state and desktop preference.
    kvEntries: { "clawbox-mascot-hidden": "1" },
    initialSetup: {
      setup_complete: true,
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      local_ai_configured: false,
      local_ai_provider: null,
      local_ai_model: null,
      telegram_configured: true,
    },
    preferences: {
      ui_mascot_hidden: 1,
    },
  });

  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();

  await openChatPopup(page);
  await expect(page.getByText("Hello from the fake gateway")).toBeVisible();

  await page.getByRole("button", { name: "Chat provider" }).click();
  await page.getByRole("option", { name: "Local AI - Set up in Settings" }).click();

  const settingsWindow = page.getByTestId("chrome-window-settings");
  await expect(settingsWindow).toBeVisible();

  // Settings opens straight on Local AI — not on Providers, where the window
  // opens by default. The sidebar row carries the reason the chat sent us here
  // as its sr-only subtitle, and the pane is the on-device inventory, in
  // which the model the chat could not switch to reads as absent.
  const localAiNav = settingsWindow.getByRole("navigation").getByRole("button", { name: /Local AI/ });
  await expect(localAiNav).toContainText("Not configured");
  const localAi = settingsWindow.getByTestId("local-ai-panel");
  await expect(localAi).toContainText("AI that runs on this box, and what each part is doing right now.");
  await expect(localAi.getByTestId("local-model-llamacpp").getByText("Not installed", { exact: true })).toBeVisible();
  await expect(settingsWindow.getByTestId("ai-provider-list")).toHaveCount(0);
});
