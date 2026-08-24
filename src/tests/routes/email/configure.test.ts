import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config-store", async (importOriginal) => ({
  // Spread the real module so DATA_DIR (used by the pending store, which the
  // email routes now reach) keeps its value.
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(),
  set: vi.fn(),
  setMany: vi.fn(),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/imap-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/imap-client")>("@/lib/imap-client");
  return { ...actual, verifyImap: vi.fn() };
});
vi.mock("@/lib/hermes-email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hermes-email")>("@/lib/hermes-email");
  return {
    wantsInbound: actual.wantsInbound,
    applyHermesEmail: vi.fn(),
    clearHermesEmail: vi.fn(),
    restartHermesForEmail: vi.fn(),
    stopHermesEmailPolling: vi.fn(),
  };
});
vi.mock("@/lib/smtp-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/smtp-client")>("@/lib/smtp-client");
  return { ...actual, verifySmtp: vi.fn() };
});

import { setMany } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  applyHermesEmail,
  clearHermesEmail,
  restartHermesForEmail,
  stopHermesEmailPolling,
} from "@/lib/hermes-email";
import { ImapError, verifyImap } from "@/lib/imap-client";
import { SmtpError, verifySmtp } from "@/lib/smtp-client";

const mockSetMany = vi.mocked(setMany);
const mockHarness = vi.mocked(getActiveHarness);
const mockVerify = vi.mocked(verifySmtp);
const mockVerifyImap = vi.mocked(verifyImap);
const mockApplyHermes = vi.mocked(applyHermesEmail);
const mockRestart = vi.mocked(restartHermesForEmail);
const mockStopPolling = vi.mocked(stopHermesEmailPolling);

let POST: typeof import("@/app/setup-api/email/configure/route").POST;
let DELETE: typeof import("@/app/setup-api/email/configure/route").DELETE;

const PASSWORD = "abcd efgh ijkl mnop";

function request(body: unknown): Request {
  return new Request("http://localhost/setup-api/email/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
  mockHarness.mockResolvedValue("openclaw");
  mockVerify.mockResolvedValue(undefined);
  mockVerifyImap.mockResolvedValue(undefined);
  mockApplyHermes.mockResolvedValue({ inbound: false });
  mockRestart.mockResolvedValue(true);
  mockStopPolling.mockResolvedValue("none-running");
  const mod = await import("@/app/setup-api/email/configure/route");
  POST = mod.POST;
  DELETE = mod.DELETE;
});

describe("POST /setup-api/email/configure", () => {
  it("rejects malformed JSON", async () => {
    const res = await POST(
      new Request("http://localhost/setup-api/email/configure", { method: "POST", body: "{" }),
    );
    expect(res.status).toBe(400);
    expect(mockSetMany).not.toHaveBeenCalled();
  });

  it("rejects a missing password before touching the network", async () => {
    const res = await POST(request({ address: "box@example.com" }));
    expect(res.status).toBe(400);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSetMany).not.toHaveBeenCalled();
  });

  it("does NOT save when the SMTP server rejects the credentials", async () => {
    mockVerify.mockRejectedValue(
      new SmtpError("auth", "The mail server rejected that address and password.", "535 5.7.8"),
    );
    const res = await POST(request({ address: "box@example.com", password: "wrong" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.kind).toBe("auth");
    // The whole point of verifying first: nothing is persisted.
    expect(mockSetMany).not.toHaveBeenCalled();
  });

  it("distinguishes a network failure from a wrong password", async () => {
    mockVerify.mockRejectedValue(new SmtpError("network", "Could not reach smtp.gmail.com on port 587."));
    const res = await POST(request({ address: "box@example.com", password: PASSWORD }));
    const data = await res.json();
    expect(data.kind).toBe("network");
  });

  it("never logs the password, on success or on failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockVerify.mockRejectedValueOnce(new SmtpError("auth", "rejected", "535"));
    await POST(request({ address: "box@example.com", password: PASSWORD }));
    mockVerify.mockResolvedValueOnce(undefined);
    await POST(request({ address: "box@example.com", password: PASSWORD }));

    const written = [...errorSpy.mock.calls, ...logSpy.mock.calls].flat().map(String).join(" ");
    expect(written).not.toContain(PASSWORD);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("saves once the server has accepted the credentials", async () => {
    const res = await POST(request({ address: "box@example.com", password: PASSWORD }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mockSetMany).toHaveBeenCalledTimes(1);
    const saved = mockSetMany.mock.calls[0][0];
    expect(saved.email_address).toBe("box@example.com");
    expect(saved.email_smtp_host).toBe("smtp.gmail.com");
    expect(saved.email_smtp_port).toBe(587);
  });

  it("hands the request's abort signal to the SMTP verify", async () => {
    // A user who navigates away mid-Connect should take the socket with them.
    await POST(request({ address: "box@example.com", password: PASSWORD }));
    expect(mockVerify.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports no inbound on OpenClaw even when the form asked for it", async () => {
    const res = await POST(
      request({
        address: "box@example.com",
        password: PASSWORD,
        imapHost: "imap.gmail.com",
        allowedSenders: "owner@example.com",
      }),
    );
    const data = await res.json();
    expect(data.inbound).toBe(false);
    expect(data.warning).toMatch(/Hermes/);
    expect(mockApplyHermes).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/email/configure — Hermes", () => {
  beforeEach(() => {
    mockHarness.mockResolvedValue("hermes");
  });

  it("wires the native adapter and restarts the gateway when inbound is requested", async () => {
    mockApplyHermes.mockResolvedValue({ inbound: true });
    const res = await POST(
      request({
        address: "box@example.com",
        password: PASSWORD,
        imapHost: "imap.gmail.com",
        allowedSenders: "owner@example.com",
      }),
    );
    const data = await res.json();
    expect(data).toMatchObject({ success: true, inbound: true, restarted: true });
    expect(mockRestart).toHaveBeenCalledTimes(1);
  });

  it("still reports success when the gateway will not come up", async () => {
    // The credentials are already on disk; a service failure is a warning.
    mockApplyHermes.mockResolvedValue({ inbound: true });
    mockRestart.mockRejectedValue(new Error("systemctl failed"));
    const res = await POST(
      request({
        address: "box@example.com",
        password: PASSWORD,
        imapHost: "imap.gmail.com",
        allowedSenders: "owner@example.com",
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, restarted: false });
    expect(data.warning).toBeTruthy();
  });

  // Turning inbound OFF is the case that used to be silently broken: the
  // EMAIL_* block was cleared but nothing restarted the gateway, so a running
  // adapter kept polling the old mailbox until something else restarted it.
  it("restarts a running gateway when inbound is turned off, so the adapter stops polling", async () => {
    mockApplyHermes.mockResolvedValue({ inbound: false });
    mockStopPolling.mockResolvedValue("stopped");
    const res = await POST(request({ address: "box@example.com", password: PASSWORD }));
    const data = await res.json();
    expect(data).toMatchObject({ success: true, inbound: false, restarted: true });
    expect(mockStopPolling).toHaveBeenCalledTimes(1);
    // ensureHermesGateway's wrapper INSTALLS a gateway; the off path must not.
    expect(mockRestart).not.toHaveBeenCalled();
  });
  it("warns instead of claiming a restart it could not perform", async () => {
    // A gateway running with no service unit behind it cannot be restarted
    // from a route handler, so it keeps the EMAIL_* values it loaded and goes
    // on receiving. Reporting `restarted` here would read as "it stopped".
    mockApplyHermes.mockResolvedValue({ inbound: false });
    mockStopPolling.mockResolvedValue("unmanaged");
    const res = await POST(request({ address: "box@example.com", password: PASSWORD }));
    const data = await res.json();
    expect(data.restarted).toBe(false);
    expect(data.warning).toMatch(/next gateway restart/i);
  });

  it("does not install a gateway on a device that never had one", async () => {
    mockApplyHermes.mockResolvedValue({ inbound: false });
    mockStopPolling.mockResolvedValue("none-running");
    const res = await POST(request({ address: "box@example.com", password: PASSWORD }));
    const data = await res.json();
    expect(data).toMatchObject({ success: true, inbound: false, restarted: false });
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("still saves when the gateway restart fails on the way out", async () => {
    mockApplyHermes.mockResolvedValue({ inbound: false });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockStopPolling.mockRejectedValue(new Error("systemctl failed"));
    const res = await POST(request({ address: "box@example.com", password: PASSWORD }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, inbound: false, restarted: false });
    expect(data.warning).toBeTruthy();
    errorSpy.mockRestore();
  });
});

describe("DELETE /setup-api/email/configure", () => {
  it("clears the stored credentials", async () => {
    const res = await DELETE(new Request("http://localhost/setup-api/email/configure", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(mockSetMany).toHaveBeenCalledTimes(1);
    const cleared = mockSetMany.mock.calls[0][0];
    expect(cleared.email_address).toBeUndefined();
    expect(cleared.email_password).toBeUndefined();
    expect(Object.keys(cleared)).toContain("email_password");
  });

  it("also tears down the Hermes adapter", async () => {
    mockHarness.mockResolvedValue("hermes");
    await DELETE(new Request("http://localhost/setup-api/email/configure", { method: "DELETE" }));
    expect(vi.mocked(clearHermesEmail)).toHaveBeenCalledTimes(1);
  });

  it("restarts a running gateway on disconnect without installing one", async () => {
    mockHarness.mockResolvedValue("hermes");
    await DELETE(new Request("http://localhost/setup-api/email/configure", { method: "DELETE" }));
    expect(mockStopPolling).toHaveBeenCalledTimes(1);
    expect(mockRestart).not.toHaveBeenCalled();
  });
});

// ── Proving the INCOMING server before saving it ────────────────────────────
//
// The same rule the outgoing side already keeps: a mode that says "the
// assistant may read my mail" and cannot open the mailbox would only be
// discovered the first time the owner asked it to look.

describe("POST /setup-api/email/configure — read modes", () => {
  const READ_BODY = {
    address: "box@example.com",
    password: "abcd efgh ijkl mnop",
    mode: "read",
  };

  it("checks the incoming server before writing anything", async () => {
    mockVerifyImap.mockRejectedValue(new ImapError("auth", "IMAP is switched off in Gmail."));
    const res = await POST(request(READ_BODY));
    expect(res.status).toBe(400);
    expect((await res.json()).kind).toBe("auth");
    expect(setMany).not.toHaveBeenCalled();
  });

  it("dials the host derived from the outgoing one", async () => {
    await POST(request(READ_BODY));
    expect(mockVerifyImap).toHaveBeenCalledTimes(1);
    expect(mockVerifyImap.mock.calls[0][0]).toMatchObject({ host: "imap.gmail.com", port: 993, secure: true });
  });

  it("uses an explicit incoming server when one is given", async () => {
    await POST(request({ ...READ_BODY, smtpHost: "smtp-mail.outlook.com", imapHost: "outlook.office365.com" }));
    expect(mockVerifyImap.mock.calls[0][0]).toMatchObject({ host: "outlook.office365.com" });
  });

  it("does not touch IMAP at all in send-only mode", async () => {
    // Nothing may open a mailbox, so there is nothing to prove.
    await POST(request({ ...READ_BODY, mode: "send" }));
    expect(mockVerifyImap).not.toHaveBeenCalled();
  });

  it("saves once both servers accept", async () => {
    const res = await POST(request(READ_BODY));
    expect(res.status).toBe(200);
    expect(setMany).toHaveBeenCalledWith(expect.objectContaining({ email_mode: "read" }));
  });
});
