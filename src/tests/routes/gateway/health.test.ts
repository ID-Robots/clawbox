import { describe, expect, it, vi, beforeEach } from "vitest";

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
    expect(body).toEqual({ available: true, port: 18789 });
    expect(isPortOpenMock).toHaveBeenCalledWith(18789, "127.0.0.1", 1000);
  });

  it("returns unavailable when the connect attempt fails", async () => {
    isPortOpenMock.mockResolvedValue(false);
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ available: false, port: 18789 });
  });
});
