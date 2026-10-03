import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import ChatApp from "@/components/ChatApp";
import { resetHarnessCache } from "@/lib/client-harness";
import { resetChatPhoneLayoutMemory } from "@/lib/chat-phone-layout";
import { isChatTabKey, mergeTabInventory, parseActivity, parseTabList, type ChatTabInventory } from "@/lib/chat-tabs";
import { installHermesBox, mountHermesChat } from "@/tests/helpers/hermes-chat-box";
import { translations } from "@/lib/translations";
import type { ReactNode } from "react";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
 * Carry on from the phone where the desktop left off (TASK-1364).
 *
 * The bug: the owner started a conversation on the desktop, picked the phone
 * up, and the phone opened the main conversation. The strip was the same on
 * both (TASK-1159) — the desktop's conversation was one tap away on the phone —
 * but which tab was OPEN stayed each browser's own localStorage, so every
 * device opened whatever it had open last time, or main.
 *
 * Two browsers are two localStorages over ONE box: the gateway (`histories`)
 * and /setup-api/chat/tabs running the real merge from chat-tabs.ts, with the
 * box's own clock for the record. What is pinned: the phone opens the
 * conversation the owner last sent a turn in, on its first paint; the record
 * moves with whoever spoke last; a desktop the owner never left is not moved
 * by its own turn; a phone left open follows when the owner comes back to it,
 * and never while a turn of its own is running or over a tab picked by hand.
 * And the two surfaces that showed another device's turn only after a reload —
 * the full-page chat, and either chat on a box that pushes nothing — now show
 * it live.
 */

const MAIN = "agent:main:main";
const SEED_TEXT = "Good morning from main";
const FIRST_WORDS = "Plan a trip to Lisbon";
const TAB_KEY = /^agent:main:clawbox-[a-z0-9]{12}$/;

const user = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });

let histories: Record<string, unknown[]> = {};
let inventory: ChatTabInventory = { tabs: [], closed: [] };
/** The box's clock: every write to the inventory happens a second after the last. */
let boxClock = 1_790_000_000_000;
/** While true a turn is acknowledged and never finishes — a reply still being written. */
let holdRuns = false;
const heldRuns: Array<() => void> = [];
/** While set, the gateway leaves the connect frame unanswered until it is called — a cold gateway. */
let holdHello: (() => void) | null = null;
let helloHeld = false;
const sent: Array<Record<string, unknown>> = [];
const tabPosts: Array<Record<string, unknown>> = [];
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
        if (helloHeld) {
          holdHello = () => this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
          return;
        }
        this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
        return;
      case "chat.history":
        this.respond(id, { messages: histories[String(params.sessionKey)] ?? [] });
        return;
      case "chat.send": {
        const key = String(params.sessionKey);
        const text = String(params.message);
        const reply = `Box heard: ${text}`;
        // Filed under the run's id, as the gateway files the owner's turn.
        histories[key] = [...(histories[key] ?? []), { ...user(text, 600), idempotencyKey: `${String(params.idempotencyKey)}:user` }];
        this.respond(id, { runId: params.idempotencyKey, status: "started" });
        const finish = () => {
          histories[key] = [...(histories[key] ?? []), assistant(reply, 700)];
          this.emit({
            type: "event",
            event: "chat",
            payload: { sessionKey: key, runId: params.idempotencyKey, state: "final", message: assistant(reply, 700) },
          });
        };
        if (holdRuns) heldRuns.push(finish);
        else setTimeout(finish, 5);
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

/** What the real route answers, from the real merge. */
function tabsAnswer() {
  return { tabs: inventory.tabs, active: inventory.active ?? null };
}

/** Another device's turn, as the box records it: its tab on the strip and the record moved. */
function elsewhereSpeaksIn(key: string, words: string) {
  boxClock += 1_000;
  histories[key] = [...(histories[key] ?? []), user(words, 900), assistant(`Box heard: ${words}`, 950)];
  inventory = mergeTabInventory(inventory, {
    upsert: key === MAIN ? [] : [{ key, label: words, createdAt: 900 }],
    activity: { key: key === MAIN ? null : key },
  }, boxClock).inventory;
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/setup-api/chat/tabs")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        tabPosts.push(body);
        const activity = parseActivity(body.activity);
        boxClock += 1_000;
        inventory = mergeTabInventory(inventory, {
          upsert: parseTabList(body.upsert),
          close: (Array.isArray(body.close) ? body.close : []).filter(isChatTabKey),
          ...(activity ? { activity } : {}),
        }, boxClock).inventory;
      }
      const answer = tabsAnswer();
      return { ok: true, json: async () => answer };
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
const activeTabKey = () => tabs().find((el) => el.getAttribute("aria-selected") === "true")?.getAttribute("data-session-key");

async function settle(ms = 30) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

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
  await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  await settle(60);
}

/** The owner comes back to this window. */
async function arrive() {
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await settle(60);
}

async function desktopStartsAConversation(): Promise<string> {
  await openOn("desktop");
  const key = await openNewTab();
  await say(FIRST_WORDS);
  expect(params(frames("chat.send")[0]).sessionKey).toBe(key);
  await waitFor(() => expect(inventory.active).toEqual({ key, at: expect.any(Number) }));
  return key;
}

describe("carrying a conversation from one device to the other", () => {
  beforeEach(() => {
    histories = { [MAIN]: [assistant(SEED_TEXT, 500)] };
    inventory = { tabs: [], closed: [] };
    boxClock = 1_790_000_000_000;
    holdRuns = false;
    heldRuns.length = 0;
    helloHeld = false;
    holdHello = null;
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
  });

  it("opens the phone in the conversation the desktop was in — on its first read, not after painting main", async () => {
    const key = await desktopStartsAConversation();

    await openOn("phone");
    // Before TASK-1364 this was MAIN: the phone's localStorage had nothing open.
    expect(activeTabKey()).toBe(key);
    expect(tabKeys()).toEqual([MAIN, key]);
    // The first history read was the conversation itself — main was never painted.
    expect(params(frames("chat.history")[0]).sessionKey).toBe(key);
    expect(frames("chat.history").map((f) => params(f).sessionKey)).not.toContain(MAIN);
    const transcript = within(screen.getByTestId("chat-transcript"));
    await transcript.findByText(FIRST_WORDS);
    await transcript.findByText(`Box heard: ${FIRST_WORDS}`);
    expect(screen.queryByText(SEED_TEXT)).toBeNull();
    // The folded phone header names it, too.
    expect(screen.getByTestId("chat-header-toggle").textContent).toContain(FIRST_WORDS);

    // And the phone carries it on, into the same session.
    await say("Add a day in Sintra");
    expect(params(frames("chat.send")[0]).sessionKey).toBe(key);
  });

  it("moves the record with whoever spoke last, main included", async () => {
    const key = await desktopStartsAConversation();
    await openOn("phone");
    expect(activeTabKey()).toBe(key);
    // On the phone the owner goes back to main and says something there.
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(MAIN));
    await say("What is on today?");
    await waitFor(() => expect(inventory.active?.key).toBeNull());

    // The desktop — which had the Lisbon tab open — opens main next time.
    await openOn("desktop");
    expect(activeTabKey()).toBe(MAIN);
    await screen.findByText("What is on today?");
  });

  it("does not move a desktop by its own turn — not on focus, not on a refresh", async () => {
    const key = await desktopStartsAConversation();
    // The owner picks main by hand on the desktop without saying anything.
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(MAIN));
    await arrive();
    expect(activeTabKey()).toBe(MAIN);
    // A refresh keeps what this browser had open: the record is its own, and older.
    await openOn("desktop");
    expect(activeTabKey()).toBe(MAIN);
    expect(tabKeys()).toEqual([MAIN, key]);
  });

  it("follows the owner when they come back to a phone left open — and only then", async () => {
    await openOn("phone");
    expect(activeTabKey()).toBe(MAIN);
    await screen.findByText(SEED_TEXT);

    // Meanwhile, on the desktop:
    const key = "agent:main:clawbox-0a1b2c3d4e5f";
    elsewhereSpeaksIn(key, FIRST_WORDS);
    // Nothing moves the phone while nobody is looking at it.
    await settle(60);
    expect(activeTabKey()).toBe(MAIN);

    // The owner picks it up.
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(activeTabKey()).toBe(key));
    await screen.findByText(`Box heard: ${FIRST_WORDS}`);
    expect(frames("chat.history").map((f) => params(f).sessionKey)).toContain(key);
  });

  it("keeps a tab picked by hand, until the other device has something newer", async () => {
    await openOn("phone");
    const key = "agent:main:clawbox-0a1b2c3d4e5f";
    elsewhereSpeaksIn(key, FIRST_WORDS);
    await arrive();
    await waitFor(() => expect(activeTabKey()).toBe(key));

    // The owner goes back to main on the phone, by hand.
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(MAIN));
    await arrive();
    await arrive();
    expect(activeTabKey()).toBe(MAIN);

    // The desktop speaks in the Lisbon tab again: that is newer than the pick.
    elsewhereSpeaksIn(key, "Book the train");
    await arrive();
    await waitFor(() => expect(activeTabKey()).toBe(key));
    await screen.findByText("Box heard: Book the train");
  });

  it("leaves a tab closed on the desktop for the conversation the owner carried on in, not for main", async () => {
    await openOn("phone");
    const first = "agent:main:clawbox-0a1b2c3d4e5f";
    elsewhereSpeaksIn(first, FIRST_WORDS);
    await arrive();
    await waitFor(() => expect(activeTabKey()).toBe(first));

    // On the desktop: that tab is closed, and the owner carries on in another.
    const second = "agent:main:clawbox-9f8e7d6c5b4a";
    inventory = mergeTabInventory(inventory, { close: [first] }, ++boxClock).inventory;
    elsewhereSpeaksIn(second, "Dinner ideas");
    await arrive();
    await waitFor(() => expect(activeTabKey()).toBe(second));
    expect(tabKeys()).toEqual([MAIN, second]);
    await screen.findByText("Box heard: Dinner ideas");
  });

  it("does not move the phone out from under a reply it is still waiting for", async () => {
    await openOn("phone");
    holdRuns = true;
    await say("Summarise my inbox");
    await waitFor(() => expect(heldRuns).toHaveLength(1));
    const key = "agent:main:clawbox-0a1b2c3d4e5f";
    elsewhereSpeaksIn(key, FIRST_WORDS);
    await arrive();
    expect(activeTabKey()).toBe(MAIN);

    // The reply lands; the next time the owner comes back, the phone follows.
    await act(async () => { heldRuns.shift()!(); });
    await screen.findByText("Box heard: Summarise my inbox");
    await arrive();
    await waitFor(() => expect(activeTabKey()).toBe(key));
  });

  it("never moves the owner on the minute tick — not even after an arrival that came during a reply", async () => {
    // Only the intervals are faked — before the chat mounts, so its strip's
    // one-minute tick is one this test can drive; every other timer (the
    // socket's, the fetches') runs for real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await openOn("phone");
      holdRuns = true;
      await say("Summarise my inbox");
      await waitFor(() => expect(heldRuns).toHaveLength(1));
      // The owner comes back to the phone while its own reply is still running.
      await arrive();
      await act(async () => { heldRuns.shift()!(); });
      await screen.findByText("Box heard: Summarise my inbox");

      // Later, while the owner reads that reply, the desktop speaks elsewhere —
      // and the strip's tick asks the box.
      const key = "agent:main:clawbox-0a1b2c3d4e5f";
      elsewhereSpeaksIn(key, FIRST_WORDS);
      await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
      await settle(60);
      await waitFor(() => expect(tabKeys()).toEqual([MAIN, key]));
      expect(activeTabKey()).toBe(MAIN);

      // Only the owner's next arrival moves it.
      await arrive();
      await waitFor(() => expect(activeTabKey()).toBe(key));
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a turn typed before the gateway answered into the conversation it was typed in", async () => {
    // The desktop was last active in a side conversation…
    const key = "agent:main:clawbox-0a1b2c3d4e5f";
    elsewhereSpeaksIn(key, FIRST_WORDS);
    // …and the phone opens on a gateway that is slow to answer. The owner
    // types into what is on screen — main — before it does.
    helloHeld = true;
    putAway();
    cleanup();
    window.localStorage.clear();
    current = "phone";
    sent.length = 0;
    sockets.length = 0;
    resetHarnessCache();
    render(<ChatPopup isOpen onClose={() => {}} mobile />);
    await waitFor(() => expect(holdHello).not.toBeNull());
    // The box has already said where the owner was (the mount's read).
    await settle(60);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Typed while connecting" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await settle(30);
    expect(frames("chat.send")).toHaveLength(0);

    act(() => { holdHello!(); });
    await waitFor(() => expect(frames("chat.send")).toHaveLength(1));
    // Sent where it was typed, and the phone stays there.
    expect(params(frames("chat.send")[0]).sessionKey).toBe(MAIN);
    await settle(60);
    expect(activeTabKey()).toBe(MAIN);
  });

  it("tells the box about every turn, in the conversation it was sent in", async () => {
    await openOn("desktop");
    await say("hello main");
    await waitFor(() => expect(tabPosts.some((b) => (b.activity as { key: unknown } | undefined)?.key === null)).toBe(true));
    const key = await openNewTab();
    await say(FIRST_WORDS);
    await waitFor(() => expect(tabPosts.some((b) => (b.activity as { key: unknown } | undefined)?.key === key)).toBe(true));
    expect(inventory.active?.key).toBe(key);
  });
});

describe("the full-page chat stays live", () => {
  beforeEach(() => {
    histories = { [MAIN]: [assistant(SEED_TEXT, 500)] };
    inventory = { tabs: [], closed: [] };
    boxClock = 1_790_000_000_000;
    holdRuns = false;
    tabPosts.length = 0;
    sent.length = 0;
    sockets.length = 0;
    window.localStorage.clear();
    resetHarnessCache();
    installFetch();
    vi.stubGlobal("WebSocket", FakeGatewayWs);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a turn the owner typed on the phone, without a reload", async () => {
    render(<ChatApp />);
    await screen.findByText(SEED_TEXT);
    // It asks the gateway to push this conversation's appends…
    await waitFor(() => expect(frames("sessions.messages.subscribe").map((f) => params(f).key)).toEqual([MAIN]));

    // …so the phone's turn, filed by the gateway, arrives as a push.
    histories[MAIN] = [...histories[MAIN], user("Sent from the phone", 800), assistant("Box heard: Sent from the phone", 850)];
    act(() => { socket()!.emit({ type: "event", event: "session.message", payload: { sessionKey: MAIN, message: user("Sent from the phone", 800) } }); });
    await screen.findByText("Sent from the phone");
    await screen.findByText("Box heard: Sent from the phone");
  });

  it("ignores a push for another conversation", async () => {
    render(<ChatApp />);
    await screen.findByText(SEED_TEXT);
    const reads = frames("chat.history").length;
    act(() => { socket()!.emit({ type: "event", event: "session.message", payload: { sessionKey: "agent:main:clawbox-0a1b2c3d4e5f", message: user("x", 1) } }); });
    await settle(600);
    expect(frames("chat.history").length).toBe(reads);
  });

  it("shows a turn sent here once, even from a browser whose clock runs ahead of the box", async () => {
    render(<ChatApp />);
    await screen.findByText(SEED_TEXT);
    const input = screen.getByRole("textbox");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "one bubble please" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await screen.findByText("Box heard: one bubble please");
    // The gateway pushes the append; the re-read returns the turn stamped with
    // the box's clock (600), far behind this browser's. Matched by the run's
    // id, it replaces the local bubble instead of standing beside it.
    act(() => { socket()!.emit({ type: "event", event: "session.message", payload: { sessionKey: MAIN, message: user("one bubble please", 600) } }); });
    await waitFor(() => expect(frames("chat.history").length).toBeGreaterThanOrEqual(2));
    await settle(100);
    expect(screen.getAllByText("one bubble please")).toHaveLength(1);
    expect(screen.getAllByText("Box heard: one bubble please")).toHaveLength(1);
  });

  it("tells the box the owner is in main now", async () => {
    render(<ChatApp />);
    await screen.findByText(SEED_TEXT);
    const input = screen.getByRole("textbox");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "from the full page" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(tabPosts).toContainEqual({ activity: { key: null } }));
    expect(inventory.active?.key).toBeNull();
  });
});

describe("a box that pushes nothing", () => {
  beforeEach(() => {
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("shows the other device's turn when the owner comes back to the mascot chat", async () => {
    const box = installHermesBox();
    await mountHermesChat(box);
    await screen.findByText("Earlier in this chat.");
    box.storedTranscript = [
      ...box.storedTranscript,
      { role: "user", text: "Sent from the phone", timestamp: 10 },
      { role: "assistant", text: "Noted from the phone.", timestamp: 11 },
    ];
    await arrive();
    await screen.findByText("Sent from the phone");
    await screen.findByText("Noted from the phone.");
  });

  it("…and on the full page", async () => {
    const box = installHermesBox();
    render(<ChatApp />);
    await screen.findByText("Earlier in this chat.");
    const reads = box.historyReads.length;
    box.storedTranscript = [...box.storedTranscript, { role: "user", text: "Sent from the phone", timestamp: 10 }];
    await arrive();
    await screen.findByText("Sent from the phone");
    expect(box.historyReads.length).toBeGreaterThan(reads);
  });
});
