import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "./helpers/coverage";
import { installClawboxMocks, openChatPopup, openLauncher } from "./helpers/clawbox";
import * as relay from "../scripts/gateway-user-relay.js";

/**
 * A second person on the box, end to end in two browsers:
 *
 *   the owner adds a user in Settings → Users → the user signs in with their
 *   own password → they get the owner's desktop: every app and Settings →
 *   they chat, and the owner's conversation is nowhere on their screen or
 *   their socket → the owner removes them.
 *
 * One stand-in box behind both browsers: the users registry, the login check,
 * and a gateway that files a transcript per session key and broadcasts every
 * chat event to every socket, the way the real one does for webchat clients.
 * The user's socket goes through the REAL relay filters
 * (scripts/gateway-user-relay.js) — production-server.js's wire policy for a
 * ClawBox user's chat — so what this spec asserts about the owner's turns is
 * what the relay itself lets through.
 */

const OWNER = "clawbox";
const OWNER_MAIN = "agent:main:main";
const OWNER_SECRET = "The owner's private plan for Friday";
const USER = "carol";
const USER_PASSWORD = "a long passphrase for carol";
const USER_MAIN = `agent:main:clawbox-user-${USER}`;

type Message = { role: "user" | "assistant"; content: Array<{ type: "text"; text: string }>; timestamp: number };
interface Session { username: string | null }

class Box {
  users: Array<{ username: string; createdAt: string }> = [];
  private passwords = new Map<string, string>();
  transcripts = new Map<string, Message[]>();
  sends: Array<{ by: string; sessionKey: string; message: string }> = [];
  /** Every frame the user's browser was handed, to search for the owner's words. */
  toUser: string[] = [];
  private sockets = new Set<(event: string, payload: unknown) => void>();
  private clock = 1_000;

  constructor() {
    this.transcripts.set(OWNER_MAIN, [this.message("assistant", OWNER_SECRET)]);
  }

  message(role: Message["role"], text: string): Message {
    this.clock += 10;
    return { role, content: [{ type: "text", text }], timestamp: this.clock };
  }

  /** The gateway: one connection, owner (raw) or user (through the relay). */
  connect(ws: WebSocketRoute, who: string) {
    const isOwner = who === OWNER;
    const state: { connectId: string | null } | null = isOwner ? null : relay.createRelayState(who);
    const toBrowser = (frame: Record<string, unknown>) => {
      const out = state ? relay.filterGatewayFrame(state, frame).toClient : frame;
      if (!out) return;
      const raw = JSON.stringify(out);
      if (!isOwner) this.toUser.push(raw);
      try { ws.send(raw); } catch { /* closed */ }
    };
    const broadcast = (event: string, payload: unknown) => toBrowser({ type: "event", event, payload });
    this.sockets.add(broadcast);
    ws.onClose(() => { this.sockets.delete(broadcast); });
    toBrowser({ type: "event", event: "connect.challenge", payload: { nonce: "nonce", ts: 1_760_000_000_000 } });

    ws.onMessage((raw) => {
      let frame: { type?: string; id?: string; method?: string; params?: Record<string, unknown> };
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type !== "req" || typeof frame.id !== "string") return;
      if (state) {
        if (frame.method === "connect") {
          state.connectId = frame.id;
        } else {
          const verdict = relay.filterClientFrame(state, frame);
          if (verdict.toClient) {
            this.toUser.push(JSON.stringify(verdict.toClient));
            try { ws.send(JSON.stringify(verdict.toClient)); } catch { /* closed */ }
            return;
          }
        }
      }
      const params = frame.params ?? {};
      const respond = (payload: unknown) => toBrowser({ type: "res", id: frame.id, ok: true, payload });
      switch (frame.method) {
        case "connect":
          respond({ type: "hello-ok", snapshot: { sessionDefaults: { mainSessionKey: OWNER_MAIN } }, auth: { deviceToken: "relay-device-token" } });
          return;
        case "chat.history":
          respond({ messages: this.transcripts.get(String(params.sessionKey)) ?? [] });
          return;
        case "chat.send":
          this.turn(who, String(params.sessionKey), String(params.message), String(params.idempotencyKey));
          respond({ runId: params.idempotencyKey, status: "started" });
          return;
        default:
          respond({});
      }
    });
  }

  private turn(by: string, sessionKey: string, text: string, runId: string) {
    this.sends.push({ by, sessionKey, message: text });
    this.transcripts.set(sessionKey, [...(this.transcripts.get(sessionKey) ?? []), this.message("user", text)]);
    const replyText = `Box heard: ${text}`;
    setTimeout(() => {
      const reply = this.message("assistant", replyText);
      this.transcripts.set(sessionKey, [...(this.transcripts.get(sessionKey) ?? []), reply]);
      for (const send of this.sockets) send("chat", { sessionKey, runId, state: "final", message: reply });
    }, 60);
  }

  /** The routes one browser sees: who it is signed in as, Settings → Users, /login. */
  async mount(page: Page, session: Session) {
    await page.route("**/setup-api/users/me", (route) => {
      if (!session.username) return route.fulfill({ status: 401, json: { error: "Authentication required" } });
      return route.fulfill({ json: { username: session.username, isOwner: session.username === OWNER, multiUser: this.users.length > 0 } });
    });
    await page.route(/\/setup-api\/users(\?.*)?$/, async (route) => {
      const request = route.request();
      const method = request.method();
      if (method === "POST") {
        const { username, password } = request.postDataJSON() as { username: string; password: string };
        if (this.users.some((u) => u.username === username)) {
          return route.fulfill({ status: 409, json: { error: "exists", code: "user_exists" } });
        }
        this.users.push({ username, createdAt: "2026-10-16T09:00:00.000Z" });
        this.passwords.set(username, password);
        return route.fulfill({ status: 201, json: { user: this.users.at(-1), ...this.listing(session) } });
      }
      if (method === "DELETE") {
        const { username } = request.postDataJSON() as { username: string };
        if (username === OWNER || username === session.username) {
          return route.fulfill({ status: 400, json: { error: "no", code: "cannot_remove_owner" } });
        }
        this.users = this.users.filter((u) => u.username !== username);
        this.passwords.delete(username);
        return route.fulfill({ json: { removed: username, ...this.listing(session) } });
      }
      return route.fulfill({ json: this.listing(session) });
    });
    await page.route(/\/login-api\/users(\?.*)?$/, (route) => route.fulfill({
      json: { multiUser: this.users.length > 0, users: [{ username: OWNER, owner: true }, ...this.users.map((u) => ({ username: u.username, owner: false }))] },
    }));
    await page.route(/\/login-api$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const { username, password } = route.request().postDataJSON() as { username?: string; password: string };
      if (!username || this.passwords.get(username) !== password) {
        return route.fulfill({ status: 401, json: { error: "Incorrect username or password", code: "bad_credentials" } });
      }
      session.username = username;
      return route.fulfill({ json: { success: true, username } });
    });
    // A user's browser is never given the gateway's token: the relay holds it.
    await page.route("**/setup-api/gateway/ws-config", (route) => route.fulfill({
      json: session.username === OWNER
        ? { token: "test-gateway-token", wsUrl: "ws://localhost:12345/mock-gateway", model: "" }
        : { token: "", wsUrl: "ws://localhost:12345/mock-gateway", model: "", relayed: true },
    }));
    await page.route("**/setup-api/chat/tabs", (route) => route.fulfill({ json: { tabs: [], active: null } }));
    await page.routeWebSocket(/mock-gateway/, (ws) => this.connect(ws, session.username ?? OWNER));
  }

  private listing(session: Session) {
    return {
      owner: { username: OWNER },
      users: this.users,
      currentUser: session.username ?? OWNER,
      signIn: { available: true },
    };
  }
}

const SETUP = {
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

async function openUsersSettings(page: Page) {
  await page.getByTestId("shelf-app-settings").click();
  const settings = page.getByTestId("chrome-window-settings");
  await expect(settings).toBeVisible();
  await settings.getByRole("navigation").getByRole("button", { name: /Users/ }).click();
  await expect(settings.getByTestId("settings-users-section")).toBeVisible();
  return settings;
}

test("a second person gets the whole box, their own chat, and can be removed by the owner", async ({ browser }) => {
  const box = new Box();

  // ── The owner adds carol.
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const owner = await ownerContext.newPage();
  await installClawboxMocks(owner, SETUP);
  await box.mount(owner, { username: OWNER });
  await owner.goto("/");
  await expect(owner.getByTestId("desktop-root")).toBeVisible();
  const ownerSettings = await openUsersSettings(owner);
  await ownerSettings.locator("#users-new-name").fill(USER);
  await ownerSettings.locator("#users-new-password").fill(USER_PASSWORD);
  await ownerSettings.locator("#users-new-confirm").fill(USER_PASSWORD);
  await ownerSettings.getByRole("button", { name: "Create user" }).click();
  await expect(ownerSettings.getByText(`${USER} can now sign in.`)).toBeVisible();
  await expect(ownerSettings.getByTestId(`users-row-${USER}`)).toBeVisible();

  // ── carol signs in on their own browser, with their own password.
  const userContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const user = await userContext.newPage();
  const userSession: Session = { username: null };
  await installClawboxMocks(user, SETUP);
  await box.mount(user, userSession);
  await user.goto("/login");
  await user.getByTestId("login-user-picker").getByRole("radio", { name: new RegExp(USER) }).click();
  await user.locator("#login-password").fill("not the password");
  await user.locator("#login-password").press("Enter");
  await expect(user.getByText("Incorrect username or password")).toBeVisible();
  await user.locator("#login-password").fill(USER_PASSWORD);
  await user.locator("#login-password").press("Enter");
  await expect(user.getByTestId("desktop-root")).toBeVisible();
  expect(userSession.username).toBe(USER);

  // ── The owner's desktop: every app, Settings — and not the harness's own
  // console, which lists every conversation on the box.
  await user.evaluate(() => window.dispatchEvent(new Event("clawbox-hide-mascot")));
  await openLauncher(user);
  const launcher = user.getByTestId("app-launcher");
  // A launcher row is named by its icon's ligature and its label ("settings
  // Settings"), and the list runs over two pages.
  const app = (name: string) => launcher.getByRole("button", { name: new RegExp(`(^|\\s)${name}$`) });
  for (const name of ["Settings", "Chat", "Terminal", "Coding Agent", "Files", "ClawKeep", "Memory Shard", "Prime Radiant"]) {
    await expect(app(name), name).toBeVisible();
  }
  await expect(app("OpenClaw")).toHaveCount(0);
  await launcher.getByRole("button", { name: "Page 2" }).click();
  for (const name of ["Store", "Agent Browser", "Remote Desktop"]) {
    await expect(app(name), name).toBeVisible();
  }
  await expect(app("OpenClaw")).toHaveCount(0);
  await user.keyboard.press("Escape");
  const userSettings = await openUsersSettings(user);
  await expect(userSettings.getByTestId(`users-row-${USER}`)).toBeVisible();

  // ── carol's own chat: their main key, never the owner's history.
  await openChatPopup(user);
  const transcript = user.getByTestId("chat-transcript");
  const composer = user.getByTestId("chat-composer").locator("textarea");
  await expect(composer).toBeEnabled();
  await composer.fill("hello from carol");
  await composer.press("Enter");
  await expect(transcript.getByText("Box heard: hello from carol", { exact: true })).toBeVisible();
  await expect(transcript.getByText(OWNER_SECRET)).toHaveCount(0);
  const theirSends = box.sends.filter((s) => s.by === USER);
  expect(theirSends.map((s) => s.message)).toContain("hello from carol");
  expect(new Set(theirSends.map((s) => s.sessionKey))).toEqual(new Set([USER_MAIN]));
  expect(box.toUser.join("\n")).not.toContain(OWNER_SECRET);
  expect(box.toUser.join("\n")).not.toContain("relay-device-token");

  // The owner's own chat still has their history, untouched by carol's.
  await owner.evaluate(() => window.dispatchEvent(new Event("clawbox-hide-mascot")));
  await openChatPopup(owner);
  await expect(owner.getByTestId("chat-transcript").getByText(OWNER_SECRET)).toBeVisible();
  await expect(owner.getByTestId("chat-transcript").getByText("hello from carol")).toHaveCount(0);
  await openChatPopup(owner);

  // ── The owner removes carol.
  const row = ownerSettings.getByTestId(`users-row-${USER}`);
  await row.getByRole("button", { name: "Remove" }).click();
  await row.getByRole("button", { name: "Remove user" }).click();
  await expect(ownerSettings.getByText(`${USER} was removed.`)).toBeVisible();
  await expect(ownerSettings.getByTestId(`users-row-${USER}`)).toHaveCount(0);
  await expect(ownerSettings.getByText("No other users yet.")).toBeVisible();

  await userContext.close();
  await ownerContext.close();
});
