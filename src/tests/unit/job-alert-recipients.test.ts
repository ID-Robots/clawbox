import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Who gets the scheduled-job alerts on Telegram (TASK-2543). The alert used to
// go to the first five of the bot's approved users, so on a bot many people
// talk to an internal notice reached people it should not, and the order of
// the approval store decided who. The owner now picks, in Settings → Harness.
// What has to hold — through the REAL job-alerts check and the REAL Telegram
// fan-out, with only the stores and the two senders stood in:
//
//   * no pick saved: exactly the old behaviour (first five, store order);
//   * a pick: only the picked people, whatever the store's order;
//   * a picked person no longer approved: skipped, and said so in the log;
//   * an empty pick: nobody on Telegram — the desktop notice still goes;
//   * a pick that cannot be read: nobody on Telegram, never the default;
//   * all of it on OpenClaw (allowlist + Bot API) and on Hermes (pairing store
//     + `hermes send`), the recovery notice included.
//
// Every id here is made up.

const NOW = Date.parse("2026-11-05T12:00:00Z");
const MIN = 60_000;

let dataDir: string;
const configValues = new Map<string, unknown>();
let configReadable = true;

vi.mock("@/lib/config-store", () => ({
  get DATA_DIR() { return dataDir; },
  get: vi.fn(async (key: string) => configValues.get(key)),
  getKnown: vi.fn(async (key: string) =>
    configReadable ? { value: configValues.get(key), known: true } : { value: undefined, known: false }),
  setMany: vi.fn(async (entries: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) configValues.delete(key);
      else configValues.set(key, value);
    }
  }),
}));

const getActiveHarness = vi.hoisted(() => vi.fn());
vi.mock("@/lib/harness", () => ({ getActiveHarness }));

const readHermesApprovedUsers = vi.hoisted(() => vi.fn());
const notifyHermesTelegramUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-telegram", () => ({ readHermesApprovedUsers, notifyHermesTelegramUser }));

const readTelegramAllowFrom = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openclaw-config", () => ({ readTelegramAllowFrom }));

const readActiveTelegramBot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telegram-bot-identity", () => ({ readActiveTelegramBot }));

const sendTelegramBotMessage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telegram-owner-send", () => ({
  isTelegramBotToken: (token: string) => /^\d+:[\w-]+$/.test(token),
  sendTelegramBotMessage,
}));

vi.mock("@/lib/job-alerts-sources", () => ({ readJobs: vi.fn() }));
vi.mock("@/lib/email-notify", () => ({ notifyOwner: vi.fn(async () => undefined) }));

import {
  checkScheduledJobs,
  isRecipientPick,
  JOB_ALERT_RECIPIENTS_KEY,
  readJobAlertRecipients,
  readRecipientPick,
  saveJobAlertSettings,
} from "@/lib/job-alerts";
import type { JobSource, WatchedJob } from "@/lib/job-alerts-sources";
import { readJobs } from "@/lib/job-alerts-sources";
import { notifyOwner } from "@/lib/email-notify";
import {
  MAX_PICKED_TELEGRAM_RECIPIENTS,
  notifyOwnerTelegram,
  pickTelegramRecipients,
} from "@/lib/owner-telegram";

/** Seven approved users: more than the default's five. */
const APPROVED = ["100000001", "100000002", "100000003", "100000004", "100000005", "100000006", "100000007"];
const FIRST_FIVE = APPROVED.slice(0, 5);
const TOKEN = "123456:TEST-TOKEN";

function job(over: Partial<WatchedJob> = {}): WatchedJob {
  return {
    id: "nightly-sync",
    name: "Nightly sync",
    timed: true,
    lastStatus: "ok",
    lastRunAtMs: NOW - 10 * MIN,
    nextRunAtMs: NOW + 24 * 60 * MIN,
    running: false,
    consecutiveErrors: 0,
    consecutiveSkipped: 0,
    stopped: false,
    error: null,
    ...over,
  };
}

const failing = () => job({ lastStatus: "error", consecutiveErrors: 1 });

function source(runtime: "openclaw" | "hermes", jobs: WatchedJob[]): JobSource {
  return { runtime, reachable: true, jobs };
}

/** Make one alert go out, on the given runtime, through the real check. */
async function alertOnce(runtime: "openclaw" | "hermes" = "openclaw") {
  vi.mocked(readJobs).mockResolvedValue(source(runtime, [failing()]));
  await checkScheduledJobs(NOW);
}

/** The chat ids the Telegram leg sent to, on whichever runtime is active. */
function sentTo(): string[] {
  return [
    ...sendTelegramBotMessage.mock.calls.map((call) => String(call[1])),
    ...notifyHermesTelegramUser.mock.calls.map((call) => String(call[0])),
  ];
}

let info: MockInstance<typeof console.info>;
let error: MockInstance<typeof console.error>;
const logged = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-alert-recipients-"));
  configValues.clear();
  configReadable = true;
  vi.mocked(readJobs).mockReset();
  vi.mocked(notifyOwner).mockClear();
  getActiveHarness.mockReset().mockResolvedValue("openclaw");
  readActiveTelegramBot.mockReset().mockResolvedValue({ token: TOKEN, known: true, account: "default" });
  readTelegramAllowFrom.mockReset().mockResolvedValue([...APPROVED]);
  readHermesApprovedUsers.mockReset().mockResolvedValue(APPROVED.map((id) => ({ id })));
  sendTelegramBotMessage.mockReset().mockResolvedValue(true);
  notifyHermesTelegramUser.mockReset().mockResolvedValue(true);
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  delete process.env.CLAWBOX_JOB_ALERTS;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("pickTelegramRecipients", () => {
  it("with no pick, the first five approved users in the store's order — the old behaviour", () => {
    expect(pickTelegramRecipients(APPROVED)).toEqual(FIRST_FIVE);
    expect(pickTelegramRecipients(APPROVED, null)).toEqual(FIRST_FIVE);
  });

  it("with a pick, only the picked — however far down the store they are", () => {
    expect(pickTelegramRecipients(APPROVED, ["100000007", "100000002"])).toEqual(["100000002", "100000007"]);
  });

  it("skips a picked id that is no longer approved", () => {
    expect(pickTelegramRecipients(APPROVED, ["100000003", "999999999"])).toEqual(["100000003"]);
  });

  it("an empty pick is nobody, not the default", () => {
    expect(pickTelegramRecipients(APPROVED, [])).toEqual([]);
  });

  it("never addresses a malformed id, nor anyone twice, and bounds a pick", () => {
    expect(pickTelegramRecipients(["100000001", "not-an-id", "100000001"], null)).toEqual(["100000001"]);
    expect(pickTelegramRecipients(["not-an-id"], ["not-an-id"])).toEqual([]);
    const many = Array.from({ length: MAX_PICKED_TELEGRAM_RECIPIENTS + 5 }, (_, i) => String(200000000 + i));
    expect(pickTelegramRecipients(many, many)).toHaveLength(MAX_PICKED_TELEGRAM_RECIPIENTS);
  });
});

describe("a scheduled-job alert on OpenClaw", () => {
  it("no pick saved: the first five approved senders, through the Bot API, as before", async () => {
    await alertOnce();
    expect(sentTo()).toEqual(FIRST_FIVE);
    expect(sendTelegramBotMessage.mock.calls[0][0]).toBe(TOKEN);
    expect(String(sendTelegramBotMessage.mock.calls[0][2])).toContain("Nightly sync");
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("a pick: only the picked people, even past the fifth", async () => {
    await saveJobAlertSettings({ recipients: ["100000006", "100000002"] });
    await alertOnce();
    expect(sentTo()).toEqual(["100000002", "100000006"]);
    expect(logged(info)).toContain("[job-alerts] telegram notice sent to 100000006");
  });

  it("a picked sender who is no longer approved is skipped, and the log says so", async () => {
    await saveJobAlertSettings({ recipients: ["100000001", "100000099"] });
    await alertOnce();
    expect(sentTo()).toEqual(["100000001"]);
    expect(logged(info)).toContain("no longer approved, skipped: 100000099");
  });

  it("an empty pick: nobody on Telegram, the desktop notice still goes", async () => {
    await saveJobAlertSettings({ recipients: [] });
    await alertOnce();
    expect(sentTo()).toEqual([]);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(logged(info)).toContain("picked nobody");
  });

  it("a pick that cannot be read: nobody on Telegram — never the default", async () => {
    await saveJobAlertSettings({ recipients: ["100000001"] });
    configReadable = false;
    await alertOnce();
    expect(sentTo()).toEqual([]);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(logged(error)).toContain("Telegram recipients could not be read");
  });

  it("a stored value that is not a list is unreadable, not the default", async () => {
    configValues.set(JOB_ALERT_RECIPIENTS_KEY, "100000001");
    expect(await readRecipientPick()).toEqual({ picked: null, known: false });
    await alertOnce();
    expect(sentTo()).toEqual([]);
  });

  it("the recovery notice goes to the same pick", async () => {
    await saveJobAlertSettings({ recipients: ["100000004"] });
    await alertOnce();
    vi.mocked(readJobs).mockResolvedValue(source("openclaw", [job()]));
    await checkScheduledJobs(NOW + 2 * MIN);
    expect(sentTo()).toEqual(["100000004", "100000004"]);
    expect(String(sendTelegramBotMessage.mock.calls[1][2])).toContain("running normally again");
  });

  it("reads the approved senders of the account the bot was taken from", async () => {
    readActiveTelegramBot.mockResolvedValue({ token: TOKEN, known: true, account: "household" });
    await saveJobAlertSettings({ recipients: ["100000003"] });
    await alertOnce();
    expect(readTelegramAllowFrom).toHaveBeenCalledWith("household");
    expect(sentTo()).toEqual(["100000003"]);
  });

  it("back to the default: forgetting the pick restores the first five", async () => {
    await saveJobAlertSettings({ recipients: ["100000007"] });
    await saveJobAlertSettings({ recipients: null });
    expect(configValues.has(JOB_ALERT_RECIPIENTS_KEY)).toBe(false);
    await alertOnce();
    expect(sentTo()).toEqual(FIRST_FIVE);
  });
});

describe("a scheduled-job alert on Hermes", () => {
  beforeEach(() => {
    getActiveHarness.mockResolvedValue("hermes");
  });

  it("no pick saved: the first five approved users, through `hermes send`, as before", async () => {
    await alertOnce("hermes");
    expect(sentTo()).toEqual(FIRST_FIVE);
    expect(sendTelegramBotMessage).not.toHaveBeenCalled();
  });

  it("a pick: only the picked people; a stale id is skipped", async () => {
    await saveJobAlertSettings({ recipients: ["100000007", "100000005", "100000098"] });
    await alertOnce("hermes");
    expect(sentTo()).toEqual(["100000005", "100000007"]);
    expect(logged(info)).toContain("no longer approved, skipped: 100000098");
  });

  it("an empty pick: nobody", async () => {
    await saveJobAlertSettings({ recipients: [] });
    await alertOnce("hermes");
    expect(notifyHermesTelegramUser).not.toHaveBeenCalled();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });
});

describe("other notices keep the default fan-out", () => {
  it("a caller that hands in no pick tells the first five, whatever the job alerts' pick is", async () => {
    await saveJobAlertSettings({ recipients: ["100000007"] });
    await notifyOwnerTelegram("Your coding run finished.", "coding-agent");
    expect(sentTo()).toEqual(FIRST_FIVE);
  });
});

describe("what the Settings card is given", () => {
  it("lists the approved users with the names known for them, and who the next alert reaches", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    readHermesApprovedUsers.mockResolvedValue([
      { id: "100000001", name: "Иван Иванов" },
      { id: "100000002" },
      { id: "bad id" },
    ]);
    configValues.set("telegram_approved_names", { "100000002": "Acme desk" });
    const r = await readJobAlertRecipients();
    expect(r).toMatchObject({ runtime: "hermes", picked: null, known: true, defaultCount: 5 });
    expect(r.approved).toEqual([{ id: "100000001", name: "Иван Иванов" }, { id: "100000002", name: "Acme desk" }]);
    expect(r.effective).toEqual(["100000001", "100000002"]);
  });

  it("on OpenClaw lists the allowlist with the names remembered at approval", async () => {
    readTelegramAllowFrom.mockResolvedValue(["100000001", "100000002"]);
    configValues.set("telegram_approved_names", { "100000001": "Globex front desk" });
    await saveJobAlertSettings({ recipients: ["100000002", "100000099"] });
    const r = await readJobAlertRecipients();
    expect(r.approved).toEqual([{ id: "100000001", name: "Globex front desk" }, { id: "100000002" }]);
    expect(r.picked).toEqual(["100000002", "100000099"]);
    expect(r.effective).toEqual(["100000002"]);
  });

  it("on OpenClaw with no usable bot token offers nobody — nobody could be sent to", async () => {
    readActiveTelegramBot.mockResolvedValue({ token: null, known: true, account: "default" });
    expect((await readJobAlertRecipients()).approved).toEqual([]);
    readActiveTelegramBot.mockResolvedValue({ token: "not-a-token", known: true, account: "default" });
    expect((await readJobAlertRecipients()).approved).toEqual([]);
  });

  it("the switch and the pick are saved together, and null forgets the pick", async () => {
    await saveJobAlertSettings({ enabled: false, recipients: ["100000002", "100000002", "100000003"] });
    expect(configValues.get("pref:ui_job_alerts")).toBe(false);
    expect(configValues.get(JOB_ALERT_RECIPIENTS_KEY)).toEqual(["100000002", "100000003"]);
    await saveJobAlertSettings({ recipients: null });
    expect(configValues.has(JOB_ALERT_RECIPIENTS_KEY)).toBe(false);
    expect(configValues.get("pref:ui_job_alerts")).toBe(false);
  });

  it("an unreadable pick reaches nobody, and says so", async () => {
    configReadable = false;
    const r = await readJobAlertRecipients();
    expect(r).toMatchObject({ known: false, effective: [] });
  });
});

describe("isRecipientPick", () => {
  it.each([
    [null, true],
    [[], true],
    [["100000001", "-100000002"], true],
    [["100000001", 5], false],
    [["not-an-id"], false],
    ["100000001", false],
    [{ ids: [] }, false],
    [Array.from({ length: MAX_PICKED_TELEGRAM_RECIPIENTS + 1 }, (_, i) => String(300000000 + i)), false],
  ])("%j → %s", (value, ok) => {
    expect(isRecipientPick(value)).toBe(ok);
  });
});
