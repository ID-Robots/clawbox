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
 * NEVER BLOCKS THE PAGE. Every read is remembered for a few seconds and shared
 * by whoever asks meanwhile. A Spark that has been read once is answered from
 * what is known while a fresh read runs behind the answer, so a Spark that
 * went away costs the page nothing but a stale card for one refresh.
 *
 * NOTHING LEAVES THE LAN. The Sparks are the owner's own list (an ssh target is
 * a name the owner chose, and ssh's own config may map it anywhere, so it is not
 * second-guessed here). The only other requests go to the engine's address, and
 * only when that address is loopback or private (RFC 1918, unique-local): the
 * check is made on the literal and on every address a name resolves to. A name
 * that is rebound between that check and the connection is not defended
 * against, which is the limit of the external engine's own probe as well.
 */

import { spawn } from "child_process";
import net from "net";
import { lookup as dnsLookup } from "dns/promises";
import { resolveConfigRoot } from "./config-store";
import {
  NO_KEY_PLACEHOLDER,
  probeExternalEngine,
  readCapped,
  readExternalEngine,
  readExternalEngineKey,
} from "./external-engine";
import { externalEngineOrigin, normalizeExternalBaseUrl } from "./external-engine-shared";
import { isWorkstationHost, probeUpdateHost } from "./update-channel";
import {
  COLLECTOR_PREFIX,
  engineSampleFrom,
  engineSampleUsable,
  parsePrometheus,
  parseSparkOutput,
  tokensPerSecondBetween,
  type ClusterAnswer,
  type ClusterSnapshot,
  type EngineGateReason,
  type EngineView,
  type SparkCard,
  type SparkFailure,
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

export interface ClusterDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  run: ScriptRunner;
  isWorkstation: () => boolean;
  readEngine: () => Promise<EngineTarget | null>;
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

/** spawn with a hard ceiling: the answer arrives by the deadline whatever the child does. */
export const runScript: ScriptRunner = (command, args, input, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnvironment() });
    } catch {
      finish(null);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
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

async function defaultReadEngine(env: NodeJS.ProcessEnv): Promise<EngineTarget | null> {
  const record = await readExternalEngine();
  const key = readExternalEngineKey();
  const recordKey = key && key !== NO_KEY_PLACEHOLDER ? key : null;
  const override = normalizeExternalBaseUrl(unquote(env[CLUSTER_ENGINE_URL_ENV]));
  if (override) {
    // The stored key and model belong to the engine they were saved for: they
    // go to the same origin and nowhere else.
    const same = record !== null && externalEngineOrigin(record.baseUrl) === externalEngineOrigin(override);
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
  T=""
  command -v timeout >/dev/null 2>&1 && T="timeout 4"
  $T nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null </dev/null | head -n 1 | while read -r l; do echo "${COLLECTOR_PREFIX} gpu $l"; done
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

async function readSpark(
  d: ClusterDeps,
  id: string,
  local: boolean,
  target: string | null,
): Promise<SparkCard> {
  const fallbackName = target ? targetHost(target) : "";
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

/**
 * Null when `hostname` is on this network — the literal, or EVERY address a name
 * resolves to — else the reason it is not. A name that does not resolve is left
 * to the request, which fails as unreachable.
 */
export async function lanRefusal(hostname: string, lookup: LookupFn): Promise<string | null> {
  const host = hostname.trim().replace(/^\[|\]$/g, "");
  if (net.isIP(host.split("%")[0])) return isLanAddress(host) ? null : "not a private address";
  const resolved = await lookup(host).catch(() => []);
  for (const { address } of resolved) {
    if (!isLanAddress(address)) return "resolves to an address outside the local network";
  }
  return null;
}

const engineTokenMemo = new Map<string, { at: number; tokens: number }>();

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

async function readEngineMetrics(
  d: ClusterDeps,
  target: EngineTarget,
): Promise<NonNullable<EngineView["metrics"]>> {
  const none = { available: false, active: null, queued: null, tokensPerSecond: null };
  const origin = externalEngineOrigin(target.baseUrl);
  const withoutV1 = target.baseUrl.replace(/\/v1$/, "");
  const bases = [...new Set([withoutV1, origin].filter(Boolean))];
  const headers: Record<string, string> = { Accept: "text/plain" };
  if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
  for (const base of bases) {
    try {
      const res = await d.fetchImpl(`${base}/metrics`, {
        method: "GET",
        headers,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const text = await readCapped(res, METRICS_MAX_BYTES);
      if (text === null) continue;
      const sample = engineSampleFrom(parsePrometheus(text));
      if (!engineSampleUsable(sample)) continue;
      const at = d.now();
      let tokensPerSecond = sample.rate !== null ? Math.round(sample.rate * 10) / 10 : null;
      if (sample.tokens !== null) {
        const previous = engineTokenMemo.get(origin) ?? null;
        if (tokensPerSecond === null) tokensPerSecond = tokensPerSecondBetween(previous, { at, tokens: sample.tokens });
        engineTokenMemo.set(origin, { at, tokens: sample.tokens });
      }
      return { available: true, active: sample.active, queued: sample.queued, tokensPerSecond };
    } catch {
      // This base has no metrics for us; the next one may.
    }
  }
  return none;
}

/**
 * The whole engine read has this long. Each request carries its own timeout, but
 * a name lookup has none of ours: a resolver that is down can take far longer
 * than any request, and the first page of a session would wait on it.
 */
export const ENGINE_DEADLINE_MS = 6_000;

async function readEngineUnbounded(d: ClusterDeps): Promise<EngineView> {
  let target: EngineTarget | null;
  try {
    target = await d.readEngine();
  } catch {
    target = null;
  }
  if (!target) return { configured: false };
  const view: EngineView = { configured: true, ...(target.modelId ? { model: target.modelId } : {}) };
  const noMetrics = { available: false, active: null, queued: null, tokensPerSecond: null };

  let hostname = "";
  try {
    hostname = new URL(target.baseUrl).hostname;
  } catch {
    return { ...view, gate: { online: false, reason: "address_refused" }, metrics: noMetrics };
  }
  if (await lanRefusal(hostname, d.lookup)) {
    return { ...view, gate: { online: false, reason: "not_lan" }, metrics: noMetrics };
  }

  const [probe, metrics] = await Promise.all([
    probeExternalEngine({
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      modelId: target.modelId,
      timeoutMs: ENGINE_TIMEOUT_MS,
      fetchImpl: d.fetchImpl,
      lookupImpl: d.lookup,
    }).catch(() => null),
    readEngineMetrics(d, target),
  ]);
  if (probe?.ok) return { ...view, gate: { online: true, latencyMs: probe.latencyMs }, metrics };
  // A gate that answered with a model list that lacks the saved model is up.
  if (probe && probe.code === "model_not_listed") return { ...view, gate: { online: true }, metrics };
  return { ...view, gate: { online: false, reason: probe ? gateReason(probe.code) : "unreachable" }, metrics };
}

async function readEngine(d: ClusterDeps): Promise<EngineView> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<EngineView>((resolve) => {
    timer = setTimeout(() => {
      // Something is configured and did not answer in time: a gate that is not up, said so.
      resolve({
        configured: true,
        gate: { online: false, reason: "unreachable" },
        metrics: { available: false, active: null, queued: null, tokensPerSecond: null },
      });
    }, ENGINE_DEADLINE_MS);
  });
  try {
    return await Promise.race([readEngineUnbounded(d), late]);
  } finally {
    clearTimeout(timer);
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
    // The OLDEST card's read, not the moment of the answer: a card served from
    // memory while a fresh read runs is up to STALE_MS old, and a stamp that
    // said "now" over it would make its figures look current.
    generatedAt: Math.min(d.now(), local.checkedAt, ...peers.map((card) => card.checkedAt)),
    sparks: [{ ...local, id: "local" }, ...peers.map((card, i) => ({ ...card, id: `peer-${i + 1}` }))],
    engine,
  };
  return snapshot;
}
