import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The device-code finaliser must relay a SENTENCE, never a response body.
 *
 * What a real box put on the setup wizard when a ClawBox AI sign-in failed its
 * credential migration, verbatim and including the braces:
 *
 *     {"error":"Credential migration failed. The subscription sign-in was
 *     rolled back — try again, or run 'openclaw doctor --fix' from the
 *     Terminal."}
 *
 * This route is where that happened. It calls `/setup-api/ai-models/configure`
 * in-process and read the failure with `.text()`, then stored the whole string
 * as the session's error — which the wizard renders as the status message. The
 * route's own `readErrorBody` had always done the right thing; the configure
 * branch simply did not use it.
 */

vi.mock("@/lib/clawai-connect", () => ({
  createClawAiUserCode: vi.fn(() => "ABCD-1234"),
  createClawAiDeviceId: vi.fn(() => "device-id-xyz"),
  CLAWAI_USER_CODE_LENGTH: 8,
  writeClawAiSession: vi.fn(),
  readClawAiSession: vi.fn(),
  clearClawAiSession: vi.fn(),
  isClawAiSessionExpired: vi.fn(() => false),
}));
vi.mock("@/app/setup-api/ai-models/configure/route", () => ({ POST: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/hermes-clawai", () => ({
  applyClawaiToHermes: vi.fn(async () => ({})),
  ClawaiApplyError: class ClawaiApplyError extends Error {},
}));
vi.mock("@/lib/clawbox-ai-portal-tier", () => ({ fetchPortalTier: vi.fn() }));

import { readClawAiSession, writeClawAiSession } from "@/lib/clawai-connect";
import { POST as configurePost } from "@/app/setup-api/ai-models/configure/route";

const mockReadSession = vi.mocked(readClawAiSession);
const mockWriteSession = vi.mocked(writeClawAiSession);
const mockConfigure = vi.mocked(configurePost);

const TOKEN = "claw_device_code_token";

const ROLLED_BACK =
  "Credential migration failed. The subscription sign-in was rolled back — try again,"
  + " or run 'openclaw doctor --fix' from the Terminal.";

/** The error this finaliser wrote onto the session, which the wizard renders. */
function sessionError(): unknown {
  const written = mockWriteSession.mock.calls
    .map(([session]) => session as { status?: string; error?: unknown })
    .filter((session) => session.status === "error");
  return written.at(-1)?.error;
}

/** Drive the poll to the point where it finalises a claimed session. */
async function finalise() {
  mockReadSession.mockResolvedValue({
    device_id: "device-id-xyz",
    user_code: "ABCD-1234",
    status: "pending",
    createdAt: Date.now(),
    tier: "flash",
  } as never);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ status: "complete", access_token: TOKEN }),
    { status: 200 },
  )));
  const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
  await POST();
  // The finalise runs off the request lifecycle; let its microtasks drain.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the device-code finaliser never stores a raw response body", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockWriteSession.mockResolvedValue(undefined as never);
  });

  it("stores the sentence out of a failed configure, not its JSON", async () => {
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ error: ROLLED_BACK }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    expect(sessionError()).toBe(ROLLED_BACK);
  });

  it("stores nothing that still looks like a body", async () => {
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ error: ROLLED_BACK }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    const stored = sessionError();
    expect(typeof stored).toBe("string");
    expect(stored as string).not.toContain("{");
    expect(stored as string).not.toContain('"error"');
  });

  it("relays the new service-ownership sentence intact", async () => {
    // The sign-in's other rollback message, and the one this device's owner
    // actually met. It must arrive whole — it names the step they can take.
    const ownership =
      "Credential migration could not start: this device's OpenClaw could not confirm that ClawBox"
      + " manages the gateway service, so the subscription sign-in was rolled back. Restart the device"
      + " and sign in again. If it is refused again, install the latest device update — older OpenClaw"
      + " versions cannot be told that ClawBox owns the gateway.";
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ error: ownership }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    expect(sessionError()).toBe(ownership);
  });

  it("falls back to its own sentence when the body carries none", async () => {
    // A body shaped in a way nothing here understands is worth nothing to the
    // owner; showing it anyway is how the braces reached the screen.
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ trace: ["step-9"], status: 502 }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    expect(sessionError()).toBe("Failed to save ClawBox AI token.");
  });

  it("falls back when the failure had no body at all", async () => {
    mockConfigure.mockResolvedValue(new Response("", { status: 502 }));

    await finalise();

    expect(sessionError()).toBe("Failed to save ClawBox AI token.");
  });

  it("keeps the token-limit rewrite working through the new reader", async () => {
    // `formatUserFacingError` still runs on what comes out, and its one rewrite
    // is keyed on a phrase that used to arrive inside the JSON.
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ error: "Token limit reached for this account." }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    expect(sessionError()).toContain("reached its token limit");
  });

  it("keeps the RAW body in the journal while the owner gets the sentence", async () => {
    // The two readers want different things. Sparing the owner the braces must
    // not spare the operator the evidence: a body whose shape the humaniser
    // does not recognise reduces to "", and logging that would have left
    // `Token save failed 502` and nothing else on a box nobody can reach.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = JSON.stringify({ code: 500, trace: ["step-9"] });
    mockConfigure.mockResolvedValue(new Response(
      body,
      { status: 502, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    expect(sessionError()).toBe("Failed to save ClawBox AI token.");
    const said = logged.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(said).toContain("Token save failed");
    expect(said).toContain(body);
    logged.mockRestore();
  });

  it("leaves a successful configure alone", async () => {
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    expect(sessionError()).toBeUndefined();
    const statuses = mockWriteSession.mock.calls
      .map(([session]) => (session as { status?: string }).status);
    expect(statuses).toContain("complete");
  });
});
