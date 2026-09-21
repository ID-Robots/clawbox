import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-744, on the device-code finaliser's HERMES branch.
 *
 * `/setup-api/ai-models/clawai/poll` is the primary link path on both editions.
 * On OpenClaw it hands over to `/setup-api/ai-models/configure`, which asks the
 * portal and records the plan; on Hermes it calls `applyClawaiToHermes`
 * directly, and that helper only records what its caller passes. Without a
 * lookup here the two editions' own device-code flows disagreed, and a Hermes
 * box finished the link with NO plan on record — so no withdrawal was reachable
 * on it at all until a BROWSER happened to poll the status route.
 *
 * Its own file rather than a describe inside `clawai-connect.test.ts`: this one
 * has to mock `@/lib/harness` and `@/lib/hermes-clawai`, and that file's other
 * cases deliberately take the OpenClaw branch.
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
vi.mock("@/app/setup-api/ai-models/configure/route", () => ({
  POST: vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
vi.mock("@/lib/hermes-clawai", () => ({
  applyClawaiToHermes: vi.fn(async () => ({})),
  ClawaiApplyError: class ClawaiApplyError extends Error {},
}));
vi.mock("@/lib/clawbox-ai-portal-tier", () => ({ fetchPortalTier: vi.fn() }));

import { readClawAiSession, writeClawAiSession } from "@/lib/clawai-connect";
import { applyClawaiToHermes } from "@/lib/hermes-clawai";
import { fetchPortalTier } from "@/lib/clawbox-ai-portal-tier";

const mockReadSession = vi.mocked(readClawAiSession);
const mockWriteSession = vi.mocked(writeClawAiSession);
const mockApply = vi.mocked(applyClawaiToHermes);
const mockFetchPortalTier = vi.mocked(fetchPortalTier);

const TOKEN = "claw_device_code_token";

/** The plan this finaliser passed to the apply, or `undefined` for none. */
function planPassed(): unknown {
  const options = mockApply.mock.calls.at(-1)?.[2];
  return options?.portalPlan;
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
  // The finalise runs in the background; let its microtasks drain.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the device-code finaliser records the PLAN on Hermes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockWriteSession.mockResolvedValue(undefined as never);
    mockApply.mockResolvedValue({} as never);
  });

  it("passes the portal's plan verdict through to the apply", async () => {
    // The card's own customer, arriving through the device-code flow: the
    // account is Max and the portal stamps the box `flash`. The badge that
    // reaches the store is the picker's; the PLAN has to be the portal's.
    mockFetchPortalTier.mockResolvedValue({
      source: "portal",
      tier: "flash",
      planTier: "pro",
      planVerdict: "pro",
      allowedModels: null,
    } as never);

    await finalise();

    expect(mockApply).toHaveBeenCalled();
    expect(planPassed()).toEqual({ verdict: "pro" });
  });

  it("passes an UNPAID verdict through, so a downgrade can be acted on", async () => {
    mockFetchPortalTier.mockResolvedValue({
      source: "portal",
      tier: null,
      planTier: null,
      planVerdict: "free",
      allowedModels: null,
    } as never);

    await finalise();

    expect(planPassed()).toEqual({ verdict: "free" });
  });

  it("passes NOTHING when the portal did not answer", async () => {
    // An unreachable portal may not put a plan on record — and may not leave a
    // previous account's standing either, which is why the apply DELETES the
    // key when it is handed nothing.
    mockFetchPortalTier.mockResolvedValue({ source: "unreachable", rejected: false } as never);

    await finalise();

    expect(mockApply).toHaveBeenCalled();
    expect(planPassed()).toBeUndefined();
  });

  it("still links the box when the plan lookup throws", async () => {
    // A plan probe may never break a pairing: the credential is what the
    // customer is waiting for, and the plan is a hint the next poll re-asks.
    mockFetchPortalTier.mockRejectedValue(new Error("portal down"));

    await finalise();

    expect(mockApply).toHaveBeenCalled();
    expect(planPassed()).toBeUndefined();
  });
});
