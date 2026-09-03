// Approving one of two identical drafts, against the REAL queue on disk.
//
// The other pending-route tests mock @/lib/email-pending, which is right for
// what they assert — that the gate holds and that a claim happens before a
// send. It is exactly wrong for this file: the whole question here is what the
// STORE looks like afterwards, and a mocked store answers that with whatever
// the test told it to.
//
// TWO THINGS ARE PINNED.
//
//   The duplicate's fate. The owner's box ended up with two identical drafts
//   from one request. Approving one used to leave the other waiting, so the
//   only honest-looking action left was to approve it too — and mail the same
//   person the same message twice. Approving one now resolves its exact twins:
//   sent ONCE, the twins marked as covered by that send, never re-sent.
//
//   The receipt. A draft that leaves the queue writes what became of it, so
//   the chat card and Settings → Email can render "sent" instead of leaving a
//   live Approve button over a message that is already gone.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/smtp-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/smtp-client")>("@/lib/smtp-client");
  return { ...actual, sendMail: vi.fn() };
});
// The chat prompt store is a different feature with its own tests; here it is
// only noise on the way to the queue.
vi.mock("@/lib/email-approval", () => ({ retireChatPrompt: vi.fn(async () => undefined) }));

// EVERY handle is taken AFTER vi.resetModules(), never from a static top-level
// import. Two things force it. A `vi.mock` factory's `importOriginal` result is
// cached across a reset, so mocking config-store here would freeze DATA_DIR at
// the FIRST test's temp root and every later case would read another test's
// queue. And a factory's `vi.fn()` is re-made on each reset, so a top-level
// binding configures a mock the route under test is not using.
type Store = typeof import("@/lib/email-pending");
type Outcomes = typeof import("@/lib/email-outcomes");

let POST: typeof import("@/app/setup-api/email/pending/route").POST;
let GET: typeof import("@/app/setup-api/email/pending/route").GET;
let store: Store;
let outcomes: Outcomes;
let smtp: typeof import("@/lib/smtp-client");
let mockSend: ReturnType<typeof vi.mocked<typeof import("@/lib/smtp-client").sendMail>>;
let mockRetire: ReturnType<
  typeof vi.mocked<typeof import("@/lib/email-approval").retireChatPrompt>
>;
let createSessionCookie: typeof import("@/lib/auth").createSessionCookie;
let root: string;

const SESSION_SECRET = "a".repeat(64);
const CONFIGURED: Record<string, unknown> = {
  email_address: "box@example.com",
  email_password: "abcd efgh ijkl mnop",
  email_smtp_host: "smtp.gmail.com",
  email_smtp_port: 587,
};

const MESSAGE = { to: ["owner@example.com"], subject: "test test", body: "test test from hermes" };

function ownerCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0)}`;
}

function request(body?: unknown): Request {
  return new Request("http://localhost/setup-api/email/pending", {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", cookie: ownerCookie() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * The state the owner's device was actually in: one message, two rows.
 *
 * Written to the file rather than queued twice, because queueing twice is the
 * thing the store now refuses — and this file is about the boxes that already
 * have the pair.
 */
function seedTwins(): { first: string; twin: string } {
  const queued = store.queuePending(MESSAGE);
  if (!queued.ok) throw new Error("fixture failed to queue");
  const twin = { ...queued.draft, id: "twin-id", createdAt: queued.draft.createdAt + 1 };
  fs.writeFileSync(
    path.join(root, "data", "email-pending.json"),
    JSON.stringify([queued.draft, twin], null, 2),
  );
  return { first: queued.draft.id, twin: twin.id };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-pending-dupes-"));
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
  mockRetire = vi.mocked((await import("@/lib/email-approval")).retireChatPrompt);
  mockRetire.mockResolvedValue(undefined);

  const route = await import("@/app/setup-api/email/pending/route");
  POST = route.POST;
  GET = route.GET;
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("approving one of two identical drafts", () => {
  it("sends once and empties the queue of both", async () => {
    const { first, twin } = seedTwins();

    const res = await POST(request({ action: "approve", id: first }));
    expect(res.status).toBe(200);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(store.listPending()).toEqual([]);
    expect(store.getPending(twin)).toBeNull();
  });

  it("says the twin was covered by that send, never that it was sent on its own", async () => {
    const { first, twin } = seedTwins();
    await POST(request({ action: "approve", id: first }));

    expect(outcomes.getOutcome(first)).toMatchObject({ kind: "sent" });
    expect(outcomes.getOutcome(twin)).toMatchObject({ kind: "duplicate", sentAs: first });
  });

  it("takes the twin's chat button away too", async () => {
    const { first, twin } = seedTwins();
    await POST(request({ action: "approve", id: first }));

    const retired = mockRetire.mock.calls.map((c) => c[0]);
    expect(retired).toContain(first);
    expect(retired).toContain(twin);
  });

  it("leaves a twin alone when the send failed — nothing was covered", async () => {
    const { first, twin } = seedTwins();
    mockSend.mockRejectedValue(new smtp.SmtpError("auth", "The mail server refused the sign-in."));

    const res = await POST(request({ action: "approve", id: first }));
    expect(res.status).toBe(502);
    // The approved draft was claimed before the send, as it always is. The one
    // that was NOT approved must still be waiting: nothing reached anybody.
    expect(store.listPending().map((d) => d.id)).toEqual([twin]);
    expect(outcomes.getOutcome(first)).toMatchObject({ kind: "failed" });
    expect(outcomes.getOutcome(twin)).toBeNull();
  });
});

describe("what the surfaces are told", () => {
  it("GET carries the receipts next to the queue", async () => {
    const { first } = seedTwins();
    await POST(request({ action: "approve", id: first }));

    const body = (await (await GET(request())).json()) as {
      pending: unknown[];
      outcomes: { id: string; kind: string }[];
    };
    expect(body.pending).toEqual([]);
    expect(body.outcomes.map((o) => o.kind).sort()).toEqual(["duplicate", "sent"]);
  });

  it("a deleted draft is recorded as deleted, not left to look sent", async () => {
    const queued = store.queuePending({ ...MESSAGE, subject: "delete me" });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;

    const res = await POST(request({ action: "reject", id: queued.draft.id }));
    expect(res.status).toBe(200);
    expect(outcomes.getOutcome(queued.draft.id)).toMatchObject({ kind: "rejected" });
  });
});

describe("the batch path answers the same way", () => {
  it("resolves the twins of every draft it sends", async () => {
    const { first, twin } = seedTwins();
    const entry = { id: first, fingerprint: store.draftFingerprint(store.getPending(first)!) };

    const res = await POST(request({ action: "approve_batch", drafts: [entry] }));
    expect(res.status).toBe(200);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(store.listPending()).toEqual([]);
    expect(outcomes.getOutcome(twin)).toMatchObject({ kind: "duplicate", sentAs: first });
  });
});

// ── "Send nothing" has to actually mean something ────────────────────────────
//
// The chat card's dismiss button dropped the card from the browser's own state
// and left every draft in the queue, so the surface re-offered them on its next
// tick. The owner's words: "when I click dismiss ('Send nothing') nothing
// happens; it returns after 20 secs." A control whose only effect is to hide
// itself for fifteen seconds is not a control.
//
// So the gesture reaches the STORE, for the whole named set at once — and it
// names its drafts with the fingerprints they were shown with, exactly as the
// approve path does. Deleting text the owner never saw is the mirror of sending
// it.

describe("rejecting a named set", () => {
  it("deletes every draft in the set and records each one", async () => {
    const a = store.queuePending({ ...MESSAGE, subject: "first" });
    const b = store.queuePending({ ...MESSAGE, subject: "second" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const res = await POST(
      request({
        action: "reject_batch",
        drafts: [a, b].map((r) => ({
          id: r.draft.id,
          fingerprint: store.draftFingerprint(r.draft),
        })),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, rejected: 2, failed: 0 });
    expect(store.listPending()).toEqual([]);
    expect(outcomes.getOutcome(a.draft.id)).toMatchObject({ kind: "rejected" });
    expect(outcomes.getOutcome(b.draft.id)).toMatchObject({ kind: "rejected" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("takes the chat buttons down with the drafts", async () => {
    const a = store.queuePending(MESSAGE);
    if (!a.ok) return;
    await POST(
      request({
        action: "reject_batch",
        drafts: [{ id: a.draft.id, fingerprint: store.draftFingerprint(a.draft) }],
      }),
    );
    expect(mockRetire.mock.calls.map((c) => c[0])).toContain(a.draft.id);
  });

  it("refuses a draft whose text moved, and says which", async () => {
    // The same rule the approve path keeps: a draft that changed after it was
    // shown is not the draft the owner decided about, and throwing away words
    // they never agreed to lose is not ours to do.
    const a = store.queuePending(MESSAGE);
    if (!a.ok) return;
    const res = await POST(
      request({ action: "reject_batch", drafts: [{ id: a.draft.id, fingerprint: "0".repeat(32) }] }),
    );

    expect(res.status).toBe(207);
    const body = (await res.json()) as { rejected: number; failed: number; results: { reason: string }[] };
    expect(body).toMatchObject({ rejected: 0, failed: 1 });
    expect(body.results[0].reason).toBe("changed");
    // Still there, untouched.
    expect(store.listPending().map((d) => d.id)).toEqual([a.draft.id]);
    expect(outcomes.getOutcome(a.draft.id)).toBeNull();
  });

  it("reports a draft that had already gone without calling it a failure to delete", async () => {
    const res = await POST(
      request({ action: "reject_batch", drafts: [{ id: "never-existed", fingerprint: "0".repeat(32) }] }),
    );
    expect(res.status).toBe(207);
    const body = (await res.json()) as { results: { id: string; reason: string }[] };
    expect(body.results[0]).toMatchObject({ id: "never-existed", reason: "gone" });
  });
});

// ── What a failed send may be RECORDED as ────────────────────────────────────
//
// approveBatch already writes the rule down: once bytes are on the wire, "it
// failed" and "the server took it and the connection dropped before saying so"
// are indistinguishable — which is why a claimed draft is never requeued. The
// receipt has to keep the same discipline. A confident "Not sent" over a
// dropped connection is a positive claim nothing here can support, and the
// owner acts on it by sending the message a second time.

describe("a send that did not come back", () => {
  it("records a mail-server refusal as not sent", async () => {
    const queued = store.queuePending(MESSAGE);
    if (!queued.ok) return;
    mockSend.mockRejectedValue(new smtp.SmtpError("auth", "The mail server refused the sign-in."));

    await POST(request({ action: "approve", id: queued.draft.id }));
    expect(outcomes.getOutcome(queued.draft.id)).toMatchObject({ kind: "failed" });
  });

  it("records a dropped connection as unconfirmed, never as not sent", async () => {
    const queued = store.queuePending(MESSAGE);
    if (!queued.ok) return;
    mockSend.mockRejectedValue(new Error("socket hang up"));

    await POST(request({ action: "approve", id: queued.draft.id }));
    expect(outcomes.getOutcome(queued.draft.id)).toMatchObject({ kind: "unconfirmed" });
  });

  it("says the same about a network-kind SmtpError", async () => {
    const queued = store.queuePending(MESSAGE);
    if (!queued.ok) return;
    mockSend.mockRejectedValue(new smtp.SmtpError("network", "Could not reach the mail server."));

    await POST(request({ action: "approve", id: queued.draft.id }));
    expect(outcomes.getOutcome(queued.draft.id)).toMatchObject({ kind: "unconfirmed" });
  });
});

describe("bookkeeping after the message has gone", () => {
  it("does not turn a queue it cannot rewrite into a failed send", async () => {
    // sendMail has resolved — the mail is in somebody's inbox. An fs error in
    // the duplicate sweep used to be caught by the handler wrapping the send:
    // 502 "Could not send the message.", the "sent" receipt overwritten with a
    // failure, and the whole draft handed back so the panel invites a re-send.
    const { first } = seedTwins();
    // Only the queue write that happens AFTER the send. The claim writes the
    // same file first and has to succeed, or the route never reaches sendMail
    // and the test would pass for the wrong reason.
    const real = fs.writeFileSync;
    let queueWrites = 0;
    const write = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (String(target).endsWith("email-pending.json.tmp") && ++queueWrites > 1) {
          throw new Error("ENOSPC: no space left on device");
        }
        return (real as (...args: unknown[]) => void)(target, ...rest);
      }) as typeof fs.writeFileSync);

    const res = await POST(request({ action: "approve", id: first }));
    write.mockRestore();

    // The message is in somebody's inbox. Anything but a 200 here is a
    // delivered email reported as a failure — which is how a person is talked
    // into sending it twice.
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(queueWrites).toBeGreaterThan(1);
    expect(outcomes.getOutcome(first)).toMatchObject({ kind: "sent" });
  });
});

describe("a batch the owner ticked in full", () => {
  it("sends ONE of a pair on one card, and says the other was covered", async () => {
    // The card the owner meets after the upgrade: the two identical drafts one
    // timed-out request left behind, both on it, both ticked. Ticking both is
    // one decision about one message — the rows are indistinguishable — and
    // sending both is the duplicate email that cannot be recalled.
    //
    // (This used to send twice on purpose, reading two ticks as two consents.
    // The owner's rule is that approving resolves an exact duplicate on EVERY
    // surface, and the batch card is the surface he uses.)
    const { first, twin } = seedTwins();
    const entries = [first, twin].map((id) => ({
      id,
      fingerprint: store.draftFingerprint(store.getPending(id)!),
    }));

    const res = await POST(request({ action: "approve_batch", drafts: entries }));

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as {
      sent: number;
      failed: number;
      duplicates: number;
      results: { id: string; ok: boolean; reason?: string; ending?: string }[];
    };
    expect(body.sent).toBe(1);
    // Not a failure, and not a 207: nothing went wrong here.
    expect(body.failed).toBe(0);
    expect(body.duplicates).toBe(1);
    expect(res.status).toBe(200);
    const covered = body.results.find((r) => r.id === twin);
    expect(covered).toMatchObject({ ok: false, reason: "duplicate", ending: "duplicate" });
    // Both are out of the queue, and both left a receipt saying which ending.
    expect(store.countPending()).toBe(0);
    expect(outcomes.getOutcome(first)?.kind).toBe("sent");
    expect(outcomes.getOutcome(twin)).toMatchObject({ kind: "duplicate", sentAs: first });
  });

  it("still sends two identical messages the owner asked for far apart", async () => {
    // The window is the whole safety argument. Two copies queued outside it are
    // two requests — DEDUPE_WINDOW_MS says so in as many words — and the batch
    // must mail both rather than swallow one.
    const first = store.queuePending(MESSAGE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const later = { ...first.draft, id: "later-id", createdAt: first.draft.createdAt + 40 * 60_000 };
    fs.writeFileSync(
      path.join(root, "data", "email-pending.json"),
      JSON.stringify([first.draft, later], null, 2),
    );
    const entries = [first.draft.id, later.id].map((id) => ({
      id,
      fingerprint: store.draftFingerprint(store.getPending(id)!),
    }));

    const res = await POST(request({ action: "approve_batch", drafts: entries }));

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(await res.json()).toMatchObject({ success: true, sent: 2, failed: 0 });
    expect(res.status).toBe(200);
  });

  it("names the ending a draft actually had, not just 'no longer waiting'", async () => {
    // The card SETTLES on this answer and the reconcile skips settled cards, so
    // a vague word here is permanent. The mail server refused this draft when
    // it was approved from Settings a minute ago; answering the stale click
    // with a shrug would paint a real failure as a non-event.
    const { first } = seedTwins();
    const entry = { id: first, fingerprint: store.draftFingerprint(store.getPending(first)!) };
    store.claimPending(first);
    outcomes.recordOutcome(
      { id: first, to: MESSAGE.to, subject: MESSAGE.subject },
      "failed",
      { error: "mailbox unavailable" },
    );

    const res = await POST(request({ action: "approve_batch", drafts: [entry] }));

    const body = (await res.json()) as { results: { ending?: string; error?: string }[] };
    expect(body.results[0]).toMatchObject({ ok: false, ending: "failed", error: "mailbox unavailable" });
  });

  it("says a draft deleted here was sent, when it turns out it had been", async () => {
    // The mirror on the delete path, and the direction that matters most: the
    // owner clicks "delete both", one of them had already gone out from another
    // surface, and "handled elsewhere" would hide that a message left the box.
    const { first } = seedTwins();
    const entry = { id: first, fingerprint: store.draftFingerprint(store.getPending(first)!) };
    store.claimPending(first);
    outcomes.recordOutcome({ id: first, to: MESSAGE.to, subject: MESSAGE.subject }, "sent");

    const res = await POST(request({ action: "reject_batch", drafts: [entry] }));

    const body = (await res.json()) as { rejected: number; results: { ok: boolean; ending?: string }[] };
    // Not counted as a deletion: this click deleted nothing.
    expect(body.rejected).toBe(0);
    expect(body.results[0]).toMatchObject({ ok: false, ending: "sent" });
  });

  it("does not call a copy covered by an earlier send a failure", async () => {
    // The twin is NOT in this batch, so the first send resolves it — and then a
    // stale card naming it comes back. It is reported apart from the failures
    // and does not force a 207: nothing went wrong.
    const { first, twin } = seedTwins();
    const firstEntry = { id: first, fingerprint: store.draftFingerprint(store.getPending(first)!) };
    const twinEntry = { id: twin, fingerprint: store.draftFingerprint(store.getPending(twin)!) };

    await POST(request({ action: "approve_batch", drafts: [firstEntry] }));
    const res = await POST(request({ action: "approve_batch", drafts: [twinEntry] }));

    const body = (await res.json()) as { failed: number; duplicates: number; results: { reason: string }[] };
    expect(body.failed).toBe(0);
    expect(body.duplicates).toBe(1);
    expect(body.results[0].reason).toBe("duplicate");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
