/**
 * The owner's switch for the Telegram leg of the coding agent's finish notice
 * (src/lib/coding-agent-notify.ts).
 *
 * Off — by the `ui_coding_agent_telegram_notify` preference or by
 * CLAWBOX_CODING_AGENT_TELEGRAM=off — means one info line and no Telegram
 * send, on either edition; the desktop card is raised either way. Anything
 * else leaves the leg on, because that is what every box did before the
 * switch existed.
 *
 * The preference is stored through the real POST /setup-api/preferences
 * handler over an in-memory config store, so the name is proven to get
 * through that door's prefix rule and land where the notice reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { CodingRun } from "@/lib/coding-agent";

const desktop = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/lib/pending-actions", () => ({
  pushPendingAction: vi.fn(async (action: Record<string, unknown>) => {
    desktop.push(action);
    return { ...action, id: "id", ts: 0 };
  }),
}));

const store = vi.hoisted(() => new Map<string, unknown>());
const configGet = vi.hoisted(() => vi.fn(async (key: string) => store.get(key)));
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  set: vi.fn(async (key: string, value: unknown) => {
    store.set(key, value);
  }),
  getAll: vi.fn(async () => Object.fromEntries(store)),
  setMany: vi.fn(async (entries: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(entries)) store.set(key, value);
  }),
}));

// Only POST is driven here; GET's session check is the preferences suite's.
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn() }));

const getActiveHarness = vi.hoisted(() => vi.fn());
vi.mock("@/lib/harness", () => ({ getActiveHarness, getEdition: vi.fn(() => "openclaw") }));

const readHermesApprovedUsers = vi.hoisted(() => vi.fn());
const notifyHermesTelegramUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-telegram", () => ({ readHermesApprovedUsers, notifyHermesTelegramUser }));

const readActiveTelegramBot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telegram-bot-identity", () => ({ readActiveTelegramBot }));

const sendTelegramBotMessage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telegram-owner-send", () => ({ isTelegramBotToken: () => true, sendTelegramBotMessage }));

const readTelegramAllowFrom = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openclaw-config")>()),
  readTelegramAllowFrom,
}));

import {
  CODING_AGENT_TELEGRAM_ENV,
  CODING_AGENT_TELEGRAM_PREF,
  announceAnthropicLimit,
  announceCodingAgent,
  codingAgentTelegramOff,
} from "@/lib/coding-agent-notify";
import { POST } from "@/app/setup-api/preferences/route";

const TOKEN = "123456789:AAH-placeholder-token-for-tests_000000";
const STORE_KEY = `pref:${CODING_AGENT_TELEGRAM_PREF}`;

const RUN = {
  id: "run-k3x9q2ab",
  projectId: "site",
  status: "completed",
  startedAt: 1_000_000,
  completedAt: 1_000_000 + 95_000,
  numTurns: 7,
  filesTouched: ["index.html"],
  permissionDenials: 0,
} as CodingRun;

async function savePreferences(body: Record<string, unknown>): Promise<Response> {
  return POST(new Request("http://localhost/setup-api/preferences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

let info: MockInstance<typeof console.info>;

/** The lines the switch itself logged — the ones naming it. */
function switchLines(): string[] {
  return info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("switched off"));
}

function expectTelegramSkipped(): void {
  expect(sendTelegramBotMessage).not.toHaveBeenCalled();
  expect(notifyHermesTelegramUser).not.toHaveBeenCalled();
  // Skipped BEFORE the leg runs, not after it looked for a bot.
  expect(getActiveHarness).not.toHaveBeenCalled();
  expect(readActiveTelegramBot).not.toHaveBeenCalled();
  // Exactly one line, and it is the only info line the notice wrote.
  expect(info).toHaveBeenCalledTimes(1);
  expect(switchLines()).toHaveLength(1);
  expect(switchLines()[0]).toContain(RUN.id);
  expect(switchLines()[0]).toContain("desktop notice only");
}

function expectDesktopCard(): void {
  expect(desktop).toHaveLength(1);
  expect(desktop[0]).toMatchObject({ type: "coding_agent", runId: RUN.id, status: "completed" });
  expect(String(desktop[0].message)).toMatch(/^Coding agent finished run-k3x9q2ab/);
}

beforeEach(() => {
  desktop.length = 0;
  store.clear();
  configGet.mockClear();
  vi.stubEnv(CODING_AGENT_TELEGRAM_ENV, undefined);
  getActiveHarness.mockReset().mockResolvedValue("openclaw");
  readHermesApprovedUsers.mockReset().mockResolvedValue([{ id: "111" }]);
  notifyHermesTelegramUser.mockReset().mockResolvedValue(true);
  readActiveTelegramBot.mockReset().mockResolvedValue({ token: TOKEN, known: true, account: null });
  sendTelegramBotMessage.mockReset().mockResolvedValue(true);
  readTelegramAllowFrom.mockReset().mockResolvedValue(["111", "222"]);
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  info.mockRestore();
});

describe("the switch's names", () => {
  it("are the ones the owner and the operator are told to use", () => {
    expect(CODING_AGENT_TELEGRAM_PREF).toBe("ui_coding_agent_telegram_notify");
    expect(CODING_AGENT_TELEGRAM_ENV).toBe("CLAWBOX_CODING_AGENT_TELEGRAM");
  });
});

describe("on — the default, and every value that is not clearly off", () => {
  it("sends to Telegram with no preference stored and nothing in the environment", async () => {
    expect(await codingAgentTelegramOff()).toBeNull();
    await announceCodingAgent(RUN);
    expectDesktopCard();
    expect(sendTelegramBotMessage.mock.calls.map((call) => call[1])).toEqual(["111", "222"]);
    expect(sendTelegramBotMessage.mock.calls[0][2]).toBe(desktop[0].message);
    expect(switchLines()).toEqual([]);
  });

  it("sends for a stored true, on, 1 — and for a value it does not recognise", async () => {
    for (const value of [true, "on", "true", 1, "yes", "please", "", null]) {
      store.set(STORE_KEY, value);
      sendTelegramBotMessage.mockClear();
      expect(await codingAgentTelegramOff(), JSON.stringify(value)).toBeNull();
      await announceCodingAgent(RUN);
      expect(sendTelegramBotMessage, JSON.stringify(value)).toHaveBeenCalledTimes(2);
    }
    expect(switchLines()).toEqual([]);
  });

  it("sends when the store cannot be read — an unreadable store is not the owner saying off", async () => {
    configGet.mockRejectedValueOnce(new Error("EACCES"));
    await announceCodingAgent(RUN);
    expectDesktopCard();
    expect(sendTelegramBotMessage).toHaveBeenCalledTimes(2);
    expect(switchLines()).toEqual([]);
  });

  it("sends when the environment names something other than off", async () => {
    for (const value of ["on", "true", "1", ""]) {
      vi.stubEnv(CODING_AGENT_TELEGRAM_ENV, value);
      sendTelegramBotMessage.mockClear();
      await announceCodingAgent(RUN);
      expect(sendTelegramBotMessage, value).toHaveBeenCalledTimes(2);
    }
  });
});

describe("off by the preference", () => {
  it("keeps the desktop card, skips Telegram and says so once", async () => {
    store.set(STORE_KEY, false);
    expect(await codingAgentTelegramOff()).toBe("pref");
    await announceCodingAgent(RUN);
    expectDesktopCard();
    expectTelegramSkipped();
    expect(switchLines()[0]).toContain(CODING_AGENT_TELEGRAM_PREF);
  });

  it("reads false, 0 and the words for off, in any case and with stray spaces", async () => {
    for (const value of [false, 0, "off", "OFF", " Off ", "false", "0", "no"]) {
      store.set(STORE_KEY, value);
      expect(await codingAgentTelegramOff(), JSON.stringify(value)).toBe("pref");
    }
  });

  it("skips the Hermes send too — the switch sits above the edition branch", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    await announceCodingAgent(RUN);
    expect(notifyHermesTelegramUser).toHaveBeenCalledTimes(1);

    notifyHermesTelegramUser.mockClear();
    getActiveHarness.mockClear();
    info.mockClear();
    desktop.length = 0;
    store.set(STORE_KEY, "off");
    await announceCodingAgent(RUN);
    expectDesktopCard();
    expectTelegramSkipped();
  });

  it("is read on every notice, so a change holds from the next run without a restart", async () => {
    store.set(STORE_KEY, false);
    await announceCodingAgent(RUN);
    expect(sendTelegramBotMessage).not.toHaveBeenCalled();
    store.set(STORE_KEY, true);
    await announceCodingAgent(RUN);
    expect(sendTelegramBotMessage).toHaveBeenCalledTimes(2);
  });
});

describe("the preference through the preferences route", () => {
  it("is stored by POST /setup-api/preferences and switches the leg off, then on again", async () => {
    const off = await savePreferences({ [CODING_AGENT_TELEGRAM_PREF]: false });
    expect(off.status).toBe(200);
    expect(store.get(STORE_KEY)).toBe(false);
    await announceCodingAgent(RUN);
    expect(sendTelegramBotMessage).not.toHaveBeenCalled();
    expect(switchLines()).toHaveLength(1);

    const on = await savePreferences({ [CODING_AGENT_TELEGRAM_PREF]: true });
    expect(on.status).toBe(200);
    await announceCodingAgent(RUN);
    expect(sendTelegramBotMessage).toHaveBeenCalledTimes(2);
  });

  it("needs its ui_ prefix: the route answers ok for a bare name and stores nothing", async () => {
    const res = await savePreferences({ coding_agent_telegram_notify: false });
    expect(res.status).toBe(200);
    expect([...store.keys()]).toEqual([]);
    await announceCodingAgent(RUN);
    expect(sendTelegramBotMessage).toHaveBeenCalledTimes(2);
  });
});

describe("off by CLAWBOX_CODING_AGENT_TELEGRAM=off", () => {
  it("keeps the desktop card, skips Telegram and says so once, with no preference stored", async () => {
    vi.stubEnv(CODING_AGENT_TELEGRAM_ENV, "off");
    expect(await codingAgentTelegramOff()).toBe("env");
    await announceCodingAgent(RUN);
    expectDesktopCard();
    expectTelegramSkipped();
    expect(switchLines()[0]).toContain(CODING_AGENT_TELEGRAM_ENV);
  });

  it("wins over a stored on preference — either one saying off is enough", async () => {
    vi.stubEnv(CODING_AGENT_TELEGRAM_ENV, "OFF");
    store.set(STORE_KEY, true);
    await announceCodingAgent(RUN);
    expectTelegramSkipped();
  });

  it("does not turn a stored off back on when it says on", async () => {
    vi.stubEnv(CODING_AGENT_TELEGRAM_ENV, "on");
    store.set(STORE_KEY, "off");
    expect(await codingAgentTelegramOff()).toBe("pref");
    await announceCodingAgent(RUN);
    expectTelegramSkipped();
  });
});

describe("what the switch does not touch", () => {
  it("leaves the Anthropic account-limit notices on Telegram", async () => {
    vi.stubEnv(CODING_AGENT_TELEGRAM_ENV, "off");
    store.set(STORE_KEY, false);
    await announceAnthropicLimit({ kind: "all_limited", resetAt: null, runId: null });
    expect(sendTelegramBotMessage).toHaveBeenCalledTimes(2);
    expect(switchLines()).toEqual([]);
  });
});
