/**
 * The coding agent's finish notice (src/lib/coding-agent-notify.ts).
 *
 * Pins the two rules that matter: the text is ClawBox's template and never
 * carries the task or the summary (both model-authored), and no failure on
 * either leg — the desktop slot or Telegram — ever reaches the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingRun } from "@/lib/coding-agent";

const kvSet = vi.hoisted(() => vi.fn());
const kvGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/kv-store", () => ({ kvGet, kvSet }));

const configGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
}));

const getActiveHarness = vi.hoisted(() => vi.fn());
vi.mock("@/lib/harness", () => ({ getActiveHarness }));

const readHermesApprovedUsers = vi.hoisted(() => vi.fn());
const notifyHermesTelegramUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-telegram", () => ({ readHermesApprovedUsers, notifyHermesTelegramUser }));

const readTelegramAllowFrom = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openclaw-config", () => ({ readTelegramAllowFrom }));

import { announceCodingAgent, buildAnnouncement } from "@/lib/coding-agent-notify";

const SECRET_TASK = "Add the API key sk-live-DO-NOT-LEAK to config";
const SECRET_SUMMARY = "I wrote the key sk-live-DO-NOT-LEAK into config.js";

function run(over: Partial<CodingRun> = {}): CodingRun {
  return {
    id: "run-k3x9q2ab",
    task: SECRET_TASK,
    directory: "/home/clawbox/clawbox/data/code-projects/site",
    projectId: "site",
    source: "agent",
    status: "completed",
    startedAt: 1_000_000,
    completedAt: 1_000_000 + 95_000,
    sessionId: "sess-1",
    model: "deepseek-v4-flash",
    summary: SECRET_SUMMARY,
    error: null,
    numTurns: 7,
    reviewOf: null,
    team: null,
    readOnly: false,
    extraBrief: null,
    filesTouched: ["index.html", "config.js"],
    commandsRun: 2,
    permissionDenials: 0,
    deniedActions: [],
    effort: "max",
    subagentsActive: 0,
    activeSubagents: [], subagents: [],
    subagentsTotal: 0,
    commit: null,
    pr: null,
    subagentsByType: {},
    modelsUsed: [],
    maxTurns: 400,
    tokensUsed: 0,
    tokenLimit: null,
    thinkingTokens: 0,
    lastActivityAt: 1_000_000 + 95_000,
    retries: 0,
    resumable: false,
    progress: [], progressAt: [],
    todos: [],
    exitCode: 0,
    media: { images: true, audio: true },
    mediaGenerated: { images: 0, audio: 0 },
    pgid: null,
    leftover: false,
    ...over,
  };
}

/** The one entry the notice appended to the owner-notice ring. */
function ringEntry(): Record<string, unknown> {
  expect(kvSet).toHaveBeenCalledTimes(1);
  const [key, value] = kvSet.mock.calls[0] as [string, string];
  expect(key).toBe("ui:pending-actions");
  const ring = JSON.parse(value) as Record<string, unknown>[];
  expect(ring).toHaveLength(1);
  return ring[0];
}

beforeEach(() => {
  kvSet.mockReset();
  kvGet.mockReset().mockReturnValue(null);
  configGet.mockReset().mockResolvedValue(undefined);
  getActiveHarness.mockReset().mockResolvedValue("openclaw");
  readHermesApprovedUsers.mockReset().mockResolvedValue([]);
  notifyHermesTelegramUser.mockReset().mockResolvedValue(true);
  readTelegramAllowFrom.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the text", () => {
  it("is a template with the run id and counts — never the task or the summary", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      const text = buildAnnouncement(run({ status }));
      expect(text).toContain("run-k3x9q2ab");
      expect(text).toContain('project "site"');
      expect(text).toContain("7 turns");
      expect(text).toContain("2 files changed");
      expect(text).toContain("1m 35s");
      expect(text).not.toContain("DO-NOT-LEAK");
      expect(text).not.toContain("config.js");
    }
  });

  it("mentions denied actions so a quietly incomplete run is not read as a clean one", () => {
    expect(buildAnnouncement(run({ permissionDenials: 3 }))).toMatch(/3 actions were not allowed/);
    expect(buildAnnouncement(run({ permissionDenials: 1 }))).toMatch(/1 action was not allowed/);
  });

  it("says where to look for the details", () => {
    expect(buildAnnouncement(run({ status: "completed" }))).toMatch(/open the Coding Agent app/);
    expect(buildAnnouncement(run({ status: "failed" }))).toMatch(/did not finish/);
    expect(buildAnnouncement(run({ status: "stopped" }))).toMatch(/was stopped/);
  });
});

describe("the desktop leg", () => {
  it("raises a card the owner can act on, not a toast that slides away", async () => {
    await announceCodingAgent(run());
    const payload = ringEntry();
    // Its own action type: the desktop renders this in the top-right stack
    // with a button into the app, where the summary is.
    expect(payload.type).toBe("coding_agent");
    expect(payload.runId).toBe("run-k3x9q2ab");
    expect(payload.status).toBe("completed");
    expect(payload.projectId).toBe("site");
    expect(payload.message).toBe(buildAnnouncement(run()));
    expect(String(payload.message).length).toBeLessThanOrEqual(280);
    expect(typeof payload.ts).toBe("number");
  });

  it("goes onto the ring every desktop reads, named after the run, beside what is already there", async () => {
    // The old single slot was deleted by the first desktop to poll it, so a
    // phone and a laptop open together meant one of them never saw the card.
    // The ring is appended to, never replaced, and the run id is the entry's
    // identity so a desktop shows one card per run however often it polls.
    kvGet.mockReturnValue(JSON.stringify([{ id: "earlier", ts: Date.now() - 1_000, type: "notify", message: "hi" }]));
    await announceCodingAgent(run());
    const [, value] = kvSet.mock.calls[0] as [string, string];
    const ring = JSON.parse(value) as { id: string }[];
    expect(ring.map((e) => e.id)).toEqual(["earlier", "coding:run-k3x9q2ab"]);
  });

  it("still carries no task and no summary — a card is not a licence to quote the model", async () => {
    await announceCodingAgent(run());
    const raw = String(kvSet.mock.calls[0][1]);
    expect(raw).not.toContain("DO-NOT-LEAK");
    expect(raw).not.toContain("config.js");
  });

  it("swallows a failed write", async () => {
    kvSet.mockImplementation(() => { throw new Error("disk full"); });
    await expect(announceCodingAgent(run())).resolves.toBeUndefined();
  });
});

describe("the Telegram leg", () => {
  it("does nothing without a bot token — on OpenClaw, where the token IS the credential", async () => {
    // Set here, not inherited from beforeEach: with the harness left implicit
    // this case passes on hermes too (an empty approved list sends nothing),
    // so it would keep passing with the OpenClaw token gate deleted.
    getActiveHarness.mockResolvedValue("openclaw");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(notifyHermesTelegramUser).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("no Telegram bot"));
  });

  it("refuses a token that could reshape the request path", async () => {
    // The token lands in the URL. CodeQL flags it as file data reaching an
    // outbound request, and it is right to: a config value carrying "/" or "?"
    // would change which path is called. The host is a literal, so this is not
    // an SSRF, but the value still has to be proved before it is used.
    configGet.mockImplementation(async (key: string) =>
      key === "telegram_bot_token" ? "123:abc/../../evil?x=" : undefined);
    readTelegramAllowFrom.mockResolvedValue(["1001"]);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the token exactly as issued — the colon must not be percent-encoded", async () => {
    // Encoding the token looks like the safe thing to do and silently breaks
    // every notice: Telegram wants the literal "<id>:<secret>" and rejects %3A.
    configGet.mockImplementation(async (key: string) => (key === "telegram_bot_token" ? "123:abc" : undefined));
    readTelegramAllowFrom.mockResolvedValue(["1001"]);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("/bot123:abc/");
    expect(url).not.toContain("%3A");
  });

  it("on OpenClaw messages the approved senders through the Bot API, as plain text", async () => {
    configGet.mockImplementation(async (key: string) => (key === "telegram_bot_token" ? "123:abc" : undefined));
    readTelegramAllowFrom.mockResolvedValue(["1001", "not-a-chat-id", "1002"]);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe("1001");
    expect(body.text).toBe(buildAnnouncement(run()));
    expect(body.parse_mode).toBeUndefined();
    expect(body.text).not.toContain("DO-NOT-LEAK");
  });

  it("on Hermes sends even with no ClawBox-side bot token — the harness owns the credential", async () => {
    // `hermes send` reads its own token from ~/.hermes/.env and the approved
    // senders come from Hermes' pairing store. ClawBox's `telegram_bot_token`
    // is written only as a side effect of /setup-api/telegram/configure, so a
    // box paired with `hermes config set` — or restored without config.json —
    // has a working bot, approved users, and no ClawBox token. Gating on that
    // token silenced the notice on every one of them, without a log line.
    getActiveHarness.mockResolvedValue("hermes");
    configGet.mockResolvedValue(undefined);
    readHermesApprovedUsers.mockResolvedValue([{ id: "42", name: "Maya" }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(notifyHermesTelegramUser).toHaveBeenCalledWith("42", buildAnnouncement(run()));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on Hermes a malformed ClawBox-side token does not silence it either", async () => {
    // A partial restore can leave a truncated value in config.json. It is not
    // the credential this path uses, so it has no business deciding anything.
    getActiveHarness.mockResolvedValue("hermes");
    configGet.mockImplementation(async (key: string) =>
      key === "telegram_bot_token" ? "not-a-token" : undefined);
    readHermesApprovedUsers.mockResolvedValue([{ id: "42" }]);

    await announceCodingAgent(run());

    expect(notifyHermesTelegramUser).toHaveBeenCalledWith("42", buildAnnouncement(run()));
  });

  it("says in the log when there was nobody to send to, on each edition and for each reason", async () => {
    // "No notice arrived" and "no notice was sent" are different problems, and
    // a silent return made them the same one to whoever went looking. Three
    // branches, three distinguishable lines — matched on the word that tells
    // them apart, not on a prefix they share.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    getActiveHarness.mockResolvedValue("hermes");
    configGet.mockResolvedValue(undefined);
    readHermesApprovedUsers.mockResolvedValue([]);
    await announceCodingAgent(run());
    expect(info).toHaveBeenCalledWith(expect.stringContaining("no approved Telegram users"));

    info.mockClear();
    getActiveHarness.mockResolvedValue("openclaw");
    await announceCodingAgent(run());
    expect(info).toHaveBeenCalledWith(expect.stringContaining("no Telegram bot is configured"));

    // The one a real OpenClaw box hits most: a working bot and nobody approved.
    info.mockClear();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    configGet.mockImplementation(async (key: string) => (key === "telegram_bot_token" ? "123:abc" : undefined));
    readTelegramAllowFrom.mockResolvedValue([]);
    await announceCodingAgent(run());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("no approved Telegram senders"));
  });

  it("counts only recipients it can actually address", async () => {
    // Hermes' pairing store tolerates a legacy layout and merges two
    // directories, so a key that addresses nobody is possible. Counting it
    // logged up to five delivery FAILURES for messages nothing attempted.
    getActiveHarness.mockResolvedValue("hermes");
    configGet.mockResolvedValue(undefined);
    readHermesApprovedUsers.mockResolvedValue([{ id: "not-an-id" }, { id: "legacy:42" }]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await announceCodingAgent(run());

    expect(notifyHermesTelegramUser).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("no approved Telegram users"));
    expect(error).not.toHaveBeenCalled();
  });

  it("on Hermes goes through the hermes send path for each approved user", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    configGet.mockImplementation(async (key: string) => (key === "telegram_bot_token" ? "123:abc" : undefined));
    readHermesApprovedUsers.mockResolvedValue([{ id: "42", name: "Maya" }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(notifyHermesTelegramUser).toHaveBeenCalledWith("42", buildAnnouncement(run()));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never lets a Telegram failure escape", async () => {
    configGet.mockImplementation(async (key: string) => (key === "telegram_bot_token" ? "123:abc" : undefined));
    readTelegramAllowFrom.mockRejectedValue(new Error("no file"));
    await expect(announceCodingAgent(run())).resolves.toBeUndefined();
    getActiveHarness.mockRejectedValue(new Error("no edition"));
    await expect(announceCodingAgent(run())).resolves.toBeUndefined();
  });
});
