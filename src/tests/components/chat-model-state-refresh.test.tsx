// The chat's model-state re-read: once a minute, on every focus and on every
// provider signal, the popup asks /setup-api/chat/model what the box runs —
// and nearly always hears exactly what its header already shows.
//
// Handed a fresh object every time, the whole popup rendered for it. It keeps
// the object it holds now when the answer is equal by value — but the fresh
// object used to re-run the two effort effects as a side effect, and two
// behaviours rode on that which must survive:
//
//   - a reasoning push the gateway REFUSED is retried by the next re-read;
//   - an effort level persisted from another window of this browser is adopted
//     by the next re-read.
//
// Mounted against a fake gateway socket; the popup's renders are counted
// through `useKioskBarInset`, a hook it calls once per render and that nothing
// else mounted here uses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { PERSIST_KEY_PREFIX } from "@/lib/chat-reasoning";

// See test-timeout-hygiene.test.ts: a jsdom mount of ChatPopup costs seconds
// under a full parallel run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const counters = vi.hoisted(() => ({ popupRenders: 0 }));
vi.mock("@/lib/kiosk-bar-inset", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/kiosk-bar-inset")>();
  return {
    ...actual,
    useKioskBarInset: () => {
      counters.popupRenders += 1;
      return actual.useKioskBarInset();
    },
  };
});

const SEED_TEXT = "Your tabby is ready";
const FLASH_MODEL = "deepseek/deepseek-v4-flash";

const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
/** How the next `sessions.patch` is answered: null = accepted, else the refusal. */
const patchRefusals: Array<string | null> = [];
let modelReads = 0;

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
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: [{ role: "assistant", content: [{ type: "text", text: SEED_TEXT }], timestamp: 500 }] });
      return;
    }
    if (frame.method === "sessions.patch") {
      const refusal = patchRefusals.shift() ?? null;
      if (refusal) {
        setTimeout(() => this.emit({ type: "res", id, ok: false, error: { message: refusal } }), 0);
      } else {
        this.respond(id, {});
      }
      return;
    }
    this.respond(id, { runId: "r1", status: "started" });
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

/**
 * ClawBox AI on Flash, with the reasoning levels the gateway publishes for it —
 * a fresh object on every read, the same content every time.
 */
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/gateway/ws-config")) {
      return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    }
    if (url.includes("/setup-api/harness/active")) {
      return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    }
    if (url.includes("/setup-api/chat/capabilities")) {
      return { ok: true, json: async () => ({ harness: "openclaw", facts: { hasClawaiToken: true, hermesSupportsImages: false } }) };
    }
    if (url.includes("/setup-api/ai-models/status")) {
      return { ok: true, json: async () => ({
        clawaiAccountTier: "pro", clawaiTier: "pro",
        clawaiAllowedModels: ["deepseek-v4-flash"],
        clawaiConfigured: true, clawaiLoggedIn: true,
      }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      modelReads += 1;
      return {
        ok: true,
        json: async () => ({
          activeOptionId: "clawai",
          activeModel: FLASH_MODEL,
          activeSource: "primary",
          activeLabel: "ClawBox AI",
          options: [{
            id: "clawai", label: "ClawBox AI", model: FLASH_MODEL,
            provider: "clawai", available: true, settingsSection: "ai", isLocal: false,
            thinkingLevels: ["off", "low", "medium", "high"],
          }],
          primary: { available: true, label: "ClawBox AI", model: FLASH_MODEL },
          local: { available: false, label: null, model: null },
        }),
      };
    }
    if (url.includes("/setup-api/chat/spoken-history")) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  }));
}

const patches = () => sent.filter((f) => f.method === "sessions.patch");
const levelOf = (frame: Record<string, unknown>) => (frame.params as Record<string, unknown>).thinkingLevel;

async function mountChat() {
  installFetch();
  render(<ChatPopup isOpen onClose={() => {}} />);
  await screen.findByText(SEED_TEXT);
  await waitFor(() => expect(patches().length).toBeGreaterThan(0));
}

/**
 * The owner coming back to the window — the commonest re-read there is (focus
 * returns each time they click out of an app's iframe) — all the way through.
 * Focus rather than a provider signal: a signal also wakes the catalogue and
 * capability hooks, whose renders are theirs, not this re-read's.
 */
async function reread() {
  const before = modelReads;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(modelReads).toBe(before + 1));
  // The read's own promise chain, and anything it scheduled, settles.
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
}

const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

beforeEach(() => {
  // The re-read on focus is only for a window on screen.
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  sent.length = 0;
  sockets.length = 0;
  patchRefusals.length = 0;
  modelReads = 0;
  counters.popupRenders = 0;
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
  if (visibility) Object.defineProperty(document, "visibilityState", visibility);
  else delete (document as { visibilityState?: unknown }).visibilityState;
});

describe("re-reading the chat's model state", () => {
  it("does not render the popup for an answer it already shows", async () => {
    await mountChat();
    // React may call a component once more to find out that an update changed
    // nothing (and then bails out of the commit) — measured here as one call
    // over the first two re-reads. From there on an unchanged answer costs no
    // render at all; before, every one of them rendered the whole popup.
    await reread();
    await reread();
    const settled = counters.popupRenders;

    for (let i = 0; i < 3; i++) await reread();

    expect(counters.popupRenders).toBe(settled);
    // Nothing was pushed again, either: the level on the box is the one shown.
    expect(patches()).toHaveLength(1);
  });

  it("still retries a reasoning push the gateway refused, on the next re-read", async () => {
    patchRefusals.push("gateway busy");
    await mountChat();
    expect(levelOf(patches()[0])).toBe("medium");
    await screen.findByText(/Failed to change effort: gateway busy/);

    await reread();
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(levelOf(patches()[1])).toBe("medium");

    // Accepted this time: nothing is owed, and the next re-read pushes nothing.
    await reread();
    await reread();
    expect(patches()).toHaveLength(2);
  });

  it("adopts an effort level another window of this browser saved, on the next re-read", async () => {
    await mountChat();
    expect(levelOf(patches()[0])).toBe("medium");

    window.localStorage.setItem(`${PERSIST_KEY_PREFIX}:clawai`, "high");
    await reread();

    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(levelOf(patches()[1])).toBe("high");
  });
});
