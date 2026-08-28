// Approving a queued email from chat.
//
// These are the tests the feature exists to pass. Every one of them is about a
// way an agent — or anyone who is not the owner — might get a message sent
// without the owner having agreed to that exact message.
//
// Run against the real filesystem in a temp CLAWBOX_ROOT, like
// email-pending.test.ts and for the same reason: the double-tap guarantee is a
// property of read-and-remove on a real file, and a mocked fs would assert it
// against the mock. Only the two things that leave the box — Telegram and SMTP
// — are stubbed.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email-approval-telegram", async (importOriginal) => ({
  // safeBotToken and CHAT_ID_RE are pure and are part of what is under test —
  // a mocked token check would let a malformed token through in a test that
  // exists to prove it cannot.
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
const STRANGER = "999";
const TOKEN = "123456:AAbbCCddEEffGG-hh_ii";

let root: string;
let approval: typeof import("@/lib/email-approval");
let pending: typeof import("@/lib/email-pending");
let prompts: typeof import("@/lib/email-approval-prompts");
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

/** Turn the feature on the way the owner would: a bot, and the switch. */
async function enableChatApproval(): Promise<void> {
  await config.set("email_approval_bot_token", TOKEN);
  await config.set("email_chat_approval", true);
}

function queueDraft(subject = "Hello") {
  const result = pending.queuePending({ to: ["someone@example.com"], subject, body: "The body." });
  if (!result.ok) throw new Error(result.error);
  return result.draft;
}

/** The handle Telegram would echo back, taken from the button we actually posted. */
function postedHandle(callIndex = 0): string {
  const buttons = vi.mocked(telegram.sendApprovalMessage).mock.calls[callIndex]?.[3];
  const approve = buttons?.[0]?.callback_data ?? "";
  return approve.slice("ea:".length);
}

function tap(data: string, from = OWNER) {
  return {
    id: `cb-${data}-${from}`,
    from: { id: Number(from) },
    data,
    message: { message_id: 11, chat: { id: Number(from) } },
  };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-approval-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  config = await import("@/lib/config-store");
  pending = await import("@/lib/email-pending");
  prompts = await import("@/lib/email-approval-prompts");
  telegram = await import("@/lib/email-approval-telegram");
  smtp = await import("@/lib/smtp-client");
  emailConfig = await import("@/lib/email-config");
  approval = await import("@/lib/email-approval");

  vi.mocked(emailConfig.getEmailCredentials).mockResolvedValue(CREDENTIALS);
  vi.mocked(smtp.sendMail).mockResolvedValue({ messageId: "<sent@example.com>" });
  let nextMessageId = 100;
  vi.mocked(telegram.sendApprovalMessage).mockImplementation(async () => (nextMessageId += 1));
  vi.mocked(telegram.clearApprovalKeyboard).mockResolvedValue(undefined);
  vi.mocked(telegram.replyInChat).mockResolvedValue(undefined);
  vi.mocked(telegram.answerCallback).mockResolvedValue(undefined);
  vi.mocked(telegram.fetchApprovalUpdates).mockResolvedValue([]);
});

afterEach(() => {
  approval.stopApprovalPoller();
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("off by default", () => {
  it("is off on a device nobody has configured", async () => {
    expect(await approval.chatApprovalEnabled()).toBe(false);
  });

  it("asks nobody, and posts nothing, when it is off", async () => {
    const draft = queueDraft();
    expect(await approval.sendApprovalPrompt(draft)).toEqual({ kind: "off" });
    expect(telegram.sendApprovalMessage).not.toHaveBeenCalled();
    // The draft is still queued for the desktop, exactly as it is today.
    expect(pending.countPending()).toBe(1);
  });

  it("stays off when a token is present but the switch was never flipped", async () => {
    await config.set("email_approval_bot_token", TOKEN);
    expect(await approval.chatApprovalEnabled()).toBe(false);
  });

  it("stays off when the switch is on but there is no bot behind it", async () => {
    await config.set("email_chat_approval", true);
    expect(await approval.chatApprovalEnabled()).toBe(false);
  });
});

describe("the question", () => {
  it("carries every recipient, the subject and the WHOLE body", async () => {
    await enableChatApproval();
    const result = pending.queuePending({
      to: ["a@example.com", "b@example.com"],
      subject: "Quarterly numbers",
      body: "Line one.\nLine two.\nLine three.",
    });
    if (!result.ok) throw new Error("queue failed");

    expect(await approval.sendApprovalPrompt(result.draft)).toEqual({ kind: "sent", chats: 1 });
    const text = vi.mocked(telegram.sendApprovalMessage).mock.calls[0][2];
    expect(text).toContain("a@example.com");
    expect(text).toContain("b@example.com");
    expect(text).toContain("Quarterly numbers");
    expect(text).toContain("Line one.\nLine two.\nLine three.");
  });

  it("refuses to offer a one-tap send for a draft it can only show part of", async () => {
    await enableChatApproval();
    const draft = queueDraft();
    // Longer than one Telegram message can hold.
    const huge = { ...draft, body: "x".repeat(4_000) };

    expect(await approval.sendApprovalPrompt(huge)).toEqual({ kind: "too_long" });
    expect(telegram.sendApprovalMessage).not.toHaveBeenCalled();
    expect(prompts.countPrompts()).toBe(0);
  });

  it("says so rather than pretending, when nobody is paired to ask", async () => {
    const openclaw = await import("@/lib/openclaw-config");
    vi.mocked(openclaw.readTelegramAllowFrom).mockResolvedValue([]);
    await enableChatApproval();

    expect(await approval.sendApprovalPrompt(queueDraft())).toEqual({ kind: "no_owner_chat" });
    expect(telegram.sendApprovalMessage).not.toHaveBeenCalled();
  });

  it("leaves nothing outstanding when Telegram refused every chat", async () => {
    await enableChatApproval();
    vi.mocked(telegram.sendApprovalMessage).mockRejectedValue(
      new telegram.TelegramApiError("bot was blocked by the user", 403),
    );

    const outcome = await approval.sendApprovalPrompt(queueDraft());
    expect(outcome).toMatchObject({ kind: "failed" });
    // Nothing to answer, so nothing to keep the poller awake.
    expect(prompts.countPrompts()).toBe(0);
  });
});

describe("who may press the button", () => {
  it("refuses a tap from a Telegram account that is not on the owner allowlist", async () => {
    await enableChatApproval();
    const draft = queueDraft();
    await approval.sendApprovalPrompt(draft);

    const outcome = await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`, STRANGER));

    expect(outcome).toBe("not_owner");
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(pending.countPending()).toBe(1);
  });

  it("does not let a stranger burn the owner's question by pressing it first", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());
    const handle = postedHandle();

    await approval.applyApprovalCallback(tap(`ea:${handle}`, STRANGER));
    // The question is still live for the person it was meant for.
    expect(prompts.countPrompts()).toBe(1);
    expect(await approval.applyApprovalCallback(tap(`ea:${handle}`, OWNER))).toBe("sent");
  });
});

describe("forged and replayed taps", () => {
  it("rejects a button that is not one of ours", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());

    expect(await approval.applyApprovalCallback(tap("something-else"))).toBe("unknown_button");
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(prompts.countPrompts()).toBe(1);
  });

  it("rejects a payload longer than a real button could carry", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());

    expect(await approval.applyApprovalCallback(tap(`ea:${"f".repeat(4_000)}`))).toBe("unknown_button");
    expect(prompts.countPrompts()).toBe(1);
  });

  it("asks once, however many times one draft is offered", async () => {
    await enableChatApproval();
    const draft = queueDraft();

    await approval.sendApprovalPrompt(draft);
    await approval.sendApprovalPrompt(draft);

    // Two live buttons for one email is the state this avoids.
    expect(telegram.sendApprovalMessage).toHaveBeenCalledTimes(1);
    expect(prompts.countPrompts()).toBe(1);
  });

  it("rejects a handle that was never issued", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());

    expect(await approval.applyApprovalCallback(tap("ea:deadbeefdeadbeef"))).toBe("expired");
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(pending.countPending()).toBe(1);
  });

  it("rejects a handle that has aged out", async () => {
    await enableChatApproval();
    const draft = queueDraft();
    const stale = prompts.createPrompt({
      draftId: draft.id,
      fingerprint: pending.draftFingerprint(draft),
      now: Date.now() - prompts.PROMPT_TTL_MS - 1,
    });
    if (!stale) throw new Error("no prompt");

    expect(await approval.applyApprovalCallback(tap(`ea:${stale.prompt.handle}`))).toBe("expired");
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });

  it("sends once when the same tap arrives twice", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());
    const handle = postedHandle();

    const first = await approval.applyApprovalCallback(tap(`ea:${handle}`));
    const second = await approval.applyApprovalCallback(tap(`ea:${handle}`));

    expect(first).toBe("sent");
    expect(second).toBe("expired");
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
  });

  it("sends once when two taps race each other", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());
    const handle = postedHandle();

    const outcomes = await Promise.all([
      approval.applyApprovalCallback(tap(`ea:${handle}`)),
      approval.applyApprovalCallback(tap(`ea:${handle}`)),
    ]);

    expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(pending.countPending()).toBe(0);
  });
});

describe("what one approval is allowed to send", () => {
  it("does not let a draft queued after the question ride along on it", async () => {
    await enableChatApproval();
    const asked = queueDraft("The one the owner read");
    await approval.sendApprovalPrompt(asked);
    // The agent keeps running while the owner reads.
    const smuggled = queueDraft("Queued during the pause");

    expect(await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`))).toBe("sent");

    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(smtp.sendMail).mock.calls[0][1].subject).toBe("The one the owner read");
    const left = pending.listPending();
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(smuggled.id);
  });

  it("refuses a draft whose content changed after the question was posted", async () => {
    await enableChatApproval();
    const draft = queueDraft();
    await approval.sendApprovalPrompt(draft);
    const handle = postedHandle();

    // Rewrite the queue under it, as an edit path one day might.
    const file = path.join(root, "data", "email-pending.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
    stored[0].body = "Something the owner never read.";
    fs.writeFileSync(file, JSON.stringify(stored));

    expect(await approval.applyApprovalCallback(tap(`ea:${handle}`))).toBe("changed");
    expect(smtp.sendMail).not.toHaveBeenCalled();
    // Not consented to, so not deleted either.
    expect(pending.countPending()).toBe(1);
  });

  it("takes the draft out of the queue before the SMTP client is handed it", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());
    let queuedAtSendTime = -1;
    vi.mocked(smtp.sendMail).mockImplementation(async () => {
      queuedAtSendTime = pending.countPending();
      return { messageId: "<sent@example.com>" };
    });

    await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`));

    expect(queuedAtSendTime).toBe(0);
  });
});

describe("after the tap", () => {
  it("leaves the approvals list empty once the message has gone", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());

    await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`));

    expect(pending.listPending()).toEqual([]);
    expect(prompts.countPrompts()).toBe(0);
  });

  it("deletes the draft, and sends nothing, when the owner says no", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());

    expect(await approval.applyApprovalCallback(tap(`er:${postedHandle()}`))).toBe("rejected");
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(pending.countPending()).toBe(0);
  });

  it("keeps the owner's copy of the draft readable when the send fails", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());
    vi.mocked(smtp.sendMail).mockRejectedValue(new smtp.SmtpError("recipient", "Mailbox unavailable"));

    expect(await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`))).toBe("send_failed");
    // The question itself is never rewritten: it is the only remaining copy of
    // the text once the queue has let go of it.
    expect(telegram.clearApprovalKeyboard).toHaveBeenCalled();
    const verdicts = vi.mocked(telegram.replyInChat).mock.calls.map((c) => c[2]);
    expect(verdicts.join(" ")).toContain("Mailbox unavailable");
  });

  it("takes the buttons away when the draft is decided at the desktop instead", async () => {
    await enableChatApproval();
    const draft = queueDraft();
    await approval.sendApprovalPrompt(draft);

    await approval.retireChatPrompt(draft.id);

    expect(prompts.countPrompts()).toBe(0);
    expect(telegram.clearApprovalKeyboard).toHaveBeenCalled();
  });
});

describe("the poller", () => {
  it("listens only while a question is outstanding", async () => {
    await enableChatApproval();
    // Nothing queued, nothing asked: there is nothing for anyone to answer, so
    // there is nothing to listen for.
    approval.startApprovalPoller();
    await vi.waitFor(() => expect(approval.approvalPollerRunning()).toBe(false));
    expect(telegram.fetchApprovalUpdates).not.toHaveBeenCalled();
  });

  it("hands a tap Telegram delivered to the same checks a direct call gets", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());
    const handle = postedHandle();
    // One update, then nothing: the loop drains it and finds no question left.
    vi.mocked(telegram.fetchApprovalUpdates)
      .mockResolvedValueOnce([{ update_id: 42, callback_query: tap(`ea:${handle}`) }])
      .mockResolvedValue([]);

    approval.startApprovalPoller();

    await vi.waitFor(() => expect(smtp.sendMail).toHaveBeenCalledTimes(1));
    expect(pending.countPending()).toBe(0);
  });

  it("does not replay a tap it has already handled", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());
    const handle = postedHandle();
    vi.mocked(telegram.fetchApprovalUpdates)
      .mockResolvedValueOnce([{ update_id: 42, callback_query: tap(`ea:${handle}`) }])
      .mockResolvedValue([]);

    approval.startApprovalPoller();
    await vi.waitFor(() => expect(smtp.sendMail).toHaveBeenCalledTimes(1));

    // The offset moved past it, so Telegram would never send it again — and if
    // it did, the handle and the draft are both gone.
    expect(prompts.readOffset()).toBe(43);
    expect(await approval.applyApprovalCallback(tap(`ea:${handle}`))).toBe("expired");
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe("the agent's own reach", () => {
  it("exports nothing that sends a draft on the agent's say-so", async () => {
    // A guard against the shape of change this feature must never take: an
    // "approve this id" helper with no tap behind it. Everything that ends in a
    // send here needs a callback_query object, which only Telegram produces.
    const exported = Object.keys(approval);
    expect(exported).not.toContain("approveDraft");
    expect(exported).not.toContain("approveById");
    expect(exported).not.toContain("simulateTap");
  });

  it("will not send for a device with no mail account, however the tap arrives", async () => {
    await enableChatApproval();
    await approval.sendApprovalPrompt(queueDraft());
    vi.mocked(emailConfig.getEmailCredentials).mockResolvedValue(null);

    expect(await approval.applyApprovalCallback(tap(`ea:${postedHandle()}`))).toBe("unconfigured");
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });
});
