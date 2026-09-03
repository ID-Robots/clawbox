// A tap in Telegram has to move the SAME store every other surface reads.
//
// THE BUG THIS PINS. The Telegram approvals bot claimed the draft and sent it,
// and that was all it did. Nothing recorded that the message had gone, so the
// chat card in the owner's browser — which had the draft frozen in its own
// state — went on offering a live "Approve & send" button for mail that was
// already in somebody's inbox, and the twin of a duplicated draft went on
// waiting to be sent a second time.
//
// The bot is a THIRD approval surface, not a special one: approving there must
// write the same receipt and resolve the same duplicates as the desktop panel
// and the chat card.
//
// Real filesystem in a temp CLAWBOX_ROOT, like email-approval.test.ts: what is
// under test is the state on disk afterwards. Only Telegram and SMTP are
// stubbed.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email-approval-telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-approval-telegram")>()),
  fetchApprovalBotInfo: vi.fn(),
  sendApprovalMessage: vi.fn(),
  clearApprovalKeyboard: vi.fn(),
  replyInChat: vi.fn(),
  answerCallback: vi.fn(),
  fetchApprovalUpdates: vi.fn(),
}));
vi.mock("@/lib/smtp-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/smtp-client")>()),
  sendMail: vi.fn(),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/openclaw-config", () => ({ readTelegramAllowFrom: vi.fn(async () => ["6001"]) }));
vi.mock("@/lib/hermes-telegram", () => ({ readHermesApprovedUsers: vi.fn(async () => []) }));
vi.mock("@/lib/email-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-config")>()),
  getEmailCredentials: vi.fn(),
}));

const OWNER = "6001";
const TOKEN = "123456:AAbbCCddEEffGG-hh_ii";

let root: string;
let approval: typeof import("@/lib/email-approval");
let pending: typeof import("@/lib/email-pending");
let outcomes: typeof import("@/lib/email-outcomes");
let telegram: typeof import("@/lib/email-approval-telegram");
let smtp: typeof import("@/lib/smtp-client");
let emailConfig: typeof import("@/lib/email-config");
let config: typeof import("@/lib/config-store");

const CREDENTIALS = {
  address: "box@example.com",
  password: "hunter2",
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecure: false,
  fromName: "ClawBox",
  mode: "send" as const,
  askBeforeSend: true,
  allowedSenders: [] as string[],
};

const MESSAGE = { to: ["someone@example.com"], subject: "test test", body: "test test from hermes" };

function postedHandle(callIndex = 0): string {
  const buttons = vi.mocked(telegram.sendApprovalMessage).mock.calls[callIndex]?.[3];
  return (buttons?.[0]?.callback_data ?? "").slice("ea:".length);
}

function rejectHandle(callIndex = 0): string {
  const buttons = vi.mocked(telegram.sendApprovalMessage).mock.calls[callIndex]?.[3];
  return (buttons?.[1]?.callback_data ?? "").slice("er:".length);
}

function tap(data: string, from = OWNER) {
  return {
    id: `cb-${data}-${from}`,
    from: { id: Number(from) },
    data,
    message: { message_id: 11, chat: { id: Number(from) } },
  };
}

/** One message, two rows — the state the owner's box reached. */
function seedTwins(): { first: import("@/lib/email-pending").PendingEmail; twinId: string } {
  const queued = pending.queuePending(MESSAGE);
  if (!queued.ok) throw new Error("fixture failed to queue");
  const twin = { ...queued.draft, id: "twin-id", createdAt: queued.draft.createdAt + 1 };
  fs.writeFileSync(
    path.join(root, "data", "email-pending.json"),
    JSON.stringify([queued.draft, twin], null, 2),
  );
  return { first: queued.draft, twinId: twin.id };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-approval-outcomes-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  config = await import("@/lib/config-store");
  pending = await import("@/lib/email-pending");
  outcomes = await import("@/lib/email-outcomes");
  telegram = await import("@/lib/email-approval-telegram");
  smtp = await import("@/lib/smtp-client");
  emailConfig = await import("@/lib/email-config");
  approval = await import("@/lib/email-approval");

  vi.mocked(emailConfig.getEmailCredentials).mockResolvedValue(CREDENTIALS);
  vi.mocked(smtp.sendMail).mockResolvedValue({ messageId: "<sent@example.com>" });
  let nextMessageId = 100;
  vi.mocked(telegram.sendApprovalMessage).mockImplementation(async () => (nextMessageId += 1));
  // The Bot API calls a tap makes on its way out. `say` awaits `.catch(...)` on
  // each, so a bare vi.fn() returning undefined would throw inside the handler.
  vi.mocked(telegram.answerCallback).mockResolvedValue(undefined);
  vi.mocked(telegram.clearApprovalKeyboard).mockResolvedValue(undefined);
  vi.mocked(telegram.replyInChat).mockResolvedValue(undefined);
  vi.mocked(telegram.fetchApprovalUpdates).mockResolvedValue([]);
  await config.set("email_approval_bot_token", TOKEN);
  await config.set("email_chat_approval", true);
});

afterEach(() => {
  approval.stopApprovalPoller();
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a tap that sends", () => {
  it("writes the receipt every other surface reads", async () => {
    const queued = pending.queuePending(MESSAGE);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    await approval.sendApprovalPrompt(queued.draft);

    expect(await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`))).toBe("sent");
    expect(outcomes.getOutcome(queued.draft.id)).toMatchObject({ kind: "sent" });
  });

  it("resolves the exact duplicate instead of leaving it to be sent again", async () => {
    const { first, twinId } = seedTwins();
    await approval.sendApprovalPrompt(first);

    expect(await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`))).toBe("sent");

    expect(vi.mocked(smtp.sendMail)).toHaveBeenCalledTimes(1);
    expect(pending.listPending()).toEqual([]);
    expect(outcomes.getOutcome(twinId)).toMatchObject({ kind: "duplicate", sentAs: first.id });
  });

  it("records a send the mail server refused as failed, and leaves the twin waiting", async () => {
    const { first, twinId } = seedTwins();
    await approval.sendApprovalPrompt(first);
    vi.mocked(smtp.sendMail).mockRejectedValue(new smtp.SmtpError("auth", "The mail server refused it."));

    expect(await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`))).toBe("send_failed");

    expect(outcomes.getOutcome(first.id)).toMatchObject({ kind: "failed" });
    expect(pending.listPending().map((d) => d.id)).toEqual([twinId]);
    expect(outcomes.getOutcome(twinId)).toBeNull();
  });

  it("does not claim a dropped connection was not sent", async () => {
    // The tap path makes the same trade every approve path does — claim, then
    // send, never requeue — precisely because after that point "it failed" and
    // "it was accepted and the connection dropped" are the same thing from
    // here. The receipt must not resolve that ambiguity in the direction that
    // has the owner sending the message again.
    const queued = pending.queuePending(MESSAGE);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    await approval.sendApprovalPrompt(queued.draft);
    vi.mocked(smtp.sendMail).mockRejectedValue(new Error("socket hang up"));

    expect(await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`))).toBe("send_failed");
    expect(outcomes.getOutcome(queued.draft.id)).toMatchObject({ kind: "unconfirmed" });
  });

  it("does not TELL him it was not sent, either — the receipt is not the only surface", async () => {
    // The receipt above has said `unconfirmed` since this feature shipped. The
    // words in the owner's own chat still said "Not sent:", two lines under a
    // comment explaining why they must not — and Telegram is where the tap
    // happened, so it is the surface he reads. The pop-up answering the tap and
    // the reply left under the question both have to match the receipt.
    const queued = pending.queuePending(MESSAGE);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    await approval.sendApprovalPrompt(queued.draft);
    vi.mocked(smtp.sendMail).mockRejectedValue(new Error("socket hang up"));

    await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`));

    const popup = vi.mocked(telegram.answerCallback).mock.calls.at(-1)?.[2] ?? "";
    const reply = vi.mocked(telegram.replyInChat).mock.calls.at(-1)?.[2] ?? "";
    for (const said of [popup, reply]) {
      expect(said).not.toMatch(/not sent/i);
      expect(said).toMatch(/sent folder/i);
    }
  });

  it("still says 'not sent' when the mail server refused it out loud", async () => {
    // The other half of the same judgement: a refusal the server SPOKE is a
    // definite failure and must keep reading like one.
    const queued = pending.queuePending(MESSAGE);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    await approval.sendApprovalPrompt(queued.draft);
    vi.mocked(smtp.sendMail).mockRejectedValue(new smtp.SmtpError("auth", "The mail server refused it."));

    await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`));

    expect(vi.mocked(telegram.answerCallback).mock.calls.at(-1)?.[2] ?? "").toMatch(/not sent/i);
    expect(vi.mocked(telegram.replyInChat).mock.calls.at(-1)?.[2] ?? "").toMatch(/not sent/i);
  });

  it("leaves a twin queued long after the first alone", async () => {
    // The sweep is bounded by the same window queueing is: two identical
    // messages queued an hour apart are two messages, and one of them going
    // out is not a reason to delete the other.
    const queued = pending.queuePending(MESSAGE);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const old = { ...queued.draft, id: "an-hour-ago", createdAt: queued.draft.createdAt - 60 * 60 * 1000 };
    fs.writeFileSync(
      path.join(root, "data", "email-pending.json"),
      JSON.stringify([old, queued.draft], null, 2),
    );
    await approval.sendApprovalPrompt(queued.draft);

    expect(await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`))).toBe("sent");
    expect(pending.listPending().map((d) => d.id)).toEqual(["an-hour-ago"]);
    expect(outcomes.getOutcome("an-hour-ago")).toBeNull();
  });
});

describe("a tap that deletes", () => {
  it("records the deletion so no surface goes on offering it", async () => {
    const queued = pending.queuePending(MESSAGE);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    await approval.sendApprovalPrompt(queued.draft);

    expect(await approval.applyApprovalCallback(tap(`er:${rejectHandle()}`))).toBe("rejected");
    expect(outcomes.getOutcome(queued.draft.id)).toMatchObject({ kind: "rejected" });
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
  });
});
