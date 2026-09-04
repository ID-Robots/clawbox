import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { PERSIST_KEY_PREFIX } from "@/lib/chat-reasoning";

/**
 * The reasoning-effort default the chat pushes to the gateway, per ClawBox AI
 * tier. Product decision (2026-08-24): the Max tier (DeepSeek V4 Pro) reasons
 * by default; Flash stays fast. The default is a property of the MODEL the
 * chat is on, and a level the user picked themselves still wins over it.
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

  close() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

/** ClawBox AI on the given tier model, for a Max-plan account so the
 *  entitlement guard in ChatPopup leaves the Pro model alone. */
function installFetch(model: string) {
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
      // `clawaiAllowedModels` is what the entitlement guard reads — without it
      // the guard is quiet because the question was unanswered, not because
      // this account is entitled, and the fixture would stop meaning what its
      // comment says.
      return { ok: true, json: async () => ({
        clawaiAccountTier: "pro",
        clawaiTier: "pro",
        clawaiAllowedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
        clawaiConfigured: true,
        clawaiLoggedIn: true,
      }) };
    }
    if (url.includes("/setup-api/chat/model")) {
      return {
        ok: true,
        json: async () => ({
          activeOptionId: "primary",
          activeModel: model,
          activeSource: "primary",
          activeLabel: "ClawBox AI",
          options: [{
            id: "primary", label: "ClawBox AI", model,
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
  return params.thinkingLevel;
}

describe("chat reasoning default per ClawBox AI tier", () => {
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

  it("starts the Max tier (DeepSeek V4 Pro) at medium", async () => {
    await expect(firstPushedThinkingLevel(PRO_MODEL)).resolves.toBe("medium");
  });

  it("keeps Flash fast — off — on the same provider", async () => {
    await expect(firstPushedThinkingLevel(FLASH_MODEL)).resolves.toBe("off");
  });

  it("lets a level the user picked earlier override the Max-tier default", async () => {
    window.localStorage.setItem(`${PERSIST_KEY_PREFIX}:clawai`, "off");
    await expect(firstPushedThinkingLevel(PRO_MODEL)).resolves.toBe("off");
  });

  it("never pushes a level the tier's ladder does not offer, even if one was persisted", async () => {
    // A stale `xhigh` from an older picker is not on the uniform ladder; the
    // persisted read ignores it and the tier default applies.
    window.localStorage.setItem(`${PERSIST_KEY_PREFIX}:clawai`, "xhigh");
    await expect(firstPushedThinkingLevel(PRO_MODEL)).resolves.toBe("medium");
  });
});
