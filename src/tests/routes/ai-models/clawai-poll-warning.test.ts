import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ClawBox AI sign-in that SUCCEEDED but could not do all of it must say so.
 *
 * The device-code finaliser calls `/setup-api/ai-models/configure` in-process
 * and read only `response.ok` from it, dropping the body — so the one warning
 * this path can produce (the deferred session sweep: ClawBox AI is a
 * `subscription` save, which takes the doctor stop) reached nobody. Settings
 * renders `saveWarning`, and the ClawBox AI login is the primary sign-in on
 * these boxes, so the path most likely to produce the sentence was the one
 * that could not show it.
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
const SWEEP_WARNING =
  "Saved, but a chat that was already open keeps its previous model — pick the model again in its header.";

/** The session record this finaliser wrote once the configure landed. */
function completedSession(): { status?: string; warning?: unknown } | undefined {
  return mockWriteSession.mock.calls
    .map(([session]) => session as { status?: string; warning?: unknown })
    .filter((session) => session.status === "complete")
    .at(-1);
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

describe("the device-code finaliser carries the configure's warning", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockWriteSession.mockResolvedValue(undefined as never);
  });

  it("records the warning a successful configure answered with", async () => {
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ success: true, warning: SWEEP_WARNING }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    expect(completedSession()?.warning).toBe(SWEEP_WARNING);
  });

  it("records no warning when there was none", async () => {
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    expect(completedSession()?.warning).toBeNull();
  });

  it("answers the warning to the poll that is waiting on it", async () => {
    mockReadSession.mockResolvedValue({
      device_id: "device-id-xyz",
      user_code: "ABCD-1234",
      status: "complete",
      createdAt: Date.now(),
      warning: SWEEP_WARNING,
    } as never);

    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const body = await (await POST()).json();

    expect(body).toEqual({ status: "complete", warning: SWEEP_WARNING });
  });

  it("answers a plain complete when the save had nothing to warn about", async () => {
    mockReadSession.mockResolvedValue({
      device_id: "device-id-xyz",
      user_code: "ABCD-1234",
      status: "complete",
      createdAt: Date.now(),
    } as never);

    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const body = await (await POST()).json();

    expect(body).toEqual({ status: "complete" });
  });
});
