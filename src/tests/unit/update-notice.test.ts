/**
 * The weekly update check and its notice (TASK-2260, src/lib/update-notice.ts).
 *
 * What is pinned: the check is the updater's own (`getVersionInfo` with its
 * cache dropped); a newer version is announced ONCE — Telegram with an Update
 * button when a bot reaches somebody, the desktop otherwise — and nothing at
 * all when there is nothing newer; the owner's switch; the catch-up after
 * downtime; and the chat side: /update and the button answer the OWNER only,
 * and the button can only ever ask (`requestPowerApproval`), never update.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const versionInfo = vi.fn();
const invalidateVersionCache = vi.fn();
const getUpdateState = vi.fn(() => ({ phase: "idle", steps: [] }));
vi.mock("@/lib/updater", () => ({
  getVersionInfo: (...a: unknown[]) => versionInfo(...a),
  invalidateVersionCache: () => invalidateVersionCache(),
  getUpdateState: () => getUpdateState(),
}));
const readUpdateWhatsNew = vi.fn();
vi.mock("@/lib/update-whats-new-server", () => ({ readUpdateWhatsNew: () => readUpdateWhatsNew() }));
const ownerChatIds = vi.fn(async (_h?: string) => ["6001"]);
vi.mock("@/lib/email-approval", () => ({ ownerChatIds: (h?: string) => ownerChatIds(h) }));
const sendOwnerTelegramButtons = vi.fn(async (..._a: unknown[]) => true);
const sendOwnerTelegramText = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/telegram-owner-send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telegram-owner-send")>()),
  sendOwnerTelegramButtons: (...a: unknown[]) => sendOwnerTelegramButtons(...a),
  sendOwnerTelegramText: (...a: unknown[]) => sendOwnerTelegramText(...a),
}));
const notifyOwner = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/email-notify", () => ({ notifyOwner: (...a: unknown[]) => notifyOwner(...a) }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
const requestPowerApproval = vi.fn();
vi.mock("@/lib/power-approval", () => {
  class PowerApprovalConflict extends Error {}
  return { requestPowerApproval: (...a: unknown[]) => requestPowerApproval(...a), PowerApprovalConflict };
});

const activeAgentWork = vi.fn(async () => ({ coding: 0, agents: 0, total: 0 }));
vi.mock("@/lib/update-busy", () => ({ activeAgentWork: () => activeAgentWork() }));

let root: string;
let notice: typeof import("@/lib/update-notice");
let config: typeof import("@/lib/config-store");
const savedTz = process.env.TZ;

const CURRENT = { clawbox: { current: "v4.3.0", target: null, updateAvailable: false }, remote: { reachable: true } };
const AVAILABLE = { clawbox: { current: "v4.3.0", target: "v4.3.1", updateAvailable: true }, remote: { reachable: true } };
const UNREACHABLE = { clawbox: { current: "v4.3.0", target: null, updateAvailable: null }, remote: { reachable: false, reason: "GitHub refused" } };
const NOTES = {
  version: "4.3.1",
  channel: "main",
  source: "notes",
  highlights: [
    { title: "Weekly update check", body: "…" },
    { title: "Faster chat", body: "…" },
    { title: "Quieter fans", body: "…" },
    { title: "A fourth thing", body: "…" },
  ],
  releaseUrl: "https://example.invalid",
};

/** Monday 2026-11-09 at a local wall-clock time. */
const monday = (h: number, min = 0) => new Date(2026, 10, 9, h, min);

async function writeState(state: Record<string, unknown>): Promise<void> {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "update-notice.json"), JSON.stringify({ jitterS: 0, ...state }));
}

function readState(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "data", "update-notice.json"), "utf-8"));
}

beforeEach(async () => {
  process.env.TZ = "Europe/Sofia";
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-update-notice-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  for (const m of [versionInfo, invalidateVersionCache, readUpdateWhatsNew, ownerChatIds, sendOwnerTelegramButtons,
    sendOwnerTelegramText, notifyOwner, requestPowerApproval]) m.mockClear();
  versionInfo.mockResolvedValue(AVAILABLE);
  readUpdateWhatsNew.mockResolvedValue(NOTES);
  ownerChatIds.mockResolvedValue(["6001"]);
  sendOwnerTelegramButtons.mockResolvedValue(true);
  sendOwnerTelegramText.mockResolvedValue(true);
  getUpdateState.mockReturnValue({ phase: "idle", steps: [] });
  activeAgentWork.mockResolvedValue({ coding: 0, agents: 0, total: 0 });
  config = await import("@/lib/config-store");
  notice = await import("@/lib/update-notice");
  notice.resetForcedCheckForTests();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("the weekly run", () => {
  it("asks the updater's own check, fresh, and announces a newer version on Telegram with an Update button", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    const result = await notice.runWeeklyUpdateCheck(monday(10, 5));

    expect(invalidateVersionCache).toHaveBeenCalledTimes(1);
    expect(versionInfo).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ran: true, week: "2026-11-09", outcome: "notified", via: "telegram" });
    expect(sendOwnerTelegramButtons).toHaveBeenCalledTimes(1);
    const [chatId, text, buttons, opts] = sendOwnerTelegramButtons.mock.calls[0];
    expect(chatId).toBe("6001");
    expect(text).toContain("ClawBox 4.3.1 is available — this box runs 4.3.0.");
    expect(text).toContain("What's new:\n• Weekly update check\n• Faster chat\n• Quieter fans");
    expect(text).not.toContain("A fourth thing");
    expect(text).toContain("Tap Update to install it.");
    expect(buttons).toEqual([{ text: "Update", callback_data: "clawbox-update" }]);
    expect(opts).toEqual({ harness: "openclaw" });
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(readState()).toMatchObject({
      lastCheckedWeek: "2026-11-09",
      lastResult: "notified",
      lastNotifiedTarget: "v4.3.1",
      lastNotifiedVersion: "4.3.1",
      lastNotifiedVia: "telegram",
    });
  });

  it("never notifies twice for the same version — not later that week, not the week after", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    await notice.runWeeklyUpdateCheck(monday(10, 5));
    // Later the same week: not due at all.
    expect(await notice.runWeeklyUpdateCheck(new Date(2026, 10, 12, 9))).toEqual({ ran: false });
    // Next Monday, same version still newest: checked, but nothing sent.
    const next = await notice.runWeeklyUpdateCheck(new Date(2026, 10, 16, 10, 30));
    expect(next).toEqual({ ran: true, week: "2026-11-16", outcome: "already-notified" });
    expect(sendOwnerTelegramButtons).toHaveBeenCalledTimes(1);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("announces the NEXT version when one comes", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02", lastNotifiedTarget: "v4.3.1" });
    versionInfo.mockResolvedValue({ ...AVAILABLE, clawbox: { ...AVAILABLE.clawbox, target: "v4.4.0" } });
    readUpdateWhatsNew.mockResolvedValue({ ...NOTES, version: "4.4.0" });
    const result = await notice.runWeeklyUpdateCheck(monday(11));
    expect(result.outcome).toBe("notified");
    expect(sendOwnerTelegramButtons.mock.calls[0][1]).toContain("ClawBox 4.4.0 is available");
    expect(readState().lastNotifiedTarget).toBe("v4.4.0");
  });

  it("sends NOTHING when there is no newer version", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    versionInfo.mockResolvedValue(CURRENT);
    const result = await notice.runWeeklyUpdateCheck(monday(10, 30));
    expect(result).toEqual({ ran: true, week: "2026-11-09", outcome: "current" });
    expect(sendOwnerTelegramButtons).not.toHaveBeenCalled();
    expect(sendOwnerTelegramText).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("falls back to the desktop notice when no Telegram is connected", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    ownerChatIds.mockResolvedValue([]);
    const result = await notice.runWeeklyUpdateCheck(monday(10, 30));
    expect(result).toMatchObject({ outcome: "notified", via: "desktop" });
    expect(sendOwnerTelegramButtons).not.toHaveBeenCalled();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner).toHaveBeenCalledWith(
      "ClawBox 4.3.1 is available — this box runs 4.3.0.",
      { open: "settings", section: "update" },
    );
    expect(readState()).toMatchObject({ lastNotifiedVia: "desktop", lastNotifiedTarget: "v4.3.1" });
  });

  it("falls back to the desktop when a bot is configured but reaches nobody", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    sendOwnerTelegramButtons.mockResolvedValue(false);
    sendOwnerTelegramText.mockResolvedValue(false);
    const result = await notice.runWeeklyUpdateCheck(monday(10, 30));
    expect(result.via).toBe("desktop");
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("sends the words in plain text when the button cannot be sent (a token ClawBox cannot read)", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    sendOwnerTelegramButtons.mockResolvedValue(false);
    const result = await notice.runWeeklyUpdateCheck(monday(10, 30));
    expect(result.via).toBe("telegram");
    expect(sendOwnerTelegramText.mock.calls[0][1]).toContain("To install it, open Settings → System Update");
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("does nothing at all before Monday's slot", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    expect(await notice.runWeeklyUpdateCheck(monday(9, 59))).toEqual({ ran: false });
    expect(versionInfo).not.toHaveBeenCalled();
  });

  it("catches up once after downtime: off on Monday, on again on Thursday", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    const thursday = new Date(2026, 10, 12, 8, 15);
    expect((await notice.runWeeklyUpdateCheck(thursday)).outcome).toBe("notified");
    expect(await notice.runWeeklyUpdateCheck(new Date(thursday.getTime() + 60_000))).toEqual({ ran: false });
    expect(versionInfo).toHaveBeenCalledTimes(1);
  });

  it("survives a restart: the state on disk is what decides, not the process", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    await notice.runWeeklyUpdateCheck(monday(10, 5));
    vi.resetModules();
    const again = await import("@/lib/update-notice");
    expect(await again.runWeeklyUpdateCheck(monday(15))).toEqual({ ran: false });
  });

  it("keeps the week open and retries an hour later when the check could not look", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    versionInfo.mockResolvedValue(UNREACHABLE);
    const first = await notice.runWeeklyUpdateCheck(monday(10, 5));
    expect(first).toEqual({ ran: true, week: "2026-11-09", outcome: "unknown" });
    expect(sendOwnerTelegramButtons).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(readState().lastCheckedWeek).toBe("2026-11-02");
    expect(await notice.runWeeklyUpdateCheck(monday(10, 30))).toEqual({ ran: false });
    versionInfo.mockResolvedValue(AVAILABLE);
    expect((await notice.runWeeklyUpdateCheck(monday(11, 6))).outcome).toBe("notified");
  });

  it("honours the owner's switch when the slot fires: off means no check and no notice", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    await notice.setWeeklyUpdateCheckEnabled(false);
    const result = await notice.runWeeklyUpdateCheck(monday(10, 30));
    expect(result).toEqual({ ran: true, week: "2026-11-09", outcome: "disabled" });
    expect(versionInfo).not.toHaveBeenCalled();
    expect(sendOwnerTelegramButtons).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("sends NOTHING when the state cannot be written — and says the run failed, so the timer backs off", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    // A data/ that cannot take the record: the temporary file's name is a directory.
    fs.mkdirSync(path.join(root, "data", `update-notice.json.${process.pid}.tmp`));
    const result = await notice.runWeeklyUpdateCheck(monday(10, 30));
    expect(result).toEqual({ ran: false, failed: true });
    expect(sendOwnerTelegramButtons).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("is ON by default, and the switch round-trips", async () => {
    expect(await notice.isWeeklyUpdateCheckEnabled()).toBe(true);
    await notice.setWeeklyUpdateCheckEnabled(false);
    expect(await notice.isWeeklyUpdateCheckEnabled()).toBe(false);
    expect(await config.get("update_weekly_check")).toBe(false);
    await notice.setWeeklyUpdateCheckEnabled(true);
    expect(await notice.isWeeklyUpdateCheckEnabled()).toBe(true);
  });

  it("does not announce anything while an update is already running", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    getUpdateState.mockReturnValue({ phase: "running", steps: [] });
    expect((await notice.runWeeklyUpdateCheck(monday(10, 30))).outcome).toBe("updating");
    expect(versionInfo).not.toHaveBeenCalled();
  });

  it("speaks the box's language", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    await config.set("pref:ui_language", "de");
    await notice.runWeeklyUpdateCheck(monday(10, 30));
    const [, text, buttons] = sendOwnerTelegramButtons.mock.calls[0];
    expect(text).toContain("ClawBox 4.3.1 ist verfügbar");
    expect(buttons).toEqual([{ text: "Aktualisieren", callback_data: "clawbox-update" }]);
  });

  it("names a branch build by its commit, with the version its package.json carries", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    versionInfo.mockResolvedValue({ ...AVAILABLE, clawbox: { ...AVAILABLE.clawbox, target: "beta@1a2b3c4" } });
    readUpdateWhatsNew.mockResolvedValue({ ...NOTES, version: "4.3.0", channel: "beta" });
    await notice.runWeeklyUpdateCheck(monday(10, 30));
    expect(sendOwnerTelegramButtons.mock.calls[0][1]).toContain("ClawBox 4.3.0 (beta@1a2b3c4) is available — this box runs 4.3.0.");
  });

  it("leaves out Highlights that belong to another version than the tag it announces", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    readUpdateWhatsNew.mockResolvedValue({ ...NOTES, version: "4.2.0" });
    await notice.runWeeklyUpdateCheck(monday(10, 30));
    expect(sendOwnerTelegramButtons.mock.calls[0][1]).not.toContain("What's new:");
  });

  it("creates its state with a jitter on first read and keeps that jitter", async () => {
    const first = await notice.readUpdateNoticeState();
    const second = await notice.readUpdateNoticeState();
    expect(first.jitterS).toBeGreaterThanOrEqual(0);
    expect(first.jitterS).toBeLessThan(3600);
    expect(second.jitterS).toBe(first.jitterS);
  });

  it("replaces a state file it cannot parse rather than giving up on checking", async () => {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "update-notice.json"), "{not json");
    const state = await notice.readUpdateNoticeState();
    expect(state.lastCheckedWeek).toBeNull();
    expect(typeof readState().jitterS).toBe("number");
  });
});

describe("Hermes", () => {
  it("asks the Hermes allowlist and speaks on the Hermes bot", async () => {
    const harness = await import("@/lib/harness");
    vi.mocked(harness.getActiveHarness).mockResolvedValue("hermes");
    await writeState({ lastCheckedWeek: "2026-11-02" });
    await notice.runWeeklyUpdateCheck(monday(10, 30));
    expect(ownerChatIds).toHaveBeenCalledWith("hermes");
    expect(sendOwnerTelegramButtons.mock.calls[0][3]).toEqual({ harness: "hermes" });
  });
});

describe("the chat: /update and the Update button", () => {
  it("knows exactly its two shapes", () => {
    const p = notice.parseUpdateChatCommand;
    expect(p("/update")).toBe("check");
    expect(p("  /update  ")).toBe("check");
    expect(p("/Update")).toBe("check");
    expect(p("/update@ClawBoxBot")).toBe("check");
    expect(p("\ufeff/update")).toBe("check");
    expect(p("clawbox-update")).toBe("update");
    expect(p("callback_data: clawbox-update")).toBe("update");
    for (const other of ["/update now", "update", "/updates", "please /update", "callback_data: clawbox-update2", "", null, 7]) {
      expect(p(other)).toBeNull();
    }
  });

  it("refuses a stranger: claimed, answered in his private chat, nothing checked or asked", async () => {
    const claim = await notice.claimUpdateChatCommand({ senderId: "999", text: "/update", harness: "openclaw" });
    expect(claim).toMatchObject({ handled: true, outcome: "not_owner" });
    await claim.run?.();
    expect(sendOwnerTelegramText).toHaveBeenCalledWith("999", "Only this ClawBox's owner can do that.", { harness: "openclaw" });
    expect(versionInfo).not.toHaveBeenCalled();
    expect(requestPowerApproval).not.toHaveBeenCalled();
  });

  it("on Hermes, hands a stranger back to Hermes' own auth instead of claiming him", async () => {
    // Hermes runs the hook BEFORE its own auth, which refuses an unknown sender
    // before any command; a claim there left Hermes typing in his chat forever.
    const claim = await notice.claimUpdateChatCommand({ senderId: "999", text: "/update", harness: "hermes" });
    expect(claim).toEqual({ handled: false, outcome: "not_owner" });
    expect(versionInfo).not.toHaveBeenCalled();
    expect(requestPowerApproval).not.toHaveBeenCalled();
  });

  it("refuses a stranger's tap on the button too — no approval is ever asked for him", async () => {
    const claim = await notice.claimUpdateChatCommand({ senderId: "999", text: "callback_data: clawbox-update", harness: "openclaw" });
    expect(claim.outcome).toBe("not_owner");
    await claim.run?.();
    expect(requestPowerApproval).not.toHaveBeenCalled();
  });

  it("says nothing into a group a stranger typed in", async () => {
    const claim = await notice.claimUpdateChatCommand({ senderId: "999", chatId: "-100", isGroup: true, text: "/update", harness: "openclaw" });
    expect(claim).toMatchObject({ handled: true, outcome: "not_owner" });
    expect(claim.run).toBeUndefined();
  });

  it("takes the owner to his private chat when he types /update in a group", async () => {
    const claim = await notice.claimUpdateChatCommand({ senderId: "6001", chatId: "-100", isGroup: true, text: "/update", harness: "openclaw" });
    expect(claim.outcome).toBe("group");
    await claim.run?.();
    expect(sendOwnerTelegramText).toHaveBeenCalledWith("6001", expect.stringContaining("private chat"), { harness: "openclaw" });
    expect(versionInfo).not.toHaveBeenCalled();
  });

  it("checks the owner's allowlist on the harness the message came from", async () => {
    await notice.claimUpdateChatCommand({ senderId: "6001", text: "/update", harness: "hermes" });
    expect(ownerChatIds).toHaveBeenCalledWith("hermes");
  });

  it("/update with something newer: the notice and its button, in the owner's chat, and remembered", async () => {
    const claim = await notice.claimUpdateChatCommand({ senderId: "6001", chatId: "6001", text: "/update", harness: "openclaw" });
    expect(claim).toMatchObject({ handled: true, outcome: "check" });
    await claim.run?.();
    expect(invalidateVersionCache).toHaveBeenCalledTimes(1);
    expect(sendOwnerTelegramButtons).toHaveBeenCalledWith(
      "6001",
      expect.stringContaining("ClawBox 4.3.1 is available"),
      [{ text: "Update", callback_data: "clawbox-update" }],
      { harness: "openclaw" },
    );
    expect(readState()).toMatchObject({ lastNotifiedTarget: "v4.3.1", lastNotifiedVia: "telegram" });
  });

  it("/update and a weekly run waking together announce a version once", async () => {
    await writeState({ lastCheckedWeek: "2026-11-02" });
    let release!: () => void;
    sendOwnerTelegramButtons.mockImplementationOnce(() => new Promise((r) => { release = () => r(true); }));
    const command = (await notice.claimUpdateChatCommand({ senderId: "6001", text: "/update", harness: "openclaw" })).run!();
    await vi.waitFor(() => expect(sendOwnerTelegramButtons).toHaveBeenCalledTimes(1));
    const weekly = notice.runWeeklyUpdateCheck(monday(10, 30));
    release();
    await command;
    expect((await weekly).outcome).toBe("already-notified");
    expect(sendOwnerTelegramButtons).toHaveBeenCalledTimes(1);
  });

  it("/update typed twice in a minute does not ask GitHub twice", async () => {
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "/update", harness: "openclaw" })).run?.();
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "/update", harness: "openclaw" })).run?.();
    expect(invalidateVersionCache).toHaveBeenCalledTimes(1);
    expect(versionInfo).toHaveBeenCalledTimes(2);
  });

  it("/update with nothing newer says so", async () => {
    versionInfo.mockResolvedValue(CURRENT);
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "/update", harness: "openclaw" })).run?.();
    expect(sendOwnerTelegramText).toHaveBeenCalledWith("6001", "ClawBox is up to date (4.3.0).", { harness: "openclaw" });
    expect(sendOwnerTelegramButtons).not.toHaveBeenCalled();
  });

  it("/update that could not look says that, not 'up to date'", async () => {
    versionInfo.mockResolvedValue(UNREACHABLE);
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "/update", harness: "openclaw" })).run?.();
    expect(sendOwnerTelegramText.mock.calls[0][1]).toContain("could not reach the update server");
  });

  it("the owner's tap ASKS — the existing approval question — and never starts the update", async () => {
    requestPowerApproval.mockResolvedValue({ id: "a".repeat(32), action: "update", messages: [] });
    const claim = await notice.claimUpdateChatCommand({ senderId: "6001", text: "callback_data: clawbox-update", harness: "openclaw" });
    expect(claim.outcome).toBe("update");
    await claim.run?.();
    expect(requestPowerApproval).toHaveBeenCalledWith("update", "Update button in Telegram");
    expect(invalidateVersionCache).not.toHaveBeenCalled();
    expect(sendOwnerTelegramText).toHaveBeenCalledWith(
      "6001",
      "Update requested. Confirm it on the ClawBox desktop within 2 minutes.",
      { harness: "openclaw" },
    );
  });

  it("points at the approvals bot when its Confirm buttons went out too", async () => {
    requestPowerApproval.mockResolvedValue({ id: "a".repeat(32), action: "update", messages: [{ chatId: "6001", messageId: 5 }] });
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "clawbox-update", harness: "hermes" })).run?.();
    expect(sendOwnerTelegramText.mock.calls[0][1]).toContain("approvals bot");
  });

  it("on Hermes, a reply `hermes send` could not deliver goes out on the Bot API with Hermes' own token", async () => {
    requestPowerApproval.mockResolvedValue({ id: "a".repeat(32), action: "update", messages: [] });
    sendOwnerTelegramText.mockResolvedValue(false);
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "clawbox-update", harness: "hermes" })).run?.();
    expect(sendOwnerTelegramButtons).toHaveBeenCalledWith(
      "6001",
      "Update requested. Confirm it on the ClawBox desktop within 2 minutes.",
      [],
      { harness: "hermes" },
    );
  });

  it("on OpenClaw, where the plain path already IS the Bot API, a failed reply is not sent twice", async () => {
    requestPowerApproval.mockResolvedValue({ id: "a".repeat(32), action: "update", messages: [] });
    sendOwnerTelegramText.mockResolvedValue(false);
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "clawbox-update", harness: "openclaw" })).run?.();
    expect(sendOwnerTelegramButtons).not.toHaveBeenCalled();
  });

  it("a stale button on an up-to-date box asks nothing", async () => {
    versionInfo.mockResolvedValue(CURRENT);
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "clawbox-update", harness: "openclaw" })).run?.();
    expect(requestPowerApproval).not.toHaveBeenCalled();
    expect(sendOwnerTelegramText.mock.calls[0][1]).toContain("Nothing to install");
  });

  it("does not ask while agents are working — the gate /update/run keeps", async () => {
    activeAgentWork.mockResolvedValue({ coding: 1, agents: 1, total: 2 });
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "clawbox-update", harness: "openclaw" })).run?.();
    expect(requestPowerApproval).not.toHaveBeenCalled();
    expect(sendOwnerTelegramText.mock.calls[0][1]).toContain("Agents are working right now (2 active)");
  });

  it("asks anyway when it cannot tell whether agents are working", async () => {
    activeAgentWork.mockRejectedValue(new Error("gateway down"));
    requestPowerApproval.mockResolvedValue({ id: "a".repeat(32), action: "update", messages: [] });
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "clawbox-update", harness: "openclaw" })).run?.();
    expect(requestPowerApproval).toHaveBeenCalledTimes(1);
  });

  it("says so when another question is already waiting", async () => {
    const { PowerApprovalConflict } = await import("@/lib/power-approval");
    requestPowerApproval.mockRejectedValue(new PowerApprovalConflict("busy"));
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "clawbox-update", harness: "openclaw" })).run?.();
    expect(sendOwnerTelegramText.mock.calls[0][1]).toContain("already waiting");
  });

  it("does not ask while an update is running", async () => {
    getUpdateState.mockReturnValue({ phase: "running", steps: [] });
    await (await notice.claimUpdateChatCommand({ senderId: "6001", text: "clawbox-update", harness: "openclaw" })).run?.();
    expect(requestPowerApproval).not.toHaveBeenCalled();
    expect(sendOwnerTelegramText.mock.calls[0][1]).toContain("already running");
  });

  it("leaves ordinary conversation alone", async () => {
    expect(await notice.claimUpdateChatCommand({ senderId: "6001", text: "what's new in the update?", harness: "openclaw" }))
      .toEqual({ handled: false, outcome: "not_command" });
    expect(ownerChatIds).not.toHaveBeenCalled();
  });
});
