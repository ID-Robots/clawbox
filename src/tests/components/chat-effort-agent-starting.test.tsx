// The effort picker right after the gateway restarts.
//
// The socket comes back before the agent does: until the agent's database has
// been inspected and prepared, the gateway refuses the chat's `sessions.patch`
// with "Agent main has not completed startup inspection and preparation … run
// `openclaw doctor --fix`". The chat showed that as a red "Failed to change
// effort" over "Restoring this conversation…" for the few seconds every restart
// takes — a normal state, worded as a fault, with repair advice the owner did
// not need. It now waits for the agent (bounded), shows a quiet "Starting…" on
// the picker meanwhile, and applies the level once the agent takes it.
//
// Mounted against a fake gateway socket, with the wait's numbers shortened so a
// test runs in seconds; the rules themselves are unit-tested in
// src/tests/unit/chat-agent-starting.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { gatewayFrameError } from "@/lib/chat-gateway-starting";
import { HarnessError, type HarnessAdapter } from "@/lib/harness/transport";
import { useSlashCommands } from "@/lib/use-slash-commands";

// See test-timeout-hygiene.test.ts: a jsdom mount of ChatPopup costs seconds
// under a full parallel run.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/chat-gateway-starting", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat-gateway-starting")>();
  return { ...actual, AGENT_STARTING_RETRY_DELAYS_MS: [250], AGENT_STARTING_DEADLINE_MS: 1_500 };
});

const SEED_TEXT = "Your tabby is ready";
const FLASH_MODEL = "deepseek/deepseek-v4-flash";
const NOT_READY =
  "Agent main has not completed startup inspection and preparation. If this persists, run `openclaw doctor --fix`.";

const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
/** How the next `sessions.patch` is answered: null = accepted, else the error frame. */
const patchRefusals: Array<Record<string, unknown> | null> = [];

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
        setTimeout(() => this.emit({ type: "res", id, ok: false, error: refusal }), 0);
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

/** ClawBox AI on Flash, with the reasoning levels the gateway publishes for it. */
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
const picker = (label: string) => screen.findByRole("button", { name: `Reasoning effort: ${label}` }, { timeout: 8_000 });
const noFaultShown = () => {
  expect(screen.queryByText(/Failed to change effort/)).toBeNull();
  expect(screen.queryByText(/doctor --fix/)).toBeNull();
  expect(screen.queryByText(/startup inspection/)).toBeNull();
};

async function mountChat() {
  installFetch();
  render(<ChatPopup isOpen onClose={() => {}} />);
  await screen.findByText(SEED_TEXT);
  await waitFor(() => expect(patches().length).toBeGreaterThan(0));
}

const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  sent.length = 0;
  sockets.length = 0;
  patchRefusals.length = 0;
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

describe("the effort picker while the agent is starting", () => {
  it("shows a quiet Starting…, no error, and applies the level once the agent takes it", async () => {
    // Prose only, as an older core sends it — and flagged final, which the
    // sentence overrides: it says "still running".
    patchRefusals.push(
      { message: NOT_READY },
      { code: "INVALID_REQUEST", retryable: false, message: NOT_READY },
    );
    await mountChat();
    // The first refusal has landed by now (the fake answers on the next tick):
    // this is where the red line used to appear.
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    noFaultShown();

    const starting = await picker("Starting…");
    expect((starting as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => expect(patches()).toHaveLength(3), { timeout: 8_000 });
    const ready = await picker("Medium");
    expect((ready as HTMLButtonElement).disabled).toBe(false);
    // The level the owner sees is the one that was applied, every try alike.
    expect(patches().map(levelOf)).toEqual(["medium", "medium", "medium"]);
    noFaultShown();
  });

  it("says so once, plainly, when the agent is still not ready at the bound — and frees the picker", async () => {
    for (let i = 0; i < 60; i++) {
      patchRefusals.push({ code: "UNAVAILABLE", message: "agent unavailable", details: { code: "agent-database-inspection-pending" } });
    }
    await mountChat();

    await screen.findByText(/still starting up/, {}, { timeout: 8_000 });
    noFaultShown();
    const freed = await picker("Medium");
    expect((freed as HTMLButtonElement).disabled).toBe(false);

    // The next re-read owes the push again, and waits again — quietly: one
    // note for an agent that does not come up, not one per wait.
    const before = patches().length;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(patches().length).toBeGreaterThan(before), { timeout: 8_000 });
    await picker("Starting…");
    await picker("Medium");
    expect(screen.getAllByText(/still starting up/)).toHaveLength(1);
    noFaultShown();
  });

  it("shows Starting… from the moment the gateway drops until it is back", async () => {
    await mountChat();
    await picker("Medium");

    await act(async () => { sockets[0].close(); });
    const starting = await picker("Starting…");
    expect((starting as HTMLButtonElement).disabled).toBe(true);

    // The chat reconnects on its own ladder, the overlay comes down, and the
    // picker is usable again.
    await waitFor(() => expect(sockets.length).toBeGreaterThan(1), { timeout: 8_000 });
    await picker("Medium");
    noFaultShown();
  });
});

describe("the slash-command catalogue while the agent is starting", () => {
  it("waits for the agent rather than spending its short failure budget on boot", async () => {
    vi.useFakeTimers();
    try {
      const notReady = () => new HarnessError("upstream", NOT_READY, gatewayFrameError({ message: NOT_READY }));
      const listCommands = vi.fn()
        .mockRejectedValueOnce(notReady())
        .mockRejectedValueOnce(notReady())
        .mockRejectedValueOnce(notReady())
        .mockRejectedValueOnce(notReady())
        .mockResolvedValueOnce([{ name: "/status", description: "Show status" }]);
      const adapter = { listCommands } as unknown as HarnessAdapter;
      renderHook(() => useSlashCommands({
        adapter, status: "connected", value: "", setValue: () => {}, inputRef: { current: null },
      }));
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      // Four refusals over ~15 s of boot, then the catalogue. The failure
      // budget alone (three tries over ~17 s) gave up before the agent was up.
      expect(listCommands).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
