import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

const isPortOpenMock = vi.fn();
// PARTIAL mock — only the probe is replaceable. A factory mock replaces the
// whole module, so an export the route imports but the factory omits fails
// module loading the moment the route reaches it (which is how this suite broke
// when the route started validating its port). `envPort` stays real, so the
// port this route probes is the one the guard actually produces.
vi.mock("@/lib/port-probe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/port-probe")>("@/lib/port-probe");
  return { ...actual, isPortOpen: (...args: unknown[]) => isPortOpenMock(...args) };
});

describe("/setup-api/gateway/health", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    isPortOpenMock.mockReset();
    const mod = await import("@/app/setup-api/gateway/health/route");
    GET = mod.GET;
  });

  it("returns available when the gateway port accepts a TCP connect", async () => {
    isPortOpenMock.mockResolvedValue(true);
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ available: true, port: 18789, restarting: false });
    expect(isPortOpenMock).toHaveBeenCalledWith(18789, "127.0.0.1", 1000);
  });

  it("returns unavailable when the connect attempt fails", async () => {
    isPortOpenMock.mockResolvedValue(false);
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ available: false, port: 18789, restarting: false });
  });

  it("is not available while a restart this server issued is still in flight (TASK-1535)", async () => {
    // The old process still listens while systemd stops it; a page following a
    // restart it was answered early about must not take that for "back".
    const { markGatewayRestartBegun } = await import("@/lib/gateway-restart-tracker");
    isPortOpenMock.mockResolvedValue(true);
    const over = markGatewayRestartBegun();
    try {
      expect(await (await GET()).json()).toEqual({ available: false, port: 18789, restarting: true });
      expect(isPortOpenMock).not.toHaveBeenCalled();
    } finally {
      over();
    }
    expect(await (await GET()).json()).toEqual({ available: true, port: 18789, restarting: false });
  });

  describe("the agents' databases", () => {
    const saved = process.env.CLAWBOX_ROOT;
    let root: string;
    beforeEach(async () => {
      const { mkdtempSync, mkdirSync } = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      root = mkdtempSync(path.join(os.tmpdir(), "health-migration-"));
      mkdirSync(path.join(root, "data"), { recursive: true });
      process.env.CLAWBOX_ROOT = root;
    });
    afterEach(async () => {
      process.env.CLAWBOX_ROOT = saved;
      (await import("node:fs")).rmSync(root, { recursive: true, force: true });
    });

    it("carries a degraded migration beside a gateway that is up, never instead of it", async () => {
      // A 10.x gateway on 9.x agent databases listens and reports ready while
      // every agent is refused: the port alone was a silent ready.
      const { writeFileSync } = await import("node:fs");
      const path = await import("node:path");
      writeFileSync(path.join(root, "data", "openclaw-migration-status.json"), JSON.stringify({
        state: "degraded", reason: "schema-behind", requiredBytes: 61_000_000_000, freeBytes: 80_000_000_000,
        databases: { total: 3, behind: 2 }, core: "2026.10.3",
      }));
      isPortOpenMock.mockResolvedValue(true);
      expect(await (await GET()).json()).toEqual({
        available: true, port: 18789, restarting: false,
        migration: { state: "degraded", reason: "schema-behind", requiredBytes: 61_000_000_000, freeBytes: 80_000_000_000 },
      });
    });

    it("says nothing when the databases are fine", async () => {
      const { writeFileSync } = await import("node:fs");
      const path = await import("node:path");
      writeFileSync(path.join(root, "data", "openclaw-migration-status.json"), JSON.stringify({ state: "ok", reason: null }));
      isPortOpenMock.mockResolvedValue(true);
      expect(await (await GET()).json()).toEqual({ available: true, port: 18789, restarting: false });
    });
  });
});
