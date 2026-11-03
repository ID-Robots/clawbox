import { describe, expect, it, vi } from "vitest";
import { OpenClawGatewayAdapter, type GatewayLink } from "@/lib/harness/openclaw-gateway-adapter";
import type { HarnessCapabilities } from "@/lib/harness/transport";

/**
 * "Shorten this conversation first" on OpenClaw (TASK-2127): the gateway's
 * `sessions.compact`, which counts as a shortening only when the gateway says
 * it compacted AND the history it reports got smaller — the Hermes twin
 * (/setup-api/hermes/compress) answers 409 for the same no-op.
 */
function link(answer: unknown): GatewayLink & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async () => answer),
    sessionKey: () => "agent:main:main",
    open: async () => {},
    close: () => {},
    onStatus: () => () => {},
  } as GatewayLink & { request: ReturnType<typeof vi.fn> };
}

describe("OpenClawGatewayAdapter.compactConversation", () => {
  it("asks sessions.compact for the key and resolves with the counts of a real compaction", async () => {
    const l = link({ ok: true, compacted: true, result: { tokensBefore: 100460, tokensAfter: 9000 } });
    const adapter = new OpenClawGatewayAdapter({} as HarnessCapabilities, l);
    await expect(adapter.compactConversation("agent:main:main")).resolves.toEqual({ tokensBefore: 100460, tokensAfter: 9000 });
    expect(l.request).toHaveBeenCalledWith("sessions.compact", { key: "agent:main:main" });
  });

  it("resolves when the gateway compacted but reported no counts", async () => {
    const adapter = new OpenClawGatewayAdapter({} as HarnessCapabilities, link({ ok: true, compacted: true }));
    await expect(adapter.compactConversation("agent:main:main")).resolves.toEqual({ tokensBefore: undefined, tokensAfter: undefined });
  });

  it("rejects when the gateway compacted nothing", async () => {
    const adapter = new OpenClawGatewayAdapter({} as HarnessCapabilities, link({ ok: true, compacted: false, reason: "nothing to compact" }));
    await expect(adapter.compactConversation("agent:main:main")).rejects.toThrow(/not shortened/);
  });

  it("rejects a compaction that left the conversation no smaller", async () => {
    const adapter = new OpenClawGatewayAdapter(
      {} as HarnessCapabilities,
      link({ ok: true, compacted: true, result: { tokensBefore: 64900, tokensAfter: 66700 } }),
    );
    await expect(adapter.compactConversation("agent:main:main")).rejects.toThrow(/not shortened/);
  });
});
