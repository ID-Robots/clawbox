import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * GET /setup-api/clawkeep/memory/search — the read half of Memory Shard on the
 * edition where ClawBox owns the index.
 *
 * The one thing worth pinning above all others is the exception this route
 * makes. Every other route under `clawkeep/memory` is a WRITE that changes what
 * the box does — which folders are read, whether indexing runs — and every one
 * of them refuses the MCP bearer, because the agent must not be able to widen
 * its owner's decisions. This one is deliberately reachable by the agent: the
 * whole feature is that it can search the owner's documents mid-conversation.
 * A future tidy-up that "fixes the missing owner check" would take the feature
 * out while leaving every panel looking exactly the same, so the decision is
 * stated here as a test rather than only in a comment.
 */

const { absent, enabled, search } = vi.hoisted(() => ({
  absent: { value: true },
  enabled: { value: true },
  search: vi.fn(async () => [{ path: "Documents/lease.md", snippet: "The deposit is two months' rent.", score: 0.82 }]),
}));

vi.mock("@/lib/openclaw-config", () => ({ openclawIsAbsent: () => absent.value }));
vi.mock("@/lib/memory-shard", () => ({ getMemoryShardEnabled: async () => enabled.value }));
vi.mock("@/lib/memory-index-local", () => ({ searchLocalMemory: search }));

import { NextRequest } from "next/server";
import { GET } from "@/app/setup-api/clawkeep/memory/search/route";

/** A real NextRequest, like every other route suite — a hand-patched `Request`
 *  cast to `never` turns the handler's argument type off, so the day the route
 *  reads another member of it the suite fails at runtime and type-checks clean. */
function call(query: string) {
  return GET(new NextRequest(`http://clawbox.local/setup-api/clawkeep/memory/search${query}`));
}

beforeEach(() => {
  absent.value = true;
  enabled.value = true;
  search.mockClear();
});

describe("who may search", () => {
  it("answers a caller with no owner session, because the agent IS the caller", async () => {
    // Not an oversight. The MCP bearer reaches this route through the
    // middleware like any other, and `memory_shard_search` is what makes the
    // index worth building on a box where nothing else reads it. The consent
    // it rides on is the one already given: the owner switched Memory Shard on
    // and chose the folders.
    const res = await call("?q=deposit");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ path: "Documents/lease.md", snippet: "The deposit is two months' rent.", score: 0.82 }],
    });
  });

  it("refuses while the owner's switch is off", async () => {
    enabled.value = false;
    const res = await call("?q=deposit");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("disabled");
    expect(search).not.toHaveBeenCalled();
  });

  it("refuses on the edition whose assistant searches its own index", async () => {
    absent.value = false;
    const res = await call("?q=deposit");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("edition");
    expect(search).not.toHaveBeenCalled();
  });
});

describe("what it accepts and answers", () => {
  it("wants something to search for", async () => {
    const res = await call("?q=%20%20");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("no_query");
    expect(search).not.toHaveBeenCalled();
  });

  it("caps the number of passages, whatever was asked for", async () => {
    await call("?q=deposit&limit=500");
    expect(search).toHaveBeenCalledWith("deposit", 10, expect.anything());
  });

  it("takes at least one, and ignores a limit that is not a number", async () => {
    await call("?q=deposit&limit=0");
    expect(search).toHaveBeenLastCalledWith("deposit", 1, expect.anything());
    await call("?q=deposit&limit=abc");
    expect(search).toHaveBeenLastCalledWith("deposit", 5, expect.anything());
  });

  it("says the index could not be searched rather than leaking the reason", async () => {
    // The embedder refusing a wake is a 502 from the proxy carrying its own
    // words; those name paths and units, and the agent relays what it is told.
    search.mockRejectedValueOnce(new Error("HTTP 502 from http://127.0.0.1/setup-api/local-ai/embed/v1"));
    const res = await call("?q=deposit");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("search_failed");
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
  });
});
