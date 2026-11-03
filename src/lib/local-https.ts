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
 *              passes the same rules the TLS listener serves by (the key, the
 *              hostname, the dates, a chain to a trusted root).
 *   DNS        ask the router's resolver — what the owner's browsers ask —
 *              whether the name answers with this box. The portal's own answer
 *              says the record is published, so a router that answers nothing
 *              long after that is filtering it (DNS-rebind protection); no
 *              third-party resolver is ever asked.
 *
 * Passes run one at a time (the job's timer and the Settings route share one
 * queue on globalThis, since they live in different bundles), every 5 minutes
 * — an IP change is noticed within that — and sooner while an order is
 * pending. A pass never throws: what went wrong is the state's `problem`, and
 * whatever certificate is still valid keeps being served.
 *
 * The owner's switch wins over any pass: every switch bumps an epoch under the
 * same lock every state write takes, and a pass from an older epoch stops
 * before its next side effect (a portal call, a key, a certificate) and writes
 * nothing.
 */

import crypto from "crypto";
import dns from "dns";
import fsp from "fs/promises";
import tls from "tls";
import {
  EMPTY_LOCAL_HTTPS_STATE,
  type LocalHttpsDnsVerdict,
  type LocalHttpsState,
  isPrivateLanIpv4,
  localHttpsDir,
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
import path from "./runtime-path";
import { getReachableIpv4 } from "./system-info";

export const PASS_INTERVAL_MS = 5 * 60_000;
/** Re-report an unchanged address this often, so the portal knows the box is alive. */
export const REREGISTER_MS = 24 * 3600_000;
export const DNS_RECHECK_MS = 6 * 3600_000;
/** A router answer that is not settled yet (pending, unknown) is asked again this soon. */
export const DNS_UNSETTLED_RECHECK_MS = 10 * 60_000;
/** How long after the portal published an address a router may still answer nothing (negative caching). */
export const DNS_PUBLISH_GRACE_MS = 10 * 60_000;
/** An order the portal has not finished in this long is abandoned and retried. */
export const ORDER_TIMEOUT_MS = 15 * 60_000;
/**
 * After an order failed (or brought a certificate we refused), wait this long
 * before the next: Let's Encrypt allows 5 certificates per week for one exact
 * name, and a box re-ordering every pass would spend them in half an hour.
 */
export const ORDER_RETRY_MS = 3600_000;
const FIRST_PASS_DELAY_MS = 20_000;

/** What the router's resolver answered for the box's name. */
export type RouterAnswer = string[] | "nxdomain" | "error";

export interface LocalHttpsDeps {
  portal: LocalHttpsPortal;
  lanIp: () => Promise<string | null>;
  now: () => number;
  lookup: (hostname: string) => Promise<RouterAnswer>;
  /** The roots a certificate must chain to — what scripts/local-https.js serves by. */
  trustedRoots: () => Promise<crypto.X509Certificate[]>;
  refreshListener: () => void;
}

export function defaultLocalHttpsDeps(): LocalHttpsDeps {
  return {
    portal: localHttpsPortal(),
    lanIp: getReachableIpv4,
    now: Date.now,
    lookup: lookupRouter,
    trustedRoots: defaultTrustedRoots,
    refreshListener: refreshLocalHttpsListener,
  };
}

// ── Certificates ──

let nodeRoots: crypto.X509Certificate[] | null = null;

function nodeRootStore(): crypto.X509Certificate[] {
  if (!nodeRoots) {
    nodeRoots = [];
    for (const pem of tls.rootCertificates) {
      try {
        nodeRoots.push(new crypto.X509Certificate(pem));
      } catch {
        // A root OpenSSL will not parse is no root of ours.
      }
    }
  }
  return nodeRoots;
}

/** Node's store, plus the stub portal's CA in stub mode — the listener's rule exactly. */
export async function defaultTrustedRoots(): Promise<crypto.X509Certificate[]> {
  if (!isStubPortalMode()) return nodeRootStore();
  try {
    const pem = await fsp.readFile(path.join(localHttpsDir(), "stub-ca.pem"), "utf-8");
    return [...nodeRootStore(), new crypto.X509Certificate(pem)];
  } catch {
    return nodeRootStore();
  }
}

function signedBy(cert: crypto.X509Certificate, issuer: crypto.X509Certificate): boolean {
  try {
    return Boolean(cert.checkIssued(issuer)) && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

export type CertificateVerdict =
  | { ok: true; notBefore: number; notAfter: number; fingerprint256: string }
  | { ok: false; reason: string };

/**
 * Would scripts/local-https.js serve this chain for `hostname` with `keyPem`
 * at `now`? The same rules, so the job never installs a certificate the
 * listener then silently refuses: a server certificate for exactly that
 * name, inside its dates, matching the key, every link signed by the next and
 * the last one a root of `roots` or signed by one.
 */
export function inspectCertificate(
  certPem: string,
  keyPem: string,
  hostname: string,
  now: number,
  roots: crypto.X509Certificate[],
): CertificateVerdict {
  let certs: crypto.X509Certificate[];
  let key: crypto.KeyObject;
  try {
    const pems = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    if (!pems.length) return { ok: false, reason: "no certificate in the answer" };
    certs = pems.map((pem) => new crypto.X509Certificate(pem));
    key = crypto.createPrivateKey(keyPem);
  } catch {
    return { ok: false, reason: "unreadable certificate or key" };
  }
  const leaf = certs[0];
  if (leaf.ca) return { ok: false, reason: "a CA certificate, not a server certificate" };
  if (leaf.checkHost(hostname) !== hostname) return { ok: false, reason: "issued for another name" };
  if (!leaf.checkPrivateKey(key)) return { ok: false, reason: "does not match the box's key" };
  const notBefore = Date.parse(leaf.validFrom);
  const notAfter = Date.parse(leaf.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) return { ok: false, reason: "unreadable dates" };
  if (now < notBefore) return { ok: false, reason: "not valid yet (is the box's clock right?)" };
  if (now >= notAfter) return { ok: false, reason: "already expired" };
  for (let i = 0; i + 1 < certs.length; i++) {
    if (!signedBy(certs[i], certs[i + 1])) return { ok: false, reason: "a broken chain" };
  }
  const last = certs[certs.length - 1];
  if (!roots.some((root) => root.fingerprint256 === last.fingerprint256 || signedBy(last, root))) {
    return { ok: false, reason: "not issued by a trusted authority" };
  }
  return { ok: true, notBefore, notAfter, fingerprint256: leaf.fingerprint256 };
}

/** Renew once a third of the lifetime is left: 30 days of a 90-day certificate, and still right as lifetimes shrink. */
export function renewAt(notBefore: number, notAfter: number): number {
  return notAfter - Math.floor((notAfter - notBefore) / 3);
}

async function readInstalled(
  hostname: string,
  now: number,
  roots: crypto.X509Certificate[],
): Promise<(CertificateVerdict & { ok: true }) | null> {
  try {
    const stored = JSON.parse(await fsp.readFile(localHttpsTlsPath(), "utf-8")) as { hostname?: unknown; key?: unknown; cert?: unknown };
    if (stored.hostname !== hostname || typeof stored.key !== "string" || typeof stored.cert !== "string") return null;
    const verdict = inspectCertificate(stored.cert, stored.key, hostname, now, roots);
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

/** The system resolver's answer for `hostname`: what the router — and so the owner's browsers — say. */
export async function lookupRouter(hostname: string): Promise<RouterAnswer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), DNS_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const list = await Promise.race([dns.promises.lookup(hostname, { all: true, family: 4 }), timeout]);
    return list.map((a) => a.address);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    return code === "ENOTFOUND" || code === "ENODATA" ? "nxdomain" : "error";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the router's answer means for this box at `ip`, given that the portal
 * published `ip` `publishedForMs` ago. Only a definite "no such name" counts
 * as filtering, and only once the grace for negative caching has passed — a
 * lookup that merely failed says nothing about the router's settings.
 */
export function dnsVerdict(router: RouterAnswer, ip: string, publishedForMs: number): LocalHttpsDnsVerdict {
  if (Array.isArray(router)) return router.includes(ip) ? "ok" : "stale";
  if (router === "nxdomain") return publishedForMs >= DNS_PUBLISH_GRACE_MS ? "rebind_blocked" : "pending";
  return "unknown";
}

function dnsDue(state: LocalHttpsState, ip: string, now: number): boolean {
  if (!state.dns || state.dns.ip !== ip) return true;
  const settled = state.dns.verdict === "ok" || state.dns.verdict === "rebind_blocked" || state.dns.verdict === "stale";
  return now - state.dns.at >= (settled ? DNS_RECHECK_MS : DNS_UNSETTLED_RECHECK_MS);
}

// ── One pass ──

/** The owner switched the feature while this pass ran: its answer is no longer theirs to write. */
class Superseded extends Error {}

interface PassContext {
  deps: LocalHttpsDeps;
  now: number;
  /** Throws Superseded once the owner has switched since the pass began. */
  guard: () => void;
  /** Run `fn` under the state lock, after the guard. */
  commit: <T>(fn: () => Promise<T>) => Promise<T>;
  save: (state: LocalHttpsState) => Promise<void>;
}

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

async function applyOrderAnswer(state: LocalHttpsState, answer: OrderAnswer, hostname: string, ctx: PassContext): Promise<LocalHttpsState> {
  const { now } = ctx;
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
  const verdict = inspectCertificate(answer.certificate, key, hostname, now, await ctx.deps.trustedRoots());
  if (!verdict.ok) {
    await fsp.rm(localHttpsOrderKeyPath(), { force: true });
    return { ...state, order: null, retryAt: now + ORDER_RETRY_MS, problem: { code: "bad_certificate", at: now, detail: verdict.reason } };
  }
  await ctx.commit(() => writeFileAtomic0600(localHttpsTlsPath(), JSON.stringify({ hostname, key, cert: answer.certificate })));
  await fsp.rm(localHttpsOrderKeyPath(), { force: true });
  console.log(`[local-https] certificate installed for ${hostname}, valid until ${new Date(verdict.notAfter).toISOString()}`);
  return { ...state, order: null, certNotBefore: verdict.notBefore, certNotAfter: verdict.notAfter };
}

async function passWhileOn(start: LocalHttpsState, ctx: PassContext): Promise<LocalHttpsState> {
  const { deps, now, guard } = ctx;
  let state = start;
  const ip = await deps.lanIp();
  if (!isPrivateLanIpv4(ip)) {
    return { ...state, problem: { code: "no_lan_ip", at: now } };
  }

  // The address.
  const stub = deps.portal.kind === "stub";
  const due = !state.hostname || state.reportedIp !== ip || !state.reportedAt || now - state.reportedAt >= REREGISTER_MS || state.stubPortal !== stub;
  if (due) {
    guard();
    const { hostname } = await deps.portal.register(ip);
    if (state.hostname && state.hostname !== hostname) {
      // A new name: the old certificate and order are worthless now.
      await ctx.commit(removeSecrets);
      state = { ...state, order: null, certNotBefore: null, certNotAfter: null };
    }
    const moved = state.reportedIp !== ip || state.hostname !== hostname;
    state = {
      ...state,
      hostname,
      reportedIp: ip,
      reportedAt: now,
      addressSince: moved || state.addressSince === null ? now : state.addressSince,
      dns: moved ? null : state.dns,
      stubPortal: stub,
    };
    // On disk before the slow part, so the Host allow-list knows the name.
    await ctx.save(state);
    deps.refreshListener();
  }
  const hostname = state.hostname!;

  // The certificate.
  const roots = await deps.trustedRoots();
  const installed = await readInstalled(hostname, now, roots);
  state = { ...state, certNotBefore: installed?.notBefore ?? null, certNotAfter: installed?.notAfter ?? null };
  if (state.order) {
    if (now >= state.order.nextPollAt) {
      guard();
      state = await applyOrderAnswer(state, await deps.portal.pollOrder(state.order.id), hostname, ctx);
    }
  } else if (!installed || now >= renewAt(installed.notBefore, installed.notAfter)) {
    guard();
    const key = generatePrivateKeyPem();
    await ctx.commit(() => writeFileAtomic0600(localHttpsOrderKeyPath(), key));
    state = await applyOrderAnswer({ ...state, order: null }, await deps.portal.order(hostname, buildCsr(key, hostname)), hostname, ctx);
  }

  // DNS: meaningless for the stub, whose name is in no zone.
  if (!stub && dnsDue(state, ip, now)) {
    const verdict = dnsVerdict(await deps.lookup(hostname), ip, now - (state.addressSince ?? now));
    state = { ...state, dns: { at: now, ip, verdict } };
  }
  return state;
}

/** Nothing on file and nothing owed to the portal: an off pass has nothing to do. */
function isQuietOff(state: LocalHttpsState): boolean {
  return !state.enabled && !state.unregisterPending && state.hostname === null && state.order === null && state.certNotAfter === null;
}

async function passFrom(initial: LocalHttpsState, ctx: PassContext): Promise<LocalHttpsState> {
  const { deps, now } = ctx;
  let state = initial;

  if (!state.enabled) {
    // The common case on every box that never turned it on: no write, no call.
    if (isQuietOff(state)) return state;
    let unregisterPending = state.unregisterPending;
    if (unregisterPending) {
      ctx.guard();
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
    await ctx.commit(removeSecrets);
    await ctx.save(next);
    deps.refreshListener();
    return next;
  }

  if (state.retryAt && now < state.retryAt) return state;

  const problemBefore = state.problem;
  try {
    state = await passWhileOn({ ...state, problem: null, retryAt: null }, ctx);
  } catch (err) {
    if (err instanceof Superseded) throw err;
    state = { ...state, ...problemFrom(err, now) };
    // The same trouble as last time keeps the time it began.
    if (problemBefore && problemBefore.code === state.problem?.code) state = { ...state, problem: { ...state.problem, at: problemBefore.at } };
  }
  state = { ...state, lastCheckAt: now };
  try {
    await ctx.save(state);
  } catch (err) {
    if (err instanceof Superseded) throw err;
    state = { ...state, ...problemFrom(err, now) };
  }
  deps.refreshListener();
  return state;
}

/** One pass. Never throws; the outcome, problem included, is the saved state. */
export async function runLocalHttpsPass(deps: LocalHttpsDeps = defaultLocalHttpsDeps()): Promise<LocalHttpsState> {
  const now = deps.now();
  const epoch = slot().epoch;
  const guard = () => {
    if (slot().epoch !== epoch) throw new Superseded();
  };
  const commit = <T>(fn: () => Promise<T>) =>
    withStateLock(async () => {
      guard();
      return fn();
    });
  const ctx: PassContext = { deps, now, guard, commit, save: (next) => commit(() => writeLocalHttpsState(next)) };
  try {
    return await passFrom(await readLocalHttpsState(), ctx);
  } catch (err) {
    if (!(err instanceof Superseded)) {
      console.error("[local-https] pass failed:", err instanceof Error ? err.message : err);
    }
    // Superseded: the pass the switch queued runs next and sees the owner's choice.
    return readLocalHttpsState();
  }
}

// ── The schedule ──

const JOB_KEY = Symbol.for("clawbox.local-https.job");

interface JobSlot {
  /** Bumped by every switch of the feature; a pass from an older epoch writes nothing. */
  epoch: number;
  /** Every state write, and every switch, runs behind this. */
  lock: Promise<unknown>;
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  tail: Promise<LocalHttpsState> | null;
  queued: Promise<LocalHttpsState> | null;
}

function slot(): JobSlot {
  const g = globalThis as unknown as { [JOB_KEY]?: JobSlot };
  g[JOB_KEY] ??= { epoch: 0, lock: Promise.resolve(), started: false, timer: null, tail: null, queued: null };
  return g[JOB_KEY];
}

function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const s = slot();
  const run = s.lock.then(fn, fn);
  s.lock = run.catch(() => undefined);
  return run;
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
 * running for the old choice stops before its next side effect (the epoch,
 * bumped under the state lock).
 */
export async function setLocalHttpsEnabled(
  enabled: boolean,
  opts: { waitMs?: number; deps?: LocalHttpsDeps } = {},
): Promise<LocalHttpsStatus> {
  await withStateLock(async () => {
    const s = slot();
    s.epoch += 1;
    const state = await readLocalHttpsState();
    if (enabled) {
      await writeLocalHttpsState({ ...state, enabled: true, problem: null, retryAt: null, unregisterPending: false });
      return;
    }
    // The secrets first: should that fail, the switch has not moved either.
    await removeSecrets();
    await writeLocalHttpsState({
      ...EMPTY_LOCAL_HTTPS_STATE,
      // `enabled`, not just a hostname on file: a pass may have published the
      // address and not yet saved the name it got back. DELETE is idempotent.
      unregisterPending: state.unregisterPending || state.enabled || state.hostname !== null,
      lastCheckAt: state.lastCheckAt,
    });
  });
  if (!enabled) (opts.deps?.refreshListener ?? refreshLocalHttpsListener)();
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
  s.lock = Promise.resolve();
  s.timer = null;
  s.tail = null;
  s.queued = null;
}
