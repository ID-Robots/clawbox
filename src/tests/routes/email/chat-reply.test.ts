// /setup-api/email/chat-reply — the harness handing ClawBox one inbound message.
//
// This is the seam the owner meets: he types "send AB2CD" in the Telegram
// conversation he already has with the box, the harness's own inbound hook
// gives ClawBox the message and the sender, and the mail goes.
//
// Nothing here is hand-built past the POST. The REAL route runs against a real
// queue on a temp root, and what the two owner-facing surfaces then show is
// read out of the REAL /setup-api/email/pending GET and handed to the REAL
// chat-card reconciler — so "the card flips to sent and the drafts row says
// sent" is asserted through the code that actually draws them, not through a
// fixture that agrees with itself.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const MCP_TOKEN = "t".repeat(32);
const SESSION_SECRET = "a".repeat(64);

let root: string;
let POST: typeof import("@/app/setup-api/email/chat-reply/route").POST;
let pendingGET: typeof import("@/app/setup-api/email/pending/route").GET;
let reply: typeof import("@/lib/email-approval-reply");
let pending: typeof import("@/lib/email-pending");
let card: typeof import("@/lib/chat-email-batch");
let smtp: typeof import("@/lib/smtp-client");
let emailConfig: typeof import("@/lib/email-config");
let ownerSend: typeof import("@/lib/telegram-owner-send");
/** /email/pending takes a browser session and nothing else — see owner-session.ts. */
let cookie: string;

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

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://127.0.0.1/setup-api/email/chat-reply", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${MCP_TOKEN}` },
      body: JSON.stringify(body),
    }),
  );
}

/** Queue one draft and ask about it, the way /email/send does. */
async function offered(subject = "Invoice"): Promise<{ id: string; code: string }> {
  const queued = pending.queuePending({ to: ["someone@example.com"], subject, body: "The body." });
  if (!queued.ok) throw new Error(queued.error);
  const outcome = await reply.offerReplyApproval(queued.draft);
  if (outcome.kind !== "offered") throw new Error(`not offered: ${outcome.kind}`);
  return { id: queued.draft.id, code: outcome.code };
}

/**
 * The two owner-facing surfaces, both read out of one GET — which is how they
 * are read on the device (email-pending-refresh.ts polls this single answer for
 * the chat popup and for Settings → Email alike).
 */
async function surfaces(cardIds: string[]) {
  const res = await pendingGET(
    new Request("http://127.0.0.1/setup-api/email/pending", { headers: { cookie } }),
  );
  const body = (await res.json()) as {
    pending: { id: string }[];
    outcomes: { id: string; kind: string; at: number }[];
  };
  const pendingIds = new Set(body.pending.map((d) => d.id));
  const resolved = new Map(
    body.outcomes.map((o) => [o.id, { id: o.id, ok: o.kind === "sent", kind: card.emailEnding(o.kind), at: o.at }]),
  );
  const cards = card.reconcileBatchCards(
    [
      {
        batchId: cardIds.join("|"),
        drafts: cardIds.map((id) => ({ id, to: ["someone@example.com"], subject: "Invoice", preview: "The body.", body: "The body.", createdAt: 1, fingerprint: "f" })),
        status: "waiting" as const,
        outcomes: [],
        requestError: "",
      },
    ],
    pendingIds,
    resolved,
  );
  return { drafts: body.outcomes, card: cards[0] };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-chat-reply-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_MCP_TOKEN = MCP_TOKEN;
  process.env.SESSION_SECRET = SESSION_SECRET;
  vi.resetModules();
  const auth = await import("@/lib/auth");
  cookie = `clawbox_session=${auth.createSessionCookie(3600, SESSION_SECRET, 0)}`;
  pending = await import("@/lib/email-pending");
  card = await import("@/lib/chat-email-batch");
  smtp = await import("@/lib/smtp-client");
  emailConfig = await import("@/lib/email-config");
  ownerSend = await import("@/lib/telegram-owner-send");
  reply = await import("@/lib/email-approval-reply");
  ({ POST } = await import("@/app/setup-api/email/chat-reply/route"));
  ({ GET: pendingGET } = await import("@/app/setup-api/email/pending/route"));

  vi.mocked(emailConfig.getEmailCredentials).mockResolvedValue(CREDENTIALS);
  vi.mocked(smtp.sendMail).mockResolvedValue({ messageId: "<sent@example.com>" });
  vi.mocked(ownerSend.sendOwnerTelegramText).mockResolvedValue(true);
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.CLAWBOX_MCP_TOKEN;
  delete process.env.SESSION_SECRET;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("an approval turn from the owner's own conversation", () => {
  it("sends that email, and both surfaces then say sent", async () => {
    const { id, code } = await offered();

    const res = await post({ senderId: OWNER, text: `send ${code}` });
    const body = (await res.json()) as { handled: boolean; reply?: string };

    expect(res.status).toBe(200);
    expect(body.handled).toBe(true);
    expect(vi.mocked(smtp.sendMail)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(smtp.sendMail).mock.calls[0][1].subject).toBe("Invoice");

    const after = await surfaces([id]);
    // Settings → Email: the drafts row says sent, with a time.
    const receipt = after.drafts.find((o) => o.id === id);
    expect(receipt?.kind).toBe("sent");
    expect(receipt?.at).toBeGreaterThan(0);
    // The ClawBox chat: the card the owner is looking at settles as sent, with
    // no reload — this is what the next poll of the same GET produces.
    expect(after.card.status).toBe("settled");
    expect(after.card.outcomes).toEqual([expect.objectContaining({ id, ok: true, kind: "sent" })]);
  });

  it("hands the message back unclaimed when the sender is not on the harness allowlist", async () => {
    const { id, code } = await offered();

    const res = await post({ senderId: "999", text: `send ${code}` });
    expect(((await res.json()) as { handled: boolean }).handled).toBe(false);
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
    expect(pending.getPending(id)).not.toBeNull();
  });

  it("does not claim ordinary conversation", async () => {
    await offered();
    const res = await post({ senderId: OWNER, text: "can you send Ivan the invoice tomorrow?" });
    expect(((await res.json()) as { handled: boolean }).handled).toBe(false);
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
  });

  it("does not spend the attempt budget on a message that is not an approval", async () => {
    // The refusal a spent budget produces lands on the NEXT real approval and
    // is silent, so anything that is not an attempt must not be charged for.
    const { code } = await offered();
    for (let i = 0; i < 30; i++) {
      const res = await post({ senderId: OWNER, text: "hello there" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { handled: boolean }).handled).toBe(false);
    }
    const res = await post({ senderId: OWNER, text: `send ${code}` });
    expect(((await res.json()) as { handled: boolean }).handled).toBe(true);
  });

  it("never writes sent over a send that failed", async () => {
    const { id, code } = await offered();
    const { SmtpError } = await import("@/lib/smtp-client");
    vi.mocked(smtp.sendMail).mockRejectedValue(new SmtpError("auth", "The mail server refused the sign-in."));

    const res = await post({ senderId: OWNER, text: `send ${code}` });
    expect(((await res.json()) as { handled: boolean }).handled).toBe(true);

    const after = await surfaces([id]);
    expect(after.drafts.find((o) => o.id === id)?.kind).toBe("failed");
    expect(after.card.outcomes).toEqual([expect.objectContaining({ id, ok: false, kind: "failed" })]);
  });

  it("does not run the owner out of budget while he clears the queue", async () => {
    // Twelve real approvals in a row, past the ten-attempt bound: a code that
    // worked is not an attempt worth counting, and an owner told "too many
    // attempts" half way through his own outbox is the false failure.
    for (let i = 0; i < 12; i++) {
      const { code } = await offered(`Draft ${i}`);
      const res = await post({ senderId: OWNER, text: `send ${code}` });
      expect(((await res.json()) as { handled: boolean }).handled).toBe(true);
    }
    expect(vi.mocked(smtp.sendMail)).toHaveBeenCalledTimes(12);
  });

  it("still stops a caller that keeps naming drafts that do not exist", async () => {
    await offered();
    const answers: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await post({ senderId: OWNER, text: "send ZZZZZ" });
      answers.push(res.status);
    }
    expect(answers).toContain(429);
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
  });

  it("refuses a browser: this route takes the harness's bearer and nothing else", async () => {
    // middleware admits a session cookie too, so without this check a page the
    // owner visits could POST here with his cookie riding along. Every real
    // caller is a harness plugin holding the bearer; none of them has a cookie.
    const { id, code } = await offered();
    const res = await POST(
      new Request("http://127.0.0.1/setup-api/email/chat-reply", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ senderId: OWNER, text: `send ${code}` }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { handled: boolean }).handled).toBe(false);
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
    expect(pending.getPending(id)).not.toBeNull();
  });

  it("refuses a body it cannot read rather than guessing", async () => {
    const res = await POST(
      new Request("http://127.0.0.1/setup-api/email/chat-reply", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${MCP_TOKEN}` },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(smtp.sendMail)).not.toHaveBeenCalled();
  });
});
