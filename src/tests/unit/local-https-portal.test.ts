import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LocalHttpsPortalError,
  createHttpPortal,
  createStubPortal,
  localHttpsPortal,
  localHttpsPortalUrl,
  parseOrderAnswer,
  stubHostnameFor,
} from "@/lib/local-https-portal";
import { isLocalHttpsHostname, isPrivateLanIpv4 } from "@/lib/local-https-state";
import { buildCsr, generatePrivateKeyPem } from "@/lib/local-https-x509";
import { saveEnv } from "@/tests/helpers/env";
import { HOST, OTHER_HOST, leafFor, testCa } from "@/tests/helpers/local-https";

/**
 * src/lib/local-https-portal.ts — the box's half of the portal contract in
 * docs/design/local-https.md, and the stub that answers it on the box until
 * the portal does. Pinned: the requests' method, URL, bearer and body; every
 * HTTP failure as the problem code the card words; nothing outside the zone
 * accepted from the portal; and a stub that issues only for the box's own
 * name, from a CSR that proves the key.
 */

const BASE = "https://portal.test/api/portal/devices/local-https";
const DEVICE = "dev_0123456789abcdef";

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = saveEnv("PORTAL_LOCAL_HTTPS_URL", "CLAWBOX_LOCAL_HTTPS_PORTAL", "CLAWBOX_ROOT");
});
afterEach(() => restoreEnv());

function respond(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function portalWith(fetchImpl: ReturnType<typeof vi.fn>, token: string | null = "claw_test_token") {
  return createHttpPortal({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch, token: async () => token, deviceId: async () => DEVICE });
}

describe("the HTTP client", () => {
  it("PUTs the address with the box's bearer and answers the portal's hostname", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { hostname: HOST, ip: "192.168.1.20" }));
    const answer = await portalWith(fetchImpl).register("192.168.1.20");
    expect(answer).toEqual({ hostname: HOST });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BASE);
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer claw_test_token");
    expect(JSON.parse(String(init.body))).toEqual({ deviceId: DEVICE, lanIp: "192.168.1.20" });
  });

  it("refuses a hostname outside lan.clawbox.com", async () => {
    for (const hostname of ["evil.example.com", "a.b.lan.clawbox.com", "", null]) {
      const fetchImpl = vi.fn(async () => respond(200, { hostname }));
      await expect(portalWith(fetchImpl).register("192.168.1.20")).rejects.toMatchObject({ code: "portal_error" });
    }
  });

  it("POSTs the CSR and polls the order by id", async () => {
    const csr = buildCsr(generatePrivateKeyPem(), HOST);
    const chain = leafFor(testCa()).chainPem;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respond(202, { orderId: "ord_1", status: "pending", retryAfterSec: 7 }))
      .mockResolvedValueOnce(respond(200, { orderId: "ord_1", status: "valid", certificate: chain }));
    const portal = portalWith(fetchImpl);
    expect(await portal.order(HOST, csr)).toEqual({ status: "pending", orderId: "ord_1", retryAfterMs: 7_000 });
    expect(await portal.pollOrder("ord_1")).toEqual({ status: "valid", orderId: "ord_1", certificate: chain });
    const [orderUrl, orderInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(orderUrl).toBe(`${BASE}/orders`);
    expect(JSON.parse(String(orderInit.body))).toEqual({ deviceId: DEVICE, hostname: HOST, csr });
    const [pollUrl, pollInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(pollUrl).toBe(`${BASE}/orders/ord_1?deviceId=${DEVICE}`);
    expect(pollInit.method).toBe("GET");
    expect(pollInit.body).toBeUndefined();
  });

  it("never puts an unusable order id into a URL", async () => {
    const fetchImpl = vi.fn();
    expect(await portalWith(fetchImpl).pollOrder("../../etc")).toMatchObject({ status: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads a refused order as invalid, with the portal's reason", async () => {
    const fetchImpl = vi.fn(async () => respond(422, { error: "csr_names_wrong" }));
    expect(await portalWith(fetchImpl).order(HOST, "csr")).toEqual({ status: "invalid", orderId: "-", error: "csr_names_wrong" });
  });

  it("DELETEs the address when the owner switches off", async () => {
    const fetchImpl = vi.fn(async () => respond(204));
    await portalWith(fetchImpl).unregister();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BASE);
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({ deviceId: DEVICE });
  });

  it.each([
    [401, "not_paired"],
    [403, "not_paired"],
    [404, "portal_unavailable"],
    [405, "portal_unavailable"],
    [501, "portal_unavailable"],
    [500, "portal_error"],
    [503, "portal_error"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const fetchImpl = vi.fn(async () => respond(status, { error: "x" }));
    await expect(portalWith(fetchImpl).register("192.168.1.20")).rejects.toMatchObject({ code });
  });

  it("backs off a refused box for an hour and a portal without the feature for six", async () => {
    const refused = await portalWith(vi.fn(async () => respond(401))).register("192.168.1.20").catch((e) => e);
    expect(refused).toMatchObject({ code: "not_paired", retryAfterMs: 3600_000 });
    const missing = await portalWith(vi.fn(async () => respond(404))).register("192.168.1.20").catch((e) => e);
    expect(missing).toMatchObject({ code: "portal_unavailable", retryAfterMs: 6 * 3600_000 });
    // No token is the box's own state, not the portal's answer: nothing to wait out.
    const unpaired = await portalWith(vi.fn(), null).register("192.168.1.20").catch((e) => e);
    expect(unpaired.retryAfterMs).toBeUndefined();
  });

  it("carries Retry-After on a 429", async () => {
    const fetchImpl = vi.fn(async () => respond(429, {}, { "retry-after": "120" }));
    const err = await portalWith(fetchImpl).register("192.168.1.20").catch((e) => e);
    expect(err).toBeInstanceOf(LocalHttpsPortalError);
    expect(err).toMatchObject({ code: "rate_limited", retryAfterMs: 120_000 });
  });

  it("is not paired without a ClawBox token, and asks nothing", async () => {
    const fetchImpl = vi.fn();
    await expect(portalWith(fetchImpl, null).register("192.168.1.20")).rejects.toMatchObject({ code: "not_paired" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an answer far larger than any the contract has, before parsing it", async () => {
    const fetchImpl = vi.fn(async () => new Response(`{"hostname":"${"x".repeat(300 * 1024)}"}`, { status: 200 }));
    await expect(portalWith(fetchImpl).register("192.168.1.20")).rejects.toMatchObject({ code: "portal_error", message: expect.stringContaining("too large") });
  });

  it("reads a network failure as portal_error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(portalWith(fetchImpl).register("192.168.1.20")).rejects.toMatchObject({ code: "portal_error" });
  });

  it("takes its URL from PORTAL_LOCAL_HTTPS_URL, the legacy portal origin migrated", () => {
    delete process.env.PORTAL_LOCAL_HTTPS_URL;
    expect(localHttpsPortalUrl()).toBe("https://clawbox.com/api/portal/devices/local-https");
    process.env.PORTAL_LOCAL_HTTPS_URL = "https://openclawhardware.dev/api/x/";
    expect(localHttpsPortalUrl()).toBe("https://clawbox.com/api/x");
  });
});

describe("parseOrderAnswer", () => {
  it("refuses shapes the contract does not have", () => {
    expect(() => parseOrderAnswer({ status: "valid", orderId: "a" })).toThrow();
    expect(() => parseOrderAnswer({ status: "weird", orderId: "a" })).toThrow();
    expect(() => parseOrderAnswer({ status: "pending" })).toThrow();
    expect(() => parseOrderAnswer({ status: "valid", orderId: "a", certificate: "x".repeat(70_000) + "-----BEGIN CERTIFICATE-----" })).toThrow();
  });

  it("bounds the poll interval it is told", () => {
    expect(parseOrderAnswer({ status: "pending", orderId: "a", retryAfterSec: 0 })).toMatchObject({ retryAfterMs: 1_000 });
    expect(parseOrderAnswer({ status: "pending", orderId: "a", retryAfterSec: 86_400 })).toMatchObject({ retryAfterMs: 300_000 });
    expect(parseOrderAnswer({ status: "pending", orderId: "a" })).toMatchObject({ retryAfterMs: 5_000 });
  });
});

describe("the stub", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "local-https-stub-"));
    process.env.CLAWBOX_ROOT = root;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("names a box by an opaque, stable label in the zone, never the device id", () => {
    const name = stubHostnameFor(DEVICE);
    expect(isLocalHttpsHostname(name)).toBe(true);
    expect(stubHostnameFor(DEVICE)).toBe(name);
    expect(name).not.toContain("0123456789abcdef");
    expect(stubHostnameFor("dev_ffffffffffffffff")).not.toBe(name);
  });

  it("issues for the box's own name from a CSR that proves its key — pending once, then valid", async () => {
    const stub = createStubPortal({ deviceId: async () => DEVICE });
    const { hostname } = await stub.register("192.168.1.20");
    const key = generatePrivateKeyPem();
    const order = await stub.order(hostname, buildCsr(key, hostname));
    expect(order.status).toBe("pending");
    const done = await stub.pollOrder(order.orderId);
    expect(done.status).toBe("valid");
    expect(fs.statSync(path.join(root, "data", "local-https", "stub-ca.json")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(root, "data", "local-https", "stub-ca.pem"))).toBe(true);
    // An order is answered once.
    expect((await stub.pollOrder(order.orderId)).status).toBe("invalid");
  });

  it("refuses another box's name, a CSR for another name, and a public address", async () => {
    const stub = createStubPortal({ deviceId: async () => DEVICE });
    const own = stubHostnameFor(DEVICE);
    expect(await stub.order(OTHER_HOST, buildCsr(generatePrivateKeyPem(), OTHER_HOST))).toMatchObject({ status: "invalid", error: "hostname_not_yours" });
    expect(await stub.order(own, buildCsr(generatePrivateKeyPem(), OTHER_HOST))).toMatchObject({ status: "invalid", error: "csr_names_wrong" });
    expect(await stub.order(own, "not a csr")).toMatchObject({ status: "invalid" });
    await expect(stub.register("203.0.113.5")).rejects.toMatchObject({ code: "portal_error" });
  });

  it("is what localHttpsPortal() answers in stub mode, once per process", () => {
    process.env.CLAWBOX_LOCAL_HTTPS_PORTAL = "stub";
    const a = localHttpsPortal();
    expect(a.kind).toBe("stub");
    expect(localHttpsPortal()).toBe(a);
    delete process.env.CLAWBOX_LOCAL_HTTPS_PORTAL;
    expect(localHttpsPortal().kind).toBe("portal");
  });
});

describe("isPrivateLanIpv4", () => {
  it.each(["192.168.1.20", "10.0.0.5", "10.42.1.1", "172.16.0.1", "172.31.255.254"])("publishes %s", (ip) => {
    expect(isPrivateLanIpv4(ip)).toBe(true);
  });
  it.each(["10.42.0.1", "10.43.0.1", "172.32.0.1", "8.8.8.8", "100.64.0.1", "127.0.0.1", "192.168.1.256", "192.168.01.2", "fe80::1", "", null])(
    "never publishes %s",
    (ip) => {
      expect(isPrivateLanIpv4(ip)).toBe(false);
    },
  );
});
