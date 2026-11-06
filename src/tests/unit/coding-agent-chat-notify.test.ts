/**
 * The chat leg of the coding agent's finish notice (TASK-2132,
 * src/lib/coding-agent-notify.ts): a run the assistant started from a ClawBox
 * chat ends, and THAT chat gets one turn saying so, so the assistant tells the
 * user without being asked.
 *
 * Pins which chat is taken for the run on each harness (the live Hermes turn,
 * the OpenClaw session the gateway says is busy, the owner's last send when it
 * cannot say), that the record lives in the kv-store beside the run's id, that
 * the notice reaches the chat once per ending and after the run's work is
 * committed, that it carries ClawBox's template and never the task or the
 * summary, and that no failure on the way reaches the caller.
 */
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingRun } from "@/lib/coding-agent";

const getActiveHarness = vi.hoisted(() => vi.fn());
vi.mock("@/lib/harness", () => ({ getActiveHarness, getEdition: vi.fn(() => "openclaw") }));

const gateway = vi.hoisted(() => {
  class GatewayWsUnavailableError extends Error {}
  class GatewayRpcError extends Error {}
  return {
    GatewayWsUnavailableError,
    GatewayRpcError,
    gatewayWsCall: vi.fn(),
    gatewayWsChatSendMain: vi.fn(),
    gatewayWsActiveSessions: vi.fn(),
  };
});
vi.mock("@/lib/openclaw-gateway-ws", () => gateway);

vi.mock("@/lib/mcp-token", () => ({ getMcpToken: () => "mcp-bearer-for-the-test" }));

// The settle chain's wake, which the notice waits for (coding-agent.ts).
const waitForRun = vi.hoisted(() => vi.fn<(id: string, ms: number) => Promise<null>>(async () => null));
vi.mock("@/lib/coding-agent", () => ({ waitForRun }));

import { DATA_DIR } from "@/lib/config-store";
import {
  ACTIVE_SESSIONS_BUDGET_MS,
  announceCodingAgent,
  announceCodingRunToChat,
  buildChatNotice,
  CHAT_NOTICE_KEY_PREFIX,
  findChatOrigin,
  forgetRunChatOrigin,
  GATEWAY_RETRY_DELAYS_MS,
  recordRunChatOrigin,
} from "@/lib/coding-agent-notify";
import { kvGet, kvGetAll } from "@/lib/kv-store";
import { beginLiveTurn } from "@/lib/harness/hermes-live-turn";
import { appendTranscript } from "@/lib/harness/transcript-store";
import { RUNNER_STEP } from "@/lib/coding-agent-progress";

const SECRET_TASK = "Add the API key sk-live-DO-NOT-LEAK to config";
const SECRET_SUMMARY = "I wrote the key sk-live-DO-NOT-LEAK into config.js";
const MAIN = "agent:main:main";
const TAB = "agent:main:clawbox-abc123def456";
const CLOSED_TAB = "agent:main:clawbox-0c105ed00001";
const HERMES_TAB = "desktop-a1b2c3d4e5f6";
const KV = path.join(DATA_DIR, "kv.json");
const TABS = path.join(DATA_DIR, "chat-tabs.json");
const TRANSCRIPTS = path.join(DATA_DIR, "chat-transcripts");

/** Only the fields the chat leg reads; the rest of the record is the run's business. */
function run(over: Partial<CodingRun> = {}): CodingRun {
  return {
    id: "run-k3x9q2ab",
    task: SECRET_TASK,
    summary: SECRET_SUMMARY,
    error: "it failed while writing sk-live-DO-NOT-LEAK",
    projectId: "site",
    status: "completed",
    startedAt: 1_000_000,
    completedAt: 1_000_000 + 95_000,
    numTurns: 7,
    filesTouched: ["index.html", "config.js"],
    permissionDenials: 0,
    team: null,
    ...over,
  } as CodingRun;
}

function writeTabs(inventory: Record<string, unknown>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TABS, JSON.stringify(inventory));
}

function ownerSentIn(key: string | null, at: number): void {
  writeTabs({
    tabs: [
      { key: TAB, label: "Site work", createdAt: 1 },
      { key: HERMES_TAB, label: "Hermes tab", createdAt: 1 },
    ],
    closed: [{ key: CLOSED_TAB, at: 5 }],
    active: { key, at },
    activeAt: at,
  });
}

const fetchMock = vi.fn();
const endTurns: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(KV, { recursive: true, force: true });
  fs.rmSync(TABS, { force: true });
  fs.rmSync(TRANSCRIPTS, { recursive: true, force: true });
  // The Telegram leg is coding-agent-notify.test.ts's; off here, so the only
  // thing these cases can see leave the box is the chat's turn.
  process.env.CLAWBOX_CODING_AGENT_TELEGRAM = "off";
  getActiveHarness.mockResolvedValue("openclaw");
  gateway.gatewayWsCall.mockResolvedValue({});
  gateway.gatewayWsChatSendMain.mockResolvedValue({ sessionKey: MAIN });
  gateway.gatewayWsActiveSessions.mockResolvedValue({ mainSessionKey: MAIN, sessionKeys: [] });
  waitForRun.mockResolvedValue(null);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ reply: "done" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const end of endTurns.splice(0)) end();
  delete process.env.CLAWBOX_CODING_AGENT_TELEGRAM;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The chat route's streamed answer: one named event per frame, as hermes-live-turn.ts writes them. */
function sse(...frames: Array<[string, unknown]>): Response {
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A ClawBox Hermes turn running in `key` — what the chat route registers. */
function liveTurn(key: string, now: number): void {
  const turn = beginLiveTurn(key, { now });
  endTurns.push(() => turn.end());
}

/** What the gateway answers `sessions.list` with `activeOnly`: the sessions with a turn running. */
function gatewayBusy(...sessionKeys: string[]): void {
  gateway.gatewayWsActiveSessions.mockResolvedValue({ mainSessionKey: MAIN, sessionKeys });
}

/** A gateway that cannot be asked — down, restarting, or a core that refuses `activeOnly`. */
function gatewaySilent(): void {
  gateway.gatewayWsActiveSessions.mockRejectedValue(new gateway.GatewayWsUnavailableError("not listening"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("which chat asked for the run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("OpenClaw: the owner's chat the gateway says is running a turn — the main conversation or a tab", async () => {
    const now = 50_000_000;
    gatewayBusy(MAIN);
    await expect(findChatOrigin(now)).resolves.toEqual({ harness: "openclaw", key: null, at: now });
    gatewayBusy(TAB);
    await expect(findChatOrigin(now)).resolves.toEqual({ harness: "openclaw", key: TAB, at: now });
    expect(gateway.gatewayWsActiveSessions).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it("OpenClaw: the busy chat wins over the owner's last send, however recent", async () => {
    const now = 50_000_000;
    ownerSentIn(TAB, now - 1_000);
    gatewayBusy(MAIN);
    await expect(findChatOrigin(now)).resolves.toMatchObject({ key: null });
  });

  it("OpenClaw: of two busy chats, the one the owner last sent in, else the newest", async () => {
    const now = 50_000_000;
    gatewayBusy(TAB, MAIN);
    await expect(findChatOrigin(now)).resolves.toMatchObject({ key: TAB });
    ownerSentIn(null, now - 60_000);
    await expect(findChatOrigin(now)).resolves.toMatchObject({ key: null });
  });

  it("OpenClaw: no chat when only a channel's, a cron job's or a ClawBox user's session is busy — even right after an owner send", async () => {
    const now = 50_000_000;
    ownerSentIn(TAB, now - 1_000);
    gatewayBusy("agent:main:telegram:direct:123456789", "agent:main:cron:nightly-report", "agent:main:clawbox-utab-0a1b2c3d-bob");
    await expect(findChatOrigin(now)).resolves.toBeNull();
    gatewayBusy();
    await expect(findChatOrigin(now)).resolves.toBeNull();
  });

  it("OpenClaw, when the gateway cannot say: the conversation the owner last sent a turn in, while that send is recent", async () => {
    gatewaySilent();
    const now = 50_000_000;
    ownerSentIn(TAB, now - 90_000);
    await expect(findChatOrigin(now)).resolves.toEqual({ harness: "openclaw", key: TAB, at: now });
    ownerSentIn(null, now - 90_000);
    await expect(findChatOrigin(now)).resolves.toEqual({ harness: "openclaw", key: null, at: now });
  });

  it("OpenClaw: a gateway that does not answer holds the run's start no longer than the budget, then the last send stands", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const now = 50_000_000;
    ownerSentIn(TAB, now - 90_000);
    gateway.gatewayWsActiveSessions.mockReturnValue(new Promise(() => {}));
    let settled: unknown = "pending";
    void findChatOrigin(now).then((origin) => { settled = origin; });
    await vi.advanceTimersByTimeAsync(ACTIVE_SESSIONS_BUDGET_MS - 10);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toEqual({ harness: "openclaw", key: TAB, at: now });
  });

  it("OpenClaw, when the gateway cannot say: none when the owner's last send is long gone, or never happened", async () => {
    gatewaySilent();
    const now = 50_000_000;
    await expect(findChatOrigin(now)).resolves.toBeNull();
    ownerSentIn(TAB, now - 31 * 60_000);
    await expect(findChatOrigin(now)).resolves.toBeNull();
    // A Hermes tab from before a swap on a dual box: no session the gateway has.
    ownerSentIn(HERMES_TAB, now - 1_000);
    await expect(findChatOrigin(now)).resolves.toBeNull();
  });

  it("Hermes: the owner's chat whose turn is running right now — not the last one sent in", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    const now = 50_000_000;
    ownerSentIn(null, now - 1_000);
    liveTurn(HERMES_TAB, now - 5_000);
    await expect(findChatOrigin(now)).resolves.toEqual({ harness: "hermes", key: HERMES_TAB, at: now });
  });

  it("Hermes: the main conversation is null, as on OpenClaw", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    liveTurn("desktop", 1_000);
    await expect(findChatOrigin(2_000)).resolves.toEqual({ harness: "hermes", key: null, at: 2_000 });
  });

  it("Hermes: of two running turns, the one the owner last sent in, else the newest", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    const now = 50_000_000;
    liveTurn("desktop", now - 9_000);
    liveTurn(HERMES_TAB, now - 1_000);
    await expect(findChatOrigin(now)).resolves.toMatchObject({ key: HERMES_TAB });
    ownerSentIn(null, now - 9_000);
    await expect(findChatOrigin(now)).resolves.toMatchObject({ key: null });
  });

  it("Hermes: no chat when no owner turn is running — Telegram, a cron job, a ClawBox user's chat", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    const now = 50_000_000;
    ownerSentIn(HERMES_TAB, now - 1_000);
    await expect(findChatOrigin(now)).resolves.toBeNull();
    liveTurn("desktop-user-bob", now - 1_000);
    await expect(findChatOrigin(now)).resolves.toBeNull();
    // Hermes never asks the OpenClaw gateway.
    expect(gateway.gatewayWsActiveSessions).not.toHaveBeenCalled();
  });

  it("never throws: a harness that cannot be read is no chat", async () => {
    getActiveHarness.mockRejectedValue(new Error("edition lock unreadable"));
    await expect(findChatOrigin()).resolves.toBeNull();
  });
});

describe("the notice, on OpenClaw", () => {
  it("is one chat.send into the tab that asked, which the agent answers there", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    await announceCodingAgent(run());
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(1);
    const [method, params] = gateway.gatewayWsCall.mock.calls[0];
    expect(method).toBe("chat.send");
    expect(params).toMatchObject({ sessionKey: TAB, deliver: false, idempotencyKey: "coding-run-run-k3x9q2ab-completed-1095000" });
    expect(params.message).toContain("[Coding run run-k3x9q2ab] finished in project \"site\"");
    expect(params.message).toContain("coding_agent_status");
    expect(gateway.gatewayWsChatSendMain).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("goes to the main chat when that is where the owner asked — and when the tab has been closed since", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: null, at: 1 });
    recordRunChatOrigin("run-closed01", { harness: "openclaw", key: CLOSED_TAB, at: 1 });
    ownerSentIn(null, 1);
    await announceCodingAgent(run());
    await announceCodingAgent(run({ id: "run-closed01" }));
    expect(gateway.gatewayWsChatSendMain).toHaveBeenCalledTimes(2);
    expect(gateway.gatewayWsCall).not.toHaveBeenCalled();
  });

  it("is sent once per ending: the same ending twice, even after a restart, sends nothing more", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    await announceCodingAgent(run());
    await announceCodingAgent(run());
    vi.resetModules();
    const fresh = await import("@/lib/coding-agent-notify");
    await fresh.announceCodingAgent(run());
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(1);
  });

  it("tells of a second ending — a run that gave up and was resumed in place, whichever way it ends again", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    await announceCodingAgent(run({ status: "gave_up", completedAt: 2_000_000 }));
    await announceCodingAgent(run({ status: "gave_up", completedAt: 2_000_000 }));
    await announceCodingAgent(run({ status: "gave_up", completedAt: 3_000_000 }));
    await announceCodingAgent(run({ status: "completed", completedAt: 4_000_000 }));
    expect(gateway.gatewayWsCall.mock.calls.map(([, p]) => p.idempotencyKey)).toEqual([
      "coding-run-run-k3x9q2ab-gave_up-2000000",
      "coding-run-run-k3x9q2ab-gave_up-3000000",
      "coding-run-run-k3x9q2ab-completed-4000000",
    ]);
  });

  it("keeps its record in the kv-store under the run's id, with the endings told", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 7 });
    expect(JSON.parse(kvGet(`${CHAT_NOTICE_KEY_PREFIX}run-k3x9q2ab`) ?? "null")).toEqual({ harness: "openclaw", key: TAB, at: 7, told: [] });
    await announceCodingAgent(run());
    expect(JSON.parse(kvGet(`${CHAT_NOTICE_KEY_PREFIX}run-k3x9q2ab`) ?? "null")).toMatchObject({ told: ["completed@1095000"] });
    // Never a key for a run that is no run id, nor a key for a chat that is not the owner's.
    recordRunChatOrigin("../../etc", { harness: "openclaw", key: TAB, at: 8 });
    recordRunChatOrigin("run-other001", { harness: "openclaw", key: "agent:main:telegram:direct:1", at: 8 });
    expect(Object.keys(kvGetAll(CHAT_NOTICE_KEY_PREFIX))).toEqual([`${CHAT_NOTICE_KEY_PREFIX}run-k3x9q2ab`]);
  });

  it("forgets the record of a start that never happened, and only that one", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    recordRunChatOrigin("run-refused1", { harness: "openclaw", key: null, at: 2 });
    forgetRunChatOrigin("run-refused1");
    forgetRunChatOrigin("run-neverwas");
    expect(Object.keys(kvGetAll(CHAT_NOTICE_KEY_PREFIX))).toEqual([`${CHAT_NOTICE_KEY_PREFIX}run-k3x9q2ab`]);
    await announceCodingRunToChat(run({ id: "run-refused1", status: "failed" }));
    expect(gateway.gatewayWsCall).not.toHaveBeenCalled();
    expect(gateway.gatewayWsChatSendMain).not.toHaveBeenCalled();
  });

  it("keeps the newest records and lets the oldest go — told ones first — leaving the rest of the store alone", async () => {
    const seeded: Record<string, string> = { "ui:something-else": "kept" };
    for (let i = 0; i < 500; i++) {
      seeded[`${CHAT_NOTICE_KEY_PREFIX}run-old${i}`] = JSON.stringify({ harness: "openclaw", key: null, at: 1_000 + i, told: [] });
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KV, JSON.stringify(seeded));
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 9_000 });
    let kept = kvGetAll(CHAT_NOTICE_KEY_PREFIX);
    expect(Object.keys(kept)).toHaveLength(500);
    expect(kept).not.toHaveProperty(`${CHAT_NOTICE_KEY_PREFIX}run-old0`);
    expect(kept).toHaveProperty(`${CHAT_NOTICE_KEY_PREFIX}run-old1`);
    // A run whose ending has been told goes before one still under way, however much newer it is.
    await announceCodingRunToChat(run({ id: "run-old499" }));
    recordRunChatOrigin("run-newer001", { harness: "openclaw", key: TAB, at: 9_001 });
    kept = kvGetAll(CHAT_NOTICE_KEY_PREFIX);
    expect(kept).not.toHaveProperty(`${CHAT_NOTICE_KEY_PREFIX}run-old499`);
    expect(kept).toHaveProperty(`${CHAT_NOTICE_KEY_PREFIX}run-old1`);
    expect(kept).toHaveProperty(`${CHAT_NOTICE_KEY_PREFIX}run-k3x9q2ab`);
    expect(kvGet("ui:something-else")).toBe("kept");
  });

  it("keeps what it has told when the store cannot be read, and sends nothing rather than twice", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    await announceCodingAgent(run());
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(1);
    const told = fs.readFileSync(KV, "utf8");
    // Half a file: what a crash mid-write elsewhere would leave.
    fs.writeFileSync(KV, told.slice(0, 40));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 2 })).not.toThrow();
    // The chat leg alone: the desktop card's own lenient write is the ring's business, not this leg's.
    await expect(announceCodingRunToChat(run({ status: "gave_up", completedAt: 2_000_000 }))).resolves.toBeUndefined();
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(1);
    // Not written over: the endings already told are still there to be read once the store is whole.
    expect(fs.readFileSync(KV, "utf8")).toBe(told.slice(0, 40));
    fs.writeFileSync(KV, told);
    await announceCodingRunToChat(run());
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(1);
    error.mockRestore();
    warn.mockRestore();
  });

  it("tells the chat only once the run's work is committed — the settle chain's wake", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    let wake: (value: null) => void = () => {};
    waitForRun.mockImplementationOnce(() => new Promise((resolve) => { wake = resolve; }));
    const done = announceCodingAgent(run());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(waitForRun).toHaveBeenCalledWith("run-k3x9q2ab", 120_000);
    expect(gateway.gatewayWsCall).not.toHaveBeenCalled();
    wake(null);
    await done;
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(1);
  });

  it("the chat leg alone, for an ending that never reached the settle: no desktop card, and still once", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    const stopped = run({ status: "stopped", completedAt: 3_000_000 });
    await announceCodingRunToChat(stopped);
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(1);
    expect(gateway.gatewayWsCall.mock.calls[0][1].message).toContain("[Coding run run-k3x9q2ab] was stopped");
    expect(kvGet("ui:pending-actions")).toBeNull();
    // The same ending through the full notice as well: the chat hears it once.
    await announceCodingAgent(stopped);
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(1);
    // A run no chat asked for, and a queued or paused record: nothing.
    await announceCodingRunToChat(run({ id: "run-nochat01", status: "failed" }));
    await announceCodingRunToChat(run({ status: "queued" }));
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a run no chat asked for, for a pause, or once the box runs the other harness", async () => {
    await announceCodingAgent(run());
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    await announceCodingAgent(run({ status: "paused" }));
    await announceCodingAgent(run({ status: "running" }));
    expect(gateway.gatewayWsCall).not.toHaveBeenCalled();
    getActiveHarness.mockResolvedValue("hermes");
    await announceCodingAgent(run());
    expect(gateway.gatewayWsCall).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tries a gateway that is not up again, and gives up quietly", async () => {
    vi.useFakeTimers();
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    gateway.gatewayWsCall
      .mockRejectedValueOnce(new gateway.GatewayWsUnavailableError("not listening"))
      .mockResolvedValueOnce({});
    const done = announceCodingAgent(run());
    await vi.advanceTimersByTimeAsync(GATEWAY_RETRY_DELAYS_MS[0]);
    await done;
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(2);

    recordRunChatOrigin("run-second01", { harness: "openclaw", key: TAB, at: 1 });
    gateway.gatewayWsCall.mockRejectedValue(new gateway.GatewayWsUnavailableError("not listening"));
    const again = announceCodingAgent(run({ id: "run-second01" }));
    await vi.advanceTimersByTimeAsync(GATEWAY_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    await expect(again).resolves.toBeUndefined();
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(2 + 1 + GATEWAY_RETRY_DELAYS_MS.length);
  });

  it("does not retry a turn the gateway refused, and never throws", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    gateway.gatewayWsCall.mockRejectedValue(new gateway.GatewayRpcError("unknown session"));
    await expect(announceCodingAgent(run())).resolves.toBeUndefined();
    expect(gateway.gatewayWsCall).toHaveBeenCalledTimes(1);
  });
});

describe("the notice, on Hermes", () => {
  beforeEach(() => {
    getActiveHarness.mockResolvedValue("hermes");
  });

  it("is a turn through the box's own chat route, as the owner, resuming the chat's session", async () => {
    await appendTranscript({ role: "user", text: "build the site", timestamp: 1 }, HERMES_TAB);
    await appendTranscript({ role: "assistant", text: "Started run-k3x9q2ab.", timestamp: 2, sessionId: "20261103_101500_a1b2c3" }, HERMES_TAB);
    recordRunChatOrigin("run-k3x9q2ab", { harness: "hermes", key: HERMES_TAB, at: 1 });
    await announceCodingAgent(run());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/setup-api\/hermes\/chat$/);
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer mcp-bearer-for-the-test");
    // Streamed, as the desktop chat sends its own turns: the session is resumed over the transport that opened it.
    expect(init.headers.accept).toBe("text/event-stream");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ sessionKey: HERMES_TAB, sessionId: "20261103_101500_a1b2c3" });
    expect(body.message).toContain("coding_agent_status");
    expect(body.displayText).toBe("[Coding run run-k3x9q2ab] finished in project \"site\" (7 turns, 2 files changed, 1m 35s).");
    expect(gateway.gatewayWsCall).not.toHaveBeenCalled();
  });

  it("goes to the main conversation for a null key, and starts a session when the chat has none", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "hermes", key: null, at: 1 });
    await announceCodingAgent(run());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sessionKey).toBe("desktop");
    expect(body).not.toHaveProperty("sessionId");
  });

  it("waits for every turn running in that chat — one the owner sends meanwhile too — then sends", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "hermes", key: HERMES_TAB, at: 1 });
    const busy = beginLiveTurn(HERMES_TAB);
    const done = announceCodingAgent(run());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    const next = beginLiveTurn(HERMES_TAB);
    busy.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    next.end();
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call a turn that outlived the request lost: it goes on, and answers in the chat", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "hermes", key: HERMES_TAB, at: 1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(announceCodingAgent(run())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("still running"));
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it("reads the stream to its end: done is told, an error before any answer is not", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    recordRunChatOrigin("run-k3x9q2ab", { harness: "hermes", key: HERMES_TAB, at: 1 });
    fetchMock.mockResolvedValueOnce(sse(["status", { text: "thinking" }], ["delta", { text: "It finished." }], ["done", { text: "It finished." }]));
    await announceCodingAgent(run());
    expect(info).toHaveBeenCalledWith(expect.stringContaining("told the chat that asked for run-k3x9q2ab"));

    recordRunChatOrigin("run-second01", { harness: "hermes", key: HERMES_TAB, at: 1 });
    fetchMock.mockResolvedValueOnce(sse(["error", { error: "The assistant could not answer." }]));
    await announceCodingAgent(run({ id: "run-second01" }));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("run-second01 was not told"), expect.stringContaining("The assistant could not answer."));
    info.mockRestore();
    error.mockRestore();
  });

  it("never sends a failed turn again: the route has written the question, and a second would show it twice", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await appendTranscript({ role: "assistant", text: "Started run-k3x9q2ab.", timestamp: 2, sessionId: "20261103_101500_a1b2c3" }, HERMES_TAB);
    recordRunChatOrigin("run-k3x9q2ab", { harness: "hermes", key: HERMES_TAB, at: 1 });
    // What a board answered when a notice went the CLI way into a session the dashboard held.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "hermes-refusal-reason: SESSION_NOT_OWNED" }), { status: 502 }));
    await announceCodingAgent(run());
    recordRunChatOrigin("run-second01", { harness: "hermes", key: HERMES_TAB, at: 1 });
    fetchMock.mockResolvedValueOnce(sse(["delta", { text: "It finished, and" }], ["error", { error: "connection lost" }]));
    await announceCodingAgent(run({ id: "run-second01" }));
    // One request each, both in the chat's own session; nothing moved the chat to a new one.
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).sessionId)).toEqual(["20261103_101500_a1b2c3", "20261103_101500_a1b2c3"]);
    expect(error.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining("run-k3x9q2ab was not told"),
      expect.stringContaining("run-second01 was not told"),
    ]);
    expect(error.mock.calls[0][1]).toContain("SESSION_NOT_OWNED");
    // And the same ending again later sends nothing: it was claimed before the send.
    await announceCodingAgent(run());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("never throws when the route refuses or the box cannot be reached", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "hermes", key: HERMES_TAB, at: 1 });
    recordRunChatOrigin("run-second01", { harness: "hermes", key: HERMES_TAB, at: 1 });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await expect(announceCodingAgent(run())).resolves.toBeUndefined();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(announceCodingAgent(run({ id: "run-second01" }))).resolves.toBeUndefined();
  });
});

describe("what the notice says", () => {
  it("is ClawBox's template: never the task, the summary or the error", () => {
    for (const status of ["completed", "failed", "gave_up", "stopped"] as const) {
      for (const harness of ["openclaw", "hermes"] as const) {
        const { message, display } = buildChatNotice(run({ status }), harness);
        expect(message).not.toContain("sk-live-DO-NOT-LEAK");
        expect(message).toContain("run-k3x9q2ab");
        expect(message.startsWith(display)).toBe(true);
      }
    }
  });

  it("asks the assistant not to start a stopped run again on its own", () => {
    expect(buildChatNotice(run({ status: "stopped" }), "openclaw").message).toMatch(/do not start it again unless they ask/);
  });

  it("says whether a run's deliverable is there, never the verdict's own words", () => {
    const deliverable = { kind: "files", files: ["index.html"] } as unknown as CodingRun["deliverable"];
    const there = buildChatNotice(run({ deliverable, deliverableCheck: { ok: true, missing: null, checkedAt: 1 } }), "openclaw").message;
    expect(there).toContain("Its deliverable is there.");
    const missing = buildChatNotice(run({ deliverable, deliverableCheck: { ok: false, missing: "index.html sk-live-DO-NOT-LEAK", checkedAt: 1 } }), "hermes").message;
    expect(missing).toMatch(/deliverable is MISSING, so do not report the work as done/);
    expect(missing).not.toContain("sk-live-DO-NOT-LEAK");
    expect(buildChatNotice(run(), "openclaw").message).not.toMatch(/deliverable/i);
  });

  it("warns when a run ended with its own work still running, without naming that work", () => {
    const progress = [RUNNER_STEP.endedWithLiveWork("board matrix sk-live-DO-NOT-LEAK")];
    const { message, display } = buildChatNotice(run({ progress }), "openclaw");
    expect(message).toMatch(/still running: the work is NOT finished/);
    expect(message).not.toContain("sk-live-DO-NOT-LEAK");
    expect(message.startsWith(display)).toBe(true);
    expect(buildChatNotice(run({ progress: [RUNNER_STEP.keptAlive(2)] }), "openclaw").message).not.toMatch(/NOT finished/);
  });

  it("offers NO_REPLY only where the chat hides it", () => {
    expect(buildChatNotice(run(), "openclaw").message).toContain("NO_REPLY");
    expect(buildChatNotice(run(), "hermes").message).not.toContain("NO_REPLY");
  });
});
