import crypto from "crypto";
import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type LocalHttpsDeps,
  DNS_PUBLISH_GRACE_MS,
  DNS_UNSETTLED_RECHECK_MS,
  ORDER_RETRY_MS,
  ORDER_TIMEOUT_MS,
  PASS_INTERVAL_MS,
  defaultTrustedRoots,
  dnsVerdict,
  inspectCertificate,
  localHttpsStatus,
  nextPassDelay,
  renewAt,
  resetLocalHttpsJobForTests,
  runLocalHttpsPass,
  setLocalHttpsEnabled,
  triggerLocalHttpsPass,
} from "@/lib/local-https";
import { type LocalHttpsPortal, LocalHttpsPortalError, createStubPortal } from "@/lib/local-https-portal";
import { EMPTY_LOCAL_HTTPS_STATE, readLocalHttpsState, writeLocalHttpsState } from "@/lib/local-https-state";
import { generatePrivateKeyPem, issueCertificate, parseCsr } from "@/lib/local-https-x509";
import { saveEnv } from "@/tests/helpers/env";
import { DAY, HOST, OTHER_HOST, type TestCa, leafFor, testCa } from "@/tests/helpers/local-https";

/**
 * src/lib/local-https.ts — the boot/renew job. Pinned: the order → poll →
 * install cycle with the box's own key; renewal at a third of the lifetime;
 * an IP change re-reported and a new hostname dropping the old certificate;
 * each portal failure as a problem the card can word, a Retry-After honoured,
 * and a still-valid certificate kept through all of it; switching off deleting
 * the key at once and telling the portal until it answers; and a pass that
 * was running when the owner switched never writing the old choice back.
 */

const LAN_IP = "192.168.1.20";

let root: string;
let restoreEnv: () => void;
let clock: number;

beforeEach(() => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "CLAWBOX_LOCAL_HTTPS_PORTAL");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "local-https-job-"));
  process.env.CLAWBOX_ROOT = root;
  delete process.env.CLAWBOX_LOCAL_HTTPS_PORTAL;
  clock = Date.now();
  resetLocalHttpsJobForTests();
});

afterEach(() => {
  resetLocalHttpsJobForTests();
  fs.rmSync(root, { recursive: true, force: true });
  restoreEnv();
});

const dir = () => path.join(root, "data", "local-https");
const tlsFile = () => path.join(dir(), "tls.json");
const orderKeyFile = () => path.join(dir(), "order-key.pem");

/** A portal that issues from `ca` for whatever key the CSR carries — pending once, then valid. */
function fakePortal(ca: TestCa, over: Partial<LocalHttpsPortal> = {}) {
  let issued = "";
  const portal = {
    kind: "portal" as const,
    /** The CA the test trusts for it (see depsFor). */
    ca,
    register: vi.fn(async (ip: string) => {
      expect(ip).toMatch(/^192\.168\./);
      return { hostname: HOST };
    }),
    order: vi.fn(async (hostname: string, csr: string) => {
      const { publicKey, dnsNames } = parseCsr(csr);
      expect(dnsNames).toEqual([hostname]);
      issued =
        issueCertificate({
          subjectPublicKey: publicKey,
          commonName: hostname,
          dnsName: hostname,
          notBefore: new Date(clock - 60_000),
          notAfter: new Date(clock + 90 * DAY),
          issuer: { commonName: ca.name, privateKeyPem: ca.keyPem },
        }) + ca.certPem;
      return { status: "pending" as const, orderId: "order-1", retryAfterMs: 2_000 };
    }),
    pollOrder: vi.fn(async (orderId: string) => ({ status: "valid" as const, orderId, certificate: issued })),
    unregister: vi.fn(async () => {}),
  };
  // `over` replaces some of the mocks; the result keeps their mock types.
  return { ...portal, ...over } as typeof portal;
}

type TestDeps = LocalHttpsDeps & { refreshListener: ReturnType<typeof vi.fn>; lookup: ReturnType<typeof vi.fn> };

/** The box's deps around `portal`: the router answers this box's address, and the portal's CA is trusted. */
function depsFor(portal: LocalHttpsPortal & { ca?: TestCa }, over: Partial<LocalHttpsDeps> = {}): TestDeps {
  return {
    portal,
    lanIp: async () => LAN_IP,
    now: () => clock,
    lookup: vi.fn(async () => [LAN_IP]),
    trustedRoots: async () => (portal.ca ? [new crypto.X509Certificate(portal.ca.certPem)] : []),
    refreshListener: vi.fn(),
    ...over,
  } as TestDeps;
}

async function turnOnAndInstall(deps: LocalHttpsDeps) {
  await setLocalHttpsEnabled(true, { deps, waitMs: 5_000 });
  clock += 2_001;
  await runLocalHttpsPass(deps);
}

describe("a pass while off", () => {
  it("does nothing and asks the portal nothing", async () => {
    const portal = fakePortal(testCa());
    const state = await runLocalHttpsPass(depsFor(portal));
    expect(state.enabled).toBe(false);
    expect(portal.register).not.toHaveBeenCalled();
    expect(portal.unregister).not.toHaveBeenCalled();
  });
});

describe("switching on", () => {
  it("reports the address, orders with a fresh key, polls, and installs the certificate 0600", async () => {
    const portal = fakePortal(testCa());
    const deps = depsFor(portal);
    const status = await setLocalHttpsEnabled(true, { deps, waitMs: 5_000 });

    expect(portal.register).toHaveBeenCalledWith(LAN_IP);
    expect(portal.order).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({ enabled: true, hostname: HOST, url: `https://${HOST}`, lanIp: LAN_IP, issuing: true, serving: false, problem: null });
    expect(fs.existsSync(orderKeyFile())).toBe(true);
    expect(fs.statSync(orderKeyFile()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(tlsFile())).toBe(false);

    // Not yet: the portal said 2 s.
    await runLocalHttpsPass(deps);
    expect(portal.pollOrder).not.toHaveBeenCalled();

    clock += 2_001;
    const state = await runLocalHttpsPass(deps);
    expect(portal.pollOrder).toHaveBeenCalledWith("order-1");
    expect(state.order).toBeNull();
    expect(state.problem).toBeNull();
    expect(state.certNotAfter).toBeGreaterThan(clock + 89 * DAY);
    expect(fs.existsSync(orderKeyFile())).toBe(false);
    expect(fs.statSync(tlsFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir(), "state.json")).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(fs.readFileSync(tlsFile(), "utf-8"));
    expect(stored.hostname).toBe(HOST);
    expect(inspectCertificate(stored.cert, stored.key, HOST, clock, await deps.trustedRoots()).ok).toBe(true);
    // Checked on the first pass, as soon as the name was known — the router only.
    expect(state.dns).toMatchObject({ ip: LAN_IP, verdict: "ok" });
    expect(deps.lookup).toHaveBeenCalledWith(HOST);
    expect(deps.refreshListener).toHaveBeenCalled();
  });

  it("is quiet once installed: no portal call until something is due", async () => {
    const portal = fakePortal(testCa());
    const deps = depsFor(portal);
    await turnOnAndInstall(deps);
    portal.register.mockClear();
    portal.order.mockClear();
    deps.lookup.mockClear();
    clock += PASS_INTERVAL_MS;
    await runLocalHttpsPass(deps);
    expect(portal.register).not.toHaveBeenCalled();
    expect(portal.order).not.toHaveBeenCalled();
    expect(deps.lookup).not.toHaveBeenCalled();
  });

  it("re-reports an unchanged address once a day", async () => {
    const portal = fakePortal(testCa());
    const deps = depsFor(portal);
    await turnOnAndInstall(deps);
    portal.register.mockClear();
    clock += DAY + 1;
    await runLocalHttpsPass(deps);
    expect(portal.register).toHaveBeenCalledTimes(1);
  });
});

describe("renewal", () => {
  it("orders again with a NEW key once a third of the lifetime is left, serving the old one meanwhile", async () => {
    const portal = fakePortal(testCa());
    const deps = depsFor(portal);
    await turnOnAndInstall(deps);
    const first = JSON.parse(fs.readFileSync(tlsFile(), "utf-8"));
    const state = await readLocalHttpsState();
    const due = renewAt(state.certNotBefore!, state.certNotAfter!);
    expect(state.certNotAfter! - due).toBeGreaterThanOrEqual(29 * DAY);

    portal.order.mockClear();
    clock = due - 1;
    await runLocalHttpsPass(deps);
    expect(portal.order).not.toHaveBeenCalled();

    clock = due + 1;
    await runLocalHttpsPass(deps);
    expect(portal.order).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(tlsFile(), "utf-8")).key).toBe(first.key);

    clock += 2_001;
    await runLocalHttpsPass(deps);
    const second = JSON.parse(fs.readFileSync(tlsFile(), "utf-8"));
    expect(second.key).not.toBe(first.key);
    expect(second.cert).not.toBe(first.cert);
  });
});

describe("the address", () => {
  it("is reported again when the LAN IP changes, keeping the certificate for the same name", async () => {
    const portal = fakePortal(testCa());
    let ip = LAN_IP;
    const deps = depsFor(portal, { lanIp: async () => ip });
    await turnOnAndInstall(deps);
    portal.register.mockClear();
    portal.order.mockClear();
    ip = "192.168.1.77";
    clock += PASS_INTERVAL_MS;
    const state = await runLocalHttpsPass(deps);
    expect(portal.register).toHaveBeenCalledWith("192.168.1.77");
    expect(portal.order).not.toHaveBeenCalled();
    expect(state.reportedIp).toBe("192.168.1.77");
    expect(state.dns?.ip).toBe("192.168.1.77");
    expect(fs.existsSync(tlsFile())).toBe(true);
  });

  it("drops the old certificate when the portal answers a different name", async () => {
    let hostname = HOST;
    const ca = testCa();
    const portal = fakePortal(ca, { register: vi.fn(async () => ({ hostname })) });
    let ip = LAN_IP;
    const deps = depsFor(portal, { lanIp: async () => ip });
    await turnOnAndInstall(deps);
    hostname = OTHER_HOST;
    ip = "192.168.1.99";
    clock += PASS_INTERVAL_MS;
    const state = await runLocalHttpsPass(deps);
    expect(state.hostname).toBe(OTHER_HOST);
    expect(fs.existsSync(tlsFile())).toBe(false);
    expect(portal.order).toHaveBeenLastCalledWith(OTHER_HOST, expect.stringContaining("CERTIFICATE REQUEST"));
  });

  it("never sends an address that is not on the home network, and keeps serving meanwhile", async () => {
    const portal = fakePortal(testCa());
    let ip: string | null = LAN_IP;
    const deps = depsFor(portal, { lanIp: async () => ip });
    await turnOnAndInstall(deps);
    portal.register.mockClear();
    for (const bad of [null, "203.0.113.9", "10.42.0.1"]) {
      ip = bad;
      clock += PASS_INTERVAL_MS;
      const state = await runLocalHttpsPass(deps);
      expect(state.problem?.code).toBe("no_lan_ip");
    }
    expect(portal.register).not.toHaveBeenCalled();
    expect(fs.existsSync(tlsFile())).toBe(true);
  });
});

describe("problems", () => {
  it.each([
    ["not_paired", new LocalHttpsPortalError("not_paired", "no account")],
    ["portal_unavailable", new LocalHttpsPortalError("portal_unavailable", "404")],
    ["portal_error", new LocalHttpsPortalError("portal_error", "502")],
    ["portal_error", new Error("socket hang up")],
  ])("records %s and keeps the switch on", async (code, err) => {
    const portal = fakePortal(testCa(), { register: vi.fn(async () => { throw err; }) });
    const status = await setLocalHttpsEnabled(true, { deps: depsFor(portal), waitMs: 5_000 });
    expect(status.enabled).toBe(true);
    expect(status.problem?.code).toBe(code);
    expect(status.serving).toBe(false);
  });

  it("keeps the first time a problem was seen while it lasts", async () => {
    const portal = fakePortal(testCa(), { register: vi.fn(async () => { throw new LocalHttpsPortalError("portal_unavailable", "404"); }) });
    const deps = depsFor(portal);
    await setLocalHttpsEnabled(true, { deps, waitMs: 5_000 });
    const since = (await readLocalHttpsState()).problem!.at;
    clock += PASS_INTERVAL_MS;
    await runLocalHttpsPass(deps);
    expect((await readLocalHttpsState()).problem!.at).toBe(since);
  });

  it("waits out the portal's Retry-After", async () => {
    const register = vi.fn(async () => {
      throw new LocalHttpsPortalError("rate_limited", "slow down", 30 * 60_000);
    });
    const deps = depsFor(fakePortal(testCa(), { register }));
    await setLocalHttpsEnabled(true, { deps, waitMs: 5_000 });
    const state = await readLocalHttpsState();
    expect(state.problem?.code).toBe("rate_limited");
    expect(state.retryAt).toBe(clock + 30 * 60_000);
    expect(nextPassDelay(state, clock)).toBe(PASS_INTERVAL_MS);
    clock += 10 * 60_000;
    await runLocalHttpsPass(deps);
    expect(register).toHaveBeenCalledTimes(1);
    clock += 21 * 60_000;
    await runLocalHttpsPass(deps);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("refuses a certificate for another key, and orders again later", async () => {
    const ca = testCa();
    const stranger = leafFor(ca);
    const portal = fakePortal(ca, { pollOrder: vi.fn(async (orderId: string) => ({ status: "valid" as const, orderId, certificate: stranger.chainPem })) });
    const deps = depsFor(portal);
    await setLocalHttpsEnabled(true, { deps, waitMs: 5_000 });
    clock += 2_001;
    const state = await runLocalHttpsPass(deps);
    expect(state.problem).toMatchObject({ code: "bad_certificate", detail: "does not match the box's key" });
    expect(fs.existsSync(tlsFile())).toBe(false);
    expect(fs.existsSync(orderKeyFile())).toBe(false);
    // Not at the next pass: an hour later (Let's Encrypt's duplicate limit).
    clock += PASS_INTERVAL_MS;
    await runLocalHttpsPass(deps);
    expect(portal.order).toHaveBeenCalledTimes(1);
    clock += ORDER_RETRY_MS;
    await runLocalHttpsPass(deps);
    expect(portal.order).toHaveBeenCalledTimes(2);
  });

  it("refuses a certificate no trusted authority issued — Let's Encrypt staging, say — and orders again later", async () => {
    const portal = fakePortal(testCa());
    const deps = depsFor(portal, { trustedRoots: async () => [] });
    await setLocalHttpsEnabled(true, { deps, waitMs: 5_000 });
    clock += 2_001;
    const state = await runLocalHttpsPass(deps);
    expect(state.problem).toMatchObject({ code: "bad_certificate", detail: "not issued by a trusted authority" });
    expect(state.retryAt).toBe(clock + ORDER_RETRY_MS);
    expect(fs.existsSync(tlsFile())).toBe(false);
  });

  it("replaces an installed certificate that stopped passing the listener's rules", async () => {
    const portal = fakePortal(testCa());
    let roots: crypto.X509Certificate[] = [new crypto.X509Certificate(portal.ca.certPem)];
    const deps = depsFor(portal, { trustedRoots: async () => roots });
    await turnOnAndInstall(deps);
    portal.order.mockClear();
    roots = [new crypto.X509Certificate(testCa("another root").certPem)];
    clock += PASS_INTERVAL_MS;
    const state = await runLocalHttpsPass(deps);
    expect(portal.order).toHaveBeenCalledTimes(1);
    expect(state.certNotAfter).toBeNull();
  });

  it("records an order the portal could not fill", async () => {
    const portal = fakePortal(testCa(), {
      pollOrder: vi.fn(async (orderId: string) => ({ status: "invalid" as const, orderId, error: "dns-01 challenge failed" })),
    });
    const deps = depsFor(portal);
    await setLocalHttpsEnabled(true, { deps, waitMs: 5_000 });
    clock += 2_001;
    const state = await runLocalHttpsPass(deps);
    expect(state.problem).toMatchObject({ code: "order_failed", detail: "dns-01 challenge failed" });
    expect(state.order).toBeNull();
    expect(state.retryAt).toBe(clock + ORDER_RETRY_MS);
    // The owner's switch retries at once.
    portal.order.mockClear();
    await setLocalHttpsEnabled(true, { deps, waitMs: 5_000 });
    expect(portal.order).toHaveBeenCalledTimes(1);
  });

  it("abandons an order the portal never finishes", async () => {
    const portal = fakePortal(testCa(), {
      pollOrder: vi.fn(async (orderId: string) => ({ status: "pending" as const, orderId, retryAfterMs: 60_000 })),
    });
    const deps = depsFor(portal);
    await setLocalHttpsEnabled(true, { deps, waitMs: 5_000 });
    clock += 2_001;
    await runLocalHttpsPass(deps);
    expect((await readLocalHttpsState()).order?.id).toBe("order-1");
    clock += ORDER_TIMEOUT_MS;
    const state = await runLocalHttpsPass(deps);
    expect(state.order).toBeNull();
    expect(state.problem?.code).toBe("order_failed");
  });
});

describe("switching off", () => {
  it("deletes the key at once, tells the portal, and forgets the name", async () => {
    const portal = fakePortal(testCa());
    const deps = depsFor(portal);
    await turnOnAndInstall(deps);
    deps.refreshListener.mockClear();
    const status = await setLocalHttpsEnabled(false, { deps, waitMs: 5_000 });
    expect(fs.existsSync(tlsFile())).toBe(false);
    expect(deps.refreshListener).toHaveBeenCalled();
    expect(portal.unregister).toHaveBeenCalledTimes(1);
    expect(status).toMatchObject({ enabled: false, hostname: null, url: null, lanIp: null, unregisterPending: false });
    const state = await readLocalHttpsState();
    expect(state).toMatchObject({ ...EMPTY_LOCAL_HTTPS_STATE, lastCheckAt: expect.any(Number) });
  });

  it("keeps telling the portal until it answers", async () => {
    let fail = true;
    const unregister = vi.fn(async () => {
      if (fail) throw new LocalHttpsPortalError("portal_error", "502");
    });
    const portal = fakePortal(testCa(), { unregister });
    const deps = depsFor(portal);
    await turnOnAndInstall(deps);
    await setLocalHttpsEnabled(false, { deps, waitMs: 5_000 });
    expect((await readLocalHttpsState()).unregisterPending).toBe(true);
    fail = false;
    await runLocalHttpsPass(deps);
    expect(unregister).toHaveBeenCalledTimes(2);
    expect((await readLocalHttpsState()).unregisterPending).toBe(false);
  });

  it("treats a portal without the feature as having nothing to take down", async () => {
    const portal = fakePortal(testCa(), {
      register: vi.fn(async () => ({ hostname: HOST })),
      unregister: vi.fn(async () => { throw new LocalHttpsPortalError("portal_unavailable", "404"); }),
    });
    const deps = depsFor(portal);
    await turnOnAndInstall(deps);
    await setLocalHttpsEnabled(false, { deps, waitMs: 5_000 });
    expect((await readLocalHttpsState()).unregisterPending).toBe(false);
  });

  it("asks the portal to drop the address even when the switch came before the name was saved", async () => {
    const portal = fakePortal(testCa());
    const deps = depsFor(portal);
    // On, a register in flight, nothing saved back yet.
    await writeLocalHttpsState({ ...EMPTY_LOCAL_HTTPS_STATE, enabled: true });
    await setLocalHttpsEnabled(false, { deps, waitMs: 5_000 });
    expect(portal.unregister).toHaveBeenCalledTimes(1);
  });

  it("writes nothing and asks nothing on a box that never turned it on", async () => {
    const portal = fakePortal(testCa());
    const deps = depsFor(portal);
    for (let i = 0; i < 3; i++) {
      clock += PASS_INTERVAL_MS;
      await runLocalHttpsPass(deps);
    }
    expect(fs.existsSync(path.join(dir(), "state.json"))).toBe(false);
    expect(portal.unregister).not.toHaveBeenCalled();
    expect(deps.refreshListener).not.toHaveBeenCalled();
  });

  it("is not undone by a pass that was already running for 'on'", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const register = vi.fn(async () => {
      await gate;
      return { hostname: HOST };
    });
    const portal = fakePortal(testCa(), { register });
    const deps = depsFor(portal);
    await writeLocalHttpsState({ ...EMPTY_LOCAL_HTTPS_STATE, enabled: true });
    const running = triggerLocalHttpsPass(deps);
    await vi.waitFor(() => expect(register).toHaveBeenCalled());

    const off = setLocalHttpsEnabled(false, { deps, waitMs: 5_000 });
    release();
    await running;
    await off;
    const state = await readLocalHttpsState();
    expect(state.enabled).toBe(false);
    expect(state.hostname).toBeNull();
    expect(fs.existsSync(tlsFile())).toBe(false);
    // Stopped before its next side effect: no order (no certificate in CT), no key.
    expect(portal.order).not.toHaveBeenCalled();
    expect(fs.existsSync(orderKeyFile())).toBe(false);
    // …and the address it had published is taken down.
    expect(portal.unregister).toHaveBeenCalled();
  });
});

describe("DNS", () => {
  it("is pending right after publishing, rebind protection once a router still says no after the grace", async () => {
    const portal = fakePortal(testCa());
    const deps = depsFor(portal, { lookup: vi.fn(async () => "nxdomain" as const) });
    await turnOnAndInstall(deps);
    expect((await readLocalHttpsState()).dns?.verdict).toBe("pending");
    clock += DNS_UNSETTLED_RECHECK_MS + DNS_PUBLISH_GRACE_MS;
    const state = await runLocalHttpsPass(deps);
    expect(state.dns?.verdict).toBe("rebind_blocked");
    expect((await localHttpsStatus()).dns).toBe("rebind_blocked");
  });

  it("asks again soon while the answer is unsettled, and rarely once it is", async () => {
    const portal = fakePortal(testCa());
    const lookup = vi.fn(async (): Promise<string[] | "error"> => "error");
    const deps = depsFor(portal, { lookup });
    await turnOnAndInstall(deps);
    expect((await readLocalHttpsState()).dns?.verdict).toBe("unknown");
    lookup.mockResolvedValue([LAN_IP]);
    clock += DNS_UNSETTLED_RECHECK_MS;
    expect((await runLocalHttpsPass(deps)).dns?.verdict).toBe("ok");
    lookup.mockClear();
    clock += DNS_UNSETTLED_RECHECK_MS;
    await runLocalHttpsPass(deps);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("the queue", () => {
  it("runs passes one at a time and folds callers that arrive while one is queued", async () => {
    let active = 0;
    let peak = 0;
    const lanIp = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return LAN_IP;
    });
    const deps = depsFor(fakePortal(testCa()), { lanIp });
    await writeLocalHttpsState({ ...EMPTY_LOCAL_HTTPS_STATE, enabled: true });
    // Callers before the first pass has started share it.
    const a = triggerLocalHttpsPass(deps);
    expect(triggerLocalHttpsPass(deps)).toBe(a);
    await vi.waitFor(() => expect(lanIp).toHaveBeenCalledTimes(1));
    // Once it runs, the next callers queue ONE pass behind it.
    const b = triggerLocalHttpsPass(deps);
    const c = triggerLocalHttpsPass(deps);
    expect(b).not.toBe(a);
    expect(c).toBe(b);
    await Promise.all([a, b, c]);
    expect(peak).toBe(1);
    expect(lanIp).toHaveBeenCalledTimes(2);
  });
});

describe("with the stub portal", () => {
  it("runs the whole cycle on the box, and scripts/local-https.js serves the result", async () => {
    process.env.CLAWBOX_LOCAL_HTTPS_PORTAL = "stub";
    const portal = createStubPortal({ deviceId: async () => "dev_0123456789abcdef", now: () => clock });
    // The box's own roots: Node's store plus the stub CA, read from stub-ca.pem.
    const deps = depsFor(portal, { trustedRoots: defaultTrustedRoots });
    await setLocalHttpsEnabled(true, { deps, waitMs: 5_000 });
    clock += 2_001;
    const state = await runLocalHttpsPass(deps);
    expect(state.problem).toBeNull();
    expect(state.stubPortal).toBe(true);
    expect(state.dns).toBeNull();
    expect(deps.lookup).not.toHaveBeenCalled();
    expect((await localHttpsStatus()).portal).toBe("stub");

    const lib = createRequire(import.meta.url)(path.resolve(process.cwd(), "scripts/local-https.js")) as {
      loadLocalHttpsMaterial: (o: { root: string }) => { ok: boolean; hostname?: string; reason?: string };
    };
    const material = lib.loadLocalHttpsMaterial({ root });
    expect(material).toMatchObject({ ok: true, hostname: state.hostname });
  });
});

describe("rules", () => {
  it("dnsVerdict calls it rebind protection only for a definite no, long after publishing", () => {
    const later = DNS_PUBLISH_GRACE_MS;
    expect(dnsVerdict([LAN_IP], LAN_IP, 0)).toBe("ok");
    expect(dnsVerdict(["192.168.1.5"], LAN_IP, later)).toBe("stale");
    expect(dnsVerdict("nxdomain", LAN_IP, later)).toBe("rebind_blocked");
    expect(dnsVerdict("nxdomain", LAN_IP, later - 1)).toBe("pending");
    // A lookup that merely failed says nothing about the router's settings.
    expect(dnsVerdict("error", LAN_IP, later)).toBe("unknown");
  });

  it("renewAt is a third of the lifetime before the end", () => {
    expect(renewAt(0, 90 * DAY)).toBe(60 * DAY);
    expect(renewAt(0, 45 * DAY)).toBe(30 * DAY);
  });

  it("nextPassDelay polls a pending order sooner and never runs hot", () => {
    const base = { ...EMPTY_LOCAL_HTTPS_STATE, enabled: true };
    expect(nextPassDelay(base, 0)).toBe(PASS_INTERVAL_MS);
    expect(nextPassDelay({ ...base, order: { id: "x", startedAt: 0, nextPollAt: 2_000 } }, 0)).toBe(2_000);
    expect(nextPassDelay({ ...base, order: { id: "x", startedAt: 0, nextPollAt: 10 } }, 0)).toBe(1_000);
    expect(nextPassDelay({ ...base, retryAt: 60_000 }, 0)).toBe(60_000);
  });

  it("inspectCertificate applies the listener's rules and names what is wrong", () => {
    const ca = testCa();
    const roots = [new crypto.X509Certificate(ca.certPem)];
    const leaf = leafFor(ca);
    const now = Date.now();
    const check = (cert: string, key: string, host = HOST, at = now, r = roots) => inspectCertificate(cert, key, host, at, r);
    expect(check(leaf.chainPem, leaf.keyPem).ok).toBe(true);
    // The leaf alone also chains: its issuer is the trusted root itself.
    expect(check(leaf.certPem, leaf.keyPem).ok).toBe(true);
    expect(check(leaf.chainPem, leaf.keyPem, OTHER_HOST)).toEqual({ ok: false, reason: "issued for another name" });
    expect(check(leaf.chainPem, generatePrivateKeyPem())).toEqual({ ok: false, reason: "does not match the box's key" });
    expect(check(leaf.chainPem, leaf.keyPem, HOST, now + 100 * DAY)).toEqual({ ok: false, reason: "already expired" });
    expect(check(leaf.chainPem, leaf.keyPem, HOST, now - DAY)).toEqual({ ok: false, reason: expect.stringMatching(/^not valid yet/) });
    expect(check(leaf.chainPem, leaf.keyPem, HOST, now, [])).toEqual({ ok: false, reason: "not issued by a trusted authority" });
    expect(check(leaf.certPem + testCa("stranger").certPem, leaf.keyPem)).toEqual({ ok: false, reason: "a broken chain" });
    expect(check("nope", leaf.keyPem)).toEqual({ ok: false, reason: "no certificate in the answer" });
    expect(check(ca.certPem, ca.keyPem).ok).toBe(false);
  });
});
