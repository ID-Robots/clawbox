import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import ChatApp from "@/components/ChatApp";
import { resetHarnessCache } from "@/lib/client-harness";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * A turn the provider refused reached the owner as "The agent run failed
 * before producing a reply." (a box, 2026-09-17) while the gateway's journal
 * had the reason: HTTP 400 "… does not support this model; version … or newer
 * is required". The gateway hands the client that reason on the `agent`
 * lifecycle stream a few frames before the `chat` error — the frames below
 * are the ones a box sent, verbatim but for ids. Both surfaces must turn them
 * into a sentence that names the provider's refusal.
 */

const MAIN = "agent:main:main";
const RUN = "run-1";

const lifecycle = (data: Record<string, unknown>) => ({
  type: "event",
  event: "agent",
  payload: { runId: RUN, sessionKey: MAIN, agentId: "main", stream: "lifecycle", data, seq: 1, ts: 1, isHeartbeat: false },
});

const FRAMES = [
  lifecycle({
    phase: "finishing",
    error: "The agent run failed before producing a reply.",
    errorObservation: { provider: "anthropic", model: "claude-fable-5-1", failoverReason: "format" },
    aborted: false,
    livenessState: "blocked",
    endedAt: 2,
  }),
  lifecycle({
    phase: "fallback_step",
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: "anthropic/claude-fable-5-1",
    fallbackStepFromFailureReason: "format",
    fallbackStepFromFailureDetail:
      'HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.75 does not support this model; version 2.1.251 or newer is required"},"request_id":"req_000000000000000000000000"}',
    fallbackStepChainPosition: 1,
    fallbackStepFinalOutcome: "chain_exhausted",
  }),
  lifecycle({
    phase: "error",
    error: "The agent run failed before producing a reply.",
    errorObservation: { provider: "anthropic", model: "claude-fable-5-1", failoverReason: "format" },
    startedAt: 1,
    endedAt: 3,
    executionSettled: true,
  }),
  {
    type: "event",
    event: "chat",
    payload: {
      runId: RUN,
      sessionKey: MAIN,
      agentId: "main",
      seq: 7,
      state: "error",
      errorMessage: "The agent run failed before producing a reply.",
      errorDetail: { provider: "anthropic", model: "claude-fable-5-1", failoverReason: "format" },
    },
  },
];

const AUTH_DETAIL =
  "unexpected status 401 Unauthorized: Incorrect API key provided: claw_08d*************************765e. You can find your API key at https://platform.openai.com/account/api-keys., url: https://api.openai.com/v1/responses, cf-ray: a3c7c040e8e4bc1a-SOF, request id: req_000000000000000000000000";

/** The same run shape when the configured fallback answers: the turn ends `final`. */
const FALLBACK_FRAMES = [
  lifecycle({
    phase: "fallback_step",
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: "openai/gpt-6-astra",
    fallbackStepToModel: "deepseek/deepseek-v4-flash",
    fallbackStepFromFailureReason: "auth",
    fallbackStepFromFailureDetail: AUTH_DETAIL,
    fallbackStepChainPosition: 1,
    fallbackStepFinalOutcome: "candidate_succeeded",
  }),
  {
    type: "event",
    event: "chat",
    payload: { runId: RUN, sessionKey: MAIN, agentId: "main", seq: 9, state: "final", stopReason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Hi from the fallback." }], timestamp: 900 } },
  },
  lifecycle({
    phase: "fallback",
    selectedProvider: "openai",
    selectedModel: "gpt-6-astra",
    activeProvider: "deepseek",
    activeModel: "deepseek-v4-flash",
    reasonSummary: "auth",
    attempts: [{ provider: "openai", model: "gpt-6-astra", error: AUTH_DETAIL }],
  }),
];

const EXPECTED_NOTE =
  "This reply came from deepseek-v4-flash, not gpt-6-astra: OpenAI did not accept this box's sign-in for gpt-6-astra (“Incorrect API key provided”). Reconnect it in Settings, under Providers, to get gpt-6-astra back.";

const EXPECTED =
  "That message did not go through — Anthropic rejected the request for claude-fable-5-1: “Claude Code 2.1.75 does not support this model; version 2.1.251 or newer is required”. Pick another model in the header, or send it again.";

const sockets: FakeGatewayWs[] = [];

class FakeGatewayWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(public url: string) {
    sockets.push(this);
    setTimeout(() => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }), 0);
  }

  send(raw: string) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "req") return;
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }], timestamp: 500 }] });
      return;
    }
    this.respond(id, {});
  }

  close() { this.readyState = FakeGatewayWs.CLOSED; }
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

async function connected() {
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  await screen.findByText("Ready.");
  return sockets[sockets.length - 1];
}

async function pushFrames(socket: FakeGatewayWs, frames: unknown[]) {
  for (const frame of frames) {
    await act(async () => {
      socket.emit(frame);
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("a turn the provider refused", () => {
  beforeEach(() => {
    sockets.length = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("the mascot chat names the provider's reason instead of the gateway's shrug", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const socket = await connected();
    await pushFrames(socket, FRAMES);
    await screen.findByText(EXPECTED);
    expect(screen.queryByText(/agent run failed/i)).toBeNull();
    expect(screen.queryByText(/request_id/)).toBeNull();
  });

  it("the full-screen chat does the same", async () => {
    render(<ChatApp />);
    const socket = await connected();
    await pushFrames(socket, FRAMES);
    await screen.findByText(EXPECTED);
    expect(screen.queryByText(/agent run failed/i)).toBeNull();
  });
});

describe("a reply the configured fallback wrote", () => {
  beforeEach(() => {
    sockets.length = 0;
    resetHarnessCache();
    window.localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetHarnessCache();
  });

  it("the mascot chat says which model answered and why the picked one did not", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    const socket = await connected();
    await pushFrames(socket, FALLBACK_FRAMES);
    await screen.findByText("Hi from the fallback.");
    await screen.findByText(EXPECTED_NOTE);
    expect(screen.queryByText(/claw_|765e/)).toBeNull();
  });

  it("the full-screen chat does the same", async () => {
    render(<ChatApp />);
    const socket = await connected();
    await pushFrames(socket, FALLBACK_FRAMES);
    await screen.findByText("Hi from the fallback.");
    await screen.findByText(EXPECTED_NOTE);
  });
});
