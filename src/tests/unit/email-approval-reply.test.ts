// Approving a queued email by REPLYING in the owner's normal conversation.
//
// The tests are the feature's whole contract, and they are written the way
// email-approval.test.ts is — against a real filesystem in a temp CLAWBOX_ROOT,
// because the single-send guarantee is a property of read-and-remove on a real
// file. Only the two things that leave the box, Telegram and SMTP, are stubbed.
//
// Three properties are load-bearing and each has its own block below:
//
//   1. THE REPLY NAMES ONE DRAFT. Never "the latest": a bare "send" decides
//      nothing, and a code names the draft it was issued for and no other.
//   2. THE SENDER IS THE OWNER. The harness reports who sent the message; the
//      allowlist is the harness's own, and a stranger's reply is not claimed —
//      it goes on to the harness untouched so the pairing flow still runs.
//   3. "SENT" IS WRITTEN AFTER THE SEND. The receipt every surface reads is
//      recorded only once the SMTP conversation has finished, and a send that
//      failed says so on all three surfaces.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email-approval-telegram", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-approval-telegram")>()),
  sendApprovalMessage: vi.fn(),
  clearApprovalKeyboard: vi.fn(),
  replyInChat: vi.fn(),
  answerCallback: vi.fn(),
  fetchApprovalUpdates: vi.fn(),
}));
vi.mock("@/lib/telegram-owner-send", () => ({ sendOwnerTelegramText: vi.fn(async () => true) }));
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

let root: string;
let reply: typeof import("@/lib/email-approval-reply");
let approval: typeof import("@/lib/email-approval");
let pending: typeof import("@/lib/email-pending");
let prompts: typeof import("@/lib/email-approval-prompts");
let outcomes: typeof import("@/lib/email-outcomes");
let ownerSend: typeof import("@/lib/telegram-owner-send");
let smtp: typeof import("@/lib/smtp-client");
let emailConfig: typeof import("@/lib/email-config");

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

function queueDraft(subject = "Hello") {
  const result = pending.queuePending({ to: ["someone@example.com"], subject, body: "The body." });
  if (!result.ok) throw new Error(result.error);
  return result.draft;
}

/** Queue a draft and offer it, returning the code the owner was given. */
async function offered(subject = "Hello"): Promise<{ id: string; code: string }> {
  const draft = queueDraft(subject);
  const outcome = await reply.offerReplyApproval(draft);
  if (outcome.kind !== "offered") throw new Error(`not offered: ${outcome.kind}`);
  return { id: draft.id, code: outcome.code };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-approval-reply-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  pending = await import("@/lib/email-pending");
  prompts = await import("@/lib/email-approval-prompts");
  outcomes = await import("@/lib/email-outcomes");
  ownerSend = await import("@/lib/telegram-owner-send");
  smtp = await import("@/lib/smtp-client");
  emailConfig = await import("@/lib/email-config");
  approval = await import("@/lib/email-approval");
  reply = await import("@/lib/email-approval-reply");

  vi.mocked(emailConfig.getEmailCredentials).mockResolvedValue(CREDENTIALS);
  vi.mocked(smtp.sendMail).mockResolvedValue({ messageId: "<sent@example.com>" });
  vi.mocked(ownerSend.sendOwnerTelegramText).mockResolvedValue(true);
});

afterEach(() => {
  approval.stopApprovalPoller();
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Asking, in the conversation the owner is already in ──────────────────────

describe("the question", () => {
  it("posts the whole draft, and a code, to the owner's own chat", async () => {
    const draft = queueDraft("Invoice");
    const outcome = await reply.offerReplyApproval(draft);

    expect(outcome.kind).toBe("offered");
    expect(vi.mocked(ownerSend.sendOwnerTelegramText)).toHaveBeenCalledTimes(1);
    const [chatId, text] = vi.mocked(ownerSend.sendOwnerTelegramText).mock.calls[0];
    expect(chatId).toBe(OWNER);
    // The reading IS the safety mechanism: every recipient, the subject and the
    // whole body, exactly as the second-bot prompt carries them.
    expect(text).toContain("someone@example.com");
    expect(text).toContain("Invoice");
    expect(text).toContain("The body.");
    // And the two things the owner has to type.
    if (outcome.kind !== "offered") throw new Error("unreachable");
    expect(text).toContain(`send ${outcome.code}`);
    expect(text).toContain(`delete ${outcome.code}`);
  });

  it("needs no approvals bot: nothing is configured here and the offer still stands", async () => {
    expect(await approval.chatApprovalEnabled()).toBe(false);
    const draft = queueDraft();
    expect((await reply.offerReplyApproval(draft)).kind).toBe("offered");
  });

  it("does not ask twice about one draft", async () => {
    const draft = queueDraft();
    const first = await reply.offerReplyApproval(draft);
    const second = await reply.offerReplyApproval(draft);
    expect(first.kind).toBe("offered");
    expect(second.kind).toBe("already_asked");
    expect(vi.mocked(ownerSend.sendOwnerTelegramText)).toHaveBeenCalledTimes(1);
  });

  it("stands down rather than showing part of a draft nobody can read in one message", async () => {
    const long = pending.queuePending({
      to: ["someone@example.com"],
      subject: "Long",
      body: "x".repeat(19_000),
    });
    if (!long.ok) throw new Error(long.error);
    expect((await reply.offerReplyApproval(long.draft)).kind).toBe("too_long");
    expect(vi.mocked(ownerSend.sendOwnerTelegramText)).not.toHaveBeenCalled();
  });

  it("says so when nobody is paired, instead of issuing a code nobody has", async () => {
    const openclaw = await import("@/lib/openclaw-config");
    vi.mocked(openclaw.readTelegramAllowFrom).mockResolvedValue([]);
    expect((await reply.offerReplyApproval(queueDraft())).kind).toBe("no_owner_chat");
  });
});

// ── One reply names one draft ────────────────────────────────────────────────

describe("the reply names one draft", () => {
  it("sends exactly the draft the code was issued for", async () => {
    const first = await offered("First");
    const second = await offered("Second");

    const result = await reply.applyReplyApproval({ senderId: OWNER, text: `send ${second.code}` });

    expect(result.handled).toBe(true);
    expect(vi.mocked(smtp.sendMail)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(smtp.sendMail).mock.calls[0][1].subject).toBe("Second");
    // The other draft is untouched and still waiting.
    expect(pending.listPending().map((d) => d.id)).toEqual([first.id]);
  });

  it("refuses to guess: a bare 'send' decides nothing", async () => {
    await offered();
    const result = await reply.applyReplyApproval({ senderId: OWNER, text: "send" });
    expect(result.handled).toBe(false);
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
    expect(pending.countPending()).toBe(1);
  });

  it("leaves ordinary conversation alone", async () => {
    await offered();
    for (const text of ["how are you", "send me the report tomorrow", "please approve the budget"]) {
      expect((await reply.applyReplyApproval({ senderId: OWNER, text })).handled).toBe(false);
    }
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
  });

  it("answers a code it does not know without touching the queue", async () => {
    await offered();
    const result = await reply.applyReplyApproval({ senderId: OWNER, text: "send ZZZZZ" });
    expect(result.handled).toBe(false);
    expect(pending.countPending()).toBe(1);
  });

  it("answers once: the same code a second time is spent", async () => {
    const { code } = await offered();
    expect((await reply.applyReplyApproval({ senderId: OWNER, text: `send ${code}` })).handled).toBe(true);
    const again = await reply.applyReplyApproval({ senderId: OWNER, text: `send ${code}` });
    expect(again.handled).toBe(false);
    expect(vi.mocked(smtp.sendMail)).toHaveBeenCalledTimes(1);
  });

  it("goes with the draft when it is decided somewhere else", async () => {
    const { id, code } = await offered();
    // The owner approved it in Settings → Email instead; the route retires the
    // question, which is what must take the code with it.
    await approval.retireChatPrompt(id);
    expect(prompts.countPrompts()).toBe(0);
    expect((await reply.applyReplyApproval({ senderId: OWNER, text: `send ${code}` })).handled).toBe(false);
  });
});

// ── The sender is the owner ──────────────────────────────────────────────────

describe("who may say send", () => {
  it("does not claim a stranger's message, and sends nothing", async () => {
    const { code } = await offered();
    const result = await reply.applyReplyApproval({ senderId: STRANGER, text: `send ${code}` });
    // NOT handled: the harness must go on to its own auth, so an unpaired
    // sender still meets the pairing flow rather than silence.
    expect(result.handled).toBe(false);
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
    expect(pending.countPending()).toBe(1);
    // And the code is still live for the person it was meant for.
    expect((await reply.applyReplyApproval({ senderId: OWNER, text: `send ${code}` })).handled).toBe(true);
  });

  it("reads the allowlist the active harness owns", async () => {
    const harness = await import("@/lib/harness");
    const hermes = await import("@/lib/hermes-telegram");
    vi.mocked(harness.getActiveHarness).mockResolvedValue("hermes");
    vi.mocked(hermes.readHermesApprovedUsers).mockResolvedValue([{ id: "7002", name: "owner" }]);

    const draft = queueDraft();
    const offer = await reply.offerReplyApproval(draft);
    if (offer.kind !== "offered") throw new Error(`not offered: ${offer.kind}`);
    // The OpenClaw allowlist must not carry on this edition.
    expect((await reply.applyReplyApproval({ senderId: OWNER, text: `send ${offer.code}` })).handled).toBe(false);
    expect((await reply.applyReplyApproval({ senderId: "7002", text: `send ${offer.code}` })).handled).toBe(true);
  });
});

// ── Deleting ─────────────────────────────────────────────────────────────────

describe("delete", () => {
  it("throws the draft away and sends nothing", async () => {
    const { id, code } = await offered();
    const result = await reply.applyReplyApproval({ senderId: OWNER, text: `delete ${code}` });

    expect(result.handled).toBe(true);
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
    expect(pending.countPending()).toBe(0);
    expect(outcomes.getOutcome(id)?.kind).toBe("rejected");
  });
});

// ── What every surface then says ─────────────────────────────────────────────

describe("the record every surface reads", () => {
  it("leaves the queue empty and a 'sent' receipt with a time", async () => {
    const { id, code } = await offered();
    const before = Date.now();

    await reply.applyReplyApproval({ senderId: OWNER, text: `send ${code}` });

    // The chat card reads the pending list; Settings → Email reads both.
    expect(pending.getPending(id)).toBeNull();
    const receipt = outcomes.getOutcome(id);
    expect(receipt?.kind).toBe("sent");
    expect(receipt?.at).toBeGreaterThanOrEqual(before);
    expect(receipt?.subject).toBe("Hello");
  });

});

// ── "Sent" is written after the send, never before ───────────────────────────

describe("no false success", () => {
  it("has written no receipt at the moment the mail server is called", async () => {
    const { id, code } = await offered();
    // "not called" is a third state on purpose: a null here would otherwise
    // also be what an unreached mock leaves behind.
    let receiptDuringSend: unknown = "not called";
    vi.mocked(smtp.sendMail).mockImplementation(async () => {
      receiptDuringSend = outcomes.getOutcome(id);
      return { messageId: "<sent@example.com>" };
    });

    await reply.applyReplyApproval({ senderId: OWNER, text: `send ${code}` });

    // Nothing may claim the message has gone while it is still going.
    expect(receiptDuringSend).toBeNull();
    expect(outcomes.getOutcome(id)?.kind).toBe("sent");
  });

  it("records a refusal as failed, on every surface, and never as sent", async () => {
    const { id, code } = await offered();
    const { SmtpError } = await import("@/lib/smtp-client");
    vi.mocked(smtp.sendMail).mockRejectedValue(new SmtpError("auth", "The mail server refused the sign-in."));

    const result = await reply.applyReplyApproval({ senderId: OWNER, text: `send ${code}` });

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Not sent");
    expect(outcomes.getOutcome(id)?.kind).toBe("failed");
    expect(outcomes.getOutcome(id)?.kind).not.toBe("sent");
  });

  it("does not call a message that never got an answer 'not sent'", async () => {
    const { id, code } = await offered();
    vi.mocked(smtp.sendMail).mockRejectedValue(new Error("socket hang up"));

    const result = await reply.applyReplyApproval({ senderId: OWNER, text: `send ${code}` });

    // The receipt and the sentence the owner reads have to agree — the #603
    // lesson, and the reason applyApprovalCallback words this branch the way
    // it does.
    expect(outcomes.getOutcome(id)?.kind).toBe("unconfirmed");
    expect(result.reply).toContain("check your Sent folder");
  });

  it("sends nothing at all when no mail account is connected", async () => {
    const { code } = await offered();
    vi.mocked(emailConfig.getEmailCredentials).mockResolvedValue(null);
    const result = await reply.applyReplyApproval({ senderId: OWNER, text: `send ${code}` });
    expect(result.handled).toBe(true);
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
  });
});

// ── The words the two harnesses' plugins have to agree on ────────────────────

describe("parseApprovalReply", () => {
  it("takes the verbs a person actually types, in any case", () => {
    for (const text of ["send AB2CD", "SEND ab2cd", " approve  AB2CD ", "ok AB2CD", "yes AB2CD"]) {
      expect(reply.parseApprovalReply(text)).toEqual({ verb: "approve", code: "AB2CD" });
    }
    for (const text of ["delete AB2CD", "deny AB2CD", "no AB2CD", "cancel AB2CD"]) {
      expect(reply.parseApprovalReply(text)).toEqual({ verb: "reject", code: "AB2CD" });
    }
  });

  it("refuses anything that is not exactly a verb and a code", () => {
    for (const text of [
      "send",
      "send the invoice AB2CD",
      "send AB2CD please",
      "sending AB2CD",
      "AB2CD",
      "",
    ]) {
      expect(reply.parseApprovalReply(text)).toBeNull();
    }
  });
});
