import { describe, expect, it, vi } from "vitest";
import { OpenClawGatewayAdapter, type GatewayLink } from "@/lib/harness/openclaw-gateway-adapter";
import type { HarnessCapabilities } from "@/lib/harness/transport";

/**
 * The one wire frame that starts a fresh agent thread. It used to be pinned
 * through the chat strip's "New chat" button; that button now opens the
 * gateway's own UI in a new tab, and the only remaining caller of
 * resetSession() is the provider-switch flow — so the contract is pinned
 * where it lives, on the adapter.
 */
function link(over: Partial<GatewayLink> = {}): GatewayLink & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async () => ({})),
    sessionKey: () => "agent:main:main",
    open: async () => {},
    close: () => {},
    onStatus: () => () => {},
    ...over,
  } as GatewayLink & { request: ReturnType<typeof vi.fn> };
}

describe("OpenClawGatewayAdapter.resetSession", () => {
  it("resets as sessions.reset{key,reason:'new'}", async () => {
    const l = link();
    const adapter = new OpenClawGatewayAdapter({} as HarnessCapabilities, l);
    await adapter.resetSession();
    // `reason: 'new'` is what makes the agent start a fresh thread rather than
    // merely rewinding.
    expect(l.request).toHaveBeenCalledWith("sessions.reset", { key: "agent:main:main", reason: "new" });
  });

  it("surfaces the gateway's refusal instead of swallowing it", async () => {
    const l = link({ request: vi.fn(async () => { throw new Error("gateway said no"); }) });
    const adapter = new OpenClawGatewayAdapter({} as HarnessCapabilities, l);
    await expect(adapter.resetSession()).rejects.toThrow(/gateway said no/);
  });
});
