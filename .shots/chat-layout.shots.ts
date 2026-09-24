import fs from "fs";
import { expect, test, type Page } from "@playwright/test";
import { installClawboxMocks, openChatPopup } from "../e2e/helpers/clawbox";

const LABEL = process.env.SHOTS_LABEL ?? "after";
const OUT = `${process.env.CLAWBOX_RUN_ARTIFACTS_DIR}/screenshots`;
fs.mkdirSync(OUT, { recursive: true });

const HISTORY = [
  ["user", "What happened with the coding runs today?"],
  ["assistant", "Three runs finished and one is still going:\n\n- **#723** TASK-1154 portal password reset → draft PR in clawbox-website, base `main`\n- **#1010** TASK-1149 unified-image design doc → draft PR in clawbox, base `beta`\n- **run-779gv5o7** TASK-1102 still running\n\nLogged the blocker in today's memory. No email or calendar items needing you."],
  ["user", "Anything I should look at before lunch?"],
  ["assistant", "Only the TASK-1102 run. It has been rebuilding for twenty minutes, which is longer than usual — I will tell you the moment it settles. Everything else can wait until the afternoon."],
  ["user", "Remind me to call Damyan at 3."],
  ["assistant", "Done — a reminder is set for 15:00 today: \"Call Damyan\". I will ping you on Telegram five minutes before."],
  ["user", "And summarise the email from the supplier."],
  ["assistant", "The supplier confirms the Jetson boards ship on Friday. Tracking follows by email once the courier collects them; the invoice is attached and matches the quote (no changes to the price or the quantity)."],
] as const;

async function installFakeGateway(page: Page) {
  await page.addInitScript((history) => {
    // Next's dev server talks HMR over a real socket; only the gateway is faked.
    const RealWebSocket = window.WebSocket;
    class FakeWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      onopen: ((e: Event) => void) | null = null;
      onmessage: ((e: MessageEvent<string>) => void) | null = null;
      onclose: ((e: Event) => void) | null = null;
      onerror: ((e: Event) => void) | null = null;
      constructor(url?: string | URL, protocols?: string | string[]) {
        if (String(url ?? "").includes("/_next/")) return new RealWebSocket(url as string, protocols) as unknown as FakeWebSocket;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
          setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 50);
        }, 10);
      }
      emit(p: unknown) { this.onmessage?.({ data: JSON.stringify(p) } as MessageEvent<string>); }
      send(raw: string) {
        const m = JSON.parse(raw) as { id: string; method: string };
        if (m.method === "connect") return this.emit({ type: "res", id: m.id, ok: true, payload: { snapshot: { sessionDefaults: { mainSessionKey: "main" } } } });
        if (m.method === "chat.history") {
          const base = 1787260000000;
          return this.emit({ type: "res", id: m.id, ok: true, payload: { messages: history.map(([role, text], i) => ({ role, content: [{ type: "text", text }], timestamp: base + i * 60_000 })) } });
        }
        this.emit({ type: "res", id: m.id, ok: true, payload: {} });
      }
      addEventListener() {}
      removeEventListener() {}
      close() { this.readyState = 3; this.onclose?.(new Event("close")); }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });
  }, HISTORY as unknown as [string, string][]);
}

const SETUP = {
  timeoutCapMs: 300_000,
  chatFacts: { hasClawaiToken: true, onboardingArmed: false },
  initialSetup: {
    setup_complete: true, wifi_configured: true, update_completed: true,
    password_configured: true, ai_model_configured: true, telegram_configured: true,
  },
  preferences: { desktop_apps: ["clawbox", "files", "settings"], wp_id: "clawbox" },
};

async function mockModels(page: Page) {
  await page.route("**/setup-api/chat/model", route => route.fulfill({
    json: {
      activeOptionId: "anthropic", activeModel: "anthropic/claude-opus-5-5", activeSource: "primary",
      options: [{ id: "anthropic", provider: "anthropic", label: "Claude", model: "anthropic/claude-opus-5-5", available: true, settingsSection: "ai", isLocal: false }],
      primary: { available: true, model: "anthropic/claude-opus-5-5", label: "Claude" },
      local: { available: false, model: null, label: null },
    },
  }));
  await page.route("**/setup-api/ai-models/catalog?**", route => route.fulfill({
    json: { provider: "anthropic", defaultModelId: "claude-opus-5-5", allowCustom: true, models: [
      { id: "claude-opus-5-5", label: "Opus 5.5" }, { id: "claude-sonnet-5", label: "Sonnet 5" },
    ] },
  }));
}

const metrics: Record<string, unknown> = {};
function record(name: string, value: unknown) {
  metrics[name] = value;
  const file = `${OUT}/metrics-${LABEL}.json`;
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  fs.writeFileSync(file, JSON.stringify({ ...prev, [name]: value }, null, 2));
}

async function transcriptShare(page: Page, name: string) {
  const box = await page.getByTestId("chat-transcript").boundingBox();
  const vp = page.viewportSize()!;
  const share = box ? Math.round((box.height / vp.height) * 1000) / 10 : null;
  record(name, { transcriptHeight: box?.height, viewportHeight: vp.height, sharePercent: share });
}

async function landInChat(page: Page) {
  page.on("pageerror", e => fs.appendFileSync(`${OUT}/page-errors-${LABEL}.log`, `${e.message}\n${e.stack ?? ""}\n`));
  await installFakeGateway(page);
  await installClawboxMocks(page, SETUP);
  await mockModels(page);
  await page.goto("/");
  await expect(page.getByTestId("chat-popup")).toHaveCSS("pointer-events", "auto");
  await expect(page.getByText("Jetson boards ship on Friday", { exact: false })).toBeVisible();
  await page.waitForTimeout(800);
}

for (const vp of [{ width: 360, height: 780 }, { width: 740, height: 360 }]) {
  test.describe(`phone ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp, hasTouch: true, isMobile: true });
    test("default layout", async ({ page }) => {
      await landInChat(page);
      const tag = `${vp.width}x${vp.height}`;
      await transcriptShare(page, `phone-${tag}-default`);
      await page.screenshot({ path: `${OUT}/${LABEL}-phone-${tag}-default.png` });
      if (LABEL !== "after") return;

      // Peek the header, open the chat options, then the text size bar.
      await page.getByTestId("chat-header-toggle").click();
      await expect(page.getByTestId("chat-popup-close")).toBeVisible();
      await page.getByTestId("composer-options-toggle").click();
      await expect(page.getByTestId("chat-composer-row")).toBeVisible();
      await page.screenshot({ path: `${OUT}/${LABEL}-phone-${tag}-expanded.png` });
      await page.getByTestId("composer-options-toggle").click();
      await page.getByTestId("chat-header-toggle").click();

      await page.getByTestId("chat-text-size-toggle").first().click();
      await page.getByTestId("chat-text-size-larger").click();
      await page.getByTestId("chat-text-size-larger").click();
      await page.screenshot({ path: `${OUT}/${LABEL}-phone-${tag}-text-130.png` });
      await page.getByTestId("chat-text-size-toggle").first().click();

      // Leave fullscreen: the standard layout, remembered across a reload.
      await page.getByTestId("chat-fullscreen-toggle").first().click();
      await expect(page.getByTestId("chat-popup-close")).toBeVisible();
      await transcriptShare(page, `phone-${tag}-standard`);
      await page.screenshot({ path: `${OUT}/${LABEL}-phone-${tag}-standard.png` });
      await page.reload();
      await expect(page.getByTestId("chat-popup")).toHaveCSS("pointer-events", "auto");
      await expect(page.getByTestId("chat-popup-close")).toBeVisible();
      await expect(page.getByText("Jetson boards ship on Friday", { exact: false })).toBeVisible();
      await page.screenshot({ path: `${OUT}/${LABEL}-phone-${tag}-standard-after-reload.png` });
    });
  });
}

test.describe("desktop 1280x800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("chat popup", async ({ page }) => {
    await installFakeGateway(page);
    await installClawboxMocks(page, SETUP);
    await mockModels(page);
    await page.goto("/");
    await expect(page.getByTestId("desktop-root")).toBeVisible();
    await openChatPopup(page);
    await expect(page.getByTestId("chat-popup")).toHaveCSS("pointer-events", "auto");
    await expect(page.getByText("Jetson boards ship on Friday", { exact: false })).toBeVisible();
    await page.waitForTimeout(1200);
    record("desktop-controls", {
      headerToggle: await page.getByTestId("chat-header-toggle").count(),
      fullscreenToggle: await page.getByTestId("chat-fullscreen-toggle").count(),
      textSize: await page.getByTestId("chat-text-size-toggle").count(),
    });
    await page.screenshot({ path: `${OUT}/${LABEL}-desktop-1280x800.png` });
  });
});

test.describe("full-page chat /app/clawbox", () => {
  for (const vp of [{ width: 360, height: 780 }, { width: 1280, height: 800 }]) {
    test(`${vp.width}x${vp.height}`, async ({ browser }) => {
      const phone = vp.width < 768;
      const context = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone, locale: "en-US" });
      const page = await context.newPage();
      await installFakeGateway(page);
      await installClawboxMocks(page, SETUP);
      await page.goto("/app/clawbox");
      await expect(page.getByText("Jetson boards ship on Friday", { exact: false })).toBeVisible();
      await page.waitForTimeout(800);
      const tag = `${vp.width}x${vp.height}`;
      const box = await page.getByTestId("chatapp-transcript").boundingBox();
      record(`chatapp-${tag}-default`, {
        transcriptHeight: box?.height, viewportHeight: vp.height,
        titleBarVisible: await page.getByTestId("standalone-title-bar").isVisible(),
        strip: await page.getByTestId("chat-header-strip").count(),
      });
      await page.screenshot({ path: `${OUT}/${LABEL}-chatapp-${tag}-default.png` });
      if (phone && LABEL === "after") {
        await page.getByTestId("chat-header-toggle").click();
        await page.getByTestId("chatapp-composer-options-toggle").click();
        await page.screenshot({ path: `${OUT}/${LABEL}-chatapp-${tag}-expanded.png` });
      }
      await context.close();
    });
  }
});
