/**
 * Local HTTPS — the boot/renew job (docs/design/local-https.md).
 *
 * One PASS does whatever is due and nothing else:
 *   off        tell the portal to drop the DNS record (once, retried until it
 *              answers), delete the certificate and its key.
 *   address    report the box's LAN IPv4 when it changed, on first use, and
 *              once a day (the portal treats a silent box as gone).
 *   certificate  order one with a fresh key when there is none, it names
 *              another host, or a third of its lifetime is left; poll a
 *              pending order; install what the portal issued only after it
 *              matches the key, the hostname and the clock.
 *   DNS        ask the router's resolver and a public one whether the name
 *              answers with this box, which is how DNS-rebind protection is
 *              told apart from a record that is not published yet.
 *
 * Passes run one at a time (the job's timer and the Settings route share
 * one queue on globalThis, since they live in different bundles), every 5
 * minutes — an IP change is noticed within that — and sooner while an order is
 * pending. A pass never throws: what went wrong is the state's `problem`, and
 * whatever certificate is still valid keeps being served.
 */

import crypto from "crypto";
import dns from "dns";
import fsp from "fs/promises";
import {
  EMPTY_LOCAL_HTTPS_STATE,
  type LocalHttpsDnsVerdict,
  type LocalHttpsState,
  isPrivateLanIpv4,
  localHttpsOrderKeyPath,
  localHttpsTlsPath,
  readLocalHttpsState,
  writeFileAtomic0600,
  writeLocalHttpsState,
} from "./local-https-state";
import { localHttpsServing, localHttpsUrl, refreshLocalHttpsListener } from "./local-https-listener";
import {
  type LocalHttpsPortal,
  type OrderAnswer,
  LocalHttpsPortalError,
  isStubPortalMode,
  localHttpsPortal,
} from "./local-https-portal";
import { buildCsr, generatePrivateKeyPem } from "./local-https-x509";
import { getReachableIpv4 } from "./system-info";

export const PASS_INTERVAL_MS = 5 * 60_000;
/** Re-report an unchanged address this often, so the portal knows the box is alive. */
export const REREGISTER_MS = 24 * 3600_000;
export const DNS_RECHECK_MS = 6 * 3600_000;
/** An order the portal has not finished in this long is abandoned and retried. */
export const ORDER_TIMEOUT_MS = 15 * 60_000;
/**
 * After an order failed (or brought a certificate we refused), wait this long
 * before the next: Let's Encrypt allows 5 certificates per week for one exact
 * name, and a box re-ordering every pass would spend them in half an hour.
 */
export const ORDER_RETRY_MS = 3600_000;
const FIRST_PASS_DELAY_MS = 20_000;

export interface LocalHttpsDeps {
  portal: LocalHttpsPortal;
  lanIp: () => Promise<string | null>;
  now: () => number;
  checkDns: (hostname: string, ip: string) => Promise<LocalHttpsDnsVerdict>;
  refreshListener: () => void;
}

export function defaultLocalHttpsDeps(): LocalHttpsDeps {
  return {
    portal: localHttpsPortal(),
    lanIp: getReachableIpv4,
    now: Date.now,
    checkDns: checkLocalHttpsDns,
    refreshListener: refreshLocalHttpsListener,
  };
}

// ── Certificates ──

export type CertificateVerdict =
  | { ok: true; notBefore: number; notAfter: number; fingerprint256: string }
  | { ok: false; reason: string };

/**
 * Does this chain serve `hostname` with `keyPem` at `now`? The box-side half of
 * the check scripts/local-https.js repeats before it serves (that one also
 * walks the chain to a trusted root).
 */
export function inspectCertificate(certPem: string, keyPem: string, hostname: string, now: number): CertificateVerdict {
  let leaf: crypto.X509Certificate;
  let key: crypto.KeyObject;
  try {
    const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(certPem);
    if (!first) return { ok: false, reason: "no certificate in the answer" };
    leaf = new crypto.X509Certificate(first[0]);
    key = crypto.createPrivateKey(keyPem);
  } catch {
    return { ok: false, reason: "unreadable certificate or key" };
  }
  if (leaf.ca) return { ok: false, reason: "a CA certificate, not a server certificate" };
  if (leaf.checkHost(hostname) !== hostname) return { ok: false, reason: "issued for another name" };
  if (!leaf.checkPrivateKey(key)) return { ok: false, reason: "does not match the box's key" };
  const notBefore = Date.parse(leaf.validFrom);
  const notAfter = Date.parse(leaf.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) return { ok: false, reason: "unreadable dates" };
  if (now >= notAfter) return { ok: false, reason: "already expired" };
  return { ok: true, notBefore, notAfter, fingerprint256: leaf.fingerprint256 };
}

/** Renew once a third of the lifetime is left: 30 days of a 90-day certificate, and still right as lifetimes shrink. */
export function renewAt(notBefore: number, notAfter: number): number {
  return notAfter - Math.floor((notAfter - notBefore) / 3);
}

async function readInstalled(hostname: string, now: number): Promise<(CertificateVerdict & { ok: true }) | null> {
  try {
    const stored = JSON.parse(await fsp.readFile(localHttpsTlsPath(), "utf-8")) as { hostname?: unknown; key?: unknown; cert?: unknown };
    if (stored.hostname !== hostname || typeof stored.key !== "string" || typeof stored.cert !== "string") return null;
    const verdict = inspectCertificate(stored.cert, stored.key, hostname, now);
    return verdict.ok ? verdict : null;
  } catch {
    return null;
  }
}

async function removeSecrets(): Promise<void> {
  await fsp.rm(localHttpsTlsPath(), { force: true });
  await fsp.rm(localHttpsOrderKeyPath(), { force: true });
}

// ── DNS ──

const DNS_TIMEOUT_MS = 5_000;
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

type Answer = string[] | "nxdomain" | "error";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref())]);
}

function classify(err: unknown): Answer {
  const code = (err as { code?: unknown })?.code;
  return code === "ENOTFOUND" || code === "ENODATA" ? "nxdomain" : "error";
}

/** The rule, apart from the lookups: what the two answers mean for this box at `ip`. */
export function dnsVerdict(router: Answer, publicDns: Answer, ip: string): LocalHttpsDnsVerdict {
  if (Array.isArray(router) && router.includes(ip)) return "ok";
  if (Array.isArray(publicDns)) {
    if (!publicDns.includes(ip)) return "stale";
    // Public DNS has the right answer: a router that answers something else is
    // caching the old one; a router that answers nothing is filtering it.
    return Array.isArray(router) ? "stale" : "rebind_blocked";
  }
  if (publicDns === "nxdomain") return "pending";
  return "unknown";
}

/**
 * Ask the system resolver (the router, normally — what the owner's browser
 * asks too) and a public resolver for `hostname`.
 */
export async function checkLocalHttpsDns(hostname: string, ip: string): Promise<LocalHttpsDnsVerdict> {
  const router: Promise<Answer> = withTimeout(dns.promises.lookup(hostname, { all: true, family: 4 }), DNS_TIMEOUT_MS)
    .then((list) => list.map((a) => a.address))
    .catch(classify);
  const resolver = new dns.promises.Resolver({ timeout: 2_000, tries: 1 });
  resolver.setServers(PUBLIC_RESOLVERS);
  const publicDns: Promise<Answer> = withTimeout(resolver.resolve4(hostname), DNS_TIMEOUT_MS).catch(classify);
  return dnsVerdict(await router, await publicDns, ip);
}

// ── One pass ──

function problemFrom(err: unknown, now: number): Pick<LocalHttpsState, "problem" | "retryAt"> {
  if (err instanceof LocalHttpsPortalError) {
    return {
      problem: { code: err.code, at: now, detail: err.message.slice(0, 300) },
      retryAt: err.retryAfterMs !== undefined ? now + err.retryAfterMs : null,
    };
  }
  const code = (err as { code?: unknown })?.code;
  const message = err instanceof Error ? err.message : String(err);
  const fsError = typeof code === "string" && /^E[A-Z]+$/.test(code) && code !== "ECONNREFUSED" && code !== "ENOTFOUND";
  return { problem: { code: fsError ? "write_failed" : "portal_error", at: now, detail: message.slice(0, 300) }, retryAt: null };
}

async function applyOrderAnswer(state: LocalHttpsState, answer: OrderAnswer, hostname: string, now: number): Promise<LocalHttpsState> {
  if (answer.status === "pending") {
    const startedAt = state.order?.id === answer.orderId ? state.order.startedAt : now;
    if (now - startedAt > ORDER_TIMEOUT_MS) {
      await fsp.rm(localHttpsOrderKeyPath(), { force: true });
      return { ...state, order: null, retryAt: now + ORDER_RETRY_MS, problem: { code: "order_failed", at: now, detail: "the portal did not finish the certificate in time" } };
    }
    return { ...state, order: { id: answer.orderId, startedAt, nextPollAt: now + Math.max(1_000, Math.min(answer.retryAfterMs, 60_000)) } };
  }
  if (answer.status === "invalid") {
    await fsp.rm(localHttpsOrderKeyPath(), { force: true });
    return { ...state, order: null, retryAt: now + ORDER_RETRY_MS, problem: { code: "order_failed", at: now, detail: answer.error } };
  }
  let key: string;
  try {
    key = await fsp.readFile(localHttpsOrderKeyPath(), "utf-8");
  } catch {
    return { ...state, order: null, problem: { code: "order_failed", at: now, detail: "the order's key is gone; ordering again" } };
  }
  const verdict = inspectCertificate(answer.certificate, key, hostname, now);
  if (!verdict.ok) {
    await fsp.rm(localHttpsOrderKeyPath(), { force: true });
    return { ...state, order: null, retryAt: now + ORDER_RETRY_MS, problem: { code: "bad_certificate", at: now, detail: verdict.reason } };
  }
  await writeFileAtomic0600(localHttpsTlsPath(), JSON.stringify({ hostname, key, cert: answer.certificate }));
  await fsp.rm(localHttpsOrderKeyPath(), { force: true });
  console.log(`[local-https] certificate installed for ${hostname}, valid until ${new Date(verdict.notAfter).toISOString()}`);
  return { ...state, order: null, certNotBefore: verdict.notBefore, certNotAfter: verdict.notAfter };
}

/** The owner switched the feature while this pass ran: its answer is no longer theirs to write. */
class Superseded extends Error {}

async function passWhileOn(
  start: LocalHttpsState,
  deps: LocalHttpsDeps,
  now: number,
  save: (state: LocalHttpsState) => Promise<void>,
): Promise<LocalHttpsState> {
  let state = start;
  const ip = await deps.lanIp();
  if (!isPrivateLanIpv4(ip)) {
    return { ...state, problem: { code: "no_lan_ip", at: now } };
  }

  // The address.
  const stub = deps.portal.kind === "stub";
  const due = !state.hostname || state.reportedIp !== ip || !state.reportedAt || now - state.reportedAt >= REREGISTER_MS || state.stubPortal !== stub;
  if (due) {
    const { hostname } = await deps.portal.register(ip);
    if (state.hostname && state.hostname !== hostname) {
      // A new name: the old certificate and order are worthless now.
      await removeSecrets();
      state = { ...state, order: null, certNotBefore: null, certNotAfter: null };
    }
    state = { ...state, hostname, reportedIp: ip, reportedAt: now, dns: null, stubPortal: stub };
    // On disk before the slow part, so the Host allow-list knows the name.
    await save(state);
    deps.refreshListener();
  }
  const hostname = state.hostname!;

  // The certificate.
  const installed = await readInstalled(hostname, now);
  state = { ...state, certNotBefore: installed?.notBefore ?? null, certNotAfter: installed?.notAfter ?? null };
  if (state.order) {
    if (now >= state.order.nextPollAt) {
      state = await applyOrderAnswer(state, await deps.portal.pollOrder(state.order.id), hostname, now);
    }
  } else if (!installed || now >= renewAt(installed.notBefore, installed.notAfter)) {
    const key = generatePrivateKeyPem();
    await writeFileAtomic0600(localHttpsOrderKeyPath(), key);
    state = await applyOrderAnswer({ ...state, order: null }, await deps.portal.order(hostname, buildCsr(key, hostname)), hostname, now);
  }

  // DNS: meaningless for the stub, whose name is in no zone.
  if (!stub && (!state.dns || state.dns.ip !== ip || now - state.dns.at >= DNS_RECHECK_MS)) {
    state = { ...state, dns: { at: now, ip, verdict: await deps.checkDns(hostname, ip) } };
  }
  return state;
}

/** One pass. Never throws; the outcome, problem included, is the saved state. */
export async function runLocalHttpsPass(deps: LocalHttpsDeps = defaultLocalHttpsDeps()): Promise<LocalHttpsState> {
  const now = deps.now();
  const epoch = slot().epoch;
  const save = async (next: LocalHttpsState) => {
    if (slot().epoch !== epoch) throw new Superseded();
    await writeLocalHttpsState(next);
  };
  try {
    return await passFrom(await readLocalHttpsState(), deps, now, save);
  } catch (err) {
    if (!(err instanceof Superseded)) throw err;
    // The pass the switch queued runs next and sees the owner's choice.
    return readLocalHttpsState();
  }
}

async function passFrom(
  initial: LocalHttpsState,
  deps: LocalHttpsDeps,
  now: number,
  save: (state: LocalHttpsState) => Promise<void>,
): Promise<LocalHttpsState> {
  let state = initial;

  if (!state.enabled) {
    let unregisterPending = state.unregisterPending;
    if (unregisterPending) {
      try {
        await deps.portal.unregister();
        unregisterPending = false;
      } catch (err) {
        // A box the portal no longer knows, or a portal without the feature,
        // publishes nothing: there is nothing left to take down.
        const code = err instanceof LocalHttpsPortalError ? err.code : null;
        if (code === "not_paired" || code === "portal_unavailable") unregisterPending = false;
        else console.warn("[local-https] the portal could not drop the address yet:", err instanceof Error ? err.message : err);
      }
    }
    const next = { ...EMPTY_LOCAL_HTTPS_STATE, unregisterPending, lastCheckAt: now };
    await save(next).catch((err) => {
      if (err instanceof Superseded) throw err;
    });
    await removeSecrets().catch(() => {});
    deps.refreshListener();
    return next;
  }

  if (state.retryAt && now < state.retryAt) return state;

  let problemBefore = state.problem;
  try {
    state = await passWhileOn({ ...state, problem: null, retryAt: null }, deps, now, save);
    problemBefore = null;
  } catch (err) {
    if (err instanceof Superseded) throw err;
    state = { ...state, ...problemFrom(err, now) };
    if (problemBefore?.code === state.problem?.code) state = { ...state, problem: { ...state.problem!, at: problemBefore!.at } };
  }
  state = { ...state, lastCheckAt: now };
  try {
    await save(state);
  } catch (err) {
    if (err instanceof Superseded) throw err;
    state = { ...state, ...problemFrom(err, now) };
  }
  deps.refreshListener();
  return state;
}

// ── The schedule ──

const JOB_KEY = Symbol.for("clawbox.local-https.job");

interface JobSlot {
  /** Bumped by every switch of the feature; a pass from an older epoch writes nothing. */
  epoch: number;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  tail: Promise<LocalHttpsState> | null;
  queued: Promise<LocalHttpsState> | null;
}

function slot(): JobSlot {
  const g = globalThis as unknown as { [JOB_KEY]?: JobSlot };
  g[JOB_KEY] ??= { epoch: 0, started: false, timer: null, tail: null, queued: null };
  return g[JOB_KEY];
}

/** When the next pass should run after one that left `state`. */
export function nextPassDelay(state: LocalHttpsState, now: number): number {
  let at = now + PASS_INTERVAL_MS;
  if (state.enabled && state.order) at = Math.min(at, state.order.nextPollAt);
  if (state.enabled && state.retryAt) at = Math.max(Math.min(at, state.retryAt), now);
  return Math.max(1_000, at - now);
}

function schedule(delayMs: number): void {
  const s = slot();
  if (!s.started) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    s.timer = null;
    void triggerLocalHttpsPass();
  }, delayMs);
  s.timer.unref?.();
}

/**
 * Run a pass now, after the one in flight. Callers arriving while a pass is
 * already queued share it: two clicks are one pass, not a backlog.
 */
export function triggerLocalHttpsPass(deps?: LocalHttpsDeps): Promise<LocalHttpsState> {
  const s = slot();
  if (s.queued) return s.queued;
  const run = async (): Promise<LocalHttpsState> => {
    s.queued = null;
    const state = await runLocalHttpsPass(deps ?? defaultLocalHttpsDeps());
    schedule(nextPassDelay(state, Date.now()));
    return state;
  };
  const queued = (s.tail ?? Promise.resolve(null)).catch(() => null).then(run);
  s.queued = queued;
  s.tail = queued;
  return queued;
}

/** Arm the job once per process: a first pass shortly after boot, then on its own schedule. */
export function startLocalHttpsJob(): void {
  const s = slot();
  if (s.started) return;
  s.started = true;
  schedule(FIRST_PASS_DELAY_MS);
}

// ── What Settings reads and writes ──

export interface LocalHttpsStatus {
  enabled: boolean;
  hostname: string | null;
  /** `https://<hostname>` once there is a hostname. */
  url: string | null;
  /** The LAN address the portal publishes for it. */
  lanIp: string | null;
  /** :443 is serving a valid certificate for `hostname` right now. */
  serving: boolean;
  certNotAfter: number | null;
  renewAt: number | null;
  /** A certificate order is in flight. */
  issuing: boolean;
  problem: { code: string; detail?: string; since: number } | null;
  dns: LocalHttpsDnsVerdict | null;
  portal: "portal" | "stub";
  /** Switched off, and the portal has not yet confirmed the address is gone. */
  unregisterPending: boolean;
  lastCheckAt: number | null;
}

export async function localHttpsStatus(): Promise<LocalHttpsStatus> {
  const state = await readLocalHttpsState();
  const serving = localHttpsServing();
  const on = state.enabled;
  return {
    enabled: on,
    hostname: on ? state.hostname : null,
    url: on && state.hostname ? localHttpsUrl(state.hostname) : null,
    lanIp: on ? state.reportedIp : null,
    serving: on && !!serving && serving.hostname === state.hostname && Date.now() < serving.notAfter,
    certNotAfter: on ? state.certNotAfter : null,
    renewAt: on && state.certNotBefore !== null && state.certNotAfter !== null ? renewAt(state.certNotBefore, state.certNotAfter) : null,
    issuing: on && state.order !== null,
    problem: on && state.problem
      ? { code: state.problem.code, since: state.problem.at, ...(state.problem.detail ? { detail: state.problem.detail } : {}) }
      : null,
    dns: on ? state.dns?.verdict ?? null : null,
    portal: isStubPortalMode() ? "stub" : "portal",
    unregisterPending: state.unregisterPending,
    lastCheckAt: state.lastCheckAt,
  };
}

/**
 * The owner's switch. On: saved, then a pass runs at once and is waited for
 * (up to `waitMs` — the card keeps polling while an order is pending). Off:
 * the certificate and key are deleted and the listener re-reads before this
 * returns, so the box stops answering on the name at once; the pass that
 * tells the portal to drop the DNS record follows. Either way a pass already
 * running for the old choice writes nothing (the epoch).
 */
export async function setLocalHttpsEnabled(
  enabled: boolean,
  opts: { waitMs?: number; deps?: LocalHttpsDeps } = {},
): Promise<LocalHttpsStatus> {
  const s = slot();
  s.epoch += 1;
  const state = await readLocalHttpsState();
  if (enabled) {
    await writeLocalHttpsState({ ...state, enabled: true, problem: null, retryAt: null, unregisterPending: false });
  } else {
    await writeLocalHttpsState({
      ...EMPTY_LOCAL_HTTPS_STATE,
      unregisterPending: state.unregisterPending || state.hostname !== null,
      lastCheckAt: state.lastCheckAt,
    });
    await removeSecrets();
    (opts.deps?.refreshListener ?? refreshLocalHttpsListener)();
  }
  const pass = triggerLocalHttpsPass(opts.deps).catch(() => null);
  const waitMs = opts.waitMs ?? (enabled ? 20_000 : 10_000);
  await Promise.race([pass, new Promise((resolve) => setTimeout(resolve, waitMs).unref?.())]);
  return localHttpsStatus();
}

/** Tests only: forget the process-wide job. */
export function resetLocalHttpsJobForTests(): void {
  const s = slot();
  if (s.timer) clearTimeout(s.timer);
  s.started = false;
  s.epoch = 0;
  s.timer = null;
  s.tail = null;
  s.queued = null;
}
