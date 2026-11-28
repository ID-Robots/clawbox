import { describe, expect, it, vi } from "vitest";
import { OpenClawGatewayAdapter, type GatewayLink } from "@/lib/harness/openclaw-gateway-adapter";
import type { HarnessCapabilities } from "@/lib/harness/transport";

/**
 * TASK-2702. A send the gateway refuses while it is still starting is tried
 * again a moment later, and by then the owner may have moved to another
 * conversation. The retry still goes to the conversation the message was typed
 * in: the turn names its session, and the link's current one is only the
 * default.
 */
function link(current: string): GatewayLink & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async () => ({ runId: "r1", status: "started" })),
    sessionKey: () => current,
    open: async () => {},
    close: () => {},
    onStatus: () => () => {},
  } as GatewayLink & { request: ReturnType<typeof vi.fn> };
}

describe("OpenClawGatewayAdapter.sendTurn session", () => {
  it("sends to the conversation the turn names, not the one on screen now", async () => {
    const l = link("agent:main:tab-b");
    const adapter = new OpenClawGatewayAdapter({} as HarnessCapabilities, l);
    await adapter.sendTurn({ text: "hello", attachments: [], idempotencyKey: "k1", sessionKey: "agent:main:main" });
    expect(l.request).toHaveBeenCalledWith("chat.send", expect.objectContaining({ sessionKey: "agent:main:main", idempotencyKey: "k1" }));
  });

  it("without one, sends to the link's current conversation as before", async () => {
    const l = link("agent:main:main");
    const adapter = new OpenClawGatewayAdapter({} as HarnessCapabilities, l);
    await adapter.sendTurn({ text: "hello", attachments: [], idempotencyKey: "k2" });
    expect(l.request).toHaveBeenCalledWith("chat.send", expect.objectContaining({ sessionKey: "agent:main:main" }));
  });
});
