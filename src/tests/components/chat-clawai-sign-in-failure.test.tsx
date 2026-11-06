import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { OPEN_CLAWAI_OFFER_EVENT, OPEN_SETTINGS_SECTION_EVENT } from "@/lib/ui-events";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * A ClawBox AI box whose sign-in the gateway could not use (2026-10-30): the
 * owner typed "хей", and the chat showed the question with nothing under it —
 * no reply and no error. The frames below are what the pinned core (2026.10.7)
 * sent for that turn on a lab board: the run's lifecycle error, ONE chat error
 * frame, then the `session.message` push for the failure row it stored — and
 * the re-read that push triggers returns that row as `role: "custom"`.
 *
 * Before the fix the mascot chat painted its line on the error frame and lost
 * it on that re-read (it keeps no notes across a read, and the projection
 * dropped the stored row), and neither chat offered the one thing that fixes
 * it: signing in to ClawBox AI again.
 */

const MAIN = "agent:main:main";
const SEED_TEXT = "Ready when you are.";
const PROMPT = "хей";
const NO_KEY_ERROR =
  'No API key found for provider "deepseek". Auth store: /home/clawbox/.openclaw/agents/main/agent/openclaw-agent.sqlite '
  + "(agentDir: /home/clawbox/.openclaw/agents/main/agent). Configure an API key (openclaw models auth paste-api-key "
  + "--provider deepseek; add --agent <id> for a non-default agent) or copy only portable static auth profiles from "
  + "the main agentDir. | missing-provider-auth";
const SIGN_IN_LINE = /this box has no working ClawBox AI sign-in/;

let histories: Record<string, unknown[]> = {};
const sent: Array<Record<string, unknown>> = [];
const sockets: FakeGatewayWs[] = [];
const socket = () => sockets[sockets.length - 1] ?? null;

class FakeGatewayWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
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
    if (frame.method === "connect") return this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
    if (frame.method === "chat.history") return this.respond(id, { messages: histories[String(params.sessionKey)] ?? [] });
    if (frame.method === "chat.send") return this.respond(id, { runId: params.idempotencyKey, status: "started" });
    this.respond(id, {});
  }

  close() { this.readyState = FakeGatewayWs.CLOSED; }

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
    if (url.includes("/setup-api/gateway/ws-config")) return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
    if (url.includes("/setup-api/harness/active")) return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
    if (url.includes("/setup-api/chat/model")) return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
    if (url.includes("/setup-api/chat/spoken-history")) return { ok: true, json: async () => ({ items: [] }) };
    return { ok: true, headers: new Headers(), json: async () => ({}) };
  }));
}

const bubbles = (text: string | RegExp) => screen.queryAllByText(text).filter((el) => el.tagName !== "TEXTAREA");

function lastSend(): { runId: string; sessionKey: string } {
  const send = sent.filter((f) => f.method === "chat.send").pop();
  const params = (send?.params ?? {}) as { idempotencyKey?: string; sessionKey?: string };
  return { runId: String(params.idempotencyKey ?? ""), sessionKey: String(params.sessionKey ?? "") };
}

async function push(event: string, payload: Record<string, unknown>, settleMs = 20) {
  await act(async () => {
    socket()?.emit({ type: "event", event, payload });
    await new Promise((r) => setTimeout(r, settleMs));
  });
}

async function sendPrompt(): Promise<{ runId: string; sessionKey: string }> {
  const before = lastSend().runId;
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: PROMPT } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(lastSend().runId).not.toBe(before));
  await waitFor(() => expect(bubbles(PROMPT)).toHaveLength(1));
  return lastSend();
}

async function mount(surface: "popup" | "page") {
  if (surface === "popup") render(<ChatPopup isOpen onClose={() => {}} />);
  else render(<ChatApp />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

/** The turn exactly as the board's gateway ended it, and the row it stored. */
async function failWithoutSignIn(runId: string, sessionKey: string) {
  await push("agent", {
    runId, sessionKey, stream: "lifecycle",
    data: { phase: "fallback_step", fallbackStepFromModel: "deepseek/deepseek-v4-flash", fallbackStepFromFailureReason: "auth", fallbackStepFromFailureDetail: NO_KEY_ERROR },
  });
  await push("agent", { runId, sessionKey, stream: "lifecycle", data: { phase: "error", error: NO_KEY_ERROR, executionSettled: true } });
  await push("chat", { runId, sessionKey, agentId: "main", seq: 4, state: "error", errorMessage: NO_KEY_ERROR });
  const stored = {
    role: "custom", customType: "run-failed-before-reply", display: true, timestamp: 1_793_374_114_575,
    content: `Your request couldn't be completed: ${NO_KEY_ERROR}`, __openclaw: { seq: 2, runId },
  };
  histories[MAIN] = [
    ...histories[MAIN],
    { role: "user", content: [{ type: "text", text: PROMPT }], timestamp: 1_793_374_114_000, idempotencyKey: `${runId}:user` },
    stored,
  ];
  // The push for the stored row; the re-read it schedules lands after 400 ms.
  await push("session.message", { sessionKey, message: stored }, 700);
}

describe.each([
  ["the mascot chat", "popup"],
  ["the full-page chat", "page"],
] as const)("a ClawBox AI turn with no usable sign-in — %s", (_name, surface) => {
  beforeEach(() => {
    histories = { [MAIN]: [{ role: "assistant", content: [{ type: "text", text: SEED_TEXT }], timestamp: 500 }] };
    sent.length = 0;
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

  it("keeps ONE visible error under the question across the re-read, with no device path in it", async () => {
    await mount(surface);
    const { runId, sessionKey } = await sendPrompt();
    await failWithoutSignIn(runId, sessionKey);

    await waitFor(() => expect(bubbles(SIGN_IN_LINE)).toHaveLength(1));
    expect(bubbles(PROMPT)).toHaveLength(1);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/openclaw-agent\.sqlite|paste-api-key|Your request couldn't be completed/);
  });

  it("offers to sign in to ClawBox AI again, which opens Settings → AI on the ClawBox AI sign-in", async () => {
    await mount(surface);
    const { runId, sessionKey } = await sendPrompt();
    await failWithoutSignIn(runId, sessionKey);

    const button = await screen.findByTestId("chat-notice-clawai-sign-in");
    expect(button.textContent).toBe("Sign in to ClawBox AI again");
    const offers: string[] = [];
    const sections: string[] = [];
    const onOffer = () => offers.push("offer");
    const onSection = (event: Event) => sections.push(String((event as CustomEvent<{ section?: string }>).detail?.section));
    window.addEventListener(OPEN_CLAWAI_OFFER_EVENT, onOffer);
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onSection);
    fireEvent.click(button);
    window.removeEventListener(OPEN_CLAWAI_OFFER_EVENT, onOffer);
    window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onSection);
    expect(offers).toEqual(["offer"]);
    expect(sections).toEqual(["ai"]);
    expect((window as Window & { __clawboxPendingClawAiOffer?: boolean }).__clawboxPendingClawAiOffer).toBe(true);
    delete (window as Window & { __clawboxPendingClawAiOffer?: boolean }).__clawboxPendingClawAiOffer;
  });

  it("says so when a run ends with no reply and no error at all", async () => {
    await mount(surface);
    const { runId, sessionKey } = await sendPrompt();
    histories[MAIN] = [
      ...histories[MAIN],
      { role: "user", content: [{ type: "text", text: PROMPT }], timestamp: 1_793_374_114_000, idempotencyKey: `${runId}:user` },
    ];
    await push("chat", { runId, sessionKey, state: "final", message: { role: "assistant", content: [{ type: "text", text: "" }] } }, 3_600);

    await waitFor(() => expect(bubbles(/No reply came back for this message/)).toHaveLength(1));
  });
});
