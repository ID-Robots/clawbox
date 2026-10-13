import { describe, expect, it, vi } from "vitest";
import { gatewayRestartInFlight, markGatewayRestartBegun } from "@/lib/gateway-restart-tracker";

describe("gateway restart tracker", () => {
  it("counts overlapping restarts and ignores a second end of the same one", () => {
    expect(gatewayRestartInFlight()).toBe(false);
    const first = markGatewayRestartBegun();
    const second = markGatewayRestartBegun();
    expect(gatewayRestartInFlight()).toBe(true);
    first();
    first();
    expect(gatewayRestartInFlight()).toBe(true);
    second();
    expect(gatewayRestartInFlight()).toBe(false);
  });

  it("is shared by every copy of the module in one process", async () => {
    // Route bundles each load their own copy; the health route has to see the
    // restart the configure route started.
    const over = markGatewayRestartBegun();
    try {
      vi.resetModules();
      const fresh = await import("@/lib/gateway-restart-tracker");
      expect(fresh.gatewayRestartInFlight()).toBe(true);
    } finally {
      over();
    }
  });
});
