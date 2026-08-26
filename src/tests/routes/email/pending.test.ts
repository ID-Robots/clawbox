// /setup-api/email/pending — the approval gate.
//
// The authorization tests here are the point of the whole feature, so they run
// against the REAL session verification (a real HMAC cookie, a real generation
// check) rather than a mocked `hasOwnerSession`. Mocking the gate would leave
// the one thing that must hold — "the agent's own token does not open this
// door" — asserted by the mock rather than by the code.
//
// Why that matters: src/middleware.ts admits callers to /setup-api/* on EITHER
// a session cookie OR the MCP bearer, and the agent holds the bearer. A route
// that trusted middleware here would let a prompt-injected agent queue a draft
// and approve it on the next tool call.

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
  // The fingerprint helper is pure and is what the route compares against, so
  // it stays REAL: a mocked one would let a freeze test pass while the check it
  // is testing did nothing.
  ...(await importOriginal<typeof import("@/lib/email-pending")>()),
  listPending: vi.fn(),
  claimPending: vi.fn(),
  claimPendingIfUnchanged: vi.fn(),
  removePending: vi.fn(),
}));

import { createSessionCookie } from "@/lib/auth";
import { get } from "@/lib/config-store";
import { claimPending, draftFingerprint, listPending, removePending } from "@/lib/email-pending";
import { sendMail, SmtpError } from "@/lib/smtp-client";

const mockGet = vi.mocked(get);
const mockSend = vi.mocked(sendMail);
const mockList = vi.mocked(listPending);
const mockClaim = vi.mocked(claimPending);
const mockRemove = vi.mocked(removePending);

let GET: typeof import("@/app/setup-api/email/pending/route").GET;
let POST: typeof import("@/app/setup-api/email/pending/route").POST;

const SESSION_SECRET = "a".repeat(64);

const CONFIGURED: Record<string, unknown> = {
  email_address: "box@example.com",
  email_password: "abcd efgh ijkl mnop",
  email_smtp_host: "smtp.gmail.com",
  email_smtp_port: 587,
};

const DRAFT = {
  id: "draft-1",
  to: ["owner@example.com"],
  subject: "Hello",
  body: "The message body.",
  createdAt: 1_700_000_000_000,
};

function storeWith(values: Record<string, unknown>) {
  mockGet.mockImplementation(async (key: string) => values[key]);
}

/** A cookie the real verifier accepts. */
function ownerCookie(gen = 0): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, gen)}`;
}

function request(init: { cookie?: string; bearer?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new Request("http://localhost/setup-api/email/pending", {
    method: init.body === undefined ? "GET" : "POST",
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  storeWith(CONFIGURED);
  mockList.mockReturnValue([{ ...DRAFT, preview: "The message body.", fingerprint: draftFingerprint(DRAFT) }]);
  mockClaim.mockReturnValue(DRAFT);
  mockRemove.mockReturnValue(true);
  mockSend.mockResolvedValue({ messageId: "sent@example.com" });
  const route = await import("@/app/setup-api/email/pending/route");
  GET = route.GET;
  POST = route.POST;
});

describe("who may reach the approval queue", () => {
  it("refuses a caller with no session at all", async () => {
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("refuses the MCP bearer, which is what the agent holds", async () => {
    // This is the whole gate. Middleware would have let this request through;
    // the route must not.
    const res = await POST(request({ bearer: "any-valid-looking-token", body: { action: "approve", id: "draft-1" } }));
    expect(res.status).toBe(403);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses a forged cookie", async () => {
    const res = await GET(request({ cookie: "clawbox_session=not.a.real.signature" }));
    expect(res.status).toBe(403);
  });

  it("refuses a cookie from before the last password change", async () => {
    // Session revocation has to reach this route too, or a stolen cookie would
    // keep approving mail after the owner changed their password.
    storeWith({ ...CONFIGURED, session_generation: 4 });
    const res = await GET(request({ cookie: ownerCookie(3) }));
    expect(res.status).toBe(403);
  });

  it("refuses an expired cookie", async () => {
    const expired = createSessionCookie(-60, SESSION_SECRET, 0);
    const res = await GET(request({ cookie: `clawbox_session=${expired}` }));
    expect(res.status).toBe(403);
  });

  it("lets the owner's own browser through", async () => {
    const res = await GET(request({ cookie: ownerCookie() }));
    expect(res.status).toBe(200);
    expect((await res.json()).pending).toHaveLength(1);
  });

  it("gives the same refusal whichever credential was wrong", async () => {
    // "Your token works elsewhere but not here" is a hint worth not giving.
    const noCreds = await GET(request());
    const bearer = await GET(request({ bearer: "token" }));
    expect(await noCreds.json()).toEqual(await bearer.json());
  });
});

describe("approve", () => {
  it("sends the draft through the normal SMTP path", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { action: "approve", id: "draft-1" } }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, approved: true, messageId: "sent@example.com" });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [cfg, message] = mockSend.mock.calls[0];
    expect(cfg).toMatchObject({ host: "smtp.gmail.com", user: "box@example.com" });
    expect(message).toMatchObject({
      from: "box@example.com",
      to: ["owner@example.com"],
      subject: "Hello",
      text: "The message body.",
    });
  });

  it("claims the draft before sending, so a double click cannot send twice", async () => {
    mockClaim.mockReturnValueOnce(DRAFT).mockReturnValueOnce(null);
    const first = await POST(request({ cookie: ownerCookie(), body: { action: "approve", id: "draft-1" } }));
    const second = await POST(request({ cookie: ownerCookie(), body: { action: "approve", id: "draft-1" } }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("hands the message back when the send fails, so nothing is lost", async () => {
    mockSend.mockRejectedValueOnce(new SmtpError("blocked", "The mail server refused the message."));
    const res = await POST(request({ cookie: ownerCookie(), body: { action: "approve", id: "draft-1" } }));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.kind).toBe("blocked");
    expect(data.draft).toMatchObject({ subject: "Hello", body: "The message body." });
  });

  it("refuses when the account has been disconnected meanwhile", async () => {
    storeWith({});
    const res = await POST(request({ cookie: ownerCookie(), body: { action: "approve", id: "draft-1" } }));
    expect(res.status).toBe(409);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("404s an id that is no longer waiting", async () => {
    mockClaim.mockReturnValue(null);
    const res = await POST(request({ cookie: ownerCookie(), body: { action: "approve", id: "gone" } }));
    expect(res.status).toBe(404);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("reject", () => {
  it("deletes the draft without sending anything", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { action: "reject", id: "draft-1" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).rejected).toBe(true);
    expect(mockRemove).toHaveBeenCalledWith("draft-1");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("404s an id that is no longer waiting", async () => {
    mockRemove.mockReturnValue(false);
    const res = await POST(request({ cookie: ownerCookie(), body: { action: "reject", id: "gone" } }));
    expect(res.status).toBe(404);
  });
});

describe("bad requests", () => {
  it("rejects an unknown action", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { action: "send-it-anyway", id: "draft-1" } }));
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("requires an id", async () => {
    const res = await POST(request({ cookie: ownerCookie(), body: { action: "approve" } }));
    expect(res.status).toBe(400);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await POST(
      new Request("http://localhost/setup-api/email/pending", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: ownerCookie() },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("checks the session before it looks at the body", async () => {
    const res = await POST(
      new Request("http://localhost/setup-api/email/pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(403);
  });
});
