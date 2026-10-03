import type { Browser, BrowserContext, Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openChatPopup } from "./helpers/clawbox";
import {
  isChatTabKey,
  mergeTabInventory,
  parseTabList,
  type ChatTabInventory,
  type TabInventoryChange,
} from "../src/lib/chat-tabs";

/**
 * One conversation, carried from the desktop to the phone and back (TASK-1364).
 *
 * Two browser contexts — separate cookies, separate localStorage, the same
 * owner — over ONE box: one gateway (every session's transcript, every
 * connected socket) and one tab inventory behind /setup-api/chat/tabs running
 * the real merge from chat-tabs.ts. The gateway here behaves the way the real
 * one does for a webchat client: `chat` frames go to every connection, a
 * `session.message` to the connections subscribed to that session.
 *
 * The bug: the owner started a conversation on the desktop, picked the phone
 * up, and the phone opened the main conversation instead — the conversation
 * they were in was one tap and one menu away, and nothing said which one it
 * was. What is pinned: the phone opens the conversation the owner was last
 * active in, with its history; a turn sent on either device shows on the other
 * without a reload; a phone left open in the background follows when the owner
 * comes back to it; switching on the phone reads the whole conversation.
 */

const MAIN = "agent:main:main";
const MAIN_GREETING = "Good morning from the main conversation";
const FIRST_WORDS = "Plan a trip to Lisbon";

type Message = { role: "user" | "assistant"; content: Array<{ type: "text"; text: string }>; timestamp: number };

class FakeBox {
  transcripts = new Map<string, Message[]>([[MAIN, [this.message("assistant", MAIN_GREETING)]]]);
  inventory: ChatTabInventory = { tabs: [], closed: [] };
  private sockets = new Set<{ ws: WebSocketRoute; subscribed: Set<string> }>();
  private clock = 1_000;

  message(role: Message["role"], text: string): Message {
    this.clock += 10;
    return { role, content: [{ type: "text", text }], timestamp: this.clock };
  }

  /** Every turn a browser sent, in order: which session and what. */
  sends: Array<{ sessionKey: string; message: string }> = [];

  connect(ws: WebSocketRoute) {
    const conn = { ws, subscribed: new Set<string>() };
    this.sockets.add(conn);
    ws.onClose(() => { this.sockets.delete(conn); });
    const send = (frame: unknown) => { try { ws.send(JSON.stringify(frame)); } catch { /* closed */ } };
    send({ type: "event", event: "connect.challenge", payload: { nonce: "nonce" } });
    ws.onMessage((raw) => {
      let frame: { type?: string; id?: string; method?: string; params?: Record<string, unknown> };
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type !== "req") return;
      const params = frame.params ?? {};
      const respond = (payload: unknown) => send({ type: "res", id: frame.id, ok: true, payload });
      switch (frame.method) {
        case "connect":
          respond({ snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
          return;
        case "chat.history":
          respond({ messages: this.transcripts.get(String(params.sessionKey)) ?? [] });
          return;
        case "sessions.messages.subscribe":
          conn.subscribed.add(String(params.key));
          respond({ subscribed: true });
          return;
        case "sessions.messages.unsubscribe":
          conn.subscribed.delete(String(params.key));
          respond({ subscribed: false });
          return;
        case "chat.send":
          this.turn(String(params.sessionKey), String(params.message), String(params.idempotencyKey));
          respond({ runId: params.idempotencyKey, status: "started" });
          return;
        default:
          respond({});
      }
    });
  }

  private broadcast(event: string, payload: unknown, onlySubscribersOf?: string) {
    for (const conn of this.sockets) {
      if (onlySubscribersOf && !conn.subscribed.has(onlySubscribersOf)) continue;
      try { conn.ws.send(JSON.stringify({ type: "event", event, payload })); } catch { /* closed */ }
    }
  }

  private turn(sessionKey: string, text: string, runId: string) {
    this.sends.push({ sessionKey, message: text });
    const said = this.message("user", text);
    this.transcripts.set(sessionKey, [...(this.transcripts.get(sessionKey) ?? []), said]);
    this.broadcast("session.message", { sessionKey, message: said }, sessionKey);
    const replyText = `Box heard: ${text}`;
    setTimeout(() => {
      this.broadcast("chat", { sessionKey, runId, state: "delta", message: { role: "assistant", content: [{ type: "text", text: replyText.slice(0, 8) }] } });
    }, 30);
    setTimeout(() => {
      const reply = this.message("assistant", replyText);
      this.transcripts.set(sessionKey, [...(this.transcripts.get(sessionKey) ?? []), reply]);
      this.broadcast("chat", { sessionKey, runId, state: "final", message: reply });
      this.broadcast("session.message", { sessionKey, message: reply }, sessionKey);
    }, 80);
  }

  /** /setup-api/chat/tabs, as the route answers it: the real merge, then the list and the active record. */
  async tabsRoute(page: Page) {
    await page.route("**/setup-api/chat/tabs", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
        const change: Record<string, unknown> = {
          upsert: parseTabList(body.upsert),
          close: (Array.isArray(body.close) ? body.close : []).filter(isChatTabKey),
        };
        // Whatever else the device reports rides through to the merge
        // unchanged — the merge, not this stand-in, decides what it means.
        for (const [key, value] of Object.entries(body)) if (!(key in change)) change[key] = value;
        this.inventory = mergeTabInventory(this.inventory, change as TabInventoryChange).inventory;
      }
      await route.fulfill({ json: { tabs: this.inventory.tabs, active: this.inventory.active ?? null } });
    });
  }
}

const SETUP = {
  // The chat's own debounces and restore waits run at their real lengths:
  // this spec is about what reaches the other browser, not about timers.
  timeoutCapMs: 300_000,
  chatFacts: { onboardingArmed: false },
  initialSetup: {
    setup_complete: true,
    wifi_configured: true,
    update_completed: true,
    password_configured: true,
    ai_model_configured: true,
  },
  preferences: { desktop_apps: ["clawbox", "files", "settings"], wp_id: "clawbox" },
};

const DESKTOP = { viewport: { width: 1280, height: 800 }, locale: "en-US" };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" };

async function openDevice(browser: Browser, box: FakeBox, options: typeof DESKTOP | typeof PHONE): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await installClawboxMocks(page, SETUP);
  await box.tabsRoute(page);
  await page.routeWebSocket(/mock-gateway/, (ws) => box.connect(ws));
  return { context, page };
}

const composer = (page: Page) => page.getByTestId("chat-composer").locator("textarea");
const transcript = (page: Page) => page.getByTestId("chat-transcript");

async function say(page: Page, text: string) {
  await expect(composer(page)).toBeEnabled();
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(transcript(page).getByText(`Box heard: ${text}`, { exact: true })).toBeVisible();
}

/** The phone's tab list sits in the header its fullscreen chat folds away. */
async function phoneTabs(page: Page) {
  const toggle = page.getByTestId("chat-header-toggle");
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  return page.getByTestId("chat-tab");
}

async function desktopWithConversation(browser: Browser, box: FakeBox) {
  const desktop = await openDevice(browser, box, DESKTOP);
  await desktop.page.goto("/");
  // The mascot wanders the shelf at real timer speed and can sit on the chat
  // button; it has nothing to do with this spec.
  await expect(desktop.page.getByTestId("desktop-root")).toBeVisible();
  await desktop.page.evaluate(() => window.dispatchEvent(new Event("clawbox-hide-mascot")));
  await openChatPopup(desktop.page);
  await expect(transcript(desktop.page).getByText(MAIN_GREETING)).toBeVisible();
  await expect(desktop.page.getByTestId("chat-new-tab")).toBeEnabled();
  await desktop.page.getByTestId("chat-new-tab").click();
  await say(desktop.page, FIRST_WORDS);
  const key = box.sends[0].sessionKey;
  expect(key).toMatch(/^agent:main:clawbox-[a-z0-9]{12}$/);
  return { ...desktop, key };
}

test.describe("one conversation on the desktop and the phone", () => {
  test("the phone opens the conversation the desktop was in, and both stay live", async ({ browser }, testInfo) => {
    const box = new FakeBox();
    const desktop = await desktopWithConversation(browser, box);
    const phone = await openDevice(browser, box, PHONE);
    try {
      await phone.page.goto("/");
      // Chat-first on a phone; and the conversation it lands in is the one the
      // owner was just in on the desktop — not the main one.
      await expect(phone.page.getByTestId("chat-popup")).toHaveCSS("pointer-events", "auto");
      await expect(phone.page.getByTestId("chat-header-toggle")).toContainText(FIRST_WORDS);
      await expect(transcript(phone.page).getByText(FIRST_WORDS, { exact: true })).toBeVisible();
      await expect(transcript(phone.page).getByText(`Box heard: ${FIRST_WORDS}`, { exact: true })).toBeVisible();
      await expect(transcript(phone.page).getByText(MAIN_GREETING)).toHaveCount(0);
      // The same list of conversations as the desktop.
      const tabs = await phoneTabs(phone.page);
      await expect(tabs).toHaveCount(2);
      await expect(tabs.nth(1)).toHaveAttribute("data-session-key", desktop.key);
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await phone.page.getByTestId("chat-header-toggle").click();
      await phone.page.screenshot({ path: testInfo.outputPath("phone-continues.png") });

      // The phone carries it on, into the SAME session, and the desktop — open
      // all along, never reloaded — shows the turn and its reply.
      await say(phone.page, "Add a day in Sintra");
      expect(box.sends.at(-1)).toEqual({ sessionKey: desktop.key, message: "Add a day in Sintra" });
      await expect(transcript(desktop.page).getByText("Add a day in Sintra", { exact: true })).toBeVisible();
      await expect(transcript(desktop.page).getByText("Box heard: Add a day in Sintra", { exact: true })).toBeVisible();

      // And back: the desktop's next turn reaches the phone the same way.
      await say(desktop.page, "Book the train");
      await expect(transcript(phone.page).getByText("Book the train", { exact: true })).toBeVisible();
      await expect(transcript(phone.page).getByText("Box heard: Book the train", { exact: true })).toBeVisible();
      await desktop.page.screenshot({ path: testInfo.outputPath("desktop-live.png") });
    } finally {
      await phone.context.close();
      await desktop.context.close();
    }
  });

  test("a phone left open in the background follows the owner to the desktop's conversation", async ({ browser }) => {
    const box = new FakeBox();
    // The phone was opened first, earlier, and is still on main.
    const phone = await openDevice(browser, box, PHONE);
    await phone.page.goto("/");
    await expect(transcript(phone.page).getByText(MAIN_GREETING)).toBeVisible();
    const desktop = await desktopWithConversation(browser, box);
    try {
      // Nothing moves the phone while nobody is looking at it…
      await expect(phone.page.getByTestId("chat-header-toggle")).toContainText("ClawBox");
      // …and coming back to it brings the owner to where they were.
      await phone.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(phone.page.getByTestId("chat-header-toggle")).toContainText(FIRST_WORDS);
      await expect(transcript(phone.page).getByText(`Box heard: ${FIRST_WORDS}`, { exact: true })).toBeVisible();
      // A desktop the owner never left does not move under them: its own turn
      // is the newest thing that happened.
      await desktop.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(desktop.page.getByTestId("chat-tab").nth(1)).toHaveAttribute("aria-selected", "true");
    } finally {
      await phone.context.close();
      await desktop.context.close();
    }
  });

  test("switching conversations on the phone reads each one whole", async ({ browser }) => {
    const box = new FakeBox();
    const desktop = await desktopWithConversation(browser, box);
    await say(desktop.page, "Somewhere to eat in Belém");
    const phone = await openDevice(browser, box, PHONE);
    try {
      await phone.page.goto("/");
      await expect(phone.page.getByTestId("chat-header-toggle")).toContainText(FIRST_WORDS);
      let tabs = await phoneTabs(phone.page);
      await tabs.first().click();
      await expect(transcript(phone.page).getByText(MAIN_GREETING)).toBeVisible();
      await expect(transcript(phone.page).getByText(FIRST_WORDS, { exact: true })).toHaveCount(0);

      tabs = await phoneTabs(phone.page);
      await tabs.nth(1).click();
      for (const line of [FIRST_WORDS, `Box heard: ${FIRST_WORDS}`, "Somewhere to eat in Belém", "Box heard: Somewhere to eat in Belém"]) {
        await expect(transcript(phone.page).getByText(line, { exact: true })).toBeVisible();
      }
      await expect(transcript(phone.page).getByText(MAIN_GREETING)).toHaveCount(0);
    } finally {
      await phone.context.close();
      await desktop.context.close();
    }
  });
});
