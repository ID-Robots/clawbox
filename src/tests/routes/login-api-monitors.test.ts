import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorStatus, MonitorView } from "@/lib/monitors";

/**
 * GET /login-api/monitors (TASK-2850): where the monitors are, for /login,
 * asked with no session. Only the box's own screen (a loopback peer that is not
 * the tunnel) is answered, and only the geometry: no make, model, serial,
 * connector, mode or trial. The real tunnel test and loopback rule; only the
 * compositor read is a stand-in.
 */

const { getMonitorStatus } = vi.hoisted(() => ({ getMonitorStatus: vi.fn<() => Promise<MonitorStatus>>() }));
vi.mock("@/lib/monitors", () => ({ getMonitorStatus }));

import { GET } from "@/app/login-api/monitors/route";

function view(id: string, label: string, name: string, rect: MonitorView["rect"]): MonitorView {
  return {
    id,
    name,
    label,
    builtIn: name.startsWith("eDP"),
    enabled: rect !== null,
    modes: [],
    current: rect ? { width: rect.width, height: rect.height, refresh: 60 } : null,
    scale: 1,
    transform: "normal",
    rect,
    physicalSize: { width: 600, height: 340 },
    adaptiveSync: false,
  };
}

/** Two monitors in a row, the main one on the right, the built-in panel off. */
const ROW: MonitorStatus = {
  available: true,
  monitors: [
    view("Acme|M27|SN0001", "Acme M27", "HDMI-A-1", { x: 0, y: 0, width: 2560, height: 1440 }),
    view("Globex|G24|SN0002", "Globex G24", "DP-2", { x: 2560, y: 0, width: 1920, height: 1080 }),
    view("Acme|P14|@eDP-1", "Built-in screen", "eDP-1", null),
  ],
  order: ["Acme|M27|SN0001", "Globex|G24|SN0002", "Acme|P14|@eDP-1"],
  main: "Globex|G24|SN0002",
  box: { width: 4480, height: 1440 },
  pending: { deadline: 1_700_000_000_000 },
  mirror: false,
};

const ask = (headers: Record<string, string>) => GET(new Request("http://localhost/login-api/monitors", { headers }));

beforeEach(() => {
  getMonitorStatus.mockReset();
  getMonitorStatus.mockResolvedValue(ROW);
});

describe("GET /login-api/monitors", () => {
  it("answers the box's own screen the geometry alone, uncached", async () => {
    const res = await ask({ "x-clawbox-peer": "127.0.0.1" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      available: true,
      main: "2",
      box: { width: 4480, height: 1440 },
      mirror: false,
      monitors: [
        { id: "1", label: "", enabled: true, rect: { x: 0, y: 0, width: 2560, height: 1440 } },
        { id: "2", label: "", enabled: true, rect: { x: 2560, y: 0, width: 1920, height: 1080 } },
      ],
    });
    for (const secret of ["Acme", "Globex", "SN000", "HDMI", "DP-2", "eDP", "Built-in", "deadline", "modes", "physicalSize"]) {
      expect(text).not.toContain(secret);
    }
  });

  it.each(["::1", "127.0.1.1"])("takes %s for loopback too", async (peer) => {
    expect((await (await ask({ "x-clawbox-peer": peer })).json()).available).toBe(true);
  });

  it.each([
    ["a request no guard attributed (next dev)", {}],
    ["a browser on the LAN", { "x-clawbox-peer": "198.51.100.20" }],
    ["the tunnel, which connects from loopback", { "x-clawbox-peer": "127.0.0.1", "cf-connecting-ip": "203.0.113.7" }],
    ["the tunnel over IPv6", { "x-clawbox-peer": "::1", "cf-connecting-ipv6": "2001:db8::7" }],
  ])("answers %s `available: false`, and reads no monitors", async (_label, headers) => {
    const res = await ask(headers);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ available: false });
    expect(getMonitorStatus).not.toHaveBeenCalled();
  });

  it("answers a box with no monitor session `available: false`", async () => {
    getMonitorStatus.mockResolvedValue({ available: false, monitors: [], order: [], main: null, box: null, pending: null, mirror: false });
    expect(await (await ask({ "x-clawbox-peer": "127.0.0.1" })).json()).toEqual({ available: false });
  });
});
