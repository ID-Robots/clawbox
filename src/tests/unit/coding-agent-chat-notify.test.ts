/**
 * The chat leg of the coding agent's finish notice (TASK-2132,
 * src/lib/coding-agent-notify.ts): a run the assistant started from a ClawBox
 * chat ends, and THAT chat gets one turn saying so, so the assistant tells the
 * user without being asked.
 *
 * Pins which chat is taken for the run on each harness (the live Hermes turn,
 * the owner's last OpenClaw send), that the notice reaches it once per ending,
 * that it carries ClawBox's template and never the task or the summary, and
 * that no failure on the way reaches the caller.
 */
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingRun } from "@/lib/coding-agent";

const kvGet = vi.hoisted(() => vi.fn());
const kvSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/kv-store", () => ({ kvGet, kvSet }));

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
  };
});
vi.mock("@/lib/openclaw-gateway-ws", () => gateway);

vi.mock("@/lib/mcp-token", () => ({ getMcpToken: () => "mcp-bearer-for-the-test" }));

import { DATA_DIR } from "@/lib/config-store";
import {
  announceCodingAgent,
  buildChatNotice,
  findChatOrigin,
  GATEWAY_RETRY_DELAYS_MS,
  recordRunChatOrigin,
} from "@/lib/coding-agent-notify";
import { beginLiveTurn } from "@/lib/harness/hermes-live-turn";
import { appendTranscript } from "@/lib/harness/transcript-store";

const SECRET_TASK = "Add the API key sk-live-DO-NOT-LEAK to config";
const SECRET_SUMMARY = "I wrote the key sk-live-DO-NOT-LEAK into config.js";
const TAB = "agent:main:clawbox-abc123def456";
const CLOSED_TAB = "agent:main:clawbox-0c105ed00001";
const HERMES_TAB = "desktop-a1b2c3d4e5f6";
const NOTICES = path.join(DATA_DIR, "coding-agent-chat-notices.json");
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
  fs.rmSync(NOTICES, { force: true });
  fs.rmSync(TABS, { force: true });
  fs.rmSync(TRANSCRIPTS, { recursive: true, force: true });
  // The Telegram leg is coding-agent-notify.test.ts's; off here, so the only
  // thing these cases can see leave the box is the chat's turn.
  process.env.CLAWBOX_CODING_AGENT_TELEGRAM = "off";
  getActiveHarness.mockResolvedValue("openclaw");
  gateway.gatewayWsCall.mockResolvedValue({});
  gateway.gatewayWsChatSendMain.mockResolvedValue({ sessionKey: "agent:main:main" });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ reply: "done" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const end of endTurns.splice(0)) end();
  delete process.env.CLAWBOX_CODING_AGENT_TELEGRAM;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A ClawBox Hermes turn running in `key` — what the chat route registers. */
function liveTurn(key: string, now: number): void {
  const turn = beginLiveTurn(key, { now });
  endTurns.push(() => turn.end());
}

describe("which chat asked for the run", () => {
  it("OpenClaw: the conversation the owner last sent a turn in, while that send is recent", async () => {
    const now = 50_000_000;
    ownerSentIn(TAB, now - 90_000);
    await expect(findChatOrigin(now)).resolves.toEqual({ harness: "openclaw", key: TAB, at: now });
    ownerSentIn(null, now - 90_000);
    await expect(findChatOrigin(now)).resolves.toEqual({ harness: "openclaw", key: null, at: now });
  });

  it("OpenClaw: none when the owner's last send is long gone, or never happened", async () => {
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
    expect(params).toMatchObject({ sessionKey: TAB, deliver: false, idempotencyKey: "coding-run-run-k3x9q2ab-completed" });
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

  it("tells of a second, different ending — a run that gave up and was resumed in place", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "openclaw", key: TAB, at: 1 });
    await announceCodingAgent(run({ status: "gave_up" }));
    await announceCodingAgent(run({ status: "completed" }));
    expect(gateway.gatewayWsCall.mock.calls.map(([, p]) => p.idempotencyKey)).toEqual([
      "coding-run-run-k3x9q2ab-gave_up",
      "coding-run-run-k3x9q2ab-completed",
    ]);
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

  it("waits for a turn already running in that chat, then sends", async () => {
    recordRunChatOrigin("run-k3x9q2ab", { harness: "hermes", key: HERMES_TAB, at: 1 });
    const busy = beginLiveTurn(HERMES_TAB);
    const done = announceCodingAgent(run());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    busy.end();
    await done;
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("offers NO_REPLY only where the chat hides it", () => {
    expect(buildChatNotice(run(), "openclaw").message).toContain("NO_REPLY");
    expect(buildChatNotice(run(), "hermes").message).not.toContain("NO_REPLY");
  });
});
