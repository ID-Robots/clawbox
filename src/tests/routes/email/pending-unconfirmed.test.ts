// What the approval route SAYS about a send it could not confirm, and about a
// draft that was already decided somewhere else.
//
// Two rules, and they are the same rule seen from two sides: the answer this
// route hands back must not contradict the receipt the same request just wrote.
//
//   AN UNCONFIRMED SEND IS NOT A FAILURE. When the connection drops after the
//   message has been handed over, nothing in this process knows whether it went
//   out. The receipt says `unconfirmed` — and the response row has to carry
//   that same word, because the surface reading the row is the one the owner
//   acts on. "Not sent" over a message that may well be in somebody's inbox is
//   how an owner is talked into sending it twice.
//
//   A DRAFT DECIDED ELSEWHERE IS NOT A FAILURE EITHER — but only when there is
//   a RECEIPT saying so. "It is no longer in the queue" on its own is not an
//   outcome, it is the absence of one, and counting it as resolved would let a
//   draft that vanished for a reason nobody recorded pass for a success.
//
// Against the REAL queue and the REAL receipts on a temp root: the whole
// question is what the store and the answer say about each other, and a mocked
// store answers that with whatever the test told it to.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/smtp-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/smtp-client")>("@/lib/smtp-client");
  return { ...actual, sendMail: vi.fn() };
});
vi.mock("@/lib/email-approval", () => ({ retireChatPrompt: vi.fn(async () => undefined) }));

// Handles taken AFTER vi.resetModules(), never from a static top-level import:
// DATA_DIR is resolved at module load, so anything imported before the temp
// root is set reads another test's queue.
let POST: typeof import("@/app/setup-api/email/pending/route").POST;
let store: typeof import("@/lib/email-pending");
let outcomes: typeof import("@/lib/email-outcomes");
let smtp: typeof import("@/lib/smtp-client");
let mockSend: ReturnType<typeof vi.mocked<typeof import("@/lib/smtp-client").sendMail>>;
let createSessionCookie: typeof import("@/lib/auth").createSessionCookie;
let root: string;

const SESSION_SECRET = "a".repeat(64);
const CONFIGURED: Record<string, unknown> = {
  email_address: "box@example.com",
  email_password: "abcd efgh ijkl mnop",
  email_smtp_host: "smtp.example.com",
  email_smtp_port: 587,
};

function request(body: unknown): Request {
  return new Request("http://localhost/setup-api/email/pending", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0)}`,
    },
    body: JSON.stringify(body),
  });
}

/** Queue one draft and hand back the entry a card would post for it. */
function queue(subject: string): { id: string; fingerprint: string } {
  const queued = store.queuePending({ to: ["person@example.com"], subject, body: `The body of ${subject}.` });
  if (!queued.ok) throw new Error("fixture failed to queue");
  return { id: queued.draft.id, fingerprint: store.draftFingerprint(queued.draft) };
}

type BatchBody = {
  success: boolean;
  sent: number;
  failed: number;
  duplicates: number;
  resolved: number;
  results: { id: string; ok: boolean; reason?: string; ending?: string; kind?: string }[];
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-pending-unconfirmed-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = SESSION_SECRET;
  vi.resetModules();
  vi.clearAllMocks();

  const config = await import("@/lib/config-store");
  for (const [key, value] of Object.entries(CONFIGURED)) await config.set(key, value);

  ({ createSessionCookie } = await import("@/lib/auth"));
  store = await import("@/lib/email-pending");
  outcomes = await import("@/lib/email-outcomes");
  smtp = await import("@/lib/smtp-client");
  mockSend = vi.mocked(smtp.sendMail);
  mockSend.mockResolvedValue({ messageId: "sent@example.com" });
  vi.mocked((await import("@/lib/email-approval")).retireChatPrompt).mockResolvedValue(undefined);
  POST = (await import("@/app/setup-api/email/pending/route")).POST;
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a send this box cannot vouch for", () => {
  it("carries the receipt's word back on the batch row", async () => {
    const one = queue("First message");
    // The socket closed after the DATA command. Not an SmtpError, so the
    // failure is a silence rather than a refusal.
    mockSend.mockRejectedValue(new Error("socket hang up"));

    const body = (await (await POST(request({ action: "approve_batch", drafts: [one] }))).json()) as BatchBody;

    expect(outcomes.getOutcome(one.id)).toMatchObject({ kind: "unconfirmed" });
    // The row and the receipt are the same request's two statements about one
    // message. They must not disagree.
    expect(body.results[0]).toMatchObject({ id: one.id, ok: false, reason: "send_failed", ending: "unconfirmed" });
  });

  it("carries it back on the single-draft row too — the sibling call site", async () => {
    const one = queue("Only message");
    mockSend.mockRejectedValue(new Error("socket hang up"));

    const res = await POST(request({ action: "approve", id: one.id }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ending?: string; kind?: string };

    expect(outcomes.getOutcome(one.id)).toMatchObject({ kind: "unconfirmed" });
    expect(body.ending).toBe("unconfirmed");
  });

  it("still says 'failed' when the mail server actually refused it", async () => {
    // The other half of the judgement. Softening a refusal the server SPOKE is
    // the mirror-image lie, and this pins that the ending is read from the
    // error rather than hard-coded.
    const one = queue("Refused message");
    mockSend.mockRejectedValue(new smtp.SmtpError("auth", "The mail server refused the sign-in."));

    const body = (await (await POST(request({ action: "approve_batch", drafts: [one] }))).json()) as BatchBody;

    expect(outcomes.getOutcome(one.id)).toMatchObject({ kind: "failed" });
    expect(body.results[0]).toMatchObject({ ending: "failed", kind: "auth" });
  });
});

describe("a draft the batch found already decided", () => {
  it("counts a receipt-backed one apart from the failures", async () => {
    const elsewhere = queue("Sent from Settings");
    const here = queue("Sent from the card");
    // The owner approved this one in Settings → Email while the card sat on
    // screen. It is out of the queue with a receipt saying it was sent.
    await POST(request({ action: "approve", id: elsewhere.id }));
    expect(outcomes.getOutcome(elsewhere.id)).toMatchObject({ kind: "sent" });

    const res = await POST(request({ action: "approve_batch", drafts: [elsewhere, here] }));
    const body = (await res.json()) as BatchBody;

    // Nothing went wrong: one message went out just now, the other had already
    // gone. A 207 with a failure on it would put a red verdict on a card where
    // every draft reached somebody.
    expect(body.resolved).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.success).toBe(true);
    expect(res.status).toBe(200);
  });

  it("still calls it a failure when NO receipt backs it", async () => {
    // The guard on the rule above. A draft that left the queue with nothing
    // recorded about it is an unknown, not a resolution, and counting it as one
    // would let the absence of an outcome pass for a good one.
    const vanished = queue("Vanished message");
    const here = queue("Sent from the card");
    expect(store.removePending(vanished.id)).toBe(true);
    expect(outcomes.getOutcome(vanished.id)).toBeNull();

    const res = await POST(request({ action: "approve_batch", drafts: [vanished, here] }));
    const body = (await res.json()) as BatchBody;

    const row = body.results.find((r) => r.id === vanished.id);
    expect(row).toMatchObject({ reason: "gone" });
    expect(row).not.toHaveProperty("ending");
    expect(body.resolved).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.success).toBe(false);
    expect(res.status).toBe(207);
  });

  it.each([
    ["refused by the mail server", async (id: string, smtpMod: typeof smtp, send: typeof mockSend) => {
      send.mockRejectedValueOnce(new smtpMod.SmtpError("recipient", "The mail server refused the recipient."));
      await POST(request({ action: "approve", id }));
    }, "failed"],
    ["left unconfirmed", async (id: string, _smtpMod: typeof smtp, send: typeof mockSend) => {
      send.mockRejectedValueOnce(new Error("socket hang up"));
      await POST(request({ action: "approve", id }));
    }, "unconfirmed"],
    ["deleted", async (id: string) => {
      await POST(request({ action: "reject", id }));
    }, "rejected"],
  ])("counts a sibling %s among the failures — it reached nobody", async (_name, decide, ending) => {
    // The other half of the rule above, and the one that decides whether this
    // counter is a fix or a new bug. "Not waiting any more" is NOT the test:
    // under these three endings the words reached no recipient, so subtracting
    // them from `failed` would answer 200 `success: true` over a batch
    // containing a message the mail server refused — a caller reading only the
    // status line would conclude both went out.
    const elsewhere = queue("Decided in Settings");
    const here = queue("Sent from the card");
    await decide(elsewhere.id, smtp, mockSend);
    expect(outcomes.getOutcome(elsewhere.id)).toMatchObject({ kind: ending });

    const res = await POST(request({ action: "approve_batch", drafts: [elsewhere, here] }));
    const body = (await res.json()) as BatchBody;

    expect(body.results.find((r) => r.id === elsewhere.id)).toMatchObject({ reason: "gone", ending });
    expect(body.resolved).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.success).toBe(false);
    expect(res.status).toBe(207);
  });

  it("does not let a send_failed row's ending be counted as resolved", async () => {
    // `resolved` is anchored on `reason === "gone"` for exactly this reason:
    // once a failed send carries an ending too, a predicate that only asked
    // "has an ending?" would quietly swallow the failure it exists to report.
    const one = queue("Dropped message");
    mockSend.mockRejectedValue(new Error("socket hang up"));

    const body = (await (await POST(request({ action: "approve_batch", drafts: [one] }))).json()) as BatchBody;

    expect(body.results[0]).toMatchObject({ reason: "send_failed", ending: "unconfirmed" });
    expect(body.resolved).toBe(0);
    expect(body.failed).toBe(1);
  });
});

describe("the single-draft answer for a draft already decided", () => {
  it("names the ending on an approve, so Settings can tell news from a failure", async () => {
    // The server half of the same rule the batch paths keep. Pinned HERE and
    // not only through the panel: the panel's own test hand-builds this body,
    // so without a route-level case the two halves are green and the seam
    // between them is not — which is exactly how the batch row came to lose
    // its ending in the first place.
    const one = queue("Sent from Telegram");
    await POST(request({ action: "approve", id: one.id }));
    expect(outcomes.getOutcome(one.id)).toMatchObject({ kind: "sent" });

    const res = await POST(request({ action: "approve", id: one.id }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ kind: "gone", ending: "sent" });
  });

  it("names it on a reject too", async () => {
    const one = queue("Sent from Telegram");
    await POST(request({ action: "approve", id: one.id }));

    const res = await POST(request({ action: "reject", id: one.id }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ kind: "gone", ending: "sent" });
  });

  it("still says only 'no longer waiting' when no receipt backs it", async () => {
    // No receipt, no ending — and the panel keeps painting that red, because
    // nobody knows what happened to it.
    const one = queue("Vanished message");
    expect(store.removePending(one.id)).toBe(true);

    const res = await POST(request({ action: "approve", id: one.id }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "gone" });
    expect(body).not.toHaveProperty("ending");
  });
});
