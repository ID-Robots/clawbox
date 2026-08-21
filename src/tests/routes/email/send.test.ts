import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", () => ({ get: vi.fn(), setMany: vi.fn() }));
vi.mock("@/lib/smtp-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/smtp-client")>("@/lib/smtp-client");
  return { ...actual, sendMail: vi.fn() };
});

import { get } from "@/lib/config-store";
import { sendMail, SmtpError } from "@/lib/smtp-client";

const mockGet = vi.mocked(get);
const mockSend = vi.mocked(sendMail);

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
