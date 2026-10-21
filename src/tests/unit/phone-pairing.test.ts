import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * src/lib/phone-pairing.ts — the decision's server half: a phone never gets
 * the shared key, the owner approves each phone before its code exists, and
 * each phone is revoked on its own through the core's device pairing.
 */

const mem = new Map<string, unknown>();
/** data/config.json readable (getKnown's `known`), as the real store says for any key once the file reads. */
const store = { readable: true };

vi.mock("@/lib/config-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config-store")>();
  return {
    ...actual,
    getKnown: vi.fn(async (key: string) => (store.readable ? { value: mem.get(key), known: true } : { value: undefined, known: false })),
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
    readConfigStrict: vi.fn(async () => ({})),
    runOpenclawConfigSet: vi.fn(async () => {}),
    runOpenclawConfigUnset: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/openclaw-gateway-ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-gateway-ws")>();
  return { ...actual, gatewayWsCall: vi.fn() };
});

vi.mock("@/lib/gateway-proxy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gateway-proxy")>();
  return { ...actual, getGatewayToken: vi.fn(async () => SHARED_TOKEN) };
});

import {
  ADDED_PROXIES_CONFIG_KEY,
  InviteStateError,
  SetupCodeRefusedError,
  applyPhonePairingSwitch,
  approveAsk,
  assertPerPhoneSetupCode,
  closeAllInvites,
  createInvite,
  inviteViews,
  isPhoneRecord,
  listPhoneDevices,
  mintPhoneSetupCode,
  pendingAsk,
  readPhonePairingEnabled,
  rejectInvite,
  requestOnInvite,
  requestStatus,
  revokePhone,
  NotAPhoneError,
} from "@/lib/phone-pairing";
import { INVITE_TTL_MS, MAX_LIVE_INVITES, PHONE_PAIRING_CONFIG_KEY } from "@/lib/phone-pairing-shared";
import { callGatewayRpc, readConfigStrict, runOpenclawConfigSet, runOpenclawConfigUnset } from "@/lib/openclaw-config";
import { gatewayWsCall } from "@/lib/openclaw-gateway-ws";

const SHARED_TOKEN = "shared-gateway-token-0123456789abcdef";
const HOST = "box-handle.clawbox.tech";
const PHONE_URL = `wss://${HOST}/phone-ws`;

const rpc = vi.mocked(callGatewayRpc);
const readOpenclaw = vi.mocked(readConfigStrict);
const configSet = vi.mocked(runOpenclawConfigSet);
const configUnset = vi.mocked(runOpenclawConfigUnset);

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** What the core's device.pair.setupCode really encodes (setup-code.ts, 2026.10.3). */
function coreCode(extra: Record<string, unknown> = {}): string {
  return encode({ url: PHONE_URL, bootstrapToken: "bootstrap-token-abcdefghijklmnop", expiresAtMs: 1_900_000_000_000, ...extra });
}

let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  mem.clear();
  store.readable = true;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-phone-pairing-"));
  previousRoot = process.env.CLAWBOX_ROOT;
  process.env.CLAWBOX_ROOT = root;
  readOpenclaw.mockResolvedValue({});
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("assertPerPhoneSetupCode — never the shared key", () => {
  it("accepts the core's one-phone bootstrap for the phone link", () => {
    const code = coreCode();
    expect(assertPerPhoneSetupCode(code, PHONE_URL, [SHARED_TOKEN])).toBe(code);
    expect(assertPerPhoneSetupCode(coreCode({ tlsFingerprint: "ab:cd" }), PHONE_URL, [SHARED_TOKEN])).toBeTruthy();
  });

  it("refuses a code that carries the shared token, whatever the field", () => {
    for (const code of [
      coreCode({ token: SHARED_TOKEN }),
      coreCode({ bootstrapToken: SHARED_TOKEN }),
      coreCode({ tlsFingerprint: `x${SHARED_TOKEN}` }),
      encode({ url: PHONE_URL, bootstrapToken: `${SHARED_TOKEN}-and-more` }),
    ]) {
      expect(() => assertPerPhoneSetupCode(code, PHONE_URL, [SHARED_TOKEN])).toThrow(SetupCodeRefusedError);
    }
  });

  it("refuses any field but the bootstrap ones (a password, a token, anything new)", () => {
    for (const extra of [{ password: "hunter2-hunter2" }, { token: "t" }, { auth: { token: "t" } }, { scopes: ["operator.admin"] }]) {
      expect(() => assertPerPhoneSetupCode(coreCode(extra), PHONE_URL, [])).toThrow(SetupCodeRefusedError);
    }
  });

  it("refuses a code for any address but this box's phone link", () => {
    expect(() => assertPerPhoneSetupCode(coreCode({ url: `wss://${HOST}` }), PHONE_URL, [])).toThrow(SetupCodeRefusedError);
    expect(() => assertPerPhoneSetupCode(coreCode({ urls: [PHONE_URL, "ws://10.42.0.1:18789"] }), PHONE_URL, [])).toThrow(
      SetupCodeRefusedError,
    );
    expect(assertPerPhoneSetupCode(coreCode({ urls: [PHONE_URL] }), PHONE_URL, [])).toBeTruthy();
  });

  it("refuses something that is not a setup code at all", () => {
    for (const code of [undefined, "", "not base64!", encode("a string"), encode([1]), encode({ url: PHONE_URL }), encode({ url: PHONE_URL, bootstrapToken: "short" })]) {
      expect(() => assertPerPhoneSetupCode(code, PHONE_URL, [])).toThrow(SetupCodeRefusedError);
    }
  });
});

describe("mintPhoneSetupCode", () => {
  it("asks the core for a LIMITED one-phone bootstrap for the phone link, and keeps its expiry", async () => {
    const now = 1_800_000_000_000;
    rpc.mockResolvedValue({ setupCode: coreCode(), setupId: "setup-1", expiresAtMs: now + 5 * 60_000 });
    const minted = await mintPhoneSetupCode(HOST, now);
    expect(rpc).toHaveBeenCalledWith("device.pair.setupCode", {
      publicUrl: PHONE_URL,
      bootstrapProfile: "limited",
      includeQr: false,
    });
    expect(minted).toEqual({ setupCode: coreCode(), setupId: "setup-1", expiresAtMs: now + 5 * 60_000 });
  });

  it("refuses to hand on a code the core filled with the shared token", async () => {
    rpc.mockResolvedValue({ setupCode: coreCode({ token: SHARED_TOKEN }) });
    await expect(mintPhoneSetupCode(HOST)).rejects.toBeInstanceOf(SetupCodeRefusedError);
  });
});

describe("the invite store", () => {
  const ASK = { name: "Pixel 9", platform: "android" as const, address: "203.0.113.7" };
  const MINTED = { setupCode: coreCode(), setupId: "setup-1", expiresAtMs: 0 };

  it("walks one phone from invite to code: ask, wait, approve, collect", () => {
    const now = 1_800_000_000_000;
    const { invite, expiresAtMs } = createInvite(now);
    expect(invite).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAtMs).toBe(now + INVITE_TTL_MS);
    expect(inviteViews(HOST, now).invites).toEqual([
      { invite, url: `https://${HOST}/phone-pair#${invite}`, expiresAtMs },
    ]);

    const { claim } = requestOnInvite(invite, ASK, now + 1_000);
    expect(claim).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(requestStatus(invite, claim, now + 2_000)).toMatchObject({ state: "waiting" });
    expect(inviteViews(HOST, now + 2_000).requests).toEqual([
      expect.objectContaining({ invite, name: "Pixel 9", platform: "android", address: "203.0.113.7", requestedAtMs: now + 1_000 }),
    ]);
    expect(pendingAsk(invite, now + 2_000)).toEqual({ name: "Pixel 9", platform: "android" });

    approveAsk(invite, { ...MINTED, expiresAtMs: now + 600_000 }, now + 3_000);
    expect(requestStatus(invite, claim, now + 4_000)).toEqual({ state: "approved", setupCode: MINTED.setupCode, expiresAtMs: now + 600_000 });
    expect(inviteViews(HOST, now + 4_000).approved).toEqual([
      expect.objectContaining({ invite, name: "Pixel 9", delivered: true }),
    ]);
  });

  it("gives the code only to the browser holding the claim", () => {
    const now = 1_800_000_000_000;
    const { invite } = createInvite(now);
    const { claim } = requestOnInvite(invite, ASK, now);
    approveAsk(invite, { ...MINTED, expiresAtMs: now + 600_000 }, now);
    expect(requestStatus(invite, "A".repeat(32), now)).toBeNull();
    expect(requestStatus("B".repeat(22), claim, now)).toBeNull();
    expect(requestStatus(invite, claim, now)).toMatchObject({ state: "approved" });
  });

  it("takes one ask per invite", () => {
    const { invite } = createInvite();
    requestOnInvite(invite, ASK);
    expect(() => requestOnInvite(invite, { ...ASK, name: "Someone else" })).toThrow(
      expect.objectContaining({ code: "used" }),
    );
  });

  it("refuses an unknown or expired invite", () => {
    const now = 1_800_000_000_000;
    expect(() => requestOnInvite("C".repeat(22), ASK, now)).toThrow(expect.objectContaining({ code: "unknown" }));
    const { invite } = createInvite(now);
    expect(() => requestOnInvite(invite, ASK, now + INVITE_TTL_MS + 1)).toThrow(expect.objectContaining({ code: "expired" }));
  });

  it("cannot approve an ask nobody made, or one already decided", () => {
    const { invite } = createInvite();
    expect(() => approveAsk(invite, MINTED)).toThrow(InviteStateError);
    requestOnInvite(invite, ASK);
    rejectInvite(invite);
    expect(() => approveAsk(invite, MINTED)).toThrow(expect.objectContaining({ code: "not_requested" }));
  });

  it("tells a rejected phone so, and closes an unused invite outright", () => {
    const { invite } = createInvite();
    const { claim } = requestOnInvite(invite, ASK);
    rejectInvite(invite);
    expect(requestStatus(invite, claim)).toEqual({ state: "rejected" });
    expect(requestStatus(invite, "D".repeat(32))).toBeNull();

    const unused = createInvite().invite;
    rejectInvite(unused);
    expect(inviteViews(HOST).invites.find((i) => i.invite === unused)).toBeUndefined();
  });

  it("keeps no more than a handful of invites open", () => {
    for (let i = 0; i < MAX_LIVE_INVITES; i++) createInvite();
    expect(() => createInvite()).toThrow(expect.objectContaining({ code: "too_many" }));
  });

  it("withdraws every open invite and uncollected code when the switch goes off", () => {
    const now = 1_800_000_000_000;
    const open = createInvite(now).invite;
    const asked = createInvite(now).invite;
    const { claim } = requestOnInvite(asked, ASK, now);
    approveAsk(asked, { ...MINTED, expiresAtMs: now + 600_000 }, now);
    closeAllInvites(now + 1);
    expect(inviteViews(HOST, now + 1)).toEqual({ invites: [], requests: [], approved: [] });
    expect(requestStatus(asked, claim, now + 2)).toEqual({ state: "rejected" });
    expect(() => requestOnInvite(open, ASK, now + 2)).toThrow(expect.objectContaining({ code: "used" }));
    expect(fs.readFileSync(path.join(root, "data", "phone-pairing.json"), "utf-8")).not.toContain(MINTED.setupCode);
  });

  it("starts over from a store that is not JSON instead of refusing every phone", () => {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "phone-pairing.json"), "{ half-writ");
    expect(inviteViews(HOST).invites).toEqual([]);
    expect(createInvite().invite).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("drops a code from disk once it can no longer be used, and keeps the file owner-only", () => {
    const now = 1_800_000_000_000;
    const { invite } = createInvite(now);
    const { claim } = requestOnInvite(invite, ASK, now);
    approveAsk(invite, { ...MINTED, expiresAtMs: now + 60_000 }, now);
    const file = path.join(root, "data", "phone-pairing.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf-8")).toContain(MINTED.setupCode);

    expect(requestStatus(invite, claim, now + 60_001)).toEqual({ state: "expired" });
    expect(fs.readFileSync(file, "utf-8")).not.toContain(MINTED.setupCode);
  });
});

describe("the core's device records", () => {
  const PHONE = { deviceId: "phone-1", clientId: "openclaw-ios", platform: "ios 18.1", deviceFamily: "iphone", displayName: "Ana's iPhone", connected: true, approvedAtMs: 5, lastSeenAtMs: 6 };
  const BOX = { deviceId: "box-cli", clientId: "cli", clientMode: "cli", platform: "linux" };
  const BROWSER = { deviceId: "browser-1", clientId: "openclaw-control-ui", platform: "linux x86_64" };

  it("knows a phone from the box's own devices", () => {
    expect(isPhoneRecord(PHONE)).toBe(true);
    expect(isPhoneRecord({ clientId: "openclaw-android" })).toBe(true);
    expect(isPhoneRecord({ deviceFamily: "Android" })).toBe(true);
    expect(isPhoneRecord({ platform: "android 15" })).toBe(true);
    expect(isPhoneRecord(BOX)).toBe(false);
    expect(isPhoneRecord(BROWSER)).toBe(false);
    expect(isPhoneRecord({ platform: "macos" })).toBe(false);
  });

  it("lists only phones, from device.pair.list", async () => {
    rpc.mockResolvedValue({
      paired: [PHONE, BOX, BROWSER, { ...PHONE, deviceId: "" }],
      pending: [
        { requestId: "req-1", deviceId: "phone-2", clientId: "openclaw-android", platform: "android 15", remoteIp: "203.0.113.9", ts: 7 },
        { requestId: "req-2", deviceId: "box-2", clientId: "cli" },
      ],
    });
    await expect(listPhoneDevices()).resolves.toEqual({
      paired: [{ deviceId: "phone-1", name: "Ana's iPhone", platform: "ios", connected: true, lastSeenAtMs: 6, approvedAtMs: 5 }],
      pending: [{ requestId: "req-1", deviceId: "phone-2", name: "Android phone", platform: "android", address: "203.0.113.9", requestedAtMs: 7 }],
    });
    expect(rpc).toHaveBeenCalledWith("device.pair.list", {});
  });

  it("refreshes over the gateway's own socket only, never starting the CLI", async () => {
    vi.mocked(gatewayWsCall).mockResolvedValue({ paired: [PHONE], pending: [] });
    expect((await listPhoneDevices({ poll: true })).paired).toHaveLength(1);
    expect(gatewayWsCall).toHaveBeenCalledWith("device.pair.list", {});
    expect(rpc).not.toHaveBeenCalled();
  });

  it("prefers the owner's label for a phone's name", async () => {
    rpc.mockResolvedValue({ paired: [{ ...PHONE, operatorLabel: "Kitchen phone" }], pending: [] });
    expect((await listPhoneDevices()).paired[0].name).toBe("Kitchen phone");
  });

  it("throws on an answer without its lists rather than reporting no phones", async () => {
    rpc.mockResolvedValue({ paired: [PHONE] });
    await expect(listPhoneDevices()).rejects.toThrow(/paired and pending/);
  });

  it("revokes only a phone, through device.pair.remove", async () => {
    rpc.mockImplementation(async (method: string) => (method === "device.pair.list" ? { paired: [PHONE, BOX], pending: [] } : {}));
    await revokePhone("phone-1");
    expect(rpc).toHaveBeenLastCalledWith("device.pair.remove", { deviceId: "phone-1" });
    await expect(revokePhone("box-cli")).rejects.toBeInstanceOf(NotAPhoneError);
    expect(rpc).not.toHaveBeenCalledWith("device.pair.remove", { deviceId: "box-cli" });
  });
});

describe("the switch", () => {
  it("is off until it is the boolean true", async () => {
    expect(await readPhonePairingEnabled()).toBe(false);
    mem.set(PHONE_PAIRING_CONFIG_KEY, "true");
    expect(await readPhonePairingEnabled()).toBe(false);
    mem.set(PHONE_PAIRING_CONFIG_KEY, true);
    expect(await readPhonePairingEnabled()).toBe(true);
  });

  it("on: adds the loopback proxies the gateway lacks, keeps the owner's own, and remembers what it added", async () => {
    readOpenclaw.mockResolvedValue({ gateway: { trustedProxies: ["10.42.0.5", "::1"] } } as never);
    await applyPhonePairingSwitch(true);
    expect(configSet).toHaveBeenCalledWith(["gateway.trustedProxies", JSON.stringify(["10.42.0.5", "::1", "127.0.0.1"]), "--json"]);
    expect(mem.get(ADDED_PROXIES_CONFIG_KEY)).toEqual(["127.0.0.1"]);
  });

  it("on, again: writes nothing when the list already has them", async () => {
    readOpenclaw.mockResolvedValue({ gateway: { trustedProxies: ["127.0.0.1", "::1"] } } as never);
    await applyPhonePairingSwitch(true);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("off: removes exactly what it added, and unsets the key when nothing else is left", async () => {
    readOpenclaw.mockResolvedValue({ gateway: { trustedProxies: ["127.0.0.1", "::1"] } } as never);
    mem.set(ADDED_PROXIES_CONFIG_KEY, ["127.0.0.1", "::1"]);
    await applyPhonePairingSwitch(false);
    expect(configUnset).toHaveBeenCalledWith("gateway.trustedProxies");
    expect(mem.has(ADDED_PROXIES_CONFIG_KEY)).toBe(false);
  });

  it("off: leaves the owner's own entries, including a loopback one it did not add", async () => {
    readOpenclaw.mockResolvedValue({ gateway: { trustedProxies: ["10.42.0.5", "::1", "127.0.0.1"] } } as never);
    mem.set(ADDED_PROXIES_CONFIG_KEY, ["127.0.0.1"]);
    await applyPhonePairingSwitch(false);
    expect(configSet).toHaveBeenCalledWith(["gateway.trustedProxies", JSON.stringify(["10.42.0.5", "::1"]), "--json"]);
    expect(configUnset).not.toHaveBeenCalled();
  });

  it("does not write over a gateway config it could not read", async () => {
    readOpenclaw.mockRejectedValue(new Error("EACCES"));
    await expect(applyPhonePairingSwitch(true)).rejects.toThrow("EACCES");
    expect(configSet).not.toHaveBeenCalled();
  });

  it("on: records what it adds before the gateway's list is written, so switch-off can always take it back", async () => {
    readOpenclaw.mockResolvedValue({ gateway: { trustedProxies: [] } } as never);
    const recordedAtWrite: unknown[] = [];
    configSet.mockImplementationOnce(async () => {
      recordedAtWrite.push(mem.get(ADDED_PROXIES_CONFIG_KEY));
    });
    await applyPhonePairingSwitch(true);
    expect(recordedAtWrite).toEqual([["127.0.0.1", "::1"]]);
  });

  it("off: does not read a record it could not read as nothing added", async () => {
    readOpenclaw.mockResolvedValue({ gateway: { trustedProxies: ["127.0.0.1", "::1"] } } as never);
    store.readable = false;
    await expect(applyPhonePairingSwitch(false)).rejects.toThrow("could not be read");
    expect(configSet).not.toHaveBeenCalled();
    expect(configUnset).not.toHaveBeenCalled();
  });
});
