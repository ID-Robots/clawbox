import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /setup-api/ai-models/xai-login — start / poll / cancel of the xAI
// (Grok) sign-in. The route is a thin dispatcher over src/lib/xai-oauth-login
// (covered by its own unit suite); what is pinned here is the dispatch, the
// `--force` decision and the two refusals.

const mocks = vi.hoisted(() => ({
  startXaiLogin: vi.fn(),
  pollXaiLogin: vi.fn(),
  cancelXaiLogin: vi.fn(),
  claimXaiLoginAttempt: vi.fn(() => 7),
  readXaiStoredProfiles: vi.fn(),
  openclawIsAbsent: vi.fn(() => false),
}));

vi.mock("@/lib/xai-oauth-login", () => ({
  startXaiLogin: mocks.startXaiLogin,
  pollXaiLogin: mocks.pollXaiLogin,
  cancelXaiLogin: mocks.cancelXaiLogin,
  claimXaiLoginAttempt: mocks.claimXaiLoginAttempt,
  readXaiStoredProfiles: mocks.readXaiStoredProfiles,
}));

vi.mock("@/lib/openclaw-config", () => ({
  openclawIsAbsent: mocks.openclawIsAbsent,
}));

import { POST } from "@/app/setup-api/ai-models/xai-login/route";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://clawbox.local/setup-api/ai-models/xai-login", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://clawbox.local", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const PENDING = { status: "pending", verificationUrl: "https://example.test/device", userCode: "ABCD-1234" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.openclawIsAbsent.mockReturnValue(false);
  mocks.readXaiStoredProfiles.mockResolvedValue([]);
  mocks.startXaiLogin.mockResolvedValue(PENDING);
});

describe("POST /setup-api/ai-models/xai-login", () => {
  it("starts a sign-in and answers with the link and the code", async () => {
    const res = await POST(post({ action: "start" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PENDING);
    // A box with no xAI profile has nothing to replace.
    expect(mocks.startXaiLogin).toHaveBeenCalledWith({ replaceExisting: false, signInAlreadyStored: false, attempt: 7 });
  });

  it("replaces an existing xAI credential — a key or an older sign-in", async () => {
    mocks.readXaiStoredProfiles.mockResolvedValue([{ id: "xai:default", type: "api_key" }]);
    await POST(post({ action: "start" }));

    // A key is replaced; it is not a sign-in, so the store may still prove
    // this login landed.
    expect(mocks.startXaiLogin).toHaveBeenCalledWith({ replaceExisting: true, signInAlreadyStored: false, attempt: 7 });
  });

  it("leaves a re-sign-in to the CLI's exit code, not the store", async () => {
    mocks.readXaiStoredProfiles.mockResolvedValue([{ id: "xai:default", type: "oauth" }]);
    await POST(post({ action: "start" }));

    expect(mocks.startXaiLogin).toHaveBeenCalledWith({ replaceExisting: true, signInAlreadyStored: true, attempt: 7 });
  });

  it("treats an unreadable store as something to replace", async () => {
    mocks.readXaiStoredProfiles.mockResolvedValue(null);
    await POST(post({ action: "start" }));

    expect(mocks.startXaiLogin).toHaveBeenCalledWith({ replaceExisting: true, signInAlreadyStored: true, attempt: 7 });
  });

  it("claims its attempt before reading the store, and starts with it", async () => {
    await POST(post({ action: "start" }));

    // The read is a CLI cold start; a cancel that lands during it must find
    // the attempt already claimed, so the start then spawns nothing.
    expect(mocks.claimXaiLoginAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.claimXaiLoginAttempt.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.readXaiStoredProfiles.mock.invocationCallOrder[0]);
    expect(mocks.startXaiLogin).toHaveBeenCalledWith(expect.objectContaining({ attempt: 7 }));
  });

  it("answers a start that failed with the failure and the CLI's own lines", async () => {
    const failed = { status: "failed", detail: "The sign-in did not complete (exit 1).", output: "Error: no subscription" };
    mocks.startXaiLogin.mockResolvedValue(failed);

    const res = await POST(post({ action: "start" }));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(failed);
  });

  it("polls the login in flight", async () => {
    mocks.pollXaiLogin.mockReturnValue({ status: "complete" });

    const res = await POST(post({ action: "poll" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "complete" });
    expect(mocks.startXaiLogin).not.toHaveBeenCalled();
  });

  it("cancels the login in flight", async () => {
    const res = await POST(post({ action: "cancel" }));

    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.cancelXaiLogin).toHaveBeenCalledTimes(1);
  });

  it("refuses an unknown action and an unreadable body before doing anything", async () => {
    expect((await POST(post({ action: "logout" }))).status).toBe(400);
    expect((await POST(post({}))).status).toBe(400);
    expect((await POST(post("not json"))).status).toBe(400);
    expect(mocks.startXaiLogin).not.toHaveBeenCalled();
    expect(mocks.cancelXaiLogin).not.toHaveBeenCalled();
  });

  it("refuses a request from another site's page", async () => {
    const res = await POST(post({ action: "start" }, { origin: "https://evil.example" }));

    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("cross_origin");
    expect(mocks.startXaiLogin).not.toHaveBeenCalled();
  });

  it("refuses on an edition with no OpenClaw CLI to run", async () => {
    mocks.openclawIsAbsent.mockReturnValue(true);

    const res = await POST(post({ action: "start" }));

    expect(res.status).toBe(400);
    expect(mocks.startXaiLogin).not.toHaveBeenCalled();
  });

  it("answers a thrown error as a failed sign-in, without the raw message", async () => {
    mocks.startXaiLogin.mockRejectedValue(new Error("EACCES /some/internal/path"));

    const res = await POST(post({ action: "start" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.status).toBe("failed");
    expect(JSON.stringify(body)).not.toContain("internal");
  });
});
