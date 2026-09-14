/**
 * /setup-api/ai-cloud-defaults — where this box runs voice, transcription and
 * memory search, and the one verb that hands a capability back to the ClawBox
 * AI cloud.
 *
 * Pinned: the POST is the owner's and only from this box's own pages (the agent
 * holds the MCP bearer the middleware also admits), the pin comes off BEFORE
 * the default is asked to move anything, and a capability the subscription does
 * not cover is answered as a fact rather than as an error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const owner = vi.fn(async () => true);
vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: () => owner() }));

const sameOrigin = vi.fn(() => true);
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: () => sameOrigin() }));

const cleared: string[] = [];
vi.mock("@/lib/clawai-cloud-choice", () => ({
  clearOwnerChoice: async (capability: string) => { cleared.push(capability); },
}));

const apply = vi.fn(async () => ({ moved: ["embeddings"], failed: [] as { capability: string; error: string }[] }));
type Row = { source: string; target: string; ownerChoice: boolean; reason: string | null };
const cloud: Row = { source: "cloud", target: "cloud", ownerChoice: false, reason: null };
const status = vi.fn(async () => ({
  linked: true,
  plan: "pro",
  capabilities: { tts: cloud, stt: cloud, embeddings: cloud } as Record<string, Row>,
}));
vi.mock("@/lib/clawai-cloud-defaults", () => ({
  applyClawaiCloudDefaults: (...a: unknown[]) => apply(...(a as [])),
  readCloudDefaultsStatus: () => status(),
}));

import { GET, POST } from "@/app/setup-api/ai-cloud-defaults/route";

function post(body: unknown) {
  return new Request("http://box/setup-api/ai-cloud-defaults", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cleared.length = 0;
  owner.mockResolvedValue(true);
  sameOrigin.mockReturnValue(true);
});

describe("GET /setup-api/ai-cloud-defaults", () => {
  it("answers where each capability runs, and never caches", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await expect(res.json()).resolves.toMatchObject({ linked: true, plan: "pro" });
  });

  it("says the box could not be read rather than inventing an answer", async () => {
    status.mockRejectedValueOnce(new Error("no"));
    expect((await GET()).status).toBe(500);
  });
});

describe("POST /setup-api/ai-cloud-defaults", () => {
  it("refuses without an owner browser session, whatever else the caller holds", async () => {
    owner.mockResolvedValue(false);
    const res = await POST(post({ capability: "tts" }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "owner_only" });
    expect(apply).not.toHaveBeenCalled();
    expect(cleared).toEqual([]);
  });

  it("refuses a cookie that rode in on another site's page", async () => {
    sameOrigin.mockReturnValue(false);
    const res = await POST(post({ capability: "tts" }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ code: "cross_origin" });
    expect(cleared).toEqual([]);
  });

  it("refuses a body it cannot read and a capability it does not have", async () => {
    const bad = new Request("http://box/setup-api/ai-cloud-defaults", { method: "POST", body: "{" });
    expect((await POST(bad)).status).toBe(400);
    expect((await POST(post({ capability: "images" }))).status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("takes the pin off first, then asks the default to move it", async () => {
    const res = await POST(post({ capability: "embeddings" }));
    expect(res.status).toBe(200);
    // Order matters: the applier READS the pin, so clearing it afterwards would
    // be asking the default to move something it had just been told not to.
    expect(cleared).toEqual(["embeddings"]);
    expect(apply).toHaveBeenCalledWith({ trigger: "owner" });
    await expect(res.json()).resolves.toMatchObject({ moved: true, linked: true });
  });

  it("answers the box's state, not the request, when the plan does not cover it", async () => {
    apply.mockResolvedValue({ moved: [], failed: [] });
    status.mockResolvedValue({
      linked: true,
      plan: "flash",
      capabilities: {
        tts: { source: "local", target: "local", ownerChoice: false, reason: "plan" },
        stt: cloud,
        embeddings: cloud,
      },
    });
    const res = await POST(post({ capability: "tts" }));
    // A capability the subscription does not cover is a fact, not a failure:
    // the row simply still says the box, with the reason beside it.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      moved: false,
      capabilities: { tts: { source: "local", reason: "plan" } },
    });
  });

  it("carries a refusal the box hit as a warning beside the state it is in", async () => {
    apply.mockResolvedValue({ moved: [], failed: [{ capability: "embeddings", error: "the CLI said no" }] });
    const res = await POST(post({ capability: "embeddings" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ warning: "the CLI said no", moved: false });
  });
});
