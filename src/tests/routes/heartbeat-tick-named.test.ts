/**
 * The five-minute tick with the NAMED tunnel up.
 *
 * A dead quick-tunnel hostname is fixed by a restart, which mints a new one. A
 * named hostname is the same after a restart, and it fails to resolve only
 * while the portal has not (yet) created its DNS record — which the portal does
 * on a heartbeat. So in named mode the tick keeps reporting and does not bounce
 * the tunnel; withholding the heartbeat would keep the record from appearing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloudflared = { readTunnelUrl: vi.fn(), startTunnelService: vi.fn() };
const heartbeat = { pushHeartbeatTick: vi.fn() };
const liveness = { checkTunnelLiveness: vi.fn(), mayRestart: vi.fn(), markRestarted: vi.fn() };
const named = { readTunnelMode: vi.fn() };

vi.mock("@/lib/language-persona", () => ({ applyDeferredLanguagePersona: vi.fn(async () => false) }));
vi.mock("@/lib/hermes-model-options", () => ({ refreshCatalogIfDue: vi.fn(async () => undefined) }));
vi.mock("@/lib/cloudflared", () => cloudflared);
vi.mock("@/lib/portal-heartbeat", () => heartbeat);
vi.mock("@/lib/tunnel-liveness", () => liveness);
vi.mock("@/lib/named-tunnel", () => named);
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/internal-token", () => ({ isInternalRequest: vi.fn(() => true) }));

const NAMED_URL = "https://amber-otter-k7m2p9qx4w3n.clawbox.tech";

async function tick() {
  const mod = await import("@/app/setup-api/portal/heartbeat-tick/route");
  return mod.GET(new Request("http://127.0.0.1/setup-api/portal/heartbeat-tick"));
}

beforeEach(() => {
  vi.resetModules();
  liveness.mayRestart.mockReturnValue(true);
  cloudflared.startTunnelService.mockResolvedValue({ bootPersisted: true, bootPersistWarning: null });
});

afterEach(() => {
  for (const fn of [...Object.values(cloudflared), ...Object.values(heartbeat), ...Object.values(liveness), ...Object.values(named)]) {
    fn.mockReset();
  }
});

describe("heartbeat-tick — named tunnel", () => {
  it("keeps reporting an unresolved named hostname and does not restart", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue(NAMED_URL);
    liveness.checkTunnelLiveness.mockResolvedValue("dead");
    named.readTunnelMode.mockResolvedValue("named");

    const res = await tick();
    expect(await res.json()).toEqual({ ok: true, tunnel: "dead", restarted: false });
    expect(heartbeat.pushHeartbeatTick).toHaveBeenCalledWith(NAMED_URL);
    expect(cloudflared.startTunnelService).not.toHaveBeenCalled();
  });

  it("pushes a live named hostname like any other", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue(NAMED_URL);
    liveness.checkTunnelLiveness.mockResolvedValue("alive");
    named.readTunnelMode.mockResolvedValue("named");
    await tick();
    expect(heartbeat.pushHeartbeatTick).toHaveBeenCalledWith(NAMED_URL);
  });

  it("still restarts a dead QUICK tunnel instead of reporting it", async () => {
    cloudflared.readTunnelUrl.mockResolvedValue("https://gone.trycloudflare.com");
    liveness.checkTunnelLiveness.mockResolvedValue("dead");
    named.readTunnelMode.mockResolvedValue("quick");
    const res = await tick();
    expect(await res.json()).toEqual({ ok: true, tunnel: "dead", restarted: true });
    expect(heartbeat.pushHeartbeatTick).not.toHaveBeenCalled();
    expect(cloudflared.startTunnelService).toHaveBeenCalledTimes(1);
  });
});
