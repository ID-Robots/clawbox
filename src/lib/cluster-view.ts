/**
 * Settings → System → Cluster (TASK-2670), server half: which box has a
 * cluster to show, how each Spark is read, and the engine's own load.
 *
 * SERVER ONLY. Owner only: the route that answers with this is
 * `/setup-api/system/cluster`, and a staff user is refused there and in the
 * middleware's owner list (src/lib/non-owner-scope.ts).
 *
 * WHAT IS CONFIGURED. Nothing about a Workstation's other Sparks lives in this
 * repository, and none of their names may: the owner lists them, in the
 * checkout's `.env` (the web server reads it):
 *
 *   CLAWBOX_CLUSTER_PEERS=sparkB sparkC sparkD     ssh targets, `[user@]host`,
 *                                                  separated by spaces or commas;
 *                                                  the OTHER Sparks, not this one
 *   CLAWBOX_CLUSTER_VIEW=auto|on|off               auto (default): shown on a
 *                                                  Workstation only; on: also on
 *                                                  a box that is not one (a bench
 *                                                  or a home-built cluster); off
 *   CLAWBOX_CLUSTER_ENGINE_URL=http://…/v1         the engine's address, when it
 *                                                  is not the external engine
 *                                                  (Settings → Local AI)
 *
 * HOW A SPARK IS READ. Over the SSH trust the Sparks already have between them,
 * from this box, with ONE read-only script per Spark fed to `sh -s` on its
 * standard input (a fixed text: nothing of a request or of the config is ever
 * put into it). Nothing is installed on the other Sparks and nothing is
 * written there. ssh runs BatchMode (it can never ask for a password or a host
 * key), with a three-second connect timeout and a seven-second ceiling, and
 * the host key must already be known: an unknown or changed key is a failure
 * to show, not a prompt, and not a key to trust on first sight.
 *
 * HOW LONG A PAGE WAITS. Every read is remembered for a few seconds and shared
 * by whoever asks meanwhile. A card read within the last `STALE_MS` (30 s) is
 * answered from memory while a fresh read runs behind the answer, so a Spark
 * that went away costs the page a stale card for one refresh, not a wait. Past
 * that — and on the first read after a restart — the answer waits for the fresh
 * read, a Spark that does not answer included: up to the seven-second ceiling
 * (the engine's read has six).
 *
 * WHAT IS CONTACTED. The Sparks are the owner's own list, reached the way the
 * owner's ssh reaches them: a target is a name the owner chose, and ssh's own
 * config may map it anywhere (an alias, a jump host), so it is not checked
 * against the local network here — keeping peer connections on the network is
 * the owner's ssh setup. The only other requests go to the engine's address,
 * and only when that address is loopback or private (RFC 1918, unique-local):
 * the check is made on the literal and on every address a preliminary lookup
 * of the name gives. The connection is not pinned to those addresses, so a
 * name that is rebound between that check and the connection is not defended
 * against, which is the limit of the external engine's own probe as well.
 * Redirects are never followed.
 */

import { spawn, type ChildProcess } from "child_process";
import net from "net";
import os from "os";
import { lookup as dnsLookup } from "dns/promises";
import { getKnown, resolveConfigRoot } from "./config-store";
import {
  NO_KEY_PLACEHOLDER,
  externalEngineFromState,
  probeExternalEngine,
  readCapped,
  readExternalEngineKey,
  readExternalEngineKeyWrittenAt,
} from "./external-engine";
import { EXTERNAL_ENGINE_STORE_KEY, externalEngineOrigin, normalizeExternalBaseUrl } from "./external-engine-shared";
import { localAiTransitionMark, onLocalAiTransitionStart } from "./local-ai-transition-lock";
import { isWorkstationHost, probeUpdateHost } from "./update-channel";
import {
  COLLECTOR_PREFIX,
  engineSampleFrom,
  engineSampleUsable,
  parsePrometheusSeries,
  parseSparkOutput,
  tokensPerSecondBetween,
  type ClusterAnswer,
  type ClusterSnapshot,
  type EngineGateReason,
  type EngineView,
  type SparkCard,
  type SparkFailure,
  type TokenRead,
} from "./cluster-shared";

export const CLUSTER_PEERS_ENV = "CLAWBOX_CLUSTER_PEERS";
export const CLUSTER_VIEW_ENV = "CLAWBOX_CLUSTER_VIEW";
export const CLUSTER_ENGINE_URL_ENV = "CLAWBOX_CLUSTER_ENGINE_URL";

/** More than this is a typo or a different tool: the extra entries are ignored. */
export const MAX_PEERS = 8;

// ── Configuration ───────────────────────────────────────────────────────────────

/** One pair of matching quotes off a value `.env` loaders may have left quoted. */
function unquote(raw: string | undefined): string {
  let value = (raw ?? "").trim();
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

// `[user@]host`: letters, digits, dot, dash, underscore; never a leading dash (it
// would be read as an ssh option), no colon (a port belongs in ssh's own config),
// no whitespace or shell character of any kind.
const TARGET_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,251}$/;

export interface PeerConfig {
  targets: string[];
  /** Entries that were not a valid target (or came after `MAX_PEERS`): counted, never echoed. */
  ignored: number;
}

export function clusterPeers(env: NodeJS.ProcessEnv = process.env): PeerConfig {
  const targets: string[] = [];
  let ignored = 0;
  for (const entry of unquote(env[CLUSTER_PEERS_ENV]).split(/[\s,]+/).filter(Boolean)) {
    if (!TARGET_RE.test(entry) || targets.length >= MAX_PEERS) {
      ignored += 1;
    } else if (!targets.includes(entry)) {
      targets.push(entry);
    }
  }
  return { targets, ignored };
}

export type ClusterMode = "auto" | "on" | "off";

export function clusterMode(env: NodeJS.ProcessEnv = process.env): ClusterMode {
  const value = unquote(env[CLUSTER_VIEW_ENV]).toLowerCase();
  if (value === "on" || value === "1" || value === "true" || value === "yes") return "on";
  if (value === "off" || value === "0" || value === "false" || value === "no") return "off";
  return "auto";
}

/** The host part of an ssh target: what an offline card is named by. */
export function targetHost(target: string): string {
  const at = target.lastIndexOf("@");
  return at < 0 ? target : target.slice(at + 1);
}

// ── Dependencies (so a test reads no machine) ──────────────────────────────────

export interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ScriptRunner = (command: string, args: string[], input: string, timeoutMs: number) => Promise<ScriptResult>;
export type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

export interface EngineTarget {
  baseUrl: string;
  apiKey: string | null;
  modelId: string;
}

/**
 * What `readEngine` answers while the AI settings are being changed: the saved
 * record and the key file may then belong to two different engines, so neither
 * is used (src/lib/local-ai-transition-lock.ts).
 */
export const ENGINE_CHANGING = "changing" as const;

/**
 * What `readEngine` answers when the key file was written after the record it
 * sits beside — a save that failed after writing its key and could not put the
 * old one back: the key is not that engine's, and is sent nowhere.
 */
export const ENGINE_UNBOUND = "unbound" as const;

/** A save writes the key a moment before it stamps the record; this much later is still that save's. */
export const KEY_BINDING_SLACK_MS = 2_000;

export interface ClusterDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  run: ScriptRunner;
  isWorkstation: () => boolean;
  readEngine: () => Promise<EngineTarget | null | typeof ENGINE_CHANGING | typeof ENGINE_UNBOUND>;
  fetchImpl: typeof fetch;
  lookup: LookupFn;
}

const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * What the child may see: where to find programs and keys, and nothing else.
 * The web server's own environment holds its session secret and every other
 * credential it was started with; a read-only collector and an ssh client have
 * no use for them, and a forced command on the far side could not see them
 * either way.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  const keep: Record<string, string> = { LC_ALL: "C" };
  for (const name of ["PATH", "HOME", "USER", "LOGNAME"]) {
    const value = process.env[name];
    if (value !== undefined) keep[name] = value;
  }
  return keep as unknown as NodeJS.ProcessEnv;
}

/**
 * SIGKILL to the child's whole process group. The child leads a group of its
 * own (`detached`), so a pipeline its shell is waiting on (`df … | tail`) or an
 * ssh it started goes with it, and cannot outlive the deadline and overlap the
 * next read. Falls back to the child alone where there is no group to signal.
 */
function killTree(child: ChildProcess | undefined): void {
  if (!child) return;
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // No such group (already gone): try the child itself.
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

/** spawn with a hard ceiling: the answer arrives by the deadline whatever the child does, and nothing it started is left running. */
export const runScript: ScriptRunner = (command, args, input, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let child: ChildProcess | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      finish(null);
    }, timeoutMs);
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnvironment(),
        // Its own process group, so the deadline stops everything it started.
        detached: process.platform !== "win32",
      });
    } catch {
      finish(null);
      return;
    }
    const proc = child;
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    proc.on("error", () => finish(null));
    proc.on("close", (code) => finish(code));
    proc.stdin?.on("error", () => {});
    proc.stdin?.end(input);
  });

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

let workstationMemo: { at: number; value: boolean } | null = null;

/** Is THIS box a Workstation? The updater's own rule (update-channel.ts), asked at most once a minute. */
function defaultIsWorkstation(): boolean {
  const now = Date.now();
  if (workstationMemo && now - workstationMemo.at >= 0 && now - workstationMemo.at < 60_000) return workstationMemo.value;
  let value = false;
  try {
    value = isWorkstationHost(probeUpdateHost(resolveConfigRoot()));
  } catch {
    // An x64 record that cannot be trusted is not an answer of "yes".
  }
  workstationMemo = { at: now, value };
  return value;
}

async function defaultReadEngine(
  env: NodeJS.ProcessEnv,
): Promise<EngineTarget | null | typeof ENGINE_CHANGING | typeof ENGINE_UNBOUND> {
  // The record and the key file are two reads, and a save writes the new key
  // before the new record (src/lib/external-engine-ops.ts): a pair read across a
  // save could send one engine's key to the other's address. Every writer of
  // either holds the Local AI transition lock, so they are read only while no
  // transition runs, and used only when none started in between.
  const before = localAiTransitionMark();
  if (before.running) return ENGINE_CHANGING;
  // The store's tri-state read: a store that cannot be read is not "no engine".
  const stored = await getKnown(EXTERNAL_ENGINE_STORE_KEY);
  if (!stored.known) throw new Error("the settings store could not be read");
  const record = externalEngineFromState({ [EXTERNAL_ENGINE_STORE_KEY]: stored.value });
  const key = readExternalEngineKey();
  const keyWrittenAt = readExternalEngineKeyWrittenAt();
  const after = localAiTransitionMark();
  if (after.running || after.generation !== before.generation) return ENGINE_CHANGING;
  const recordKey = key && key !== NO_KEY_PLACEHOLDER ? key : null;
  const override = normalizeExternalBaseUrl(unquote(env[CLUSTER_ENGINE_URL_ENV]));
  // The stored key and model belong to the engine they were saved for: they go
  // to that engine's origin and nowhere else.
  const same = override === null || (record !== null && externalEngineOrigin(record.baseUrl) === externalEngineOrigin(override));
  if (record && recordKey && same) {
    // ...and only while the key is that save's: a key written after its record
    // (a save that failed half way, its old key not put back) is not. Nor is a
    // key that cannot be shown to be — a record with no save time, a key file
    // whose time cannot be read: withheld, never assumed.
    const savedAt = Date.parse(record.savedAt);
    if (!Number.isFinite(savedAt) || keyWrittenAt === null || keyWrittenAt > savedAt + KEY_BINDING_SLACK_MS) {
      return ENGINE_UNBOUND;
    }
  }
  if (override) {
    return { baseUrl: override, apiKey: same ? recordKey : null, modelId: same && record ? record.modelId : "" };
  }
  if (record) return { baseUrl: record.baseUrl, apiKey: recordKey, modelId: record.modelId };
  return null;
}

function defaultDeps(): ClusterDeps {
  return {
    env: process.env,
    now: () => Date.now(),
    run: runScript,
    isWorkstation: defaultIsWorkstation,
    readEngine: () => defaultReadEngine(process.env),
    fetchImpl: fetch,
    lookup: defaultLookup,
  };
}

let depsOverride: Partial<ClusterDeps> | null = null;

function deps(): ClusterDeps {
  return { ...defaultDeps(), ...(depsOverride ?? {}) };
}

// ── Remembering answers ─────────────────────────────────────────────────────────

/** A good read is trusted this long; a failed one less, so a Spark that came back shows soon. */
export const FRESH_MS = 6_000;
export const FRESH_FAILURE_MS = 4_000;
/** Past this a remembered card is not shown while a read runs: the page waits for the new one. */
export const STALE_MS = 30_000;

interface Remembered<T> {
  at: number;
  value: T;
  ok: boolean;
}

const remembered = new Map<string, Remembered<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

/**
 * The answer for `key`: the remembered one while it is fresh, the remembered
 * one while a new read runs behind it (up to `STALE_MS`), else the new read.
 * `load` must not reject — a failure is a value the caller draws.
 */
function remember<T>(key: string, clock: () => number, isOk: (v: T) => boolean, load: () => Promise<T>): Promise<T> {
  const hit = remembered.get(key) as Remembered<T> | undefined;
  // A clock corrected backwards must not pin an entry: negative ages are stale.
  const age = hit ? clock() - hit.at : Infinity;
  if (hit && age >= 0 && age < (hit.ok ? FRESH_MS : FRESH_FAILURE_MS)) return Promise.resolve(hit.value);
  let pending = inFlight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = load()
      .then((value) => {
        // Stamped when the read ENDED: a seven-second timeout must not make its own answer stale on arrival.
        remembered.set(key, { at: clock(), value, ok: isOk(value) });
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    // Nobody may be waiting on it (the stale answer went out instead).
    pending.catch(() => {});
    inFlight.set(key, pending);
  }
  if (hit && age >= 0 && age < STALE_MS) return Promise.resolve(hit.value);
  return pending;
}

/** Forget everything remembered (tests, and nothing else). */
export function _resetClusterForTest(): void {
  remembered.clear();
  inFlight.clear();
  engineTokenMemo.clear();
  workstationMemo = null;
  depsOverride = null;
}

/** Replace some dependencies (tests, and nothing else). */
export function _setClusterDepsForTest(next: Partial<ClusterDeps>): void {
  depsOverride = { ...(depsOverride ?? {}), ...next };
}

// ── One Spark ───────────────────────────────────────────────────────────────────

/**
 * The script every Spark is asked to run, as text for `sh -s`. FIXED: it holds
 * nothing from a request, from the config or from the other Sparks. Read-only —
 * /proc, /sys, `df`, `hostname` and `nvidia-smi --query-gpu`.
 *
 * Written as ONE brace group, so the shell has read all of it before it runs
 * any: a command that reads standard input could otherwise swallow the lines
 * after it (they arrive on that very stream). Every command that might read it
 * gets /dev/null anyway.
 */
export const COLLECTOR_SCRIPT = `{
export LC_ALL=C
H=$(hostname 2>/dev/null </dev/null | head -n 1)
[ -n "$H" ] || H=$(cat /proc/sys/kernel/hostname 2>/dev/null </dev/null | head -n 1)
echo "${COLLECTOR_PREFIX} host $H"
echo "${COLLECTOR_PREFIX} cpu1 $(head -n 1 /proc/stat 2>/dev/null </dev/null)"
sleep 0.5 </dev/null 2>/dev/null || sleep 1 </dev/null
echo "${COLLECTOR_PREFIX} cpu2 $(head -n 1 /proc/stat 2>/dev/null </dev/null)"
echo "${COLLECTOR_PREFIX} up $(cat /proc/uptime 2>/dev/null </dev/null)"
grep -E '^(MemTotal|MemAvailable|MemFree):' /proc/meminfo 2>/dev/null </dev/null | while read -r l; do echo "${COLLECTOR_PREFIX} mem $l"; done
if command -v nvidia-smi >/dev/null 2>&1; then
  # --foreground keeps timeout in this process group, which the deadline stops whole.
  T=""
  if timeout --foreground 1 true >/dev/null 2>&1 </dev/null; then T="timeout --foreground -k 1 4"
  elif command -v timeout >/dev/null 2>&1; then T="timeout 4"; fi
  $T nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null </dev/null | head -n 1 | while read -r l; do echo "${COLLECTOR_PREFIX} gpu $l"; done
fi
for z in /sys/class/thermal/thermal_zone*/temp; do
  [ -r "$z" ] && echo "${COLLECTOR_PREFIX} temp $(cat "$z" 2>/dev/null </dev/null)"
done
df -P -k / 2>/dev/null </dev/null | tail -n 1 | while read -r l; do echo "${COLLECTOR_PREFIX} disk $l"; done
echo "${COLLECTOR_PREFIX} end"
}
`;

const SSH_OPTIONS = [
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=3",
  "-o", "ConnectionAttempts=1",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "IdentitiesOnly=yes",
  "-o", "PasswordAuthentication=no",
  "-o", "KbdInteractiveAuthentication=no",
  "-o", "ServerAliveInterval=2",
  "-o", "ServerAliveCountMax=2",
  "-o", "ForwardAgent=no",
  "-o", "ForwardX11=no",
  "-o", "ControlMaster=no",
  "-o", "ControlPath=none",
  "-o", "LogLevel=ERROR",
];

/** The whole read of one Spark may take this long, ssh's connect included. */
export const SPARK_TIMEOUT_MS = 7_000;

/** Why a read failed, from what ssh said — never passed on as text. */
export function failureOf(result: ScriptResult): SparkFailure {
  if (result.timedOut) return "timeout";
  const said = result.stderr.toLowerCase();
  if (said.includes("host key verification failed") || said.includes("host identification has changed")) return "host_key";
  if (said.includes("permission denied")) return "auth";
  if (said.includes("timed out")) return "timeout";
  if (
    result.code === 255
    || said.includes("could not resolve")
    || said.includes("refused")
    || said.includes("no route")
    || said.includes("unreachable")
    || said.includes("connection closed")
    || said.includes("connection reset")
  ) {
    return "unreachable";
  }
  return "failed";
}

/** This box's own name, for its card when its collector did not answer. */
function localHostname(): string {
  try {
    return os.hostname().replace(/[^\x20-\x7e]/g, "").trim().slice(0, 253);
  } catch {
    return "";
  }
}

async function readSpark(
  d: ClusterDeps,
  id: string,
  local: boolean,
  target: string | null,
): Promise<SparkCard> {
  // A card that could not be read is still named: by the configured host for a
  // peer, by this box's own hostname for this one.
  const fallbackName = target ? targetHost(target) : localHostname();
  let result: ScriptResult;
  try {
    result = target
      ? await d.run("ssh", [...SSH_OPTIONS, "--", target, "sh", "-s"], COLLECTOR_SCRIPT, SPARK_TIMEOUT_MS)
      : await d.run("sh", ["-s"], COLLECTOR_SCRIPT, SPARK_TIMEOUT_MS);
  } catch {
    result = { code: null, stdout: "", stderr: "", timedOut: false };
  }
  const checkedAt = d.now();
  const parsed = result.code === 0 && !result.timedOut ? parseSparkOutput(result.stdout) : null;
  if (parsed) {
    return { id, local, online: true, hostname: parsed.hostname, checkedAt, figures: parsed.figures };
  }
  // A clean exit with output that is not the collector's is a Spark that answered
  // wrongly (no `sh`, a refusing forced command): reachable, but not readable.
  const failure: SparkFailure = result.code === 0 && !result.timedOut ? "failed" : failureOf(result);
  return { id, local, online: false, hostname: fallbackName, failure, checkedAt };
}

// ── The engine ──────────────────────────────────────────────────────────────────

/** The gate's `/models` and the metrics each get this long, together, not in turn. */
export const ENGINE_TIMEOUT_MS = 2_500;
const METRICS_MAX_BYTES = 1024 * 1024;

const LAN = new net.BlockList();
LAN.addSubnet("10.0.0.0", 8, "ipv4"); // public-hygiene: allow RFC 1918 range of the LAN rule
LAN.addSubnet("172.16.0.0", 12, "ipv4"); // public-hygiene: allow RFC 1918 range of the LAN rule
LAN.addSubnet("192.168.0.0", 16, "ipv4"); // public-hygiene: allow RFC 1918 range of the LAN rule
LAN.addSubnet("127.0.0.0", 8, "ipv4");
LAN.addAddress("::1", "ipv6");
LAN.addSubnet("fc00::", 7, "ipv6");

/** Loopback, RFC 1918 and unique-local: the addresses "this network" means. */
export function isLanAddress(address: string): boolean {
  const bare = address.trim().replace(/^\[|\]$/g, "").split("%")[0];
  const family = net.isIP(bare);
  if (family === 0) return false;
  return LAN.check(bare, family === 6 ? "ipv6" : "ipv4");
}

/** `lanRefusal`'s answer for a name the lookup could not resolve (an error, or no address). */
export const NAME_UNRESOLVED = "does not resolve";

/**
 * Null when `hostname` is on this network — the literal, or EVERY address a name
 * resolves to — else the reason it is not. A name the lookup cannot resolve is
 * `NAME_UNRESOLVED`, never a pass: the request would look the name up again,
 * unchecked, and could reach an address this check never saw.
 */
export async function lanRefusal(hostname: string, lookup: LookupFn): Promise<string | null> {
  const host = hostname.trim().replace(/^\[|\]$/g, "");
  if (net.isIP(host.split("%")[0])) return isLanAddress(host) ? null : "not a private address";
  const resolved = await lookup(host).catch(() => null);
  if (!resolved || resolved.length === 0) return NAME_UNRESOLVED;
  for (const { address } of resolved) {
    if (!isLanAddress(address)) return "resolves to an address outside the local network";
  }
  return null;
}

/**
 * The last token read of each metrics page, by its URL: a rate only ever
 * compares two reads of the SAME page (the counter series are compared inside
 * it), so a fallback page or another engine starts at n/a. Bounded.
 */
const engineTokenMemo = new Map<string, TokenRead>();
const ENGINE_TOKEN_MEMO_MAX = 8;

function rememberTokens(url: string, read: TokenRead): void {
  engineTokenMemo.delete(url);
  engineTokenMemo.set(url, read);
  while (engineTokenMemo.size > ENGINE_TOKEN_MEMO_MAX) {
    const oldest = engineTokenMemo.keys().next().value;
    if (oldest === undefined) break;
    engineTokenMemo.delete(oldest);
  }
}

const NO_METRICS = { available: false, active: null, queued: null, tokensPerSecond: null } as const;

function gateReason(code: string): EngineGateReason {
  switch (code) {
    case "unreachable":
      return "unreachable";
    case "unauthorized":
      return "unauthorized";
    case "address_refused":
      return "address_refused";
    default:
      return "bad_response";
  }
}

/** One engine read's own state: what stops it, which settings it read, and what it may remember once it is the answer. */
interface EngineReadContext {
  /** Fired at the deadline, or when a Local AI transition starts. */
  signal: AbortSignal;
  /** The transition stamp at the read's start: token baselines are kept per settings generation. */
  generation: number;
  /** Token baselines to keep, committed only when this read is the one answered. */
  staged: (() => void)[];
}

async function readEngineMetrics(
  d: ClusterDeps,
  target: EngineTarget,
  ctx: EngineReadContext,
): Promise<NonNullable<EngineView["metrics"]>> {
  const deadline = ctx.signal;
  const origin = externalEngineOrigin(target.baseUrl);
  const withoutV1 = target.baseUrl.replace(/\/v1$/, "");
  const bases = [...new Set([withoutV1, origin].filter(Boolean))];
  const headers: Record<string, string> = { Accept: "text/plain" };
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
  for (const base of bases) {
    // A read the deadline has given up on starts no request.
    if (deadline.aborted) break;
    const url = `${base}/metrics`;
    try {
      const res = await d.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(ENGINE_TIMEOUT_MS)]),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const text = await readCapped(res, METRICS_MAX_BYTES);
      if (text === null) continue;
      const sample = engineSampleFrom(parsePrometheusSeries(text));
      if (!engineSampleUsable(sample)) continue;
      // Its answer reaches nobody, and must not move the baseline a later read compares with.
      if (deadline.aborted) break;
      const at = d.now();
      let tokensPerSecond = sample.rate !== null ? Math.round(sample.rate * 10) / 10 : null;
      if (sample.tokens !== null) {
        // The same page under other settings (another engine behind the same
        // address) is another stream: baselines are kept per settings generation.
        const memoKey = `${ctx.generation}|${url}`;
        const read: TokenRead = { at, tokens: sample.tokens };
        if (tokensPerSecond === null) tokensPerSecond = tokensPerSecondBetween(engineTokenMemo.get(memoKey) ?? null, read);
        // Kept only if the whole engine read is the answer (`readEngine`).
        ctx.staged.push(() => rememberTokens(memoKey, read));
      }
      return { available: true, active: sample.active, queued: sample.queued, tokensPerSecond };
    } catch {
      // This base has no metrics for us; the next one may.
    }
  }
  return { ...NO_METRICS };
}

/**
 * The whole engine read has this long. Each request carries its own timeout, but
 * a name lookup has none of ours: a resolver that is down can take far longer
 * than any request, and the first page of a session would wait on it.
 */
export const ENGINE_DEADLINE_MS = 6_000;

async function readEngineUnbounded(d: ClusterDeps, ctx: EngineReadContext): Promise<EngineView> {
  const deadline = ctx.signal;
  let target: EngineTarget | null | typeof ENGINE_CHANGING | typeof ENGINE_UNBOUND;
  try {
    target = await d.readEngine();
  } catch {
    // Not "none is set up": the record is there or not, and could not be told.
    return { configured: false, unread: "unreadable", checkedAt: d.now() };
  }
  if (target === ENGINE_CHANGING) return { configured: true, unread: "changing", checkedAt: d.now() };
  if (target === ENGINE_UNBOUND) return { configured: true, unread: "unbound", checkedAt: d.now() };
  if (!target) return { configured: false };
  const view: EngineView = { configured: true, ...(target.modelId ? { model: target.modelId } : {}) };

  let hostname = "";
  try {
    hostname = new URL(target.baseUrl).hostname;
  } catch {
    return { ...view, checkedAt: d.now(), gate: { online: false, reason: "address_refused" }, metrics: { ...NO_METRICS } };
  }
  const refusal = await lanRefusal(hostname, d.lookup);
  if (refusal === NAME_UNRESOLVED) {
    // Nothing to check it against, so nothing is asked: a gate that cannot be reached.
    return { ...view, checkedAt: d.now(), gate: { online: false, reason: "unreachable" }, metrics: { ...NO_METRICS } };
  }
  if (refusal) {
    return { ...view, checkedAt: d.now(), gate: { online: false, reason: "not_lan" }, metrics: { ...NO_METRICS } };
  }
  // A lookup that outlived the deadline: its answer reaches nobody, so nothing is asked.
  if (deadline.aborted) return { ...view, checkedAt: d.now(), gate: { online: false, reason: "unreachable" }, metrics: { ...NO_METRICS } };

  const [probe, metrics] = await Promise.all([
    probeExternalEngine({
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      modelId: target.modelId,
      timeoutMs: ENGINE_TIMEOUT_MS,
      fetchImpl: d.fetchImpl,
      lookupImpl: d.lookup,
      signal: deadline,
    }).catch(() => null),
    readEngineMetrics(d, target, ctx),
  ]);
  const checkedAt = d.now();
  if (probe?.ok) return { ...view, checkedAt, gate: { online: true, latencyMs: probe.latencyMs }, metrics };
  // A gate that answered with a model list that lacks the saved model is up.
  if (probe && probe.code === "model_not_listed") return { ...view, checkedAt, gate: { online: true }, metrics };
  return { ...view, checkedAt, gate: { online: false, reason: probe ? gateReason(probe.code) : "unreachable" }, metrics };
}

async function readEngine(d: ClusterDeps): Promise<EngineView> {
  // Fired at the deadline: the read that lost the race starts no request after
  // it and leaves the token baseline alone (`Promise.race` cancels nothing).
  // Fired too when a Local AI transition starts while the read runs: the
  // address and the key it read may stop belonging together, so no request it
  // has not sent yet goes out, the ones under way are cut, and the answer says
  // the settings are changing.
  const deadline = new AbortController();
  let changed = false;
  const stopWatching = onLocalAiTransitionStart(() => {
    changed = true;
    deadline.abort();
  });
  const ctx: EngineReadContext = { signal: deadline.signal, generation: localAiTransitionMark().generation, staged: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<EngineView>((resolve) => {
    timer = setTimeout(() => {
      deadline.abort();
      // Something is configured and did not answer in time: a gate that is not up, said so.
      resolve({
        configured: true,
        checkedAt: d.now(),
        gate: { online: false, reason: "unreachable" },
        metrics: { ...NO_METRICS },
      });
    }, ENGINE_DEADLINE_MS);
  });
  try {
    const answer = await Promise.race([readEngineUnbounded(d, ctx), late]);
    if (changed) return { configured: true, unread: "changing", checkedAt: d.now() };
    // The read that IS the answer keeps its token baselines; one the deadline
    // gave up on keeps none, even what it finished before the deadline.
    if (!deadline.signal.aborted) for (const commit of ctx.staged) commit();
    return answer;
  } finally {
    clearTimeout(timer);
    stopWatching();
  }
}

// ── The page's questions ────────────────────────────────────────────────────────

/** Does this box show a Cluster view at all? Cheap: no ssh, no request. */
export function clusterEnabled(d: ClusterDeps = deps()): boolean {
  const mode = clusterMode(d.env);
  if (mode === "off") return false;
  if (clusterPeers(d.env).targets.length === 0) return false;
  return mode === "on" || d.isWorkstation();
}

/** The cluster as it is now, or `{ enabled: false }` where there is none to show. */
export async function clusterAnswer(): Promise<ClusterAnswer> {
  const d = deps();
  if (!clusterEnabled(d)) return { enabled: false };
  const { targets } = clusterPeers(d.env);
  const sparkOk = (card: SparkCard) => card.online;
  const [local, engine, ...peers] = await Promise.all([
    remember("local", d.now, sparkOk, () => readSpark(d, "local", true, null)),
    remember("engine", d.now, (v: EngineView) => v.gate?.online === true, () => readEngine(d)),
    ...targets.map((target) =>
      remember(`peer:${target}`, d.now, sparkOk, () => readSpark(d, "peer", false, target)),
    ),
  ]);
  const snapshot: ClusterSnapshot = {
    enabled: true,
    // The OLDEST reading's time, not the moment of the answer: a card — or the
    // engine's reading — served from memory while a fresh read runs is up to
    // STALE_MS old, and a stamp that said "now" over it would make its figures
    // look current.
    generatedAt: Math.min(
      d.now(),
      local.checkedAt,
      ...peers.map((card) => card.checkedAt),
      ...(typeof engine.checkedAt === "number" ? [engine.checkedAt] : []),
    ),
    sparks: [{ ...local, id: "local" }, ...peers.map((card, i) => ({ ...card, id: `peer-${i + 1}` }))],
    engine,
  };
  return snapshot;
}
