import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { PERSIST_KEY_PREFIX } from "@/lib/chat-reasoning";

// A jsdom mount of `ChatPopup` — the fake gateway handshake, the model seed,
// the transcript — costs seconds under a full parallel run, and a case does it
// once and then waits on several sub-5 s `waitFor`s in series. Every component
// suite that mounts it declares both ceilings; `test-timeout-hygiene.test.ts`
// is the rule, and says there why 5 s is the wrong budget here and 30 s still
// fails a test that has genuinely hung.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


/**
 * Both legacy ClawBox AI model ids now serve Flash 4.1 and start with reasoning
 * off. A level the user picked themselves still wins over that default.
 *
 * Mounts the real ChatPopup against a fake gateway socket and asserts the
 * first `sessions.patch{thinkingLevel}` frame — the wire value is what the
 * gateway will actually apply to the session, so it is the thing to pin.
 */

const SEED_TEXT = "Your tabby is ready";
const PRO_MODEL = "deepseek/deepseek-v4-pro";
const FLASH_MODEL = "deepseek/deepseek-v4-flash";

let history: unknown[] = [];
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
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: history });
      return;
    }
    if (frame.method === "sessions.reset") {
      history = [];
      this.respond(id, {});
      return;
    }
    if (frame.method === "sessions.patch") {
      this.respond(id, {});
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

/** A Max-plan account whose legacy aliases both serve Flash 4.1. */
function installFetch(model: string) {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
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
      // A Max subscription still allows both legacy ids, but neither should
      // make chat opt into reasoning when the user has not selected it.
      return { ok: true, json: async () => ({
        clawaiAccountTier: "pro",
        clawaiTier: "pro",
        clawaiAllowedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
        clawaiConfigured: true,
        clawaiLoggedIn: true,
      }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      if (init?.method === "POST") {
        model = (JSON.parse(String(init.body)) as { model: string }).model;
      }
      return {
        ok: true,
        json: async () => ({
          activeOptionId: "clawai",
          activeModel: model,
          activeSource: "primary",
          activeLabel: "ClawBox AI",
          options: [{
            id: "clawai", label: "ClawBox AI", model,
            provider: "clawai", available: true, settingsSection: "ai", isLocal: false,
          }],
          primary: { available: true, label: "ClawBox AI", model },
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

const framesFor = (method: string) => sent.filter((f) => f.method === method);

async function firstPushedThinkingLevel(model: string): Promise<unknown> {
  installFetch(model);
  render(<ChatPopup isOpen onClose={() => {}} />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
  await waitFor(() => expect(framesFor("sessions.patch").length).toBeGreaterThan(0));
  const params = framesFor("sessions.patch")[0].params as Record<string, unknown>;
  expect(params.key).toBe("agent:main:main");
  expect(params.model).toBe(FLASH_MODEL);
  expect(framesFor("sessions.reset")).toHaveLength(0);
  return params.thinkingLevel;
}

describe("chat reasoning default for ClawBox AI Flash 4.1", () => {
  beforeEach(() => {
    history = [{ role: "assistant", content: [{ type: "text", text: SEED_TEXT }], timestamp: 500 }];
    sent.length = 0;
    sockets.length = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("starts the legacy V4 Pro alias at off", async () => {
    await expect(firstPushedThinkingLevel(PRO_MODEL)).resolves.toBe("off");
  });

  it("keeps Flash fast — off — on the same provider", async () => {
    await expect(firstPushedThinkingLevel(FLASH_MODEL)).resolves.toBe("off");
  });

  it.each([PRO_MODEL, FLASH_MODEL])("keeps the user's selected effort on %s", async (model) => {
    window.localStorage.setItem(`${PERSIST_KEY_PREFIX}:clawai`, "high");
    await expect(firstPushedThinkingLevel(model)).resolves.toBe("high");
  });

  it("never pushes a level the provider's ladder does not offer, even if one was persisted", async () => {
    // A stale `xhigh` from an older picker is not on the uniform ladder; the
    // persisted read ignores it and the off default applies.
    window.localStorage.setItem(`${PERSIST_KEY_PREFIX}:clawai`, "xhigh");
    await expect(firstPushedThinkingLevel(PRO_MODEL)).resolves.toBe("off");
  });
});
