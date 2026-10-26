import { describe, expect, it, vi } from "vitest";

// An update must not start while an OpenClaw database maintenance run holds the
// gateway: both hold it down with the same guard (clawbox-gateway-maintenance.sh)
// and LIFT it when they are done, so an update started under a compaction would
// lift it halfway and start the gateway beside the running doctor.

const h = vi.hoisted(() => ({ running: true }));

vi.mock("@/lib/openclaw-db-maintenance", () => ({ dbMaintenanceRunning: () => h.running }));

describe("startUpdate / startOpenclawUpdate under a database maintenance run", () => {
  it("refuse to start, saying why, while a run holds the gateway", async () => {
    const updater = await import("@/lib/updater");
    expect(updater.startUpdate()).toEqual({ started: false, error: expect.stringMatching(/database maintenance is running/) });
    expect(updater.startOpenclawUpdate()).toEqual({ started: false, error: expect.stringMatching(/database maintenance is running/) });
    expect(updater.getUpdateState().phase).not.toBe("running");
  });
});
