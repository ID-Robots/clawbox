/**
 * GET /setup-api/ai-models/usage — the box's ClawBox AI allowances, asked of
 * the portal with the box's own credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/harness/credentials", () => ({
  resolveClawaiToken: vi.fn(),
}));

import { resolveClawaiToken } from "@/lib/harness/credentials";

const mockToken = vi.mocked(resolveClawaiToken);

const WEEKLY_BODY = {
  percentUsed: 24,
  resetIn: "3d 0h",
  isOverLimit: false,
  tier: "max",
  tierDisplayName: "Max",
  buckets: { flash: { used: 1, limit: 2 } },
  weekly: { used: 1_200_000, limit: 5_000_000, remaining: 3_800_000, percentUsed: 24, isOverLimit: false, resetAt: "2026-09-20T09:00:00.000Z" },
  burst: { used: 0, limit: 1_250_000, remaining: 1_250_000, percentUsed: 0, isOverLimit: false, resetAt: "2026-09-17T09:00:00.000Z" },
  meters: { images: { used: 1, limit: 40, remaining: 39, percentUsed: 3, isOverLimit: false, period: "week", resetAt: "2026-09-20T09:00:00.000Z" } },
  credits: { balanceCents: 500, usedThisWeekCents: 0, usedThisWeekByDimension: {}, canBuy: true },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": typeof body === "string" ? "text/html" : "application/json" },
  });
}

describe("/setup-api/ai-models/usage", () => {
  let GET: () => Promise<Response>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.CLAWBOX_AI_USAGE_URL;
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    GET = (await import("@/app/setup-api/ai-models/usage/route")).GET;
    (await import("@/lib/clawai-usage-portal"))._resetClawaiUsageCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers not_connected, and asks nobody, on a box with no ClawBox AI credential", async () => {
    mockToken.mockResolvedValue(null);
    const body = await (await GET()).json();
    expect(body).toEqual({ available: false, reason: "not_connected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not hand a credential that is not a portal token to the portal", async () => {
    mockToken.mockResolvedValue("sk-something-else");
    expect(await (await GET()).json()).toEqual({ available: false, reason: "not_connected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the weekly payload, normalized, with the old fields still on top", async () => {
    mockToken.mockResolvedValue("claw_box_token");
    fetchSpy.mockResolvedValue(jsonResponse(200, WEEKLY_BODY));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://clawbox.com/api/portal/usage");
    expect(init.headers).toMatchObject({ Authorization: "Bearer claw_box_token", "X-ClawBox-Token": "claw_box_token" });

    expect(body.available).toBe(true);
    expect(typeof body.timeZone).toBe("string");
    expect(body.usage.shape).toBe("weekly");
    expect(body.usage.plan).toBe("max");
    expect(body.usage.weekly.percentUsed).toBe(24);
    expect(body.usage.credits).toMatchObject({ balanceCents: 500, canBuy: true, currency: "EUR" });
    expect(body).toMatchObject({
      percentUsed: 24, resetIn: "3d 0h", isOverLimit: false, tier: "max", tierDisplayName: "Max", buckets: WEEKLY_BODY.buckets,
    });
    // The credential is the server's to use, never the browser's to read.
    expect(JSON.stringify(body)).not.toContain("claw_box_token");
  });

  it("passes an older portal's daily answer through as the legacy shape", async () => {
    mockToken.mockResolvedValue("claw_box_token");
    fetchSpy.mockResolvedValue(jsonResponse(200, { percentUsed: 37, resetIn: "4h 30m", isOverLimit: false, tier: "free", tierDisplayName: "Free", buckets: {} }));
    const body = await (await GET()).json();
    expect(body.usage.shape).toBe("legacy");
    expect(body).toMatchObject({ available: true, percentUsed: 37, resetIn: "4h 30m", tier: "free" });
  });

  it("calls a portal that will not give this credential its usage refused", async () => {
    mockToken.mockResolvedValue("claw_box_token");
    for (const status of [401, 403, 404]) {
      (await import("@/lib/clawai-usage-portal"))._resetClawaiUsageCache();
      fetchSpy.mockResolvedValueOnce(jsonResponse(status, { error: "Not authenticated" }));
      expect(await (await GET()).json(), String(status)).toEqual({ available: false, reason: "refused" });
    }
  });

  it("calls an outage a moment, not a verdict", async () => {
    mockToken.mockResolvedValue("claw_box_token");
    fetchSpy.mockResolvedValueOnce(jsonResponse(503, { error: "Usage metering is temporarily unavailable.", code: "metering_unavailable" }));
    expect(await (await GET()).json()).toEqual({ available: false, reason: "unreachable" });

    (await import("@/lib/clawai-usage-portal"))._resetClawaiUsageCache();
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await (await GET()).json()).toEqual({ available: false, reason: "unreachable" });
  });

  it("does not draw an interception page as usage", async () => {
    mockToken.mockResolvedValue("claw_box_token");
    fetchSpy.mockResolvedValue(jsonResponse(200, "<html>Sign in to the hotel Wi-Fi</html>"));
    expect(await (await GET()).json()).toEqual({ available: false, reason: "invalid" });
  });

  it("asks the portal once per half-minute however many tabs poll", async () => {
    mockToken.mockResolvedValue("claw_box_token");
    fetchSpy.mockImplementation(async () => jsonResponse(200, WEEKLY_BODY));
    await GET();
    await GET();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // A re-linked box is a different credential and gets its own answer.
    mockToken.mockResolvedValue("claw_new_token");
    await GET();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("honours an overridden portal address", async () => {
    process.env.CLAWBOX_AI_USAGE_URL = "http://127.0.0.1:9/usage";
    mockToken.mockResolvedValue("claw_box_token");
    fetchSpy.mockResolvedValue(jsonResponse(200, WEEKLY_BODY));
    await GET();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:9/usage");
    delete process.env.CLAWBOX_AI_USAGE_URL;
  });
});
