import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openChatPopup } from "./helpers/clawbox";

/**
 * View on the chat's coding-run card (TASK-1065).
 *
 * On a phone the chat is full screen, ABOVE the one app window the phone
 * draws, and View opened the run's page in the Coding Agent under it: the
 * press looked dead. The chat now gets out of the way on a phone, and the run
 * page it lands on has to be usable in that window — the live view's tabs on
 * screen, and the header's back button stepping out of the run before it
 * closes the app. On a desktop the chat stays open beside the window.
 *
 * Screenshots go to the test's output folder, for a human to look at.
 */
async function installFakeGatewaySocket(page: Page) {
  await page.addInitScript(() => {
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onclose: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor() {
        setTimeout(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          setTimeout(() => {
            this.onmessage?.({
              data: JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "test-nonce" } }),
            } as MessageEvent<string>);
          }, 50);
        }, 10);
      }

      send(raw: unknown) {
        // The run page's terminal and browser preview open sockets of their
        // own, and not every frame they send is the gateway's JSON.
        let message: { id: string; method: string; params?: Record<string, unknown> };
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }
        const emit = (payload: unknown) => this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
        if (message.method === "connect") {
          emit({ type: "res", id: message.id, ok: true, payload: { snapshot: { sessionDefaults: { mainSessionKey: "main" } } } });
          return;
        }
        if (message.method === "chat.history") {
          emit({ type: "res", id: message.id, ok: true, payload: { messages: [] } });
          return;
        }
        if (message.method === "chat.send") {
          // The popup greets an empty transcript with a "hi" of its own.
          emit({ type: "res", id: message.id, ok: true, payload: {} });
          setTimeout(() => {
            emit({ type: "event", event: "chat", payload: { sessionKey: "main", state: "final", message: { text: "Hello from the fake gateway" } } });
          }, 50);
          return;
        }
        if (["chat.abort", "sessions.reset", "sessions.patch", "sessions.subscribe"].includes(message.method)) {
          emit({ type: "res", id: message.id, ok: true, payload: {} });
        }
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new Event("close"));
      }

      addEventListener() {}
      removeEventListener() {}
    }

    // Next's own socket (`/_next/…`, the dev server's hot reload) stays real,
    // so the spec also runs against a local `bun run dev`.
    const RealWebSocket = window.WebSocket;
    const value = new Proxy(FakeWebSocket, {
      construct: (Fake, args: unknown[]) =>
        /\/_next\//.test(String(args[0])) ? new RealWebSocket(...(args as [string, string?])) : new Fake(),
    });
    Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value });
  });
}

const SETUP = {
  timeoutCapMs: 300_000,
  initialSetup: {
    setup_complete: true,
    wifi_configured: true,
    update_completed: true,
    password_configured: true,
    ai_model_configured: true,
    telegram_configured: true,
  },
  // Hiding the mascot writes both its KV state and desktop preference: the
  // walking crab would otherwise sit on the shelf's chat button.
  kvEntries: { "clawbox-mascot-hidden": "1" },
  // Not a fresh install, so the one-time greeting auto-open is not what opens
  // the chat here.
  preferences: { desktop_apps: ["clawbox", "files", "settings"], wp_id: "clawbox", ui_mascot_hidden: 1 },
};

/** One delegated run, in flight — the card the owner sees in the chat. */
const RUN = {
  id: "run-e2eview1",
  task: "Build a countdown timer page",
  directory: "/home/clawbox/projects/timer",
  projectId: null,
  source: "agent",
  status: "running",
  startedAt: Date.now() - 60_000,
  completedAt: null,
  summary: null,
  error: null,
  numTurns: 3,
  filesTouched: ["index.html"],
  permissionDenials: 0,
  progress: ["Writing index.html", "$ npm test"],
  // A transcript is what gives the live view its terminal tab.
  transcriptPath: "/home/clawbox/.claude-ds/projects/timer/session.jsonl",
  sessionId: "session-e2eview1",
};

async function installDevice(page: Page) {
  await installFakeGatewaySocket(page);
  await installClawboxMocks(page, SETUP);
  // Registered after the helper's catch-all, so these answer first. The
  // helper's device has the Coding Agent switched off and unfinished, which
  // lands the app on its wizard; this one is on and set up.
  await page.route("**/setup-api/coding-agent/status*", (route) =>
    route.fulfill({ json: {
      enabled: true, ready: true, running: 1, setupComplete: true,
      readiness: { ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true, problems: [] },
      harnessCommand: "claude-ds", maxTaskChars: 4000, defaultDirectory: "/home/clawbox/projects",
      effort: "ultracode", effortLevels: ["low", "xhigh", "max", "ultracode"], reviewPass: false,
    } }));
  await page.route("**/setup-api/coding-agent/projects*", (route) =>
    route.fulfill({ json: { directory: "/home/clawbox/projects", projects: [] } }));
  // Both readers: the chat's card poll and the Coding Agent's own list.
  await page.route("**/setup-api/coding-agent/runs*", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: url.searchParams.has("id") ? { run: RUN } : { runs: [RUN] } });
  });
}

const chatOpen = (page: Page) => expect(page.getByTestId("chat-popup")).toHaveCSS("pointer-events", "auto");
// A closed chat is not rendered at all (ChatPopup returns null while !isOpen).
const chatClosed = (page: Page) => expect(page.getByTestId("chat-popup")).toHaveCount(0);

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("View closes the chat and lands on the run's page in the phone's window, whose tabs and back button work", async ({ page }, testInfo) => {
    await installDevice(page);
    await page.goto("/");

    // The phone lands in the chat (src/lib/mobile-chat-first.ts), with the run's card in it.
    await chatOpen(page);
    const card = page.getByTestId("coding-agent-activity");
    await expect(card).toBeVisible();
    await expect(card).toContainText(RUN.task);
    await expect(page.getByTestId("mobile-app-window")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("phone-1-chat-before-view.png") });

    await card.getByTestId("coding-agent-activity-view").tap();

    // The chat is out of the way, and the window it opened is the one on screen.
    await chatClosed(page);
    const win = page.getByTestId("mobile-app-window");
    await expect(win).toBeVisible();
    await expect(win).toContainText("Coding Agent");
    // On THIS run's page — handed over on a cold open, since the app was not up.
    const runPage = win.getByTestId("coding-agent-run-page");
    await expect(runPage).toBeVisible();
    await expect(runPage).toHaveAttribute("data-run-id", RUN.id);
    await expect(runPage).toContainText(RUN.task);
    await expect(runPage).toBeInViewport();
    // The window slides up from the bottom; photograph it once it is there.
    await expect.poll(async () => Math.round((await win.boundingBox())?.y ?? -1)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("phone-2-run-page-after-view.png") });

    // The live view's tabs are on screen inside the 390px window, not cut off.
    const liveCard = runPage.getByTestId("coding-agent-live-card");
    await liveCard.scrollIntoViewIfNeeded();
    for (const id of ["timeline", "terminal", "browser"]) {
      const tab = liveCard.getByTestId(`coding-agent-live-tab-${id}`);
      await expect(tab).toBeInViewport({ ratio: 1 });
      const box = (await tab.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await liveCard.getByTestId("coding-agent-live-tab-terminal").tap();
    await expect(liveCard.getByTestId("coding-agent-live-tab-terminal")).toHaveAttribute("aria-selected", "true");
    await expect(liveCard.getByTestId("coding-agent-run-terminal")).toBeVisible();
    await liveCard.getByTestId("coding-agent-live-tab-browser").tap();
    await expect(liveCard.getByTestId("coding-agent-live-tab-browser")).toHaveAttribute("aria-selected", "true");
    await expect(liveCard.getByTestId("coding-agent-browser-preview")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("phone-3-run-page-preview-tab.png") });

    // Back steps out of the run first (the app's own back), then out of the app.
    await win.getByTestId("mobile-window-back").tap();
    await expect(win.getByTestId("coding-agent-run-page")).toHaveCount(0);
    await expect(win).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("phone-4-after-back.png") });
    await win.getByTestId("mobile-window-back").tap();
    await expect(page.getByTestId("mobile-app-window")).toHaveCount(0);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("View opens the run's page in the Coding Agent window and the chat stays open beside it", async ({ page }, testInfo) => {
    await installDevice(page);
    await page.goto("/");
    await expect(page.getByTestId("desktop-root")).toBeVisible();
    await openChatPopup(page);
    await chatOpen(page);

    const card = page.getByTestId("coding-agent-activity");
    await expect(card).toBeVisible();
    await card.getByTestId("coding-agent-activity-view").click();

    const win = page.getByTestId("chrome-window-coding");
    await expect(win).toBeVisible();
    const runPage = win.getByTestId("coding-agent-run-page");
    await expect(runPage).toBeVisible();
    await expect(runPage).toHaveAttribute("data-run-id", RUN.id);
    // Still open, and still the card the owner pressed.
    await chatOpen(page);
    await expect(card).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("desktop-view-chat-stays-open.png") });
  });
});
