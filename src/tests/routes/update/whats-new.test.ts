/**
 * GET /setup-api/update/whats-new — the /updating screen's "What's new" panel
 * (TASK-1205).
 *
 * What is pinned here: the route passes the server half's answer through,
 * uncached by the browser, and is NEVER a 500 — a failure is the `none` answer
 * the screen already knows how to draw.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/update-whats-new-server", () => ({
  readUpdateWhatsNew: vi.fn(),
}));

import { readUpdateWhatsNew } from "@/lib/update-whats-new-server";
import { CLAWBOX_RELEASES_URL, releasePageUrl, type UpdateWhatsNew } from "@/lib/update-whats-new";

let GET: () => Promise<Response>;

beforeEach(async () => {
  vi.resetModules();
  GET = (await import("@/app/setup-api/update/whats-new/route")).GET;
});

describe("GET /setup-api/update/whats-new", () => {
  it("answers the target's highlights, not to be cached", async () => {
    const answer: UpdateWhatsNew = {
      version: "4.2.0",
      channel: "beta",
      source: "notes",
      highlights: [{ title: "Faster updates", body: "Less to download." }],
      releaseUrl: releasePageUrl("4.2.0"),
    };
    vi.mocked(readUpdateWhatsNew).mockResolvedValue(answer);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual(answer);
  });

  it("answers `none` — never a 500 — when the read throws", async () => {
    vi.mocked(readUpdateWhatsNew).mockRejectedValue(new Error("git exploded"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: null, channel: null, source: "none", highlights: [], releaseUrl: CLAWBOX_RELEASES_URL,
    });
    expect(warn).toHaveBeenCalled();
  });
});
