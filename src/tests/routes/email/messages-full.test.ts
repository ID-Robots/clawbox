// /setup-api/email/messages?view=full — the OWNER's view of one message.
//
// The parsing is proven in src/tests/unit/email-mime.test.ts and the
// sanitising in email-html.test.ts. What matters HERE is the route's own
// promises: the same mode gate as every other read, one fetch of the message,
// nothing loaded from the network unless the request says the owner asked, and
// a response that no cache may keep.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", () => ({ get: vi.fn(), setMany: vi.fn() }));
vi.mock("@/lib/imap-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/imap-client")>("@/lib/imap-client");
  return { ...actual, listMessages: vi.fn(), readMessage: vi.fn(), readRawMessage: vi.fn() };
});
vi.mock("@/lib/email-image-fetch", () => ({ fetchRemoteImages: vi.fn() }));

import { get } from "@/lib/config-store";
import { readRawMessage } from "@/lib/imap-client";
import { fetchRemoteImages } from "@/lib/email-image-fetch";

const mockGet = vi.mocked(get);
const mockReadRaw = vi.mocked(readRawMessage);
const mockFetchImages = vi.mocked(fetchRemoteImages);

let GET: typeof import("@/app/setup-api/email/messages/route").GET;

const BASE: Record<string, unknown> = {
  email_address: "box@example.com",
  email_password: "abcd efgh ijkl mnop",
  email_smtp_host: "smtp.gmail.com",
  email_smtp_port: 587,
};
const READ_MODE = { ...BASE, email_mode: "read" };

const CRLF = "\r\n";
const mail = (...lines: string[]): string => lines.join(CRLF);

const TRACKED = mail(
  "From: Shop <shop@example.com>",
  "To: Owner <owner@example.com>",
  "Subject: Spring sale",
  "Date: Tue, 6 May 2025 08:15:00 +0000",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Hello</p><script>alert(1)</script><img src="https://tracker.example/p.gif?u=abc123">',
);

const RAW = {
  uid: 101,
  raw: TRACKED,
  unread: true,
  internalDate: "Tue, 6 May 2025 08:15:00 +0000",
  truncated: false,
};

function storeWith(values: Record<string, unknown>) {
  mockGet.mockImplementation(async (key: string) => values[key]);
}

const request = (query: string): Request =>
  new Request(`http://localhost/setup-api/email/messages${query}`);

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mockReadRaw.mockResolvedValue(RAW);
  mockFetchImages.mockResolvedValue(new Map());
  storeWith(READ_MODE);
  GET = (await import("@/app/setup-api/email/messages/route")).GET;
});

describe("the same gate as every other read", () => {
  it("refuses with 409 when no account is connected", async () => {
    storeWith({});
    const res = await GET(request("?uid=101&view=full"));
    expect(res.status).toBe(409);
    expect(mockReadRaw).not.toHaveBeenCalled();
  });

  it("refuses with 409 on a send-only device", async () => {
    storeWith(BASE);
    const res = await GET(request("?uid=101&view=full"));
    expect(res.status).toBe(409);
    expect((await res.json()).kind).toBe("mode");
    expect(mockReadRaw).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a message id", async () => {
    for (const uid of ["abc", "0", "-1", "1.5"]) {
      const res = await GET(request(`?uid=${uid}&view=full`));
      expect(res.status).toBe(400);
    }
    expect(mockReadRaw).not.toHaveBeenCalled();
  });
});

describe("the message it returns", () => {
  it("gives the header block parsed into names and addresses", async () => {
    const res = await GET(request("?uid=101&view=full"));
    expect(res.status).toBe(200);
    const { message } = await res.json();
    expect(message.from).toEqual({ name: "Shop", address: "shop@example.com" });
    expect(message.to).toEqual([{ name: "Owner", address: "owner@example.com" }]);
    expect(message.subject).toBe("Spring sale");
    expect(message.uid).toBe(101);
  });

  it("returns a sanitised node tree and no markup at all", async () => {
    const { message } = await (await GET(request("?uid=101&view=full"))).json();
    expect(message.format).toBe("html");
    expect(Array.isArray(message.body)).toBe(true);
    const dumped = JSON.stringify(message.body);
    expect(dumped).not.toContain("alert(1)");
    expect(dumped).not.toContain("<script");
  });

  it("reads the message once, not once per view", async () => {
    await GET(request("?uid=101&view=full"));
    expect(mockReadRaw).toHaveBeenCalledTimes(1);
  });

  it("is never cached, because it is the owner's mail", async () => {
    const res = await GET(request("?uid=101&view=full"));
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("leaves the agent's own view untouched", async () => {
    // Without `view=full` the route still answers with flattened text through
    // `readMessage`, which is what `email_read` consumes.
    const { readMessage } = await import("@/lib/imap-client");
    vi.mocked(readMessage).mockResolvedValue({
      uid: 101, from: "a@b.com", to: "box@example.com", subject: "Hi",
      date: "Mon, 01 Jan 2026", unread: true, text: "the body", truncated: false,
    });
    const { message } = await (await GET(request("?uid=101"))).json();
    expect(message.text).toBe("the body");
    expect(message.body).toBeUndefined();
  });
});

describe("remote images", () => {
  it("loads nothing and reports what it withheld", async () => {
    const { message } = await (await GET(request("?uid=101&view=full"))).json();
    expect(mockFetchImages).not.toHaveBeenCalled();
    expect(message.blockedImages).toBe(1);
    // The tracking URL must not reach the browser at all.
    expect(JSON.stringify(message)).not.toContain("abc123");
  });

  it("fetches them only when the request says the owner asked", async () => {
    mockFetchImages.mockResolvedValue(
      new Map([["https://tracker.example/p.gif?u=abc123", "data:image/png;base64,AAAA"]]),
    );
    const { message } = await (await GET(request("?uid=101&view=full&images=1"))).json();
    expect(mockFetchImages).toHaveBeenCalledTimes(1);
    expect(message.blockedImages).toBe(0);
    expect(JSON.stringify(message)).toContain("data:image/png;base64,AAAA");
  });

  it("hands the fetcher URLs from the MESSAGE, never from the query string", async () => {
    // This is what makes the image path a closed proxy rather than an open one:
    // there is no request shape that can aim it at an address of the caller's
    // choosing.
    await GET(request("?uid=101&view=full&images=1&src=http://127.0.0.1/admin"));
    expect(mockFetchImages).toHaveBeenCalledWith(["https://tracker.example/p.gif?u=abc123"]);
  });

  it("leaves an image blocked when the fetch came back with nothing", async () => {
    mockFetchImages.mockResolvedValue(new Map());
    const { message } = await (await GET(request("?uid=101&view=full&images=1"))).json();
    expect(message.blockedImages).toBe(1);
  });

  it("treats any value other than 1 as no consent", async () => {
    await GET(request("?uid=101&view=full&images=true"));
    await GET(request("?uid=101&view=full&images=0"));
    expect(mockFetchImages).not.toHaveBeenCalled();
  });
});
