/**
 * wifi_status (mcp/tools/system.ts).
 *
 * A real misdiagnosis on a real box: the tool promised to "report whether the
 * ClawBox is online" but proxied a WiFi-only route. On a ClawBox running off
 * an Ethernet cable with WiFi down, it answered `connected: false`, and the
 * assistant concluded the device was offline — then blamed a coding run's
 * upstream auth failure on a network that was, in fact, working. The box had
 * a default route, DNS and a 200 from the provider throughout.
 *
 * So the property under test is not "does it call the WiFi route" but: does a
 * box on a cable read as ONLINE.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock("../../../mcp/lib/api", () => ({
  apiGet,
  apiPost: vi.fn(),
  apiTry: async () => null,
  API_BASE: "http://127.0.0.1:80",
  CLAWBOX_ROOT: "/home/clawbox/clawbox",
}));

import { captureRegistrar } from "../helpers/mcp-registrar";
import { registerSystemTools } from "../../../mcp/tools/system";

const WIFI_UP = { connected: true, ssid: "Home", ip: "192.168.50.65" };
const WIFI_DOWN = { connected: false, ssid: null, ip: null };
const ETH_UP = { connected: true, cable: true, iface: "enP8p1s0" };
const ETH_DOWN = { connected: false, cable: false, iface: null };

/** Enough context for registration; wifi_status reads none of it. */
const CTX = {
  edition: "openclaw",
  install: "openclaw",
  profile: "full",
  capabilities: { screenGrabber: null, imageConvert: false, journal: false, du: true },
  providers: [],
  emailCanRead: false,
} as unknown as Parameters<typeof registerSystemTools>[1];

function harness() {
  const h = captureRegistrar("openclaw");
  registerSystemTools(h.reg, CTX);
  return h;
}

/** Answer each route independently, the way the device does. */
function routes(wifi: unknown, ethernet: unknown | Error) {
  apiGet.mockImplementation(async (path: string) => {
    if (path.startsWith("/setup-api/wifi/ethernet")) {
      if (ethernet instanceof Error) throw ethernet;
      return ethernet;
    }
    if (path.startsWith("/setup-api/wifi/status")) return wifi;
    throw new Error(`unexpected path ${path}`);
  });
}

async function status(h: ReturnType<typeof harness>) {
  const out = await h.call("wifi_status");
  return JSON.parse(out.text);
}

beforeEach(() => {
  apiGet.mockReset();
});

describe("wifi_status", () => {
  it("calls a cabled box with WiFi down ONLINE — the bug that caused the misdiagnosis", async () => {
    routes(WIFI_DOWN, ETH_UP);
    const body = await status(harness());

    expect(body.online).toBe(true);
    expect(body.connectedVia).toEqual(["ethernet"]);
    // The WiFi truth is still reported — it just no longer stands for
    // "is the device online".
    expect(body.wifi.connected).toBe(false);
    expect(body.ethernet.iface).toBe("enP8p1s0");
  });

  it("is offline only when BOTH are down", async () => {
    routes(WIFI_DOWN, ETH_DOWN);
    const body = await status(harness());
    expect(body.online).toBe(false);
    expect(body.connectedVia).toEqual([]);
  });

  it("reports both when both are up", async () => {
    routes(WIFI_UP, ETH_UP);
    const body = await status(harness());
    expect(body.online).toBe(true);
    expect(body.connectedVia).toEqual(["wifi", "ethernet"]);
    expect(body.wifi.ssid).toBe("Home");
  });

  it("still answers on WiFi alone when the ethernet route is unavailable", async () => {
    // An older device, or a route that 404s: a best-effort second call must
    // never turn a working WiFi answer into a tool failure.
    routes(WIFI_UP, new Error("no such route"));
    const body = await status(harness());
    expect(body.online).toBe(true);
    expect(body.connectedVia).toEqual(["wifi"]);
    expect(body.ethernet.unknown).toBe(true);
  });

  it("tells the agent which field decides it", async () => {
    const tool = harness().reg.list().find((t) => t.name === "wifi_status");
    expect(tool?.description).toMatch(/online/i);
    expect(tool?.description).toMatch(/ethernet/i);
  });
});
