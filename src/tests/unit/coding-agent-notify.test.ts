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
const getEdition = vi.hoisted(() => vi.fn(() => "openclaw"));
vi.mock("@/lib/harness", () => ({ getActiveHarness, getEdition }));

const readHermesApprovedUsers = vi.hoisted(() => vi.fn());
const notifyHermesTelegramUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-telegram", () => ({ readHermesApprovedUsers, notifyHermesTelegramUser }));

const readTelegramAllowFrom = vi.hoisted(() => vi.fn());
// OpenClaw's OWN credential store — channels.telegram.botToken in openclaw.json
// is what the gateway long-polls from, and what `openclaw config set` writes.
const readConfigStrict = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openclaw-config", () => ({ readTelegramAllowFrom, readConfigStrict }));

import { announceAnthropicLimit, announceCodingAgent, announceCodingTeam, buildAnnouncement, buildAnthropicLimitNotice, buildTeamAnnouncement } from "@/lib/coding-agent-notify";
import type { TeamBoard } from "@/lib/coding-team-board";

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
    provider: "clawbox-ai",
    requestedModel: null,
    modelRole: null,
    anthropicAccount: null,
    accountSwitches: [],
    model: "deepseek-v4-flash",
    summary: SECRET_SUMMARY,
    error: null,
    numTurns: 7,
    reviewOf: null,
    reviewLoopOf: null,
    reviewRound: null,
    pipeline: null,
    team: null,
    readOnly: false,
    extraBrief: null,
    filesTouched: ["index.html", "config.js"],
    commandsRun: 2,
    permissionDenials: 0,
    deniedActions: [],
    denials: [],
    worktreeHints: 0,
    allowRules: [],
    inputs: null,
    secretNames: [],
    effort: "max",
    subagentsActive: 0,
    activeSubagents: [], subagents: [],
    subagentsTotal: 0,
    commit: null,
    pr: null,
    review: null,
    subagentsByType: {},
    modelsUsed: [],
    maxTurns: 400,
    tokensUsed: 0,
    tokenBreakdown: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    spawnTokens: [],
    tokenLimit: null,
    thinkingTokens: 0,
    lastActivityAt: 1_000_000 + 95_000,
    retries: 0,
    resumable: false,
    failureKind: null,
    pauseReason: null,
    progress: [], progressAt: [],
    todos: [],
    exitCode: 0,
    media: { images: true, audio: true },
    reviewPass: false,
    visual: null,
    mediaGenerated: { images: 0, audio: 0 },
    pgid: null,
    unit: null,
    streamOffset: 0,
    leftover: false,
    headAtStart: null,
    commitError: null,
    worktree: null,
    deliverable: null,
    deliverableCheck: null,
    attempts: [],
    completionAttempts: 3,
    messages: [],
    ...over,
  };
}

/** A settled team's board — only the fields the notice may read, so a new read shows up here as a type error. */
function board(over: Partial<TeamBoard> = {}): TeamBoard {
  const partial: Pick<TeamBoard, "id" | "goal" | "projectId" | "status" | "branch" | "pr" | "error" | "tasks"> = {
    id: "team-k3x9q2ab",
    goal: SECRET_TASK,
    projectId: "site",
    status: "done",
    branch: "clawbox/team-k3x9q2ab",
    pr: null,
    error: "The final review rejected the merged work: it wrote sk-live-DO-NOT-LEAK into config.js",
    tasks: [
      { task_id: "t1", task_description: SECRET_TASK, status: "complete", result: SECRET_SUMMARY },
      { task_id: "t2", task_description: SECRET_TASK, status: "complete", result: SECRET_SUMMARY },
      { task_id: "t3", task_description: SECRET_TASK, status: "failed", result: SECRET_SUMMARY },
      { task_id: "t4", task_description: SECRET_TASK, status: "retired", result: null },
    ] as unknown as TeamBoard["tasks"],
    ...over,
  };
  return partial as TeamBoard;
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
  readConfigStrict.mockReset().mockResolvedValue({});
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

describe("a team's text", () => {
  it("is a template with the team id, the counts and the branch — never the goal, a task, a result or the error", () => {
    for (const status of ["done", "failed", "stopped"] as const) {
      const text = buildTeamAnnouncement(board({ status }));
      expect(text).toContain("team-k3x9q2ab");
      expect(text).toContain('project "site"');
      // t4 is retired: not a task the team owed.
      expect(text).toContain("2 of 3 tasks done, 1 failed, on branch clawbox/team-k3x9q2ab");
      expect(text).not.toContain("DO-NOT-LEAK");
      expect(text).not.toContain("config.js");
      expect(text).not.toContain("final review");
    }
    expect(buildTeamAnnouncement(board({ status: "done" }))).toMatch(/^Coding team team-k3x9q2ab finished .*open the Coding Agent app/);
    expect(buildTeamAnnouncement(board({ status: "failed" }))).toMatch(/did not finish/);
    expect(buildTeamAnnouncement(board({ status: "stopped" }))).toMatch(/was stopped/);
  });

  it("names the pull request when the box opened one, and says nothing of a branch an in-place team has none of", () => {
    expect(buildTeamAnnouncement(board({ pr: { number: 12 } as TeamBoard["pr"] }))).toContain("on branch clawbox/team-k3x9q2ab, pull request #12");
    expect(buildTeamAnnouncement(board({ branch: null, projectId: null }))).toContain("in its folder (2 of 3 tasks done, 1 failed).");
  });

  it("goes to the desktop as the plain notice named after the team, and to Telegram, with the same template", async () => {
    readTelegramAllowFrom.mockResolvedValue(["12345"]);
    readConfigStrict.mockResolvedValue({ channels: { telegram: { botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi" } } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await announceCodingTeam(board());
    const payload = ringEntry();
    expect(payload.type).toBe("notify");
    expect(payload.id).toBe("coding-team:team-k3x9q2ab");
    expect(payload.message).toBe(buildTeamAnnouncement(board()));
    expect(String(payload.message).length).toBeLessThanOrEqual(280);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(fetchMock.mock.calls[0]);
    expect(sent).toContain("Coding team team-k3x9q2ab finished");
    expect(sent).not.toContain("DO-NOT-LEAK");
  });

  it("never throws: a ring that cannot be written and a Telegram that will not answer cost only the notice", async () => {
    kvSet.mockImplementation(() => { throw new Error("disk full"); });
    readTelegramAllowFrom.mockRejectedValue(new Error("no config"));
    await expect(announceCodingTeam(board())).resolves.toBeUndefined();
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

  // The OpenClaw twin of the Hermes case below: the credential is the harness's
  // on BOTH editions, and a box paired with `openclaw config set` (or restored
  // with ~/.openclaw intact and a fresh data/config.json) has no ClawBox mirror.
  // Gating the notice on the mirror silences it on a box with a working bot and
  // approved senders — and logs it at info, so nothing ever tells the owner.
  it("on OpenClaw sends with no ClawBox mirror — the harness owns the credential", async () => {
    readConfigStrict.mockResolvedValue({
      channels: { telegram: { enabled: true, botToken: "654321:NativeOpenClawBot" } },
    });
    readTelegramAllowFrom.mockResolvedValue(["1001"]);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.telegram.org/bot654321:NativeOpenClawBot/sendMessage");
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

/**
 * OpenClaw's multi-account Telegram channel keeps each bot under
 * `channels.telegram.accounts.<id>`, and `openclaw channels add` moves the
 * root's token there when a second account is added — so the root holds none.
 * Reading only the root logged "no Telegram bot is configured" on a box whose
 * bot works, and the approved senders it then asked for were the wrong
 * account's: the pairing store files them per account.
 */
describe("the Telegram leg on a multi-account OpenClaw channel", () => {
  const ROOT_BOT = "700001:RootChannelBot_0";
  const DEFAULT_ACCOUNT_BOT = "700002:DefaultAccountBot_0";
  const WORK_BOT = "700003:WorkAccountBot_00";
  const ENV_REF = { source: "env", provider: "default", id: "TELEGRAM_WORK_BOT_TOKEN" };

  function sentWith(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return fetchMock.mock.calls.map(([url]) => String(url));
  }

  beforeEach(() => {
    getActiveHarness.mockResolvedValue("openclaw");
    readTelegramAllowFrom.mockResolvedValue(["1001"]);
  });

  it("still sends through the top-level token, for the default account", async () => {
    readConfigStrict.mockResolvedValue({
      channels: { telegram: { enabled: true, botToken: ROOT_BOT, accounts: { work: { botToken: WORK_BOT } } } },
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(sentWith(fetchMock)).toEqual([`https://api.telegram.org/bot${ROOT_BOT}/sendMessage`]);
    expect(readTelegramAllowFrom).toHaveBeenCalledWith("default");
  });

  it("sends through accounts.default when the top level holds no token", async () => {
    readConfigStrict.mockResolvedValue({
      channels: {
        telegram: {
          enabled: true,
          accounts: { work: { botToken: WORK_BOT }, default: { botToken: DEFAULT_ACCOUNT_BOT } },
        },
      },
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(sentWith(fetchMock)).toEqual([`https://api.telegram.org/bot${DEFAULT_ACCOUNT_BOT}/sendMessage`]);
    expect(readTelegramAllowFrom).toHaveBeenCalledWith("default");
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining("no Telegram bot"));
  });

  it("follows defaultAccount to another account, and asks THAT account who is approved", async () => {
    readConfigStrict.mockResolvedValue({
      channels: {
        telegram: {
          enabled: true,
          defaultAccount: "Work",
          accounts: { default: { botToken: DEFAULT_ACCOUNT_BOT }, work: { botToken: WORK_BOT } },
        },
      },
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(sentWith(fetchMock)).toEqual([`https://api.telegram.org/bot${WORK_BOT}/sendMessage`]);
    expect(readTelegramAllowFrom).toHaveBeenCalledWith("work");
  });

  it("says the bot could not be read — not that there is none — for an account holding a secret reference", async () => {
    readConfigStrict.mockResolvedValue({
      channels: { telegram: { enabled: true, defaultAccount: "work", accounts: { work: { botToken: ENV_REF } } } },
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("could not be read"));
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining("no Telegram bot is configured"));
  });

  it("says no bot is configured when no account holds a token at all", async () => {
    readConfigStrict.mockResolvedValue({
      channels: { telegram: { enabled: true, accounts: { work: { enabled: true }, family: { botToken: "" } } } },
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await announceCodingAgent(run());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("no Telegram bot is configured"));
  });
});

/**
 * The Anthropic account-limit notices (TASK-902): one when an account becomes
 * limited and the box moves on, one when that leaves no account — and never
 * the run card's type, which is deduped by run id and would take the place of
 * the same run's finish notice.
 */
describe("the Anthropic account-limit notices", () => {
  const SOFIA = "Europe/Sofia";
  const AT_2250 = Date.UTC(2026, 8, 18, 19, 50);

  it("says which account stopped, when it is back, and that everything using Claude moved (TASK-1260)", () => {
    expect(buildAnthropicLimitNotice({ kind: "switched", fromLabel: "Work Max", toLabel: "Personal Max", resetAt: AT_2250, runId: "run-k3x9q2ab" }, SOFIA))
      .toBe('Anthropic account "Work Max" hit its usage limit (back at 22:50). ClawBox switched everything that uses Claude to "Personal Max" and run-k3x9q2ab carried on.');
    // A limit seen by the chat or a cron: no run to name.
    expect(buildAnthropicLimitNotice({ kind: "switched", reason: "limit", fromLabel: "Work Max", toLabel: "Personal Max", resetAt: AT_2250, runId: null }, SOFIA))
      .toBe('Anthropic account "Work Max" hit its usage limit (back at 22:50). ClawBox switched everything that uses Claude to "Personal Max".');
  });

  it("names a refused credential as one the owner has to sign in again, with no reset time", () => {
    expect(buildAnthropicLimitNotice({ kind: "switched", reason: "auth", fromLabel: "Work Max", toLabel: "Personal Max", resetAt: null, runId: null }, SOFIA))
      .toBe('Anthropic account "Work Max" was refused by Anthropic and needs to be signed in again (Settings → Providers). ClawBox switched everything that uses Claude to "Personal Max".');
  });

  it("says that runs WAIT when every account is limited, and until when", () => {
    expect(buildAnthropicLimitNotice({ kind: "all_limited", resetAt: AT_2250, runId: null }, SOFIA))
      .toBe("Every Anthropic account on this ClawBox is at its usage limit. Coding runs and the chat's Claude work are waiting instead of failing, and pick up again at 22:50.");
    expect(buildAnthropicLimitNotice({ kind: "all_limited", resetAt: null, runId: null }, SOFIA)).toMatch(/as soon as one is back/);
  });

  it("goes to the desktop as a plain notice that opens Settings → Providers on the accounts, not as a run card", async () => {
    await announceAnthropicLimit({ kind: "switched", fromLabel: "A", toLabel: "B", resetAt: AT_2250, runId: "run-k3x9q2ab" });
    const payload = ringEntry();
    expect(payload.type).toBe("notify");
    // The accounts sit folded behind a button on the Anthropic row; the focus
    // is what lands the owner with them open and in view.
    expect(payload.action).toEqual({ open: "settings", section: "ai", focus: "anthropicAccounts" });
    expect(payload.runId).toBeUndefined();
  });

  it("reaches the owner's Telegram chat on OpenClaw, as the same plain text", async () => {
    const notice = { kind: "switched", fromLabel: "Work Max", toLabel: "Personal Max", resetAt: AT_2250, runId: "run-k3x9q2ab" } as const;
    configGet.mockImplementation(async (key: string) => (key === "telegram_bot_token" ? "123:abc" : undefined));
    readTelegramAllowFrom.mockResolvedValue(["1001"]);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await announceAnthropicLimit(notice);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe("1001");
    expect(body.text).toBe(buildAnthropicLimitNotice(notice));
    expect(body.parse_mode).toBeUndefined();
  });

  it("reaches each approved user through the hermes send path on Hermes", async () => {
    const notice = { kind: "all_limited", resetAt: AT_2250, runId: null } as const;
    getActiveHarness.mockResolvedValue("hermes");
    readHermesApprovedUsers.mockResolvedValue([{ id: "42", name: "Maya" }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await announceAnthropicLimit(notice);

    expect(notifyHermesTelegramUser).toHaveBeenCalledWith("42", buildAnthropicLimitNotice(notice));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("goes to the owner's Telegram too, and never lets a failure escape", async () => {
    configGet.mockImplementation(async (key: string) => (key === "telegram_bot_token" ? "123:abc" : undefined));
    readTelegramAllowFrom.mockRejectedValue(new Error("no file"));
    kvSet.mockImplementation(() => { throw new Error("disk full"); });
    await expect(announceAnthropicLimit({ kind: "all_limited", resetAt: null, runId: null })).resolves.toBeUndefined();
  });
});
