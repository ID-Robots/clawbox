import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A refused ClawBox AI sign-in reaches the panel as a refusal it can act on.
 *
 * Found on a box: the configure route refused the device login's save (the
 * credential slot held another sign-in), and the panel stayed on
 * "Connecting…". The finaliser runs off the poll request that started it, so
 * the session file is the ONLY way its outcome reaches the client — the
 * sentence, and beside it the code and the profile the panel translates and
 * hangs the removal on. And that file must be written even when the first
 * write fails, or the client waits out a timeout that says the wrong thing.
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

import { readClawAiSession, writeClawAiSession, type ClawAiConnectSession } from "@/lib/clawai-connect";
import { POST as configurePost } from "@/app/setup-api/ai-models/configure/route";

const mockReadSession = vi.mocked(readClawAiSession);
const mockWriteSession = vi.mocked(writeClawAiSession);
const mockConfigure = vi.mocked(configurePost);

const REFUSAL =
  "This box already has your own DeepSeek API key saved in the credential slot ClawBox AI signs in to"
  + " (deepseek:default), and ClawBox does not replace a key you saved while it may still work.";

const PENDING = {
  device_id: "device-id-xyz",
  user_code: "ABCD-1234",
  status: "pending",
  createdAt: Date.now(),
  tier: "flash",
} as unknown as ClawAiConnectSession;

function refusedWith(body: Record<string, unknown>, status = 409) {
  mockConfigure.mockResolvedValue(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

/** The error sessions the finaliser wrote. */
function errorSessions() {
  return mockWriteSession.mock.calls
    .map(([session]) => session as ClawAiConnectSession)
    .filter((session) => session.status === "error");
}

/** Drive the poll to the point where it finalises a claimed session, and let the finaliser finish. */
async function finalise() {
  mockReadSession.mockResolvedValue(PENDING);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ status: "complete", access_token: "claw_FAKE-device-code-token" }),
    { status: 200 },
  )));
  const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
  await POST();
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  // The retry of a failed session write waits a quarter second.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

describe("a refused ClawBox AI sign-in reaches the panel", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockWriteSession.mockResolvedValue(undefined as never);
  });

  it("records the refusal's code and profile beside its sentence", async () => {
    refusedWith({ error: REFUSAL, code: "clawai_slot_owner_key", profileId: "deepseek:default" });

    await finalise();

    expect(errorSessions().at(-1)).toMatchObject({
      status: "error",
      error: REFUSAL,
      errorCode: "clawai_slot_owner_key",
      errorProfileId: "deepseek:default",
    });
  });

  it("answers the next poll with the sentence, the code and the profile", async () => {
    mockReadSession.mockResolvedValue({
      ...PENDING,
      status: "error",
      error: REFUSAL,
      errorCode: "clawai_slot_owner_key",
      errorProfileId: "deepseek:default",
    });
    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");

    const res = await POST();

    expect(await res.json()).toEqual({
      status: "error",
      error: REFUSAL,
      code: "clawai_slot_owner_key",
      profileId: "deepseek:default",
    });
  });

  it("answers an error without a code exactly as before", async () => {
    mockReadSession.mockResolvedValue({ ...PENDING, status: "error", error: REFUSAL });
    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");

    expect(await (await POST()).json()).toEqual({ status: "error", error: REFUSAL });
  });

  it("relays no code or profile that is not one", async () => {
    refusedWith({ error: REFUSAL, code: "<script>", profileId: "/home/someone/.openclaw" }, 500);

    await finalise();

    expect(errorSessions().at(-1)).toMatchObject({ error: REFUSAL, errorCode: null, errorProfileId: null });
  });

  it("writes the outcome again when the first write fails, so the panel never waits on a session that says configuring", async () => {
    refusedWith({ error: REFUSAL, code: "clawai_slot_conflict", profileId: "deepseek:default" });
    let failedOnce = false;
    mockWriteSession.mockImplementation(async (session) => {
      if ((session as ClawAiConnectSession).status === "error" && !failedOnce) {
        failedOnce = true;
        throw new Error("EBUSY");
      }
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await finalise();

    expect(errorSessions()).toHaveLength(2);
    expect(errorSessions()[1]).toMatchObject({ errorCode: "clawai_slot_conflict" });
  });
});
