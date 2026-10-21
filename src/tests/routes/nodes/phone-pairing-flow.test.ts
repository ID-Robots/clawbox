import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

/**
 * The /setup-api/nodes routes end to end, against the real invite store and
 * with the core's RPC mocked: the owner opens an invite, a phone asks with no
 * session, the owner approves THAT phone, and only then is a per-phone code
 * minted and handed to the browser that asked — never the shared key.
 */

const mem = new Map<string, unknown>();

vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return {
    ...actual,
    // A readable store: `known` for every key, absent ones included, as the real one answers.
    getKnown: vi.fn(async (key: string) => ({ value: mem.get(key), known: true })),
    set: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) mem.delete(key);
      else mem.set(key, value);
    }),
  };
});

vi.mock("@/lib/openclaw-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-config")>();
  return {
    ...actual,
    callGatewayRpc: vi.fn(),
    openclawIsAbsent: vi.fn(() => false),
    readConfigStrict: vi.fn(async () => ({})),
    runOpenclawConfigSet: vi.fn(async () => {}),
    runOpenclawConfigUnset: vi.fn(async () => {}),
  };
});

// The Phones panel's refresh asks the gateway's own socket only; here it
// answers from the same stand-in as every other call.
vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>();
  return {
    ...actual,
    gatewayWsCall: vi.fn(async (method: string, params: Record<string, unknown>) => {
      const { callGatewayRpc: stand } = await import("@/lib/openclaw-config");
      return stand(method, params);
    }),
  };
});

vi.mock("@/lib/named-tunnel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/named-tunnel")>();
  return {
    ...actual,
    readTunnelMode: vi.fn(async () => "named"),
    readNamedTunnelCredential: vi.fn(async () => ({ hostname: "box-handle.clawbox.tech", token: "t".repeat(40) })),
  };
});

vi.mock("@/lib/gateway-proxy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gateway-proxy")>();
  return { ...actual, getGatewayToken: vi.fn(async () => SHARED_TOKEN) };
});

import { GET as list } from "@/app/setup-api/nodes/route";
import { POST as approve } from "@/app/setup-api/nodes/approve/route";
import { POST as invite } from "@/app/setup-api/nodes/invite/route";
import { POST as reject } from "@/app/setup-api/nodes/reject/route";
import { POST as ask } from "@/app/setup-api/nodes/request/route";
import { POST as askStatus } from "@/app/setup-api/nodes/request/status/route";
import { POST as settings } from "@/app/setup-api/nodes/settings/route";
import { readNamedTunnelCredential, readTunnelMode } from "@/lib/named-tunnel";
import { callGatewayRpc, openclawIsAbsent, readConfigStrict, runOpenclawConfigSet } from "@/lib/openclaw-config";
import { ADDED_PROXIES_CONFIG_KEY } from "@/lib/phone-pairing";
import { PHONE_PAIRING_CONFIG_KEY, type PhonesState } from "@/lib/phone-pairing-shared";
import { resetRateLimit } from "@/lib/rate-limit";

const SHARED_TOKEN = "shared-gateway-token-0123456789abcdef";
const PHONE_URL = "wss://box-handle.clawbox.tech/phone-ws";
const PHONE_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile Safari/537.36";

const rpc = vi.mocked(callGatewayRpc);
const noOpenclaw = vi.mocked(openclawIsAbsent);
const tunnelMode = vi.mocked(readTunnelMode);
const tunnelCredential = vi.mocked(readNamedTunnelCredential);
const readOpenclaw = vi.mocked(readConfigStrict);
const configSet = vi.mocked(runOpenclawConfigSet);

function coreCode(extra: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({ url: PHONE_URL, bootstrapToken: "bootstrap-token-abcdefghijklmnop", expiresAtMs: Date.now() + 600_000, ...extra }),
  ).toString("base64url");
}

let session: SessionFixture;
let mintedCode: string;

beforeEach(() => {
  session = installSessionFixture();
  mem.clear();
  mem.set(PHONE_PAIRING_CONFIG_KEY, true);
  noOpenclaw.mockReturnValue(false);
  tunnelMode.mockResolvedValue("named");
  tunnelCredential.mockResolvedValue({ hostname: "box-handle.clawbox.tech", token: "t".repeat(40) });
  readOpenclaw.mockResolvedValue({});
  mintedCode = coreCode();
  rpc.mockImplementation(async (method: string) => {
    if (method === "device.pair.list") return { paired: [], pending: [] };
    if (method === "device.pair.setupCode") return { setupCode: mintedCode, setupId: "setup-1", expiresAtMs: Date.now() + 600_000 };
    return {};
  });
  for (const bucket of ["phone-pair-request", "phone-pair-status"]) {
    resetRateLimit(bucket, "lan");
    resetRateLimit(bucket, "203.0.113.7");
  }
});

afterEach(() => session.cleanup());

const BASE = "http://box-handle.clawbox.tech";

/** The owner's browser: session cookie, same origin. */
function owner(path: string, body?: unknown, method = "POST"): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      Cookie: session.cookie,
      Origin: BASE,
      Host: "box-handle.clawbox.tech",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The phone's browser through the tunnel: no session at all. */
function phone(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", "User-Agent": PHONE_UA },
    body: JSON.stringify(body),
  });
}

async function state(): Promise<PhonesState> {
  const res = await list(owner("/setup-api/nodes", undefined, "GET"));
  expect(res.status).toBe(200);
  return (await res.json()) as PhonesState;
}

async function openInvite(): Promise<string> {
  const res = await invite(owner("/setup-api/nodes/invite", {}));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.url).toBe(`https://box-handle.clawbox.tech/phone-pair#${body.invite}`);
  return body.invite as string;
}

async function phoneAsks(inv: string, name = "Pixel 9"): Promise<string> {
  const res = await ask(phone("/setup-api/nodes/request", { invite: inv, name }));
  expect(res.status).toBe(200);
  return (await res.json()).claim as string;
}

describe("one phone, from invite to its own code", () => {
  it("is asked for by the phone, approved by the owner, and collected only by that phone", async () => {
    const inv = await openInvite();
    const claim = await phoneAsks(inv);

    // Nothing is minted while the phone waits.
    expect(rpc).not.toHaveBeenCalledWith("device.pair.setupCode", expect.anything());
    const waiting = await askStatus(phone("/setup-api/nodes/request/status", { invite: inv, claim }));
    expect(await waiting.json()).toMatchObject({ state: "waiting" });

    const seen = await state();
    expect(seen.requests).toEqual([
      expect.objectContaining({ invite: inv, name: "Pixel 9", platform: "android", address: "203.0.113.7" }),
    ]);

    const approved = await approve(owner("/setup-api/nodes/approve", { invite: inv }));
    expect(approved.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("device.pair.setupCode", {
      publicUrl: PHONE_URL,
      bootstrapProfile: "limited",
      includeQr: false,
    });

    const collected = await askStatus(phone("/setup-api/nodes/request/status", { invite: inv, claim }));
    const body = await collected.json();
    expect(body).toMatchObject({ state: "approved", setupCode: mintedCode });
    const payload = JSON.parse(Buffer.from(body.setupCode, "base64url").toString("utf8"));
    expect(Object.keys(payload).sort()).toEqual(["bootstrapToken", "expiresAtMs", "url"]);
    expect(JSON.stringify(payload)).not.toContain(SHARED_TOKEN);

    // Another browser with the invite but not the claim learns nothing.
    const stranger = await askStatus(phone("/setup-api/nodes/request/status", { invite: inv, claim: "Z".repeat(32) }));
    expect(stranger.status).toBe(404);
  });

  it("hands out nothing when the core's code carries the shared key", async () => {
    mintedCode = coreCode({ token: SHARED_TOKEN });
    const inv = await openInvite();
    const claim = await phoneAsks(inv);

    const res = await approve(owner("/setup-api/nodes/approve", { invite: inv }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "unsafe_setup_code" });

    const after = await askStatus(phone("/setup-api/nodes/request/status", { invite: inv, claim }));
    expect(await after.json()).toMatchObject({ state: "waiting" });
  });

  it("tells a phone the owner turned down", async () => {
    const inv = await openInvite();
    const claim = await phoneAsks(inv);
    expect((await reject(owner("/setup-api/nodes/reject", { invite: inv }))).status).toBe(200);
    const res = await askStatus(phone("/setup-api/nodes/request/status", { invite: inv, claim }));
    expect(await res.json()).toEqual({ state: "rejected" });
    expect((await approve(owner("/setup-api/nodes/approve", { invite: inv }))).status).toBe(409);
  });

  it("lets one phone ask per invite", async () => {
    const inv = await openInvite();
    await phoneAsks(inv);
    const second = await ask(phone("/setup-api/nodes/request", { invite: inv, name: "Someone else" }));
    expect(second.status).toBe(409);
  });

  it("cannot approve an invite no phone has asked on", async () => {
    const inv = await openInvite();
    const res = await approve(owner("/setup-api/nodes/approve", { invite: inv }));
    expect(res.status).toBe(409);
    expect(rpc).not.toHaveBeenCalledWith("device.pair.setupCode", expect.anything());
  });
});

describe("a phone request the gateway itself holds", () => {
  const PENDING = { requestId: "req-1", deviceId: "phone-2", clientId: "openclaw-ios", platform: "ios 18", remoteIp: "203.0.113.9", ts: 1 };

  beforeEach(() => {
    rpc.mockImplementation(async (method: string) => {
      if (method === "device.pair.list") return { paired: [], pending: [PENDING, { requestId: "req-box", clientId: "cli" }] };
      return {};
    });
  });

  it("is approved with the core's device.pair.approve", async () => {
    expect((await approve(owner("/setup-api/nodes/approve", { requestId: "req-1" }))).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("device.pair.approve", { requestId: "req-1" });
  });

  it("is refused with the core's device.pair.reject", async () => {
    expect((await reject(owner("/setup-api/nodes/reject", { requestId: "req-1" }))).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("device.pair.reject", { requestId: "req-1" });
  });

  it("is never a request of the box's own devices", async () => {
    expect((await approve(owner("/setup-api/nodes/approve", { requestId: "req-box" }))).status).toBe(404);
    expect(rpc).not.toHaveBeenCalledWith("device.pair.approve", expect.anything());
  });

  it("must be named exactly once", async () => {
    expect((await approve(owner("/setup-api/nodes/approve", {}))).status).toBe(400);
    expect((await approve(owner("/setup-api/nodes/approve", { requestId: "req-1", invite: "A".repeat(22) }))).status).toBe(400);
    expect((await approve(owner("/setup-api/nodes/approve", { invite: "not-an-invite" }))).status).toBe(400);
  });
});

describe("GET /setup-api/nodes", () => {
  it("lists paired phones from the core, and not the box's own devices", async () => {
    rpc.mockImplementation(async () => ({
      paired: [
        { deviceId: "phone-1", clientId: "openclaw-android", platform: "android 15", displayName: "Pixel 9", connected: true },
        { deviceId: "box-cli", clientId: "cli", platform: "linux" },
      ],
      pending: [],
    }));
    const s = await state();
    expect(s).toMatchObject({ available: true, enabled: true, host: "box-handle.clawbox.tech" });
    expect(s.paired).toEqual([expect.objectContaining({ deviceId: "phone-1", name: "Pixel 9", platform: "android", connected: true })]);
  });

  it("says the gateway could not be asked rather than showing no phones", async () => {
    rpc.mockRejectedValue(new Error("gateway closed the connection"));
    const s = await state();
    expect(s.paired).toBeNull();
    expect(s.gatewayError).toContain("gateway closed the connection");
  });

  it("is owner only", async () => {
    const res = await list(new Request(`${BASE}/setup-api/nodes`));
    expect(res.status).toBe(401);
  });

  it("answers available: false on a box without OpenClaw", async () => {
    noOpenclaw.mockReturnValue(true);
    const s = await state();
    expect(s.available).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("the switch", () => {
  it("is off until the owner turns it on, and the phone's routes do not exist meanwhile", async () => {
    mem.delete(PHONE_PAIRING_CONFIG_KEY);
    expect((await invite(owner("/setup-api/nodes/invite", {}))).status).toBe(409);
    const res = await ask(phone("/setup-api/nodes/request", { invite: "A".repeat(22), name: "x" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "unavailable" });
    expect((await askStatus(phone("/setup-api/nodes/request/status", { invite: "A".repeat(22), claim: "B".repeat(32) }))).status).toBe(404);
  });

  it("on: tells the gateway to trust the box's own proxy before saving the switch", async () => {
    mem.delete(PHONE_PAIRING_CONFIG_KEY);
    const res = await settings(owner("/setup-api/nodes/settings", { enabled: true }));
    expect(res.status).toBe(200);
    expect(configSet).toHaveBeenCalledWith(["gateway.trustedProxies", JSON.stringify(["127.0.0.1", "::1"]), "--json"]);
    expect(mem.get(PHONE_PAIRING_CONFIG_KEY)).toBe(true);
    expect(mem.get(ADDED_PROXIES_CONFIG_KEY)).toEqual(["127.0.0.1", "::1"]);
  });

  it("on: stays off when the gateway could not be told", async () => {
    mem.delete(PHONE_PAIRING_CONFIG_KEY);
    configSet.mockRejectedValueOnce(new Error("config set failed"));
    const res = await settings(owner("/setup-api/nodes/settings", { enabled: true }));
    expect(res.status).toBe(502);
    expect(mem.has(PHONE_PAIRING_CONFIG_KEY)).toBe(false);
  });

  it("off: closes every open invite and waiting phone", async () => {
    const inv = await openInvite();
    const claim = await phoneAsks(await openInvite());
    expect((await settings(owner("/setup-api/nodes/settings", { enabled: false }))).status).toBe(200);
    expect(mem.get(PHONE_PAIRING_CONFIG_KEY)).toBe(false);
    mem.set(PHONE_PAIRING_CONFIG_KEY, true);
    const s = await state();
    expect(s.invites).toEqual([]);
    expect(s.requests).toEqual([]);
    expect((await ask(phone("/setup-api/nodes/request", { invite: inv, name: "late" }))).status).toBe(409);
    expect(claim).toBeTruthy();
  });

  it("off: says so, rather than ok, when the open invites could not be withdrawn", async () => {
    await openInvite();
    // The pairing store becomes unreadable: a directory where its file was.
    const storeFile = path.join(process.env.CLAWBOX_ROOT as string, "data", "phone-pairing.json");
    fs.rmSync(storeFile);
    fs.mkdirSync(storeFile);

    const res = await settings(owner("/setup-api/nodes/settings", { enabled: false }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "withdrawal_failed" });
    // The phone link is still closed: the switch was saved first.
    expect(mem.get(PHONE_PAIRING_CONFIG_KEY)).toBe(false);
  });

  it("is refused from another site and for a body that is not a boolean", async () => {
    const cross = new Request(`${BASE}/setup-api/nodes/settings`, {
      method: "POST",
      headers: { Cookie: session.cookie, Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect((await settings(cross)).status).toBe(403);
    expect((await settings(owner("/setup-api/nodes/settings", { enabled: "yes" }))).status).toBe(400);
  });
});

describe("the invite", () => {
  it("needs the permanent clawbox.tech link: a quick tunnel would strand the phone", async () => {
    tunnelMode.mockResolvedValue("quick");
    const res = await invite(owner("/setup-api/nodes/invite", {}));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "no_permanent_link" });
  });

  it("is not made when the switch went off while it was being prepared", async () => {
    tunnelMode.mockImplementationOnce(async () => {
      mem.set(PHONE_PAIRING_CONFIG_KEY, false);
      return "named";
    });
    const res = await invite(owner("/setup-api/nodes/invite", {}));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "switched_off" });
    mem.set(PHONE_PAIRING_CONFIG_KEY, true);
    expect((await state()).invites).toEqual([]);
  });

  it("refuses a phone's oversized body instead of reading it whole", async () => {
    const pad = "x".repeat(8_000);
    const asked = await ask(phone("/setup-api/nodes/request", { invite: "A".repeat(22), name: pad }));
    expect(asked.status).toBe(413);
    expect(await asked.json()).toMatchObject({ code: "too_long" });
    const polled = await askStatus(phone("/setup-api/nodes/request/status", { invite: "A".repeat(22), claim: "B".repeat(32), pad }));
    expect(polled.status).toBe(413);
  });

  it("refuses an unknown or malformed invite from a phone", async () => {
    expect((await ask(phone("/setup-api/nodes/request", { invite: "A".repeat(22) }))).status).toBe(404);
    expect((await ask(phone("/setup-api/nodes/request", { invite: "../../etc" }))).status).toBe(404);
  });

  it("rate-limits a phone's asks", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await ask(phone("/setup-api/nodes/request", { invite: "A".repeat(22) }))).status;
    }
    expect(last).toBe(429);
  });
});
