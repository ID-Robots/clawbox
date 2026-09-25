import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { resetChatPhoneLayoutMemory } from "@/lib/chat-phone-layout";
import { isChatTabKey, mergeTabInventory, parseTabList, type ChatTabInventory } from "@/lib/chat-tabs";
import { translations } from "@/lib/translations";
import type { ReactNode } from "react";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// For the last block, which sends the popup's requests to the REAL route: the
// session gate and the owner check are the route's own tests' business, and
// here stand for a signed-in owner's browser.
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn(async () => true) }));

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) => {
        let str = translations.en[key] ?? key;
        for (const [k, v] of Object.entries(params ?? {})) str = str.replaceAll(`{${k}}`, String(v));
        return str;
      },
    }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/**
 * A conversation started on the phone is on the desktop's strip (TASK-1159).
 *
 * The bug: the desktop showed the main "ClawBox" tab alone while the phone had
 * side conversations open with the same agent, on the same box, for the same
 * owner. The sessions were never missing — the gateway held every one — but the
 * LIST of them was each browser's own localStorage, so a second browser had no
 * way to learn they existed. There was no server response filtering anything:
 * there was no server response.
 *
 * Two browsers are modelled here as two localStorages over ONE box: the gateway
 * (`histories`, keyed by session) and the tab inventory behind
 * /setup-api/chat/tabs, which runs the real merge from chat-tabs.ts. What is
 * pinned: the phone's tab reaches the desktop and opens there; it survives a
 * refresh and a sign-out; a tab closed on one device leaves the other; a
 * desktop already open learns of a new tab when the owner comes back to it; a
 * box that cannot answer leaves the cached strip exactly as it was.
 */

const SEED_TEXT = "Here's your orange tabby";
const MAIN = "agent:main:main";
const TAB_KEY = /^agent:main:clawbox-[a-z0-9]{12}$/;
const FIRST_WORDS = "Plan my week in Lisbon please";
const LABEL = "Plan my week in Lisbon p…";

const user = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });

/** The gateway: every session's transcript, the same for every browser. */
let histories: Record<string, unknown[]> = {};
/** The box's tab inventory, as /setup-api/chat/tabs keeps it. */
let inventory: ChatTabInventory = { tabs: [], closed: [] };
/** While true the route answers 503 — a box mid-restart, or an older build. */
let tabsRouteDown = false;
const tabPosts: Array<{ upsert?: unknown[]; close?: unknown[] }> = [];
/** When set, /setup-api/chat/tabs is answered by the real route handler instead of the fake box. */
let realTabsRoute: typeof import("@/app/setup-api/chat/tabs/route") | null = null;
const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;

class FakeGatewayWs {
  static readonly OPEN = 1;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    sockets.push(this);
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "req") return;
    sent.push(frame);
    const id = frame.id as string;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    switch (frame.method) {
      case "connect":
        this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
        return;
      case "chat.history":
        this.respond(id, { messages: histories[String(params.sessionKey)] ?? [] });
        return;
      case "sessions.delete":
        delete histories[String(params.key)];
        this.respond(id, { ok: true, key: params.key, deleted: true });
        return;
      case "chat.send": {
        // The gateway files the session on its first turn and keeps the
        // transcript — which is what the desktop reads when it opens the tab.
        const key = String(params.sessionKey);
        histories[key] = [...(histories[key] ?? []), user(String(params.message), 600), assistant("Day one: Alfama.", 700)];
        this.respond(id, { runId: params.idempotencyKey, status: "started" });
        setTimeout(() => this.emit({
          type: "event",
          event: "chat",
          payload: { sessionKey: key, runId: params.idempotencyKey, state: "final", message: assistant("Day one: Alfama.", 700) },
        }), 5);
        return;
      }
      default:
        this.respond(id, {});
    }
  }

  close() {}
  addEventListener() {}
  removeEventListener() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/chat/tabs") && realTabsRoute) {
      const req = new NextRequest(`http://clawbox.local${url}`, {
        method: init?.method ?? "GET",
        body: init?.body as string | undefined,
        headers: init?.headers as Record<string, string> | undefined,
      });
      return init?.method === "POST" ? realTabsRoute.POST(req) : realTabsRoute.GET(req);
    }
    if (url.includes("/setup-api/chat/tabs")) {
      if (tabsRouteDown) return { ok: false, status: 503, json: async () => ({ error: "down" }) };
      const body = JSON.parse(String(init?.body ?? "{}")) as { upsert?: unknown[]; close?: unknown[] };
      tabPosts.push(body);
      inventory = mergeTabInventory(inventory, {
        upsert: parseTabList(body.upsert),
        close: (body.close ?? []).filter(isChatTabKey),
      }).inventory;
      const tabs = inventory.tabs;
      return { ok: true, json: async () => ({ tabs }) };
    }
    if (url.includes("/setup-api/gateway/ws-config")) {
      return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    }
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    }
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

// ── Two browsers, one box ──
// Each device keeps its own localStorage; switching devices puts one away and
// takes the other out, exactly as two browsers would never share one.
type Device = "phone" | "desktop";
const storages: Record<Device, Record<string, string>> = { phone: {}, desktop: {} };
let current: Device | null = null;

function putAway() {
  if (!current) return;
  const snapshot: Record<string, string> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i)!;
    snapshot[k] = window.localStorage.getItem(k)!;
  }
  storages[current] = snapshot;
}

async function openOn(device: Device) {
  putAway();
  cleanup();
  window.localStorage.clear();
  for (const [k, v] of Object.entries(storages[device])) window.localStorage.setItem(k, v);
  current = device;
  sent.length = 0;
  sockets.length = 0;
  resetHarnessCache();
  render(<ChatPopup isOpen onClose={() => {}} mobile={device === "phone"} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await waitFor(() => expect(frames("chat.history").length).toBeGreaterThan(0));
  await settle();
}

const frames = (method: string) => sent.filter((f) => f.method === method);
const params = (f: Record<string, unknown>) => f.params as Record<string, unknown>;
const tabs = () => screen.getAllByTestId("chat-tab");
const tabKeys = () => tabs().map((el) => el.getAttribute("data-session-key"));
const tabLabels = () => tabs().map((el) => el.textContent);
const activeTabKey = () => tabs().find((el) => el.getAttribute("aria-selected") === "true")?.getAttribute("data-session-key");

async function settle(ms = 30) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

/** The +, from whichever header this device shows — the phone's is folded into its strip. */
async function openNewTab(): Promise<string> {
  const toggle = screen.queryByTestId("chat-header-toggle");
  if (toggle && toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  const plus = screen.getByTestId("chat-new-tab");
  await waitFor(() => expect(plus).not.toBeDisabled());
  fireEvent.click(plus);
  await settle();
  const key = activeTabKey();
  expect(key).toMatch(TAB_KEY);
  return key as string;
}

async function say(text: string) {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  await settle(60);
}

/** The phone opens a side conversation and says something in it. */
async function phoneStartsAConversation(): Promise<string> {
  await openOn("phone");
  const key = await openNewTab();
  await say(FIRST_WORDS);
  expect(params(frames("chat.send")[0]).sessionKey).toBe(key);
  // Named after the first words — and the name went to the box.
  await waitFor(() => expect(inventory.tabs).toEqual([expect.objectContaining({ key, label: LABEL })]));
  return key;
}

describe("the chat strip across devices", () => {
  beforeEach(() => {
    histories = { [MAIN]: [assistant(SEED_TEXT, 500)] };
    inventory = { tabs: [], closed: [] };
    tabsRouteDown = false;
    tabPosts.length = 0;
    storages.phone = {};
    storages.desktop = {};
    current = null;
    window.localStorage.clear();
    resetChatPhoneLayoutMemory();
    installFetch();
    vi.stubGlobal("WebSocket", FakeGatewayWs);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    resetChatPhoneLayoutMemory();
    realTabsRoute = null;
  });

  it("shows the desktop the conversation the phone started, and opens it there", async () => {
    const key = await phoneStartsAConversation();

    await openOn("desktop");
    // Before TASK-1159 this was ["ClawBox"] alone: the desktop's localStorage
    // had never heard of the phone's tab.
    await waitFor(() => expect(tabKeys()).toEqual([MAIN, key]));
    expect(tabLabels()).toEqual(["ClawBox", LABEL]);
    expect(activeTabKey()).toBe(MAIN);

    fireEvent.click(tabs()[1]);
    await waitFor(() => expect(activeTabKey()).toBe(key));
    // The phone's conversation, read from the gateway on the desktop.
    await screen.findByText(FIRST_WORDS);
    await screen.findByText("Day one: Alfama.");
    expect(frames("chat.history").map((f) => params(f).sessionKey)).toContain(key);

    // And the desktop can carry it on: its turn goes to the same session.
    await say("and the weekend after");
    expect(params(frames("chat.send")[0]).sessionKey).toBe(key);
  });

  it("keeps the phone's conversation open on the desktop across a refresh", async () => {
    const key = await phoneStartsAConversation();
    await openOn("desktop");
    await waitFor(() => expect(tabKeys()).toEqual([MAIN, key]));
    fireEvent.click(tabs()[1]);
    await waitFor(() => expect(activeTabKey()).toBe(key));

    // A refresh: same browser, same localStorage.
    await openOn("desktop");
    expect(tabKeys()).toEqual([MAIN, key]);
    expect(activeTabKey()).toBe(key);
    // The hello binds to the tab the owner was in, and reads ITS history.
    expect(params(frames("chat.history")[0]).sessionKey).toBe(key);
    await screen.findByText(FIRST_WORDS);
  });

  it("still lists it after signing out and back in, even when the browser forgot everything", async () => {
    const key = await phoneStartsAConversation();
    await openOn("desktop");
    await waitFor(() => expect(tabKeys()).toEqual([MAIN, key]));

    // Signing out clears the cookie, not the box: the list is the box's. The
    // worst case is a browser that drops the site's storage with it.
    storages.desktop = {};
    putAway();
    current = null;
    await openOn("desktop");
    await waitFor(() => expect(tabKeys()).toEqual([MAIN, key]));
    expect(tabLabels()).toEqual(["ClawBox", LABEL]);
    fireEvent.click(tabs()[1]);
    await screen.findByText(FIRST_WORDS);
  });

  it("takes a tab closed on the desktop off the phone, and moves the phone back to main", async () => {
    const key = await phoneStartsAConversation();
    // The phone was left ON that tab.
    await openOn("desktop");
    await waitFor(() => expect(tabKeys()).toEqual([MAIN, key]));
    fireEvent.click(tabs()[1]);
    await waitFor(() => expect(activeTabKey()).toBe(key));
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(inventory.tabs).toEqual([]));
    expect(inventory.closed.map((c) => c.key)).toEqual([key]);

    await openOn("phone");
    await waitFor(() => expect(tabKeys()).toEqual([MAIN]));
    expect(activeTabKey()).toBe(MAIN);
    await screen.findByText(SEED_TEXT);
    // …and the phone's stale copy did not put it back on the box.
    expect(inventory.tabs).toEqual([]);
  });

  it("brings a new tab to a desktop that is already open, when the owner comes back to it", async () => {
    await openOn("desktop");
    expect(tabKeys()).toEqual([MAIN]);
    // Meanwhile, on the phone:
    const key = "agent:main:clawbox-0a1b2c3d4e5f";
    histories[key] = [user("Remind me about the dentist", 900)];
    inventory = mergeTabInventory(inventory, { upsert: [{ key, label: "Remind me about the dent…", createdAt: 900 }] }).inventory;
    expect(tabKeys()).toEqual([MAIN]);

    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(tabKeys()).toEqual([MAIN, key]));
    expect(tabLabels()).toEqual(["ClawBox", "Remind me about the dent…"]);
  });

  it("names a placeholder in this browser's language, whatever device opened it", async () => {
    // A tab the phone opened and has not said anything in yet — and one found
    // on the box with no name at all.
    inventory = mergeTabInventory(inventory, {
      upsert: [
        { key: "agent:main:clawbox-0a1b2c3d4e5f", label: "Unterhaltung 2", createdAt: 900, autoLabel: true, seq: 2 },
        { key: "agent:main:clawbox-9f8e7d6c5b4a", label: "", createdAt: 950, autoLabel: true },
      ],
    }).inventory;
    await openOn("desktop");
    await waitFor(() => expect(tabLabels()).toEqual(["ClawBox", "Chat 2", "Chat 3"]));
  });

  it("puts a tab this browser opened before the list lived on the box onto the box", async () => {
    // An older build kept the strip in localStorage alone; the first sync after
    // the update is what lets the other devices see it.
    const key = "agent:main:clawbox-00aa11bb22cc";
    histories[key] = [user("Old trip plans", 100)];
    storages.phone = {
      "clawbox-chat-tabs": JSON.stringify({ tabs: [{ key, label: "Old trip plans", createdAt: 100, autoLabel: false }], active: key }),
    };
    await openOn("phone");
    await waitFor(() => expect(inventory.tabs.map((t) => t.key)).toEqual([key]));
    expect(activeTabKey()).toBe(key);

    await openOn("desktop");
    await waitFor(() => expect(tabLabels()).toEqual(["ClawBox", "Old trip plans"]));
  });

  it("leaves the cached strip exactly as it was while the box cannot answer", async () => {
    tabsRouteDown = true;
    await openOn("desktop");
    const key = await openNewTab();
    await openOn("desktop");
    expect(tabKeys()).toEqual([MAIN, key]);
    expect(activeTabKey()).toBe(key);

    // The box is back: the tab it never heard of goes up with the next sync.
    tabsRouteDown = false;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(inventory.tabs.map((t) => t.key)).toEqual([key]));
    expect(tabKeys()).toEqual([MAIN, key]);
  });

  it("retries a close the box never heard, so the tab does not come back on the next sync", async () => {
    await openOn("desktop");
    const key = await openNewTab();
    await waitFor(() => expect(inventory.tabs.map((t) => t.key)).toEqual([key]));

    tabsRouteDown = true;
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await settle();
    expect(tabKeys()).toEqual([MAIN]);
    expect(inventory.tabs.map((t) => t.key)).toEqual([key]);

    // A refresh while the box is still down, then it comes back.
    await openOn("desktop");
    expect(tabKeys()).toEqual([MAIN]);
    tabsRouteDown = false;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(inventory.closed.map((c) => c.key)).toEqual([key]));
    expect(inventory.tabs).toEqual([]);
    expect(tabKeys()).toEqual([MAIN]);
  });

  describe("through the real route and the file on the box", () => {
    let root: string;

    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-tabs-e2e-"));
      process.env.CLAWBOX_ROOT = root;
      process.env.CLAWBOX_OPENCLAW_HOME = path.join(root, "openclaw");
      vi.resetModules();
      realTabsRoute = await import("@/app/setup-api/chat/tabs/route");
    });

    afterEach(() => {
      delete process.env.CLAWBOX_ROOT;
      delete process.env.CLAWBOX_OPENCLAW_HOME;
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("carries the phone's conversation to the desktop, across a refresh and a sign-in with nothing cached", async () => {
      await openOn("phone");
      const key = await openNewTab();
      await say(FIRST_WORDS);
      const file = path.join(root, "data", "chat-tabs.json");
      await waitFor(() => expect(JSON.parse(fs.readFileSync(file, "utf8")).tabs).toEqual([
        expect.objectContaining({ key, label: LABEL }),
      ]));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);

      await openOn("desktop");
      await waitFor(() => expect(tabKeys()).toEqual([MAIN, key]));
      expect(tabLabels()).toEqual(["ClawBox", LABEL]);
      fireEvent.click(tabs()[1]);
      await screen.findByText(FIRST_WORDS);

      await openOn("desktop");
      expect(activeTabKey()).toBe(key);
      await screen.findByText(FIRST_WORDS);

      storages.desktop = {};
      putAway();
      current = null;
      await openOn("desktop");
      await waitFor(() => expect(tabKeys()).toEqual([MAIN, key]));

      // Closed on the desktop: gone from the file and from the phone.
      fireEvent.click(tabs()[1]);
      await waitFor(() => expect(activeTabKey()).toBe(key));
      fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
      await waitFor(() => expect(JSON.parse(fs.readFileSync(file, "utf8")).tabs).toEqual([]));
      await openOn("phone");
      await waitFor(() => expect(tabKeys()).toEqual([MAIN]));
      expect(JSON.parse(fs.readFileSync(file, "utf8")).closed.map((c: { key: string }) => c.key)).toEqual([key]);
    });
  });
});
