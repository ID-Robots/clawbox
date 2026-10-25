import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openChatPopup } from "./helpers/clawbox";

/**
 * A session that runs out while the desktop is open, in a real browser.
 *
 * The chat was the one surface that kept working: its socket outlived the
 * session that opened it, while every other app was already being answered
 * 401. Now the box ends that socket with the session-expired close code and
 * refuses the chat's routes with the session gate's marked 401
 * (src/lib/session-expiry.ts) — and either one takes the WHOLE page to
 * /login, chat included, carrying where it was, so signing in again lands the
 * person back on it.
 *
 * This server runs with the session gate off (playwright.config.ts), so the
 * gate's answers are played by the mocks below: the close code on the chat's
 * socket, the marked 401 on /setup-api.
 */

const SIGNED_IN_SETUP = {
  setup_complete: true,
  wifi_configured: true,
  update_completed: true,
  password_configured: true,
  ai_model_configured: true,
  telegram_configured: true,
};

const SESSION_EXPIRED_CLOSE = { code: 4401, reason: "Session expired" };

/** A stand-in gateway behind the chat's socket: the handshake, an empty transcript, and an echo. */
class Gateway {
  sockets: WebSocketRoute[] = [];
  /** The sockets the page itself closed. */
  closedByPage = new Set<WebSocketRoute>();
  sends: string[] = [];

  async install(page: Page) {
    await page.routeWebSocket(/mock-gateway/, (ws) => {
      this.sockets.push(ws);
      ws.onClose(() => { this.closedByPage.add(ws); });
      ws.onMessage((raw) => {
        let frame: { type?: string; id?: string; method?: string; params?: { message?: unknown } };
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame.type !== "req" || !frame.id) return;
        if (frame.method === "connect") {
          ws.send(JSON.stringify({
            type: "res", id: frame.id, ok: true,
            payload: { snapshot: { sessionDefaults: { mainSessionKey: "main" } } },
          }));
          return;
        }
        if (frame.method === "chat.send") {
          const sent = String(frame.params?.message ?? "");
          this.sends.push(sent);
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
          ws.send(JSON.stringify({
            type: "event", event: "chat",
            payload: { sessionKey: "main", state: "final", message: { text: `Gateway heard: ${sent}` } },
          }));
          return;
        }
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { messages: [] } }));
      });
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
    });
  }
}

/** /login's own endpoints: who may sign in, and the sign-in itself. */
async function mockLoginApi(page: Page, signIns: unknown[]) {
  await page.route(/\/login-api\/users(\?.*)?$/, (route) => route.fulfill({ json: { multiUser: false } }));
  await page.route(/\/login-api$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    signIns.push(route.request().postDataJSON());
    await route.fulfill({ json: { success: true, username: "clawbox" } });
  });
}

/** The session gate's answer to every /setup-api request once the session has run out. */
async function expireSessionForApis(page: Page) {
  await page.route("**/setup-api/**", (route) => route.fulfill({
    status: 401,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-clawbox-session": "expired" },
    body: JSON.stringify({ error: "Authentication required" }),
  }));
}

async function openDesktopWithLiveChat(page: Page, gateway: Gateway, signIns: unknown[]) {
  await gateway.install(page);
  await installClawboxMocks(page, {
    // The real handshake clocks: the default 50 ms cap would expire them.
    timeoutCapMs: 300_000,
    kvEntries: { "clawbox-mascot-hidden": "1" },
    // No first-conversation greet: the only turn on the socket is this spec's.
    chatFacts: { onboardingArmed: false },
    initialSetup: SIGNED_IN_SETUP,
    preferences: { ui_mascot_hidden: 1 },
  });
  await mockLoginApi(page, signIns);
  await page.goto("/");
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  await openChatPopup(page);
  await expect(page.getByTestId("chat-popup")).toBeVisible();

  // The chat is live before the session ends: a message makes the round trip.
  await page.locator("textarea").last().fill("still signed in?");
  await page.getByTitle("Send").click();
  await expect(page.getByText("Gateway heard: still signed in?", { exact: true })).toBeVisible();
}

test("the box ending the chat's socket for a lapsed session takes the page to /login, and signing in brings it back", async ({ page }) => {
  const gateway = new Gateway();
  const signIns: unknown[] = [];
  await openDesktopWithLiveChat(page, gateway, signIns);
  const socketsBefore = gateway.sockets.length;
  const sendsBefore = [...gateway.sends];
  expect(sendsBefore).toContain("still signed in?");

  await gateway.sockets[socketsBefore - 1].close(SESSION_EXPIRED_CLOSE);

  // The whole page leaves — not a "Restarting chat…" overlay retrying into 401s.
  await expect(page).toHaveURL(/\/login\?redirect=%2F$/);
  await expect(page.locator("#login-password")).toBeVisible();
  // Nothing reconnected or was sent on the way out.
  expect(gateway.sockets).toHaveLength(socketsBefore);
  expect(gateway.sends).toEqual(sendsBefore);

  await page.locator("#login-password").fill("correct horse battery");
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("desktop-root")).toBeVisible();
  expect(signIns).toHaveLength(1);
});

test("the session gate refusing any request takes the desktop, and its open chat, to /login", async ({ page }) => {
  const gateway = new Gateway();
  await openDesktopWithLiveChat(page, gateway, []);
  const socketsBefore = gateway.sockets.length;

  await expireSessionForApis(page);

  await expect(page).toHaveURL(/\/login\?redirect=%2F$/);
  // The chat's socket did not outlive the page that held it, and no other
  // was opened on the way out.
  await expect.poll(() => gateway.sockets.every((ws) => gateway.closedByPage.has(ws))).toBe(true);
  expect(gateway.sockets).toHaveLength(socketsBefore);
});
