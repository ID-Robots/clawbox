import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";
import { describeChatFailure } from "@/lib/chat-error-text";
import type { ReactNode } from "react";

// Resolve against the REAL tables rather than a hand-written map, so these
// break if a label stops reading the catalogue or a key goes away. The
// provider itself loads its tables through a dynamic import that never
// settles inside a jsdom test, which is why it is mocked at all.
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
 * Chat tabs. The "+" in the header used to open the gateway's own chat UI in
 * a new BROWSER tab; the owner asked for tabs in the header instead, each a
 * new conversation with the main agent. Every tab is its own gateway session
 * under the same agent (`agent:main:clawbox-<id>`), created lazily by the
 * first chat.send — so opening one costs a history read and a subscribe, and
 * never a `sessions.reset`, which would wipe the main conversation.
 *
 * What is pinned here:
 *  - the + binds the popup to a fresh, fully qualified key and reads ITS
 *    history (empty), with no reset and no auto-greet;
 *  - a message typed in the tab is sent to the tab's session;
 *  - switching back reloads main's transcript;
 *  - closing a tab deletes its session and returns to a neighbour;
 *  - the list and the open tab survive a remount (a refresh) and the hello
 *    binds to the open tab, not to main.
 */

const SEED_TEXT = "Here's your orange tabby";
const MAIN = "agent:main:main";
const TAB_KEY = /^agent:main:clawbox-[a-z0-9]{12}$/;

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

/** Transcript per session key, as the gateway would hold it. */
let histories: Record<string, unknown[]> = {};
/** Per-key artificial latency on chat.history, for in-flight-read races. */
let historyDelayMs: Record<string, number> = {};
/** Every frame the component sent. */
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
      case "chat.history": {
        // A key the gateway has never seen answers an empty transcript.
        const historyKey = String(params.sessionKey);
        setTimeout(
          () => this.emit({ type: "res", id, ok: true, payload: { messages: histories[historyKey] ?? [] } }),
          historyDelayMs[historyKey] ?? 0,
        );
        return;
      }
      case "sessions.reset":
        histories[String(params.key)] = [];
        this.respond(id, { ok: true, key: params.key });
        return;
      case "sessions.messages.subscribe":
        this.respond(id, { subscribed: true, key: params.key });
        return;
      case "sessions.messages.unsubscribe":
        this.respond(id, { subscribed: false, key: params.key });
        return;
      case "sessions.delete":
        delete histories[String(params.key)];
        this.respond(id, { ok: true, key: params.key, deleted: true });
        return;
      case "chat.send":
        this.respond(id, { runId: params.idempotencyKey, status: "started" });
        return;
      default:
        this.respond(id, {});
    }
  }

  close() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
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

const frames = (method: string) => sent.filter((f) => f.method === method);
const params = (f: Record<string, unknown>) => f.params as Record<string, unknown>;
const tabs = () => screen.getAllByTestId("chat-tab");
const tabKeys = () => tabs().map((el) => el.getAttribute("data-session-key"));
const activeTabKey = () => tabs().find((el) => el.getAttribute("aria-selected") === "true")?.getAttribute("data-session-key");

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

async function mountReady() {
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

async function openNewTab() {
  const plus = await screen.findByRole("button", { name: "New chat" });
  await waitFor(() => expect(plus).not.toBeDisabled());
  fireEvent.click(plus);
  await settle();
  const key = activeTabKey();
  expect(key).toMatch(TAB_KEY);
  return key as string;
}

describe("chat tabs", () => {
  beforeEach(() => {
    histories = { [MAIN]: [assistantMessage(SEED_TEXT, 500)] };
    historyDelayMs = {};
    sent.length = 0;
    sockets.length = 0;
    window.localStorage.clear();
    resetHarnessCache();
    installFetch();
    vi.stubGlobal("WebSocket", FakeGatewayWs);
    // jsdom has no layout: the transcript's scroll-to-bottom on every new
    // message would otherwise throw off the React tree as an unhandled error.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with the main session as the only tab, bound as before", async () => {
    await mountReady();
    expect(tabKeys()).toEqual([MAIN]);
    expect(activeTabKey()).toBe(MAIN);
    // `includeApprovals` rides on every subscribe this surface makes (TASK-704):
    // the opt-in is per call and not sticky, so a tab switch that dropped it
    // would silently turn the approval cards off.
    expect(params(frames("sessions.messages.subscribe")[0])).toEqual({ key: MAIN, includeApprovals: true });
  });

  it("the + opens a tab on a fresh session under the same agent: history read, subscribed, no reset, no greet", async () => {
    await mountReady();
    const key = await openNewTab();
    expect(tabKeys()).toEqual([MAIN, key]);
    // Its own transcript was read — empty — and the main one is no longer shown.
    const historyKeys = frames("chat.history").map((f) => params(f).sessionKey);
    expect(historyKeys).toContain(key);
    expect(screen.queryByText(SEED_TEXT)).toBeNull();
    // Pushes now come for the new key, and no longer for main.
    expect(frames("sessions.messages.unsubscribe").map((f) => params(f).key)).toEqual([MAIN]);
    expect(frames("sessions.messages.subscribe").map((f) => params(f).key)).toEqual([MAIN, key]);
    // The main conversation is untouched and nothing was sent on the owner's behalf.
    expect(frames("sessions.reset")).toHaveLength(0);
    expect(frames("chat.send")).toHaveLength(0);
    // It has a placeholder name until the owner says something.
    expect(tabs()[1].textContent).toBe("Chat 2");
  });

  it("a message typed in the tab goes to the tab's session, and names the tab", async () => {
    await mountReady();
    const key = await openNewTab();
    const input = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(input, { target: { value: "Plan my week in Lisbon please" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await settle();
    expect(frames("chat.send")).toHaveLength(1);
    expect(params(frames("chat.send")[0]).sessionKey).toBe(key);
    expect(tabs()[1].textContent).toBe("Plan my week in Lisbon p…");
  });

  it("switching back to main reloads its transcript", async () => {
    await mountReady();
    const key = await openNewTab();
    fireEvent.click(tabs()[0]);
    await settle();
    expect(activeTabKey()).toBe(MAIN);
    await screen.findByText(SEED_TEXT);
    expect(frames("sessions.messages.unsubscribe").map((f) => params(f).key)).toEqual([MAIN, key]);
    expect(frames("sessions.messages.subscribe").map((f) => params(f).key)).toEqual([MAIN, key, MAIN]);
  });

  it("closing the tab takes ONE tap, then deletes its session and returns to its neighbour", async () => {
    await mountReady();
    const key = await openNewTab();
    // One tap closes. It used to arm on the first tap and close on the second,
    // which painted a red "Close tab?" in place — the owner read that as a
    // confirmation dialog and asked for it gone. The tab strip is not the place
    // for a two-step gesture: a mis-tap costs one session, and the ✕ only
    // appears on the tab you are already in.
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await settle();
    expect(tabKeys()).toEqual([MAIN]);
    expect(activeTabKey()).toBe(MAIN);
    expect(frames("sessions.delete").map((f) => params(f))).toEqual([{ key, deleteTranscript: true }]);
    await screen.findByText(SEED_TEXT);
  });

  it("the tabs and the open one survive a remount, and the hello binds to the open tab", async () => {
    await mountReady();
    const key = await openNewTab();
    cleanup();
    sent.length = 0;
    sockets.length = 0;
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(socket()).not.toBeNull());
    await waitFor(() => expect(frames("chat.history").length).toBeGreaterThan(0));
    expect(tabKeys()).toEqual([MAIN, key]);
    expect(activeTabKey()).toBe(key);
    expect(params(frames("sessions.messages.subscribe")[0])).toEqual({ key, includeApprovals: true });
    expect(params(frames("chat.history")[0]).sessionKey).toBe(key);
  });

  it("the main tab has no close button", async () => {
    await mountReady();
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
  });

  async function sendInActiveTab(text: string) {
    const input = screen.getByPlaceholderText("Type a message...");
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await settle();
  }

  it("does not greet a restored empty tab after a reload", async () => {
    await mountReady();
    await openNewTab();
    cleanup();
    sent.length = 0;
    sockets.length = 0;
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(frames("chat.history").length).toBeGreaterThan(0));
    await settle();
    // The restored tab's transcript is empty — exactly the state the main
    // conversation's first-boot greet keys on. It must not fire here: the
    // greet belongs to main alone.
    expect(frames("chat.send")).toHaveLength(0);
  });

  it("a run left behind keeps its tab busy, turns unread when it ends, and is read on return", async () => {
    await mountReady();
    const key = await openNewTab();
    await sendInActiveTab("count to a billion");
    fireEvent.click(tabs()[0]); // leave mid-run
    await settle();
    expect(tabs()[1].querySelector('[data-testid="chat-tab-busy"]')).not.toBeNull();
    // The run ends while the owner is elsewhere: busy -> unread. This also
    // pins the pre-filter ORDER — the terminal event for a non-active key
    // must be seen before the session filter drops it.
    histories[key] = [
      { role: "user", content: [{ type: "text", text: "count to a billion" }], timestamp: 600 },
      assistantMessage("done", 700),
    ];
    await act(async () => {
      socket().emit({ type: "event", event: "chat", payload: { sessionKey: key, runId: "r9", state: "final", message: assistantMessage("done", 700) } });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(tabs()[1].querySelector('[data-testid="chat-tab-busy"]')).toBeNull();
    expect(tabs()[1].querySelector('[data-testid="chat-tab-unread"]')).not.toBeNull();
    fireEvent.click(tabs()[1]);
    await settle();
    expect(tabs()[1].querySelector('[data-testid="chat-tab-unread"]')).toBeNull();
    await screen.findByText("done");
  });

  it("returning to a busy tab restores the running-turn controls", async () => {
    await mountReady();
    await openNewTab();
    await sendInActiveTab("still going");
    fireEvent.click(tabs()[0]);
    await settle();
    fireEvent.click(tabs()[1]);
    await settle();
    // The run is still out: Stop is back and the composer queues behind it.
    expect(screen.getByTitle(translations.en["chat.stop"])).toBeTruthy();
  });

  it("an error that ended a background run is shown when the tab is next opened", async () => {
    await mountReady();
    const key = await openNewTab();
    await sendInActiveTab("please fail");
    fireEvent.click(tabs()[0]);
    await settle();
    await act(async () => {
      socket().emit({ type: "event", event: "chat", payload: { sessionKey: key, runId: "r9", state: "error", errorMessage: "model exploded" } });
      await new Promise((r) => setTimeout(r, 20));
    });
    fireEvent.click(tabs()[1]);
    await settle();
    // The transcript on the gateway has no error line — the client kept it.
    await screen.findByText(describeChatFailure("model exploded"));
  });

  it("closing the tab you are in mid-run aborts the run before deleting the session", async () => {
    await mountReady();
    const key = await openNewTab();
    await sendInActiveTab("long task");
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await settle();
    const abortIdx = sent.findIndex((f) => f.method === "chat.abort" && params(f).sessionKey === key);
    const deleteIdx = sent.findIndex((f) => f.method === "sessions.delete" && params(f).key === key);
    expect(abortIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(abortIdx);
    expect(tabKeys()).toEqual([MAIN]);
  });

  it("a closed tab's number is not minted again while a later one lives", async () => {
    await mountReady();
    await openNewTab(); // Chat 2
    await openNewTab(); // Chat 3, active
    fireEvent.click(tabs()[1]); // over to Chat 2
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" })); // closes Chat 2
    await settle();
    expect(tabs().map((el) => el.textContent)).toEqual(["ClawBox", "Chat 3"]);
    fireEvent.click(screen.getByTestId("chat-new-tab"));
    await settle();
    expect(tabs().map((el) => el.textContent)).toEqual(["ClawBox", "Chat 3", "Chat 4"]);
  });

  it("a history read still in flight for the old tab cannot paint into the new one", async () => {
    await mountReady();
    historyDelayMs[MAIN] = 800;
    // A pushed append schedules main's 400 ms reconcile read...
    await act(async () => {
      socket().emit({ type: "event", event: "session.message", payload: { sessionKey: MAIN, message: assistantMessage("late reply", 900) } });
      await new Promise((r) => setTimeout(r, 500)); // debounce fired; the read is in flight
    });
    await openNewTab(); // ...and the owner switches before it answers.
    await act(async () => { await new Promise((r) => setTimeout(r, 900)); }); // the stale answer lands
    expect(screen.queryByText(SEED_TEXT)).toBeNull();
    expect(tabs()[1].textContent).toBe("Chat 2");
  });

  it("a remembered size larger than the screen is clamped to it", async () => {
    window.localStorage.setItem("clawbox-chat-size", JSON.stringify({ w: 2400, h: 1600 }));
    await mountReady();
    const popup = screen.getByTestId("chat-popup");
    expect(popup.style.width).toBe(`${window.innerWidth - 16}px`);
    expect(popup.style.height).toBe(`${window.innerHeight - 16}px`);
  });

  it("the main tab's hover ✕ starts a fresh main session and never greets", async () => {
    await mountReady();
    fireEvent.click(screen.getByTestId("chat-tab-restart"));
    await settle();
    expect(frames("sessions.reset").map((f) => params(f))).toEqual([{ key: MAIN, reason: "new" }]);
    expect(screen.queryByText(SEED_TEXT)).toBeNull();
    expect(frames("chat.send")).toHaveLength(0);
    expect(tabKeys()).toEqual([MAIN]);
  });
  it("names the transcript as the tab strip's panel, with ids a session key can carry", async () => {
    // The strip and the transcript are the SAME JSX on both editions; the
    // Hermes suite proves the behaviour, and this proves the half that only
    // exists here — an OpenClaw session key is `agent:main:clawbox-…`, and a
    // colon has to be escaped in every CSS selector an id is looked up with.
    await mountReady();
    await openNewTab();

    const panel = screen.getByTestId("chat-transcript");
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel.id).toBeTruthy();
    for (const tab of tabs()) {
      const key = tab.getAttribute("data-session-key") ?? "";
      expect(tab.getAttribute("aria-controls"), key).toBe(panel.id);
      expect(tab.id, key).toMatch(/^chat-tab-[A-Za-z0-9_-]+$/);
      expect(tab.id, key).not.toContain(":");
    }
    expect(tabs()[0].id).toBe("chat-tab-main");
    expect(tabs()[1].id).toMatch(/^chat-tab-agent_main_clawbox-[a-z0-9]{12}$/);

    const selected = () => tabs().find((el) => el.getAttribute("aria-selected") === "true")!;
    expect(panel.getAttribute("aria-labelledby")).toBe(selected().id);

    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(MAIN));
    expect(panel.getAttribute("aria-labelledby")).toBe(selected().id);
  });
});
