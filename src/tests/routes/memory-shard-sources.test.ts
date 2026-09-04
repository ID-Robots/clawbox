/**
 * Memory Shard's new owner-only routes.
 *
 * The property that matters: the ASSISTANT must not be able to switch the index
 * on, widen what it reads, or move where the owner's memories are embedded.
 * Middleware admits the MCP bearer on every /setup-api path and the agent holds
 * it, so each of these routes refuses in-handler with hasOwnerSession — the same
 * rule as coding-agent/enable. (The three memory routes that existed before this
 * have no such check at all, which is how the agent can start a full reindex
 * today; that is noted for a separate change.)
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/owner-session", () => ({ hasOwnerSession: vi.fn(async () => false) }));

const url = (p: string) => `http://localhost/setup-api/clawkeep/memory/${p}`;

describe("owner-only gates", () => {
  it("refuses the switch without an owner session", async () => {
    const { POST } = await import("@/app/setup-api/clawkeep/memory/enable/route");
    const res = await POST(new Request(url("enable"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
  });

  it("refuses the embedding-provider switch without an owner session", async () => {
    const { POST } = await import("@/app/setup-api/clawkeep/memory/provider/route");
    const res = await POST(new Request(url("provider"), { method: "POST" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
  });

  it("refuses reading or changing the indexed folders without an owner session", async () => {
    const { NextRequest } = await import("next/server");
    const mod = await import("@/app/setup-api/clawkeep/memory/sources/route");
    for (const [method, call] of [
      ["GET", () => mod.GET(new NextRequest(url("sources")))],
      ["POST", () => mod.POST(new NextRequest(url("sources"), { method: "POST", body: JSON.stringify({ path: "/home/clawbox/Documents" }) }))],
      ["DELETE", () => mod.DELETE(new NextRequest(url("sources"), { method: "DELETE", body: JSON.stringify({ path: "/home/clawbox/Documents" }) }))],
    ] as const) {
      const res = await call();
      expect(res.status, method).toBe(403);
    }
  });
});

describe("the state module stays client-safe", () => {
  it("carries the constants without importing the CLI driver", async () => {
    // A client component importing a VALUE from a module that spawns processes
    // pulls child_process into the browser bundle and fails the build — that
    // exact mistake took the desktop down earlier in this session.
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/memory-shard-state.ts"), "utf8");
    // IMPORTS only — the file's own comment names child_process to explain why
    // this split exists, and matching the prose would fail on the explanation
    // rather than on the hazard.
    const imports = src.match(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?$/gm) ?? [];
    expect(imports.join("\n")).not.toMatch(/child_process|openclaw-config|config-store|clawkeep-memory/);
    const state = await import("@/lib/memory-shard-state");
    // llama-server's --alias, sent as `model` — not an ollama tag any more.
    expect(state.LOCAL_EMBEDDING_MODEL).toBe("qwen3-embedding-0.6b");
    expect(state.EXTRA_PATHS_CONFIG_PATH).toBe("memory.search.extraPaths");
    // PDFs are extracted BY CLAWBOX; OpenClaw's indexer reads .md and nothing
    // else, so these two lists must not be confused.
    expect([...state.INDEXABLE_EXTENSIONS]).toEqual([".md"]);
    expect([...state.EXTRACTABLE_EXTENSIONS]).toContain(".pdf");
  });
});
