/**
 * Local HTTPS — the files under data/local-https/ and the one reader the
 * middleware needs (docs/design/local-https.md).
 *
 *   state.json   LocalHttpsState below: the owner's switch, the hostname the
 *                portal assigned, what was last reported, the certificate's
 *                dates, a pending order and the last problem. 0600.
 *   tls.json     { hostname, key, cert } 0600 — the private key and the chain
 *                issued for it, one file so a renewal is one rename.
 *   order-key.pem  the key of an order the portal has not answered yet, 0600.
 *   stub-ca.json / stub-ca.pem  the stub portal's CA (stub mode only).
 *
 * This module is the WRITER; scripts/local-https.js reads the same files for
 * production-server.js and the Hermes dashboard proxy. Kept free of heavy
 * imports: src/lib/host-allowlist.ts (middleware) reads the hostname through
 * `readLocalHttpsHostnameSync`.
 */

import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path, { untraced } from "./runtime-path";

/** The zone every box hostname lives in: exactly one label under it. */
export const LOCAL_HTTPS_ZONE = "lan.clawbox.com";

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `<label>.lan.clawbox.com`, exactly one label, lower case. */
export function isLocalHttpsHostname(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const suffix = `.${LOCAL_HTTPS_ZONE}`;
  return value.endsWith(suffix) && LABEL_RE.test(value.slice(0, -suffix.length));
}

/**
 * An address the portal may publish: RFC 1918 IPv4, and not one of the box's
 * own link networks (the setup access point 10.42.0.0/24, the cable link
 * 10.43.0.0/24), which no other device on the owner's LAN can reach. A public
 * address is never sent — Local HTTPS is for the home network only.
 */
export function isPrivateLanIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255) || m.slice(1).some((s) => s.length > 1 && s.startsWith("0"))) return false;
  if (a === 10) return !(b === 42 && c === 0) && !(b === 43 && c === 0);
  if (a === 172) return b >= 16 && b <= 31;
  return a === 192 && b === 168;
}

/** Why the box is not (or not fully) serving its secure address. */
export type LocalHttpsProblem =
  | "not_paired" // no ClawBox account on the box, or the portal refused it
  | "portal_unavailable" // the portal does not offer Local HTTPS (yet)
  | "portal_error" // the portal or the network failed; retried
  | "rate_limited" // the portal asked us to wait
  | "no_lan_ip" // no private IPv4 address on the box's own network
  | "order_failed" // the portal could not issue the certificate
  | "bad_certificate" // the portal answered with a certificate we will not serve
  | "write_failed"; // data/local-https/ could not be written

/** What the box's own resolvers answered for its hostname. */
export type LocalHttpsDnsVerdict =
  | "ok" // the router's DNS answers with this box's address
  | "rebind_blocked" // public DNS has it, the router drops it (DNS-rebind protection)
  | "stale" // DNS still answers with another address
  | "pending" // not in public DNS yet
  | "unknown"; // could not tell (offline, stub portal)

export interface LocalHttpsState {
  enabled: boolean;
  hostname: string | null;
  /** The LAN address the portal last accepted for `hostname`. */
  reportedIp: string | null;
  reportedAt: number | null;
  certNotBefore: number | null;
  certNotAfter: number | null;
  /** A certificate order the portal has not finished; its key is order-key.pem. */
  order: { id: string; startedAt: number; nextPollAt: number } | null;
  problem: { code: LocalHttpsProblem; at: number; detail?: string } | null;
  /** The portal's Retry-After, honoured by the job. */
  retryAt: number | null;
  dns: { at: number; verdict: LocalHttpsDnsVerdict; ip: string } | null;
  /** Switched off while the portal still publishes the address: tell it, then forget. */
  unregisterPending: boolean;
  lastCheckAt: number | null;
  /**
   * The certificate came from the stub portal (CLAWBOX_LOCAL_HTTPS_PORTAL=stub),
   * so scripts/local-https.js may trust stub-ca.pem for it. Lives here, not in
   * the environment, because the Hermes dashboard proxy does not share the web
   * server's environment.
   */
  stubPortal: boolean;
}

export const EMPTY_LOCAL_HTTPS_STATE: LocalHttpsState = {
  enabled: false,
  hostname: null,
  reportedIp: null,
  reportedAt: null,
  certNotBefore: null,
  certNotAfter: null,
  order: null,
  problem: null,
  retryAt: null,
  dns: null,
  unregisterPending: false,
  lastCheckAt: null,
  stubPortal: false,
};

/** Resolved per call so a test (or a moved install) is followed. */
export function localHttpsDir(): string {
  const root = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
  return path.join(root, "data", "local-https");
}

export function localHttpsStatePath(): string {
  return path.join(localHttpsDir(), "state.json");
}

export function localHttpsTlsPath(): string {
  return path.join(localHttpsDir(), "tls.json");
}

export function localHttpsOrderKeyPath(): string {
  return path.join(localHttpsDir(), "order-key.pem");
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse what is on disk into a well-formed state; anything odd reads as its default. */
export function normalizeLocalHttpsState(raw: unknown): LocalHttpsState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_LOCAL_HTTPS_STATE };
  const r = raw as Record<string, unknown>;
  const order = r.order as Record<string, unknown> | null | undefined;
  const problem = r.problem as Record<string, unknown> | null | undefined;
  const dns = r.dns as Record<string, unknown> | null | undefined;
  return {
    enabled: r.enabled === true,
    hostname: isLocalHttpsHostname(r.hostname) ? r.hostname : null,
    reportedIp: typeof r.reportedIp === "string" ? r.reportedIp : null,
    reportedAt: num(r.reportedAt),
    certNotBefore: num(r.certNotBefore),
    certNotAfter: num(r.certNotAfter),
    order:
      order && typeof order.id === "string" && num(order.startedAt) !== null
        ? { id: order.id, startedAt: num(order.startedAt)!, nextPollAt: num(order.nextPollAt) ?? 0 }
        : null,
    problem:
      problem && typeof problem.code === "string" && num(problem.at) !== null
        ? {
            code: problem.code as LocalHttpsProblem,
            at: num(problem.at)!,
            ...(typeof problem.detail === "string" ? { detail: problem.detail } : {}),
          }
        : null,
    retryAt: num(r.retryAt),
    dns:
      dns && typeof dns.verdict === "string" && num(dns.at) !== null && typeof dns.ip === "string"
        ? { at: num(dns.at)!, verdict: dns.verdict as LocalHttpsDnsVerdict, ip: dns.ip }
        : null,
    unregisterPending: r.unregisterPending === true,
    lastCheckAt: num(r.lastCheckAt),
    stubPortal: r.stubPortal === true,
  };
}

export async function readLocalHttpsState(): Promise<LocalHttpsState> {
  try {
    return normalizeLocalHttpsState(JSON.parse(await fsp.readFile(localHttpsStatePath(), "utf-8")));
  } catch {
    return { ...EMPTY_LOCAL_HTTPS_STATE };
  }
}

/** 0600 temp file in the same directory, then rename — the box's usual atomic write. */
export async function writeFileAtomic0600(file: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = untraced(`${file}.tmp.${crypto.randomBytes(4).toString("hex")}`);
  try {
    await fsp.writeFile(tmp, contents, { mode: 0o600 });
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function writeLocalHttpsState(state: LocalHttpsState): Promise<void> {
  await writeFileAtomic0600(localHttpsStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

let hostnameCache: { signature: string; hostname: string | null } | null = null;

/**
 * The box's Local HTTPS hostname while the owner has it switched on, else
 * null — synchronous and cached on the file's identity, because the
 * middleware's Host allow-list asks on every request. Mirrors
 * `localHttpsHostname()` in scripts/local-https.js.
 */
export function readLocalHttpsHostnameSync(): string | null {
  const file = localHttpsStatePath();
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    const signature = `${file}:${st.ino}:${st.size}:${st.mtimeMs}`;
    if (hostnameCache?.signature === signature) return hostnameCache.hostname;
    let hostname: string | null = null;
    try {
      const state = normalizeLocalHttpsState(JSON.parse(fs.readFileSync(fd, "utf-8")));
      hostname = state.enabled ? state.hostname : null;
    } catch {
      hostname = null;
    }
    hostnameCache = { signature, hostname };
    return hostname;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
  }
}
