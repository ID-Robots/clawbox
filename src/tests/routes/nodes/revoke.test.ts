import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

/**
 * POST /setup-api/nodes/revoke — the owner cuts ONE paired phone off.
 *
 * Revoking is the core's own device-pairing removal (`device.pair.remove`),
 * which deletes the phone's pairing record and its tokens and disconnects its
 * live sockets. Nothing here writes the gateway's pairing store itself. The
 * route must:
 *  - answer the owner only, and only from the box's own pages;
 *  - remove exactly the phone it was asked about, never one of the box's own
 *    devices (its CLI or a browser), which the Phones list does not show;
 *  - say 200 only when the core said the phone is gone, never on a refusal;
 *  - work whether or not phone pairing is switched on, because turning the
 *    switch off must never be the thing that stops the owner revoking a phone.
 */

vi.mock("@/lib/openclaw-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-config")>();
  return { ...actual, callGatewayRpc: vi.fn(), openclawIsAbsent: vi.fn(() => false) };
});

import { POST } from "@/app/setup-api/nodes/revoke/route";
import { callGatewayRpc, openclawIsAbsent } from "@/lib/openclaw-config";

const rpc = vi.mocked(callGatewayRpc);
const noOpenclaw = vi.mocked(openclawIsAbsent);

const PHONE = {
  deviceId: "phone-device-1",
  displayName: "Pixel 9",
  platform: "android 15",
  deviceFamily: "android",
  clientId: "openclaw-android",
  clientMode: "node",
  role: "node",
  roles: ["node", "operator"],
  approvedVia: "bootstrap",
  createdAtMs: 1_700_000_000_000,
  approvedAtMs: 1_700_000_000_000,
};

/** The box's own CLI device: paired with the gateway, never a phone. */
const BOX_CLI = {
  deviceId: "box-cli-device",
  displayName: "cli",
  platform: "linux",
  clientId: "cli",
  clientMode: "cli",
  role: "operator",
  roles: ["operator"],
  createdAtMs: 1_700_000_000_000,
  approvedAtMs: 1_700_000_000_000,
};

let session: SessionFixture;

beforeEach(() => {
  session = installSessionFixture();
  noOpenclaw.mockReturnValue(false);
  rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "device.pair.list") return { pending: [], paired: [PHONE, BOX_CLI] };
    if (method === "device.pair.remove") return { deviceId: params.deviceId };
    throw new Error(`unexpected gateway call ${method}`);
  });
});

afterEach(() => session.cleanup());

function post(body: unknown, opts: { auth?: boolean; headers?: Record<string, string> } = {}): Request {
  const { auth = true, headers = {} } = opts;
  return new Request("http://localhost/setup-api/nodes/revoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Cookie: session.cookie } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function removeCalls() {
  return rpc.mock.calls.filter(([method]) => method === "device.pair.remove");
}

describe("POST /setup-api/nodes/revoke", () => {
  it("calls the core's native device.pair.remove for the owner and answers 200", async () => {
    const res = await POST(post({ deviceId: PHONE.deviceId }));

    expect(res.status).toBe(200);
    expect(removeCalls()).toEqual([["device.pair.remove", { deviceId: PHONE.deviceId }]]);
    expect(await res.json()).toMatchObject({ ok: true, deviceId: PHONE.deviceId });
  });

  it("works while phone pairing is switched off (the fixture's config has no switch)", async () => {
    const res = await POST(post({ deviceId: PHONE.deviceId }));
    expect(res.status).toBe(200);
    expect(removeCalls()).toHaveLength(1);
  });

  it("is 401 without a session and removes nothing", async () => {
    const res = await POST(post({ deviceId: PHONE.deviceId }, { auth: false }));
    expect(res.status).toBe(401);
    expect(removeCalls()).toHaveLength(0);
  });

  it("refuses a cross-site page riding the owner's cookie", async () => {
    const res = await POST(post({ deviceId: PHONE.deviceId }, { headers: { Origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    expect(removeCalls()).toHaveLength(0);
  });

  it("is 400 for a body without a usable deviceId", async () => {
    for (const body of [{}, { deviceId: "" }, { deviceId: 42 }, { deviceId: "x".repeat(300) }, "not json"]) {
      const res = await POST(post(body));
      expect(res.status).toBe(400);
    }
    expect(removeCalls()).toHaveLength(0);
  });

  it("will not remove one of the box's own devices: only a paired phone", async () => {
    const res = await POST(post({ deviceId: BOX_CLI.deviceId }));
    expect(res.status).toBe(404);
    expect(removeCalls()).toHaveLength(0);
  });

  it("is 404 for a phone the gateway does not have", async () => {
    const res = await POST(post({ deviceId: "never-paired" }));
    expect(res.status).toBe(404);
    expect(removeCalls()).toHaveLength(0);
  });

  it("is a 502 carrying the core's words when the removal is refused — never a 200", async () => {
    rpc.mockImplementation(async (method: string) => {
      if (method === "device.pair.list") return { pending: [], paired: [PHONE] };
      throw new Error("unknown deviceId");
    });
    const res = await POST(post({ deviceId: PHONE.deviceId }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("unknown deviceId") });
  });

  it("is a 502 when the gateway cannot list its devices, and removes nothing", async () => {
    rpc.mockImplementation(async () => {
      throw new Error("gateway closed the connection");
    });
    const res = await POST(post({ deviceId: PHONE.deviceId }));
    expect(res.status).toBe(502);
    expect(removeCalls()).toHaveLength(0);
  });

  it("is 409 on a box without OpenClaw (Hermes edition) and calls nothing", async () => {
    noOpenclaw.mockReturnValue(true);
    const res = await POST(post({ deviceId: PHONE.deviceId }));
    expect(res.status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });
});
