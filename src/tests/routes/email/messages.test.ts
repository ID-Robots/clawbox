// /setup-api/email/messages — the backend behind email_list and email_read.
//
// The IMAP client itself is proven against a real socket in
// src/tests/unit/imap-client.test.ts; what matters here is the GATE. Reading is
// off unless the owner turned it on, and this route must say so in a way the
// MCP tool turns into "stop and tell the user" rather than a retry loop.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", () => ({ get: vi.fn(), setMany: vi.fn() }));
vi.mock("@/lib/imap-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/imap-client")>("@/lib/imap-client");
  return { ...actual, listMessages: vi.fn(), readMessage: vi.fn() };
});

import { get } from "@/lib/config-store";
import { ImapError, listMessages, readMessage } from "@/lib/imap-client";

const mockGet = vi.mocked(get);
const mockList = vi.mocked(listMessages);
const mockRead = vi.mocked(readMessage);

let GET: typeof import("@/app/setup-api/email/messages/route").GET;

const BASE: Record<string, unknown> = {
  email_address: "box@example.com",
  email_password: "abcd efgh ijkl mnop",
  email_smtp_host: "smtp.gmail.com",
  email_smtp_port: 587,
};

const READ_MODE = { ...BASE, email_mode: "read" };

const LISTING = {
  mailbox: "INBOX",
  total: 42,
  unseen: 3,
  messages: [{ uid: 101, from: "a@b.com", subject: "Hi", date: "Mon, 01 Jan 2026", unread: true }],
};

const MESSAGE = {
  uid: 101,
  from: "a@b.com",
  to: "box@example.com",
  subject: "Hi",
  date: "Mon, 01 Jan 2026",
  unread: true,
  text: "the body",
  truncated: false,
};

function storeWith(values: Record<string, unknown>) {
  mockGet.mockImplementation(async (key: string) => values[key]);
}

function request(query = ""): Request {
  return new Request(`http://localhost/setup-api/email/messages${query}`);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockList.mockResolvedValue(LISTING);
  mockRead.mockResolvedValue(MESSAGE);
  storeWith(READ_MODE);
  GET = (await import("@/app/setup-api/email/messages/route")).GET;
});

describe("the mode gate", () => {
  it("refuses with 409 when no account is connected", async () => {
    storeWith({});
    const res = await GET(request());
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("unconfigured");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("refuses with 409 on a send-only device", async () => {
    // 409 is what the MCP tool turns into a "tell the user how to switch it on"
    // instruction instead of a retry.
    storeWith(BASE);
    const res = await GET(request());
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.kind).toBe("mode");
    expect(data.error).toMatch(/Read on demand/i);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("allows read mode", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("allows answer mode too, which already opens the mailbox", async () => {
    storeWith({ ...BASE, email_mode: "answer", email_allowed_senders: ["a@b.com"] });
    const res = await GET(request());
    expect(res.status).toBe(200);
  });

  it("allows a legacy inbound account, which migrates to answer", async () => {
    storeWith({ ...BASE, email_imap_host: "imap.gmail.com", email_allowed_senders: ["a@b.com"] });
    const res = await GET(request());
    expect(res.status).toBe(200);
  });
});

describe("listing", () => {
  it("returns the mailbox counts and the messages", async () => {
    const res = await GET(request("?limit=5"));
    expect(await res.json()).toMatchObject({ total: 42, unseen: 3 });
    expect(mockList).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: 5 }));
  });

  it("defaults to ten", async () => {
    await GET(request());
    expect(mockList).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: 10 }));
  });

  it("rejects a limit outside the allowed range", async () => {
    for (const q of ["?limit=0", "?limit=500", "?limit=abc"]) {
      const res = await GET(request(q));
      expect(res.status, q).toBe(400);
    }
    expect(mockList).not.toHaveBeenCalled();
  });

  it("dials the host derived from the SMTP one", async () => {
    await GET(request());
    expect(mockList.mock.calls[0][0]).toMatchObject({ host: "imap.gmail.com", port: 993, secure: true });
  });

  it("prefers an explicit incoming server", async () => {
    storeWith({ ...READ_MODE, email_imap_host: "outlook.office365.com" });
    await GET(request());
    expect(mockList.mock.calls[0][0]).toMatchObject({ host: "outlook.office365.com" });
  });
});

describe("reading one message", () => {
  it("returns the message when given a uid", async () => {
    const res = await GET(request("?uid=101"));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatchObject({ uid: 101, text: "the body" });
    expect(mockRead).toHaveBeenCalledWith(expect.anything(), 101, expect.anything());
    expect(mockList).not.toHaveBeenCalled();
  });

  it("rejects a uid that is not a positive integer", async () => {
    for (const q of ["?uid=0", "?uid=-3", "?uid=abc", "?uid=1.5"]) {
      const res = await GET(request(q));
      expect(res.status, q).toBe(400);
    }
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it("maps a rejected sign-in to 401", async () => {
    mockList.mockRejectedValueOnce(new ImapError("auth", "rejected"));
    expect((await GET(request())).status).toBe(401);
  });

  it("maps a missing message to 404", async () => {
    mockRead.mockRejectedValueOnce(new ImapError("mailbox", "no such message"));
    expect((await GET(request("?uid=9"))).status).toBe(404);
  });

  it("maps everything else to 502", async () => {
    mockList.mockRejectedValueOnce(new ImapError("network", "unreachable"));
    expect((await GET(request())).status).toBe(502);
  });

  it("never puts the owner's mail in the response of a failure", async () => {
    mockList.mockRejectedValueOnce(new Error("Subject: something private"));
    const res = await GET(request());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("something private");
  });
});
