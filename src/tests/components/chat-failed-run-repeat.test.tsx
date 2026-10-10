import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

// Both surfaces mount the fake gateway handshake, the history restore and the
// transcript in jsdom, which costs seconds under a full parallel run; see
// test-timeout-hygiene.test.ts for why the ceiling is declared per file.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * One failed run, one sentence — and the right one (2026-10-10).
 *
 * A box whose gateway held no usable Claude sign-in answered every turn with
 * "That message did not go through. Send it again — the details stayed in this
 * box's log.", which could never work. Two things made that the line on
 * screen. The gateway's wording of the failure carries a device path and a CLI
 * instruction, so it was dropped to the generic sentence instead of being
 * read. And the gateway (core 2026.9.4) reports a failed run TWICE: a second
 * `chat` error frame when dispatch completes, seconds after the first, with
 * the operator's wording and none of the run's context — each chat worded it
 * as a second, generic failure, and in the mascot chat a history re-read had
 * taken the first sentence by then, so the generic one was all that was left.
 *
 * The frames are the ones such a run sends, with the home directory changed.
 */

const MAIN = "agent:main:main";
const TAB_KEY = /^agent:main:clawbox-[a-z0-9]{12}$/;
const SEED_TEXT = "Ready when you are.";
/** The Stop control's title: the bare key, since no locale pack loads in jsdom. */
const STOP = "chat.stop";
const PROMPT = "what is on my calendar today";
const NEXT_PROMPT = "and tomorrow";

const RAW =
  'No API key found for provider "anthropic". Auth store: /home/clawbox/.openclaw/state/openclaw.sqlite'
  + " (agentDir: /home/clawbox/.openclaw/agents/main/agent). Configure an API key"
  + " (openclaw models auth paste-api-key --provider anthropic; add --agent <id> for a non-default agent)"
  + " or copy only portable static auth profiles from the main agentDir.";
/** The first error frame's sentence: the gateway cuts it at 240 characters. */
const FRAME1 = `${(RAW + " | missing-provider-auth").slice(0, 240)}...`;
/** The second one's: the same failure inside the Control UI's failure copy. */
const FRAME2 =
  "⚠️ Agent failed before reply: " + RAW + " | missing-provider-auth.\nTo view logs, run `openclaw logs --follow` in a terminal.";

const SENTENCE =
  "That message did not go through — this box has no working sign-in for Anthropic, the provider this chat is set to."
  + " Connect Anthropic again in Settings, under Providers, or pick another model in the header, then send it again.";
const GENERIC = "That message did not go through. Send it again — the details stayed in this box's log.";
const REFUSED =
  "That message did not go through — the AI provider is not accepting this box's sign-in any more."
  + " Reconnect it in Settings, under Providers, and send it again.";

function userMessage(text: string, timestamp: number, idempotencyKey?: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp, ...(idempotencyKey ? { idempotencyKey } : {}) };
}

function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

/** Transcript per session key, as the gateway would hold it. */
let histories: Record<string, unknown[]> = {};
let historyReads = 0;
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
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: MAIN } } });
      return;
    }
    if (frame.method === "chat.history") {
      historyReads += 1;
      // A key the gateway has never seen answers an empty transcript.
      this.respond(id, { messages: histories[String(params.sessionKey)] ?? [] });
      return;
    }
    if (frame.method === "chat.send") {
      this.respond(id, { runId: params.idempotencyKey, status: "started" });
      return;
    }
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
    return { ok: true, headers: new Headers(), json: async () => ({}) };
  }));
}

/** How many times the chat handed a failure to the Anthropic account swap. */
const failureReports = () =>
  vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/setup-api/anthropic/failure")).length;

/** Message bubbles only — never the composer's own draft text. */
const bubbles = (text: string | RegExp) => screen.queryAllByText(text).filter((el) => el.tagName !== "TEXTAREA");

/** The run id the surface generated for the turn it just sent. */
function lastSentRunId(): string {
  const send = sent.filter((f) => f.method === "chat.send").pop();
  return String((send?.params as { idempotencyKey?: string })?.idempotencyKey ?? "");
}

/** Emit one gateway event and give the socket's answers, and React, a turn. */
async function push(event: string, payload: Record<string, unknown>) {
  await act(async () => {
    socket()?.emit({ type: "event", event, payload });
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function sendPrompt(text = PROMPT): Promise<string> {
  const before = lastSentRunId();
  const textarea = await screen.findByRole("textbox");
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(lastSentRunId()).not.toBe(before));
  await waitFor(() => expect(bubbles(text)).toHaveLength(1));
  return lastSentRunId();
}

/** The lifecycle frame that carries the gateway's own account of the failure. */
const fallbackStep = (runId: string, sessionKey = MAIN) => push("agent", {
  runId,
  sessionKey,
  agentId: "main",
  stream: "lifecycle",
  data: {
    phase: "fallback_step",
    fallbackStepType: "fallback_step",
    fallbackStepFromModel: "anthropic/claude-opus-5-5",
    fallbackStepFromFailureReason: "auth",
    fallbackStepFromFailureDetail: RAW,
    fallbackStepChainPosition: 1,
    fallbackStepFinalOutcome: "chain_exhausted",
  },
});

/** The first error frame: right after the failure. */
const firstError = (runId: string, sessionKey = MAIN) =>
  push("chat", { runId, sessionKey, agentId: "main", state: "error", errorMessage: FRAME1 });

/** The second: when dispatch completes, some seven seconds later, with the sentence alone. */
const secondError = (runId: string, sessionKey = MAIN) =>
  push("chat", { runId, sessionKey, state: "error", errorMessage: FRAME2 });

async function mount(Surface: "popup" | "page") {
  if (Surface === "popup") render(<ChatPopup isOpen onClose={() => {}} />);
  else render(<ChatApp />);
  await waitFor(() => expect(socket()).not.toBeNull());
  await screen.findByText(SEED_TEXT);
}

function arrange() {
  histories = { [MAIN]: [assistantMessage(SEED_TEXT, 500)] };
  historyReads = 0;
  sent.length = 0;
  sockets.length = 0;
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  installFetch();
}

function tidy() {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
}

describe.each([
  ["the mascot chat", "popup"],
  ["the full-page chat", "page"],
] as const)("a failed run the gateway reports twice — %s", (_name, surface) => {
  beforeEach(arrange);
  afterEach(tidy);

  it("says what is wrong, and says it once", async () => {
    await mount(surface);
    const run = await sendPrompt();
    await fallbackStep(run);
    await firstError(run);
    await screen.findByText(SENTENCE);

    await secondError(run);

    expect(bubbles(SENTENCE)).toHaveLength(1);
    expect(bubbles(GENERIC)).toHaveLength(0);
    // Nothing of the gateway's own line, from either frame.
    expect(document.body.textContent ?? "").not.toMatch(/openclaw|sqlite|missing-provider-auth|agentDir|\/home\//);
    // The repeat is not a second failure to hand to the account swap.
    expect(failureReports()).toBeLessThanOrEqual(1);
  });

  it("reads the second frame alone the same way — a page reloaded between the two", async () => {
    await mount(surface);
    await secondError("a-run-from-before-the-reload");
    await screen.findByText(SENTENCE);
    expect(bubbles(SENTENCE)).toHaveLength(1);
    expect(bubbles(GENERIC)).toHaveLength(0);
  });

  it("leaves the next turn alone when the repeat lands on it", async () => {
    await mount(surface);
    const failed = await sendPrompt();
    await fallbackStep(failed);
    await firstError(failed);
    await screen.findByText(SENTENCE);

    // The owner has already sent the next message; its reply is streaming.
    const next = await sendPrompt(NEXT_PROMPT);
    await push("chat", { runId: next, sessionKey: MAIN, state: "delta", message: assistantMessage("Tomorrow you have", 0) });
    await waitFor(() => expect(bubbles(/Tomorrow you have/)).toHaveLength(1));

    await secondError(failed);

    // Still that turn's: Stop is up, and the half-written reply was not filed
    // as an interrupted answer.
    expect(screen.getByTitle(STOP)).toBeTruthy();
    await push("chat", { runId: next, sessionKey: MAIN, state: "final", message: assistantMessage("Tomorrow you have two meetings.", 0) });
    await waitFor(() => expect(bubbles("Tomorrow you have two meetings.")).toHaveLength(1));
    expect(bubbles(/Tomorrow you have/)).toHaveLength(1);
    expect(bubbles(SENTENCE)).toHaveLength(1);
    expect(bubbles(GENERIC)).toHaveLength(0);
    // The sentence stayed with the turn it is about.
    const text = document.body.textContent ?? "";
    expect(text.indexOf(SENTENCE)).toBeGreaterThan(text.indexOf(PROMPT));
    expect(text.indexOf(SENTENCE)).toBeLessThan(text.indexOf(NEXT_PROMPT));
  });

  it("hands a sign-in Anthropic really refused to the account swap once, not once per frame", async () => {
    await mount(surface);
    const run = await sendPrompt();
    await push("agent", {
      runId: run,
      sessionKey: MAIN,
      stream: "lifecycle",
      data: {
        phase: "fallback_step",
        fallbackStepFromModel: "anthropic/claude-opus-5-5",
        fallbackStepFromFailureReason: "auth",
        fallbackStepFromFailureDetail:
          'HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_000000000000000000000000"}',
      },
    });
    const shrug = "The agent run failed before producing a reply.";
    await push("chat", {
      runId: run,
      sessionKey: MAIN,
      state: "error",
      errorMessage: shrug,
      errorDetail: { provider: "anthropic", model: "claude-opus-5-5", failoverReason: "auth" },
    });
    await screen.findByText(REFUSED);
    await waitFor(() => expect(failureReports()).toBe(1));

    await push("chat", {
      runId: run,
      sessionKey: MAIN,
      state: "error",
      errorMessage: `⚠️ Agent failed before reply: ${shrug}\nTo view logs, run \`openclaw logs --follow\` in a terminal.`,
    });

    expect(failureReports()).toBe(1);
    expect(bubbles(REFUSED)).toHaveLength(1);
    expect(bubbles(GENERIC)).toHaveLength(0);
  });
});

/**
 * One run id is not always one run (lib/chat-run-failure.ts). The Claude
 * account swap sends its retry under ONE key before and after the gateway
 * restart that moves the box to the next account; the restart empties the
 * gateway's dedupe map, so the key runs AGAIN — a whole new run, opening the
 * way every run does. Taken for the first run's repeat, its failure was
 * swallowed: no sentence, no report to the account pool, and its half-written
 * reply left up as a live bubble. The frames are a live 2026.9.4 gateway's.
 */
describe.each([
  ["the mascot chat", "popup"],
  ["the full-page chat", "page"],
] as const)("a run id the account swap runs twice — %s", (_name, surface) => {
  beforeEach(arrange);
  afterEach(tidy);

  const RATE = "API rate limit reached. Please try again later.";
  const RATE_SENTENCE = /rate-limiting this box right now/;
  const SHRUG = "The agent run failed before producing a reply.";
  /** The id the swap's retry goes out under: fixed for (session, message, account). */
  const SWAP = "clawbox-swap-0123456789abcdef";
  const ANTHROPIC = { provider: "anthropic", model: "claude-opus-5-5" };
  /** The blinking cursor both surfaces draw only on the LIVE streaming bubble. */
  const liveCursor = () => document.querySelector('span[style*="blink 1s step-end"]');
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 150)); });

  /** A run that hits the account's limit — and the gateway's own repeat of that error, seconds later. */
  async function rateLimited(runId: string) {
    await push("chat", { runId, sessionKey: MAIN, state: "error", errorMessage: RATE, errorDetail: { ...ANTHROPIC, failoverReason: "rate_limit" } });
    await push("chat", { runId, sessionKey: MAIN, state: "error", errorMessage: `⚠️ Agent failed before reply: ${RATE}\nTo view logs, run \`openclaw logs --follow\` in a terminal.` });
  }

  /** How every run opens on the wire: a status frame on each stream, before anything else. */
  async function runOpens(runId: string) {
    await push("chat", { runId, sessionKey: MAIN, agentId: "main", seq: 1, state: "status", phase: "preparing_workspace" });
    await push("agent", { runId, stream: "run_status", data: { phase: "preparing_workspace" }, sessionKey: MAIN, agentId: "main", seq: 1, ts: Date.now(), isHeartbeat: false });
  }

  /** The owner's turn is throttled, and so is the box's retry of it under the swap's key. */
  async function upToTheSwap() {
    await mount(surface);
    const own = await sendPrompt();
    await rateLimited(own);
    await waitFor(() => expect(bubbles(RATE_SENTENCE).length).toBeGreaterThanOrEqual(1));
    await rateLimited(SWAP);
    await settle();
    return { notes: bubbles(/did not go through/).length, reports: failureReports() };
  }

  it("words the second run's own failure, ends its half-written reply and tells the account pool", async () => {
    const before = await upToTheSwap();

    // The gateway restarted onto the next account and was sent the same key.
    await runOpens(SWAP);
    await push("chat", { runId: SWAP, sessionKey: MAIN, state: "delta", message: assistantMessage("Let me look at your calen", 0) });
    await waitFor(() => expect(bubbles(/Let me look at your calen/)).toHaveLength(1));
    expect(liveCursor()).not.toBeNull();
    await push("agent", {
      runId: SWAP,
      sessionKey: MAIN,
      stream: "lifecycle",
      data: {
        phase: "fallback_step",
        fallbackStepFromModel: "anthropic/claude-opus-5-5",
        fallbackStepFromFailureReason: "auth",
        fallbackStepFromFailureDetail:
          'HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_000000000000000000000000"}',
      },
    });
    await push("chat", { runId: SWAP, sessionKey: MAIN, state: "error", errorMessage: SHRUG, errorDetail: { ...ANTHROPIC, failoverReason: "auth" } });
    await settle();

    // Its own sentence, not the first run's and not nothing…
    expect(bubbles(REFUSED)).toHaveLength(1);
    expect(bubbles(/did not go through/)).toHaveLength(before.notes + 1);
    // …the half-reply is no longer "still being written"…
    expect(liveCursor()).toBeNull();
    // …and the account that refused the sign-in reaches the pool.
    expect(failureReports()).toBe(before.reports + 1);
  });

  it("reports the next account's own limit too, and still takes THAT run's repeat for a repeat", async () => {
    const before = await upToTheSwap();

    await runOpens(SWAP);
    await push("chat", { runId: SWAP, sessionKey: MAIN, state: "error", errorMessage: RATE, errorDetail: { ...ANTHROPIC, failoverReason: "rate_limit" } });
    await settle();
    expect(failureReports()).toBe(before.reports + 1);

    const reports = failureReports();
    const notes = bubbles(/did not go through/).length;
    await push("chat", { runId: SWAP, sessionKey: MAIN, state: "error", errorMessage: `⚠️ Agent failed before reply: ${RATE}` });
    await settle();
    expect(failureReports()).toBe(reports);
    expect(bubbles(/did not go through/)).toHaveLength(notes);
    expect(bubbles(GENERIC)).toHaveLength(0);
  });
});

describe("the mascot chat, whose history re-read drops its own notes", () => {
  beforeEach(arrange);
  afterEach(tidy);

  const tabs = () => screen.getAllByTestId("chat-tab");
  /** Whether tab `i` wears the flag with that test id (busy, unread). */
  const flagged = (i: number, id: string) => tabs()[i].querySelector(`[data-testid="${id}"]`) !== null;

  it("puts the sentence back, once, when a re-read took it between the two frames", async () => {
    await mount("popup");
    const run = await sendPrompt();
    await fallbackStep(run);
    await firstError(run);
    await screen.findByText(SENTENCE);

    // The gateway stored the turn; its append is pushed, and the chat re-reads.
    histories[MAIN] = [assistantMessage(SEED_TEXT, 500), userMessage(PROMPT, 600, `${run}:user`)];
    const before = historyReads;
    await push("session.message", { sessionKey: MAIN, message: histories[MAIN][1] });
    await waitFor(() => expect(historyReads).toBeGreaterThan(before), { timeout: 3_000 });
    await waitFor(() => expect(bubbles(SENTENCE)).toHaveLength(0));

    await secondError(run);

    await waitFor(() => expect(bubbles(SENTENCE)).toHaveLength(1));
    expect(bubbles(GENERIC)).toHaveLength(0);
    expect(bubbles(PROMPT)).toHaveLength(1);
    const text = document.body.textContent ?? "";
    expect(text.indexOf(SENTENCE)).toBeGreaterThan(text.indexOf(PROMPT));
    expect(failureReports()).toBeLessThanOrEqual(1);
  });

  it("puts it back under its own turn, not under the message sent since", async () => {
    await mount("popup");
    const failed = await sendPrompt();
    await fallbackStep(failed);
    await firstError(failed);
    await screen.findByText(SENTENCE);

    const next = await sendPrompt(NEXT_PROMPT);
    histories[MAIN] = [
      assistantMessage(SEED_TEXT, 500),
      userMessage(PROMPT, 600, `${failed}:user`),
      userMessage(NEXT_PROMPT, 700, `${next}:user`),
    ];
    const before = historyReads;
    await push("session.message", { sessionKey: MAIN, message: histories[MAIN][2] });
    await waitFor(() => expect(historyReads).toBeGreaterThan(before), { timeout: 3_000 });
    await waitFor(() => expect(bubbles(SENTENCE)).toHaveLength(0));

    await secondError(failed);

    await waitFor(() => expect(bubbles(SENTENCE)).toHaveLength(1));
    const text = document.body.textContent ?? "";
    expect(text.indexOf(SENTENCE)).toBeGreaterThan(text.indexOf(PROMPT));
    expect(text.indexOf(SENTENCE)).toBeLessThan(text.indexOf(NEXT_PROMPT));
    // The turn in flight is still in flight.
    expect(screen.getByTitle(STOP)).toBeTruthy();
  });

  it("shows a background tab's failure once, though the repeat arrives after the owner is back", async () => {
    await mount("popup");
    const plus = await screen.findByTestId("chat-new-tab");
    await waitFor(() => expect(plus).not.toBeDisabled());
    fireEvent.click(plus);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const key = tabs().find((el) => el.getAttribute("aria-selected") === "true")?.getAttribute("data-session-key") ?? "";
    expect(key).toMatch(TAB_KEY);
    const run = await sendPrompt();

    // The owner leaves; the run dies behind them.
    fireEvent.click(tabs()[0]);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    await fallbackStep(run, key);
    await firstError(run, key);
    expect(tabs()[1].querySelector('[data-testid="chat-tab-unread"]')).not.toBeNull();

    // Back in the tab: the kept sentence is appended, without a run to its name.
    fireEvent.click(tabs()[1]);
    await screen.findByText(SENTENCE);

    await secondError(run, key);

    expect(bubbles(SENTENCE)).toHaveLength(1);
    expect(bubbles(GENERIC)).toHaveLength(0);
  });

  // The guard on `settleRun`: a repeat ends nothing. In the FOREGROUND tab the
  // case above cannot see it — there is no busy mark there to take — so this
  // is the one where the owner has left a tab whose next turn is running.
  // Unguarded, the repeat took that turn's busy mark, flagged the tab unread
  // and filed the old failure to be appended under the new message.
  it("leaves the next turn of a tab the owner has left alone: still busy, not unread, nothing filed under it", async () => {
    await mount("popup");
    const plus = await screen.findByTestId("chat-new-tab");
    await waitFor(() => expect(plus).not.toBeDisabled());
    fireEvent.click(plus);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const key = tabs().find((el) => el.getAttribute("aria-selected") === "true")?.getAttribute("data-session-key") ?? "";
    expect(key).toMatch(TAB_KEY);

    // The first turn fails in the side tab, in front of the owner.
    const failed = await sendPrompt();
    await fallbackStep(failed, key);
    await firstError(failed, key);
    await screen.findByText(SENTENCE);

    // They send the next message there and go to the main tab while it runs.
    const next = await sendPrompt(NEXT_PROMPT);
    expect(next).not.toBe(failed);
    histories[key] = [userMessage(PROMPT, 600, `${failed}:user`), userMessage(NEXT_PROMPT, 700, `${next}:user`)];
    fireEvent.click(tabs()[0]);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(flagged(1, "chat-tab-busy")).toBe(true);
    expect(flagged(1, "chat-tab-unread")).toBe(false);

    // Seconds after the first frame: the gateway's repeat for the run that already failed.
    await secondError(failed, key);

    expect(flagged(1, "chat-tab-busy")).toBe(true);
    expect(flagged(1, "chat-tab-unread")).toBe(false);

    // Back in the tab: the turn is still in flight, and the old failure was not put under it.
    fireEvent.click(tabs()[1]);
    await waitFor(() => expect(bubbles(NEXT_PROMPT)).toHaveLength(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect(screen.queryByTitle(STOP)).not.toBeNull();
    const text = document.body.textContent ?? "";
    expect(text.lastIndexOf(SENTENCE)).toBeLessThan(text.indexOf(NEXT_PROMPT));

    // And the run that really is in flight still paints and ends as itself.
    await push("chat", { runId: next, sessionKey: key, state: "final", message: assistantMessage("Tomorrow you have two meetings.", 0) });
    await waitFor(() => expect(bubbles("Tomorrow you have two meetings.")).toHaveLength(1));
    expect(screen.queryByTitle(STOP)).toBeNull();
  });
});
