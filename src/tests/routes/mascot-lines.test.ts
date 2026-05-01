import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/kv-store", () => ({
  kvGet: vi.fn(),
}));

import { kvGet } from "@/lib/kv-store";
const mockKvGet = vi.mocked(kvGet);

describe("/setup-api/mascot-lines", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("@/app/setup-api/mascot-lines/route");
    GET = mod.GET;
  });

  // The route was extended to also return categorized `phrases` and `meta`
  // (LLM-generated set + cache metadata) alongside the legacy `lines`/`date`
  // fields. These tests assert the legacy contract only — `toMatchObject`
  // tolerates the extra fields without re-asserting them on every run.
  it("returns empty lines when no data", async () => {
    mockKvGet.mockReturnValue(null);
    const res = await GET();
    const body = await res.json();
    expect(body).toMatchObject({ lines: [] });
  });

  it("returns parsed lines from KV", async () => {
    mockKvGet.mockReturnValue(JSON.stringify({ lines: ["hello", "world"], date: "2026-01-01" }));
    const res = await GET();
    const body = await res.json();
    expect(body).toMatchObject({ lines: ["hello", "world"], date: "2026-01-01" });
  });

  it("handles invalid JSON gracefully", async () => {
    mockKvGet.mockReturnValue("not json");
    const res = await GET();
    const body = await res.json();
    expect(body).toMatchObject({ lines: [] });
  });

  it("handles missing lines field", async () => {
    mockKvGet.mockReturnValue(JSON.stringify({ date: "2026-01-01" }));
    const res = await GET();
    const body = await res.json();
    expect(body.lines).toEqual([]);
  });
});
