/**
 * Local HTTPS — the box's side of the portal API (docs/design/local-https.md,
 * "Portal API"). The portal owns the `lan.clawbox.com` zone and the ACME
 * account: it publishes `<id>.lan.clawbox.com → <LAN IP>` and answers the
 * DNS-01 challenge for a certificate the BOX requested with its own key. The
 * box never holds a DNS credential and its private key never leaves it.
 *
 *   PUT    {base}                 { deviceId, lanIp }           → { hostname }
 *   POST   {base}/orders          { deviceId, hostname, csr }   → OrderAnswer
 *   GET    {base}/orders/{id}?deviceId=…                        → OrderAnswer
 *   DELETE {base}                 { deviceId }                  → 204
 *
 * Authenticated like the heartbeat: `Authorization: Bearer <clawai_token>`.
 *
 * The endpoint does not exist yet. Until it does, a 404/405/501 reads as
 * `portal_unavailable` (the Settings card says so and the box keeps trying),
 * and `CLAWBOX_LOCAL_HTTPS_PORTAL=stub` swaps in `createStubPortal` — the same
 * contract answered on the box, with a CA of its own — so everything after the
 * portal (key, CSR, certificate install, the TLS listeners, the Host
 * allow-list, the redirect) can be exercised end to end on a real board.
 */

import crypto from "crypto";
import fsp from "fs/promises";
import {
  type LocalHttpsProblem,
  isLocalHttpsHostname,
  isPrivateLanIpv4,
  localHttpsDir,
  LOCAL_HTTPS_ZONE,
  writeFileAtomic0600,
} from "./local-https-state";
import { createCa, issueCertificate, parseCsr } from "./local-https-x509";
import { getOrCreateDeviceId, readClawAiToken } from "./portal-heartbeat";
import { migrateLegacyPortalUrl } from "./portal-legacy-domain";
import path from "./runtime-path";

export type OrderAnswer =
  | { status: "pending"; orderId: string; retryAfterMs: number }
  | { status: "valid"; orderId: string; certificate: string }
  | { status: "invalid"; orderId: string; error: string };

export interface LocalHttpsPortal {
  readonly kind: "portal" | "stub";
  /** Publish (or move) the box's hostname to `lanIp`; answers the hostname. */
  register(lanIp: string): Promise<{ hostname: string }>;
  /** Ask for a certificate for `hostname` from a PEM CSR. */
  order(hostname: string, csrPem: string): Promise<OrderAnswer>;
  pollOrder(orderId: string): Promise<OrderAnswer>;
  /** Remove the DNS record: the owner switched Local HTTPS off. */
  unregister(): Promise<void>;
}

export class LocalHttpsPortalError extends Error {
  constructor(
    readonly code: LocalHttpsProblem,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LocalHttpsPortalError";
  }
}

const DEFAULT_URL = "https://clawbox.com/api/portal/devices/local-https";
export const NOT_PAIRED_RETRY_MS = 3600_000;
export const UNAVAILABLE_RETRY_MS = 6 * 3600_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** A chain is a few KB; anything far past that is not one. */
const MAX_CERTIFICATE_BYTES = 64 * 1024;

export function localHttpsPortalUrl(): string {
  return migrateLegacyPortalUrl(process.env.PORTAL_LOCAL_HTTPS_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 24 * 3600) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 24 * 3600 * 1000)) : undefined;
}

function isCertificateChain(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_CERTIFICATE_BYTES && value.includes("-----BEGIN CERTIFICATE-----");
}

/** Read an order answer, refusing any shape the contract does not have. */
export function parseOrderAnswer(body: unknown, fallbackId?: string): OrderAnswer {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const orderId = typeof b.orderId === "string" && ORDER_ID_RE.test(b.orderId) ? b.orderId : fallbackId;
  if (!orderId) throw new LocalHttpsPortalError("portal_error", "the portal's order answer has no usable orderId");
  if (b.status === "valid" && isCertificateChain(b.certificate)) return { status: "valid", orderId, certificate: b.certificate };
  if (b.status === "pending") {
    const seconds = typeof b.retryAfterSec === "number" && Number.isFinite(b.retryAfterSec) ? b.retryAfterSec : 5;
    return { status: "pending", orderId, retryAfterMs: Math.max(1, Math.min(seconds, 300)) * 1000 };
  }
  if (b.status === "invalid") {
    return { status: "invalid", orderId, error: typeof b.error === "string" ? b.error.slice(0, 300) : "the order failed" };
  }
  throw new LocalHttpsPortalError("portal_error", "the portal's order answer has an unknown shape");
}

export interface HttpPortalOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  token?: () => Promise<string | null>;
  deviceId?: () => Promise<string>;
}

/** The real client, against the contract above. */
export function createHttpPortal(opts: HttpPortalOptions = {}): LocalHttpsPortal {
  const base = opts.baseUrl ?? localHttpsPortalUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.token ?? readClawAiToken;
  const deviceId = opts.deviceId ?? getOrCreateDeviceId;

  async function call(method: string, url: string, body?: Record<string, unknown>): Promise<{ res: Response; json: unknown }> {
    const bearer = await token();
    if (!bearer) throw new LocalHttpsPortalError("not_paired", "this box is not signed in to a ClawBox account");
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (err) {
      throw new LocalHttpsPortalError("portal_error", `the portal could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Back-offs, so a fleet of boxes does not ask every 5 minutes for what the
    // portal will not give; the owner's switch retries at once regardless.
    if (res.status === 401 || res.status === 403) {
      throw new LocalHttpsPortalError("not_paired", `the portal refused this box (${res.status})`, NOT_PAIRED_RETRY_MS);
    }
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      throw new LocalHttpsPortalError("portal_unavailable", `the portal does not offer Local HTTPS (${res.status})`, UNAVAILABLE_RETRY_MS);
    }
    if (res.status === 429) {
      throw new LocalHttpsPortalError("rate_limited", "the portal asked the box to wait", retryAfterMs(res) ?? 15 * 60_000);
    }
    const json: unknown = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status >= 500) {
      throw new LocalHttpsPortalError("portal_error", `the portal failed (${res.status})`, retryAfterMs(res));
    }
    return { res, json };
  }

  function errorText(json: unknown, status: number): string {
    const e = (json as { error?: unknown } | null)?.error;
    return typeof e === "string" ? e.slice(0, 300) : `HTTP ${status}`;
  }

  return {
    kind: "portal",
    async register(lanIp) {
      const { res, json } = await call("PUT", base, { deviceId: await deviceId(), lanIp });
      if (!res.ok) throw new LocalHttpsPortalError("portal_error", `the portal refused the address: ${errorText(json, res.status)}`);
      const hostname = (json as { hostname?: unknown } | null)?.hostname;
      if (!isLocalHttpsHostname(hostname)) {
        throw new LocalHttpsPortalError("portal_error", `the portal answered a hostname outside ${LOCAL_HTTPS_ZONE}`);
      }
      return { hostname };
    },
    async order(hostname, csrPem) {
      const { res, json } = await call("POST", `${base}/orders`, { deviceId: await deviceId(), hostname, csr: csrPem });
      if (res.status === 400 || res.status === 422) {
        return { status: "invalid", orderId: "-", error: errorText(json, res.status) };
      }
      if (!res.ok) throw new LocalHttpsPortalError("portal_error", `the portal refused the order: ${errorText(json, res.status)}`);
      return parseOrderAnswer(json);
    },
    async pollOrder(orderId) {
      if (!ORDER_ID_RE.test(orderId)) return { status: "invalid", orderId, error: "unusable order id" };
      const url = `${base}/orders/${encodeURIComponent(orderId)}?deviceId=${encodeURIComponent(await deviceId())}`;
      const { res, json } = await call("GET", url);
      if (res.status === 400 || res.status === 410 || res.status === 422) {
        return { status: "invalid", orderId, error: errorText(json, res.status) };
      }
      if (!res.ok) throw new LocalHttpsPortalError("portal_error", `the portal refused the order poll: ${errorText(json, res.status)}`);
      return parseOrderAnswer(json, orderId);
    },
    async unregister() {
      const { res, json } = await call("DELETE", base, { deviceId: await deviceId() });
      if (!res.ok) throw new LocalHttpsPortalError("portal_error", `the portal refused the removal: ${errorText(json, res.status)}`);
    },
  };
}

// ── The stub ──

const STUB_CA_NAME = "ClawBox Local HTTPS stub CA (not trusted by any browser)";
const DAY_MS = 24 * 3600 * 1000;

/** The stub's hostname for a device: a stable, opaque base32 label, never the device id itself. */
export function stubHostnameFor(deviceId: string): string {
  const digest = crypto.createHash("sha256").update(`clawbox-local-https:${deviceId}`).digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let label = "";
  for (let i = 0; i < 16; i++) label += alphabet[digest[i] & 31];
  return `${label}.${LOCAL_HTTPS_ZONE}`;
}

async function loadOrCreateStubCa(now: number): Promise<{ certPem: string; keyPem: string }> {
  const file = path.join(localHttpsDir(), "stub-ca.json");
  try {
    const stored = JSON.parse(await fsp.readFile(file, "utf-8")) as { certPem?: unknown; keyPem?: unknown };
    if (typeof stored.certPem === "string" && typeof stored.keyPem === "string") {
      const cert = new crypto.X509Certificate(stored.certPem);
      if (Date.parse(cert.validTo) > now + 120 * DAY_MS) return { certPem: stored.certPem, keyPem: stored.keyPem };
    }
  } catch {
    // None yet, or unreadable: make one.
  }
  const ca = createCa(STUB_CA_NAME, new Date(now - DAY_MS), new Date(now + 3650 * DAY_MS));
  await writeFileAtomic0600(file, JSON.stringify(ca));
  // The certificate alone, where scripts/local-https.js looks for it.
  await writeFileAtomic0600(path.join(localHttpsDir(), "stub-ca.pem"), ca.certPem);
  return ca;
}

export interface StubPortalOptions {
  deviceId?: () => Promise<string>;
  now?: () => number;
}

/**
 * The contract answered on the box (CLAWBOX_LOCAL_HTTPS_PORTAL=stub): a
 * hostname derived from the device id, a CA of the box's own, and an order
 * that is pending once — so the polling path runs too — before it is valid.
 * Nothing leaves the box. A browser does not trust what it issues; the board
 * tests reach the listener with `curl --cacert data/local-https/stub-ca.pem`.
 */
export function createStubPortal(opts: StubPortalOptions = {}): LocalHttpsPortal {
  const deviceId = opts.deviceId ?? getOrCreateDeviceId;
  const now = opts.now ?? Date.now;
  const orders = new Map<string, { certificate: string; polled: boolean }>();
  return {
    kind: "stub",
    async register(lanIp) {
      if (!isPrivateLanIpv4(lanIp)) throw new LocalHttpsPortalError("portal_error", "the portal refused the address: invalid_ip");
      return { hostname: stubHostnameFor(await deviceId()) };
    },
    async order(hostname, csrPem) {
      if (hostname !== stubHostnameFor(await deviceId())) {
        return { status: "invalid", orderId: "-", error: "hostname_not_yours" };
      }
      let csr;
      try {
        csr = parseCsr(csrPem);
      } catch (err) {
        return { status: "invalid", orderId: "-", error: `bad_csr: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (csr.dnsNames.length !== 1 || csr.dnsNames[0] !== hostname) {
        return { status: "invalid", orderId: "-", error: "csr_names_wrong" };
      }
      const t = now();
      const ca = await loadOrCreateStubCa(t);
      const leaf = issueCertificate({
        subjectPublicKey: csr.publicKey,
        commonName: hostname,
        dnsName: hostname,
        notBefore: new Date(t - 60_000),
        notAfter: new Date(t + 90 * DAY_MS),
        issuer: { commonName: STUB_CA_NAME, privateKeyPem: ca.keyPem },
      });
      const orderId = `stub-${crypto.randomBytes(6).toString("hex")}`;
      orders.set(orderId, { certificate: leaf + ca.certPem, polled: false });
      return { status: "pending", orderId, retryAfterMs: 2_000 };
    },
    async pollOrder(orderId) {
      const order = orders.get(orderId);
      // A restart forgets the stub's orders, as a real portal might expire one.
      if (!order) return { status: "invalid", orderId, error: "unknown_order" };
      orders.delete(orderId);
      return { status: "valid", orderId, certificate: order.certificate };
    },
    async unregister() {},
  };
}

const STUB_KEY = Symbol.for("clawbox.local-https.stub-portal");

/**
 * The portal this box talks to: the stub when CLAWBOX_LOCAL_HTTPS_PORTAL=stub.
 * The stub is ONE per process (its orders live in memory, and the job and the
 * route are separate bundles), kept on globalThis like the box's other
 * process-wide state.
 */
export function localHttpsPortal(): LocalHttpsPortal {
  if (!isStubPortalMode()) return createHttpPortal();
  const g = globalThis as unknown as { [STUB_KEY]?: LocalHttpsPortal };
  g[STUB_KEY] ??= createStubPortal();
  return g[STUB_KEY];
}

export function isStubPortalMode(): boolean {
  return process.env.CLAWBOX_LOCAL_HTTPS_PORTAL === "stub";
}
