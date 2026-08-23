import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", () => ({ get: vi.fn(), setMany: vi.fn() }));
vi.mock("@/lib/email-pending", () => ({ queuePending: vi.fn() }));
vi.mock("@/lib/email-notify", () => ({ notifyOwner: vi.fn() }));
vi.mock("@/lib/smtp-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/smtp-client")>("@/lib/smtp-client");
  return { ...actual, sendMail: vi.fn() };
});

import { get } from "@/lib/config-store";
import { notifyOwner } from "@/lib/email-notify";
import { queuePending } from "@/lib/email-pending";
import { sendMail, SmtpError } from "@/lib/smtp-client";

const mockGet = vi.mocked(get);
const mockSend = vi.mocked(sendMail);
const mockQueue = vi.mocked(queuePending);
const mockNotify = vi.mocked(notifyOwner);

let POST: typeof import("@/app/setup-api/email/send/route").POST;
let TEST_POST: typeof import("@/app/setup-api/email/test/route").POST;

const PASSWORD = "abcd efgh ijkl mnop";
const CONFIGURED: Record<string, unknown> = {
  email_address: "box@example.com",
  email_password: PASSWORD,
  email_smtp_host: "smtp.gmail.com",
  email_smtp_port: 587,
};

function storeWith(values: Record<string, unknown>) {
  mockGet.mockImplementation(async (key: string) => values[key]);
}

function sendRequest(body: unknown): Request {
  return new Request("http://localhost/setup-api/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { to: "owner@example.com", subject: "Hello", body: "Text" };

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
  mockSend.mockResolvedValue({ messageId: "abc@example.com" });
  mockNotify.mockResolvedValue(undefined);
  mockQueue.mockReturnValue({
    ok: true,
    draft: { id: "draft-1", to: ["owner@example.com"], subject: "Hello", body: "Text", createdAt: 0 },
  });
  storeWith(CONFIGURED);
  POST = (await import("@/app/setup-api/email/send/route")).POST;
  TEST_POST = (await import("@/app/setup-api/email/test/route")).POST;
});

describe("POST /setup-api/email/send", () => {
  it("refuses with 409 when no account is connected", async () => {
    storeWith({});
    const res = await POST(sendRequest(VALID_BODY));
    // 409 is what the MCP tool turns into a "tell the user to set it up"
    // instruction rather than a retry.
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.kind).toBe("unconfigured");
    expect(data.error).toMatch(/Settings/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends to the configured account's recipients", async () => {
    const res = await POST(sendRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    const [config, message] = mockSend.mock.calls[0];
    expect(config.host).toBe("smtp.gmail.com");
    expect(message.from).toBe("box@example.com");
    expect(message.to).toEqual(["owner@example.com"]);
  });

  it("splits several recipients", async () => {
    await POST(sendRequest({ ...VALID_BODY, to: "a@example.com, b@example.com" }));
    expect(mockSend.mock.calls[0][1].to).toEqual(["a@example.com", "b@example.com"]);
  });

  it.each([
    [{ ...VALID_BODY, to: "" }, /recipient is required/i],
    [{ ...VALID_BODY, to: "not-an-address" }, /valid email address/i],
    [{ ...VALID_BODY, subject: "" }, /subject is required/i],
    [{ ...VALID_BODY, subject: "a\r\nBcc: victim@example.com" }, /line breaks/i],
    [{ ...VALID_BODY, body: "" }, /body is required/i],
  ])("rejects %j", async (body, expected) => {
    const res = await POST(sendRequest(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(expected);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns 502 with a classified reason when the server refuses", async () => {
    mockSend.mockRejectedValue(new SmtpError("blocked", "The mail server refused the message."));
    const res = await POST(sendRequest(VALID_BODY));
    expect(res.status).toBe(502);
    expect((await res.json()).kind).toBe("blocked");
  });

  // CONTAINMENT. There is no approval prompt in front of this route: ClawBox
  // registers its MCP server with `trust: full` because a headless one-shot
  // agent turn has nobody to answer one. The hourly budget is what bounds a
  // prompt-injected or looping agent, so it is a behaviour, not a nicety.
  it("stops the agent once the hourly send budget is spent", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) {
      expect((await POST(sendRequest(VALID_BODY))).status).toBe(200);
    }
    const res = await POST(sendRequest(VALID_BODY));
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.kind).toBe("rate_limited");
    // The sixth message was never handed to the SMTP client.
    expect(mockSend).toHaveBeenCalledTimes(5);
    errorSpy.mockRestore();
  });

  it("does not spend the budget on a device with no account connected", async () => {
    // A 409 costs nothing, so an agent that keeps asking on an unconfigured box
    // cannot burn the owner's budget before the owner has one.
    storeWith({});
    for (let i = 0; i < 8; i++) {
      expect((await POST(sendRequest(VALID_BODY))).status).toBe(409);
    }
    storeWith(CONFIGURED);
    expect((await POST(sendRequest(VALID_BODY))).status).toBe(200);
  });

  it("leaves the owner's own test email outside the agent's budget", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) await POST(sendRequest(VALID_BODY));
    expect((await POST(sendRequest(VALID_BODY))).status).toBe(429);
    // The person at the keyboard must still be able to prove the account works.
    expect((await TEST_POST()).status).toBe(200);
    errorSpy.mockRestore();
  });

  it("never logs the password", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSend.mockRejectedValue(new SmtpError("network", "gone"));
    await POST(sendRequest(VALID_BODY));
    expect(errorSpy.mock.calls.flat().map(String).join(" ")).not.toContain(PASSWORD);
    errorSpy.mockRestore();
  });
});

describe("POST /setup-api/email/test", () => {
  it("refuses when nothing is configured", async () => {
    storeWith({});
    const res = await TEST_POST();
    expect(res.status).toBe(400);
    expect((await res.json()).kind).toBe("unconfigured");
  });

  it("sends to the device's own address, never to a caller-supplied one", async () => {
    const res = await TEST_POST();
    expect(res.status).toBe(200);
    const message = mockSend.mock.calls[0][1];
    expect(message.to).toEqual(["box@example.com"]);
    expect(message.subject).toBe("ClawBox test email");
  });

  it("reports a wrong password as an auth failure the user can act on", async () => {
    mockSend.mockRejectedValue(
      new SmtpError("auth", "The mail server rejected that address and password."),
    );
    const res = await TEST_POST();
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.kind).toBe("auth");
    expect(data.error).toMatch(/rejected/i);
  });
});

// ── The approval gate ────────────────────────────────────────────────────────
//
// The difference between the send budget and this: the budget bounds a runaway,
// it cannot stop the first message. With the gate on, nothing reaches the SMTP
// client at all.

describe("ask me before sending", () => {
  const GATED = { ...CONFIGURED, email_ask_before_send: true };

  it("does not send — it queues", async () => {
    storeWith(GATED);
    const res = await POST(sendRequest(VALID_BODY));
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, queued: true, pendingId: "draft-1" });
    // The whole point.
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockQueue).toHaveBeenCalledWith({
      to: ["owner@example.com"],
      subject: "Hello",
      body: "Text",
    });
  });

  it("tells the owner something is waiting", async () => {
    storeWith(GATED);
    await POST(sendRequest(VALID_BODY));
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it("still queues when the desktop notification fails", async () => {
    // A notice that does not appear must not turn a queued draft into a failed
    // send.
    storeWith(GATED);
    mockNotify.mockRejectedValueOnce(new Error("no desktop"));
    const res = await POST(sendRequest(VALID_BODY));
    expect(res.status).toBe(202);
  });

  it("never puts the message on the wire when the queue is full", async () => {
    storeWith(GATED);
    mockQueue.mockReturnValue({ ok: false, reason: "full", error: "20 messages are already waiting" });
    const res = await POST(sendRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expect((await res.json()).kind).toBe("queue_full");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("validates the message before queueing it", async () => {
    storeWith(GATED);
    const res = await POST(sendRequest({ ...VALID_BODY, to: "not-an-address" }));
    expect(res.status).toBe(400);
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it("refuses before queueing when nothing is configured", async () => {
    storeWith({});
    const res = await POST(sendRequest(VALID_BODY));
    expect(res.status).toBe(409);
    expect(mockQueue).not.toHaveBeenCalled();
  });
});

describe("with the gate off", () => {
  it("sends straight away, as an account configured before the gate does", async () => {
    // MIGRATION: no email_ask_before_send key at all is an existing account,
    // and it must keep behaving exactly as it did.
    storeWith(CONFIGURED);
    const res = await POST(sendRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect((await res.json())).toMatchObject({ queued: false, messageId: "abc@example.com" });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it("sends when the gate is explicitly off", async () => {
    storeWith({ ...CONFIGURED, email_ask_before_send: false });
    const res = await POST(sendRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
