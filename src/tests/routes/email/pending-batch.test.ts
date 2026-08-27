// /setup-api/email/pending, action "approve_batch" — one consent, N messages.
//
// The authorization tests run against the REAL session verification, for the
// reason pending.test.ts gives: mocking `hasOwnerSession` would leave the one
// property that must hold — "the agent's own token does not open this door" —
// asserted by the mock rather than by the code. The batch path is a new way in
// and therefore needs its own proof of that, not an inherited one.
//
// The STORE is mocked (it is filesystem-backed and has its own suite) except
// for `draftFingerprint`, which stays real: a mocked fingerprint would let the
// freeze tests pass while the comparison they exist to check did nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(),
  set: vi.fn(),
  setMany: vi.fn(),
}));
vi.mock("@/lib/smtp-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/smtp-client")>("@/lib/smtp-client");
  return { ...actual, sendMail: vi.fn() };
});
vi.mock("@/lib/email-pending", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-pending")>()),
  listPending: vi.fn(),
  claimPending: vi.fn(),
  claimPendingIfUnchanged: vi.fn(),
  removePending: vi.fn(),
}));

import { createSessionCookie } from "@/lib/auth";
import { get } from "@/lib/config-store";
import { claimPendingIfUnchanged, draftFingerprint, type PendingEmail } from "@/lib/email-pending";
import { sendMail, SmtpError } from "@/lib/smtp-client";

const mockGet = vi.mocked(get);
const mockSend = vi.mocked(sendMail);
const mockClaimIfUnchanged = vi.mocked(claimPendingIfUnchanged);

let POST: typeof import("@/app/setup-api/email/pending/route").POST;

const SESSION_SECRET = "a".repeat(64);

const CONFIGURED: Record<string, unknown> = {
  email_address: "box@example.com",
  email_password: "abcd efgh ijkl mnop",
  email_smtp_host: "smtp.gmail.com",
  email_smtp_port: 587,
};

/** Three drafts, the way a single turn's worth of `email_send` calls leaves them. */
function draft(n: number): PendingEmail {
  return {
    id: `draft-${n}`,
    to: [`person${n}@example.com`],
    subject: `Subject ${n}`,
    body: `The body of message ${n}.`,
    createdAt: 1_700_000_000_000 + n,
  };
}

const DRAFTS = [draft(1), draft(2), draft(3)];

/** The entries the card posts: id plus the fingerprint of what was on screen. */
function entriesFor(drafts: PendingEmail[]) {
  return drafts.map((d) => ({ id: d.id, fingerprint: draftFingerprint(d) }));
}

function storeWith(values: Record<string, unknown>) {
  mockGet.mockImplementation(async (key: string) => values[key]);
}

function ownerCookie(gen = 0): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, gen)}`;
}

function request(init: { cookie?: string; bearer?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new Request("http://localhost/setup-api/email/pending", {
    method: "POST",
    headers,
    body: JSON.stringify(init.body ?? {}),
  });
}

function approve(entries: { id: string; fingerprint: string }[], init: { cookie?: string; bearer?: string } = {}) {
  return POST(request({ ...init, body: { action: "approve_batch", drafts: entries } }));
}

/** The store as it really behaves: a draft is claimable once, and only unchanged. */
function liveStore(drafts: PendingEmail[]) {
  const queue = new Map(drafts.map((d) => [d.id, d]));
  mockClaimIfUnchanged.mockImplementation((id: string, fingerprint: string) => {
    const found = queue.get(id);
    if (!found) return { ok: false as const, reason: "gone" as const };
    if (draftFingerprint(found) !== fingerprint) return { ok: false as const, reason: "changed" as const };
    queue.delete(id);
    return { ok: true as const, draft: found };
  });
  return queue;
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  storeWith(CONFIGURED);
  mockSend.mockResolvedValue({ messageId: "sent@example.com" });
  liveStore([...DRAFTS]);
  POST = (await import("@/app/setup-api/email/pending/route")).POST;
});

describe("only the owner may approve a batch", () => {
  it("refuses the MCP bearer, which is what the agent holds", async () => {
    // The whole point of the gate, restated for the new action: the agent can
    // queue drafts and can reach this route through middleware. It must not be
    // able to approve its own eight messages in one call.
    const res = await approve(entriesFor(DRAFTS), { bearer: "any-valid-looking-token" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
    expect(mockClaimIfUnchanged).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses a caller with no credential at all, identically", async () => {
    const bearer = await approve(entriesFor(DRAFTS), { bearer: "token" });
    const none = await approve(entriesFor(DRAFTS));
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual(await bearer.json());
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses a cookie from before the last password change", async () => {
    storeWith({ ...CONFIGURED, session_generation: 4 });
    const res = await approve(entriesFor(DRAFTS), { cookie: ownerCookie(3) });
    expect(res.status).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("one approval, every message", () => {
  it("sends all three on a single request", async () => {
    const res = await approve(entriesFor(DRAFTS), { cookie: ownerCookie() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, sent: 3, failed: 0 });
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(3);

    // What actually went on the wire is what the owner read.
    const subjects = mockSend.mock.calls.map((call) => call[1].subject);
    expect(subjects).toEqual(["Subject 1", "Subject 2", "Subject 3"]);
    expect(mockSend.mock.calls.map((call) => call[1].text)).toEqual(DRAFTS.map((d) => d.body));
    expect(mockSend.mock.calls.map((call) => call[1].to)).toEqual(DRAFTS.map((d) => d.to));
  });

  it("sends from the configured account, never from a caller-supplied sender", async () => {
    await approve(entriesFor(DRAFTS.slice(0, 1)), { cookie: ownerCookie() });
    expect(mockSend.mock.calls[0][1].from).toBe("box@example.com");
  });

  it("sends only the drafts still ticked when one was dropped from the batch", async () => {
    const kept = [DRAFTS[0], DRAFTS[2]];
    const res = await approve(entriesFor(kept), { cookie: ownerCookie() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: 2, failed: 0 });
    expect(mockSend.mock.calls.map((call) => call[1].subject)).toEqual(["Subject 1", "Subject 3"]);
    // The dropped one was not claimed, so it is still waiting in Settings.
    expect(mockClaimIfUnchanged.mock.calls.map((call) => call[0])).toEqual(["draft-1", "draft-3"]);
  });

  it("sends nothing at all when the owner cancels — there is no request", async () => {
    // Cancel is the absence of this call. The assertion that matters is that
    // no OTHER path can send a queued draft, so a batch route reached with an
    // empty list is refused rather than treated as "send everything waiting".
    const res = await approve([], { cookie: ownerCookie() });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockClaimIfUnchanged).not.toHaveBeenCalled();
  });

  it("refuses a batch that names the same draft twice", async () => {
    const entries = entriesFor([DRAFTS[0]]);
    const res = await approve([...entries, ...entries], { cookie: ownerCookie() });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses an entry with no fingerprint, so nothing unverifiable is sent", async () => {
    const res = await POST(
      request({
        cookie: ownerCookie(),
        body: { action: "approve_batch", drafts: [{ id: "draft-1" }] },
      }),
    );
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("what actually happened, per draft", () => {
  it("reports a partial failure as a partial failure, not as success", async () => {
    // The bug this is here to prevent has already shipped once in this
    // codebase, as `{ restarted: true }` for a restart that had failed.
    mockSend
      .mockResolvedValueOnce({ messageId: "one@example.com" })
      .mockRejectedValueOnce(new SmtpError("network", "The mail server refused the message."))
      .mockResolvedValueOnce({ messageId: "three@example.com" });

    const res = await approve(entriesFor(DRAFTS), { cookie: ownerCookie() });
    // 207, so a caller reading only the status line cannot mistake two of
    // three for everything.
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.sent).toBe(2);
    expect(body.failed).toBe(1);

    const failed = body.results.find((r: { ok: boolean }) => !r.ok);
    expect(failed).toMatchObject({ id: "draft-2", reason: "send_failed", kind: "network" });
    // The message is handed back, because claiming removed it from the queue —
    // nothing the owner approved is lost to a transient error.
    expect(failed.draft).toMatchObject({ subject: "Subject 2", body: "The body of message 2." });
  });

  it("keeps going after one failure instead of abandoning the rest", async () => {
    mockSend.mockRejectedValueOnce(new SmtpError("network", "nope"));
    const res = await approve(entriesFor(DRAFTS), { cookie: ownerCookie() });
    expect(res.status).toBe(207);
    expect(await res.json()).toMatchObject({ sent: 2, failed: 1 });
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("reports every draft when nothing could be sent", async () => {
    mockSend.mockRejectedValue(new SmtpError("auth", "nope"));
    const res = await approve(entriesFor(DRAFTS), { cookie: ownerCookie() });
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, sent: 0, failed: 3 });
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(["draft-1", "draft-2", "draft-3"]);
  });

  it("never leaks the recipient or the subject into the log", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    mockSend.mockRejectedValue(new SmtpError("network", "nope"));
    await approve(entriesFor(DRAFTS), { cookie: ownerCookie() });
    spy.mockRestore();

    const joined = logged.join("\n");
    expect(joined).not.toContain("person1@example.com");
    expect(joined).not.toContain("Subject 1");
    expect(joined).not.toContain("The body of message 1.");
  });

  it("says a draft is gone rather than sending something else in its place", async () => {
    const res = await approve(
      [{ id: "draft-404", fingerprint: "0".repeat(32) }],
      { cookie: ownerCookie() },
    );
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ ok: false, reason: "gone" });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("the batch is frozen at the moment it was shown", () => {
  it("does not send a draft the agent queued while the owner was reading", async () => {
    // Drawn from two...
    const shown = entriesFor([DRAFTS[0], DRAFTS[1]]);
    // ...and a third arrives during the pause the card introduces. This is the
    // #492 shape: state moving underneath a human-length dialog.
    liveStore([...DRAFTS]);

    const res = await approve(shown, { cookie: ownerCookie() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: 2, failed: 0 });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls.map((call) => call[1].subject)).toEqual(["Subject 1", "Subject 2"]);
    // The late one was never even looked at.
    expect(mockClaimIfUnchanged.mock.calls.map((call) => call[0])).not.toContain("draft-3");
  });

  it("refuses a draft whose text changed after it was shown", async () => {
    const shown = entriesFor([DRAFTS[0]]);
    // The same id, different words — what the owner read is no longer what is
    // on disk, so it must not go out under the consent he gave.
    liveStore([{ ...DRAFTS[0], body: "Wire the money to a different account." }]);

    const res = await approve(shown, { cookie: ownerCookie() });
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, sent: 0, failed: 1 });
    expect(body.results[0]).toMatchObject({ ok: false, reason: "changed" });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
