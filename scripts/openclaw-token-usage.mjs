#!/usr/bin/env node
/**
 * `clawbox tokens` — what every OpenClaw agent and every model spent, over a
 * window of whole UTC days (default: the last 7, today included).
 *
 *   node scripts/openclaw-token-usage.mjs [--days N] [--agent ID] [--json]
 *                                         [--source auto|gateway|db]
 *                                         [--state-dir DIR] [--timeout SECONDS]
 *
 * Per agent, per model and per agent × model it prints sessions, model calls,
 * input, output, cache-read and cache-write tokens. READ-ONLY, from either of
 * two sources:
 *
 * `gateway` — HARNESS FIRST. The core's own usage report, `sessions.usage`
 *   with `agentScope: "all"` (docs/gateway/protocol/rpc-system-and-channels.md
 *   in the pinned core), asked through `openclaw gateway call`. It is the same
 *   accounting the Control UI's Usage page shows. It needs a running gateway,
 *   and on a cold cache it answers with what it has (`cacheStatus` not
 *   "fresh", sessions marked `computing`) while it rebuilds in the background.
 *
 * `db` — the agent databases themselves,
 *   `<state>/agents/<id>/agent/openclaw-agent.sqlite`, opened read-only
 *   (`mode=ro`, `PRAGMA query_only`), never written and never locked against
 *   the gateway: under WAL a reader takes no lock a writer waits on. Each model
 *   call is the `usage` of one assistant message in `transcript_events`.
 *   Fast on multi-GB databases because it reads only the window: a session
 *   window whose transcript was last written before the window starts
 *   (`session_windows.transcript_updated_at` / `updated_at`, the core's own
 *   watermarks) is not opened at all; the others are walked NEWEST FIRST
 *   through the (session_id, seq) primary key, and the walk stops at the first
 *   run of rows created before the window — `created_at` is when the row was
 *   written, never earlier than the message in it. Rows that cannot hold an
 *   assistant message are not decoded
 *   (a plain row without `"assistant"` in it, a compressed row whose
 *   navigation facts say it is not a message). Compressed rows (agent schema
 *   23+: `event_zstd`) are decoded with node:zlib's zstd; cold-archived
 *   windows archived inside the window are read from their archive. A session
 *   the core reset or deleted is gone from the database but still counted, as
 *   the core's own report counts it: from its transcript archive beside the
 *   database (`sessions/<id>.jsonl.reset.<stamp>`, `.deleted.`, `.zst`).
 *
 * `auto` (the default) asks the gateway and takes its answer when it is
 * complete; when the gateway is down, or still computing, it counts from the
 * databases instead and says so.
 *
 * The two can differ slightly: the gateway follows OpenClaw's visible branch
 * of each transcript, the databases count every recorded model call
 * (including a branch rewound later), each response once.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT_DB_NAME = "openclaw-agent.sqlite";
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/**
 * Rows older than the window a newest-first walk reads before it stops. More
 * than one, so a row stamped by a clock that was briefly wrong (a box that
 * booted before NTP) cannot end the walk early; few, because reading a row's
 * `created_at` reads past its whole payload.
 */
export const STOP_AFTER_OLD_ROWS = 8;
/** The most sessions.usage may return in one answer; more is "incomplete". */
const GATEWAY_SESSION_LIMIT = 100000;
const DEFAULT_TIMEOUT_S = 120;
/**
 * A cold archive that decodes to more than this is not read (it is named in
 * the notes): the pinned core's own cap (`MAX_COLD_ARCHIVE_BYTES`, its
 * session-cold-storage worker), which it neither writes nor decodes past.
 */
const COLD_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
/**
 * A reset or deleted session's transcript archive bigger than this is not
 * read (it is named in the notes): the whole archive is held in memory while
 * it is counted, and a long-lived chat's can be hundreds of MB.
 */
const TRANSCRIPT_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
/**
 * The transcript files the pinned core's usage report counts
 * (parseUsageCountedSessionIdFromFileName, its transcript-file-names module):
 * a file-era `<id>.jsonl` that is not a trajectory or compaction checkpoint,
 * and the archive a reset or delete leaves, `<id>.jsonl.<reason>.<stamp>`
 * with an optional `.<32 hex>` and `.zst`.
 */
const ARCHIVE_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z(?:\.[0-9a-f]{32})?$/;
const CHECKPOINT_TRANSCRIPT_RE = /^(.+)\.checkpoint\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i;

const USAGE = `Usage: clawbox tokens [--days N] [--agent ID] [--json] [--source auto|gateway|db]
                      [--state-dir DIR] [--timeout SECONDS]

Token usage per OpenClaw agent and per model, read-only.
  --days N        whole UTC days, today included (default ${DEFAULT_DAYS})
  --agent ID      one agent only (default: every agent)
  --json          machine-readable output
  --source S      gateway: the core's sessions.usage; db: the agent databases,
                  read-only; auto (default): gateway when it answers in full,
                  else the databases
  --state-dir DIR the OpenClaw state dir (default: $OPENCLAW_STATE_DIR or ~/.openclaw)
  --timeout S     seconds to wait for the gateway (default ${DEFAULT_TIMEOUT_S})`;

export class UsageError extends Error {}

/**
 * @typedef {{ days: number, agent: string | null, json: boolean, source: "auto" | "gateway" | "db",
 *   stateDir: string | null, timeoutMs: number, help: boolean }} Options
 */

/**
 * Parse argv (without node and the script). Throws UsageError.
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const opts = {
    days: DEFAULT_DAYS,
    agent: null,
    json: false,
    source: "auto",
    stateDir: null,
    timeoutMs: DEFAULT_TIMEOUT_S * 1000,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith("--") && eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${name} needs a value`);
      i += 1;
      return next;
    };
    switch (name) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--days": {
        const raw = value();
        const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
          throw new UsageError(`--days must be a whole number from 1 to ${MAX_DAYS}, got "${raw}"`);
        }
        opts.days = days;
        break;
      }
      case "--agent": {
        const raw = value();
        if (!AGENT_ID_RE.test(raw)) throw new UsageError(`--agent: not an agent id: "${raw}"`);
        opts.agent = raw;
        break;
      }
      case "--source": {
        const raw = value();
        if (!["auto", "gateway", "db"].includes(raw)) {
          throw new UsageError(`--source must be auto, gateway or db, got "${raw}"`);
        }
        opts.source = /** @type {Options["source"]} */ (raw);
        break;
      }
      case "--state-dir":
        opts.stateDir = path.resolve(value());
        break;
      case "--timeout": {
        const raw = value();
        const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) {
          throw new UsageError(`--timeout must be 1-3600 seconds, got "${raw}"`);
        }
        opts.timeoutMs = seconds * 1000;
        break;
      }
      default:
        throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/** @typedef {Record<string, string | undefined>} Env */

/**
 * The OpenClaw state dir, the way the core resolves it.
 * @param {Env} [env]
 * @param {string} [home]
 */
export function resolveStateDir(env = process.env, home = os.homedir()) {
  if (env.OPENCLAW_STATE_DIR?.trim()) return path.resolve(env.OPENCLAW_STATE_DIR.trim());
  if (env.OPENCLAW_HOME?.trim()) return path.join(path.resolve(env.OPENCLAW_HOME.trim()), ".openclaw");
  return path.join(env.HOME?.trim() || home, ".openclaw");
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The window: `days` whole UTC calendar days ending with today — the range
 * sessions.usage computes for the same startDate/endDate in `utc` mode, so
 * both sources count the same messages.
 */
export function usageWindow(days, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = todayStart - (days - 1) * DAY_MS;
  const endMs = todayStart + DAY_MS - 1;
  return { days, startMs, endMs, startDate: isoDay(startMs), endDate: isoDay(endMs) };
}

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const count = (v) => {
  const n = finite(typeof v === "string" && v.trim() !== "" ? Number(v) : v);
  if (n === undefined) return undefined;
  return n <= 0 ? 0 : Math.min(Math.trunc(n), Number.MAX_SAFE_INTEGER);
};

/**
 * One provider's usage object as OpenClaw's own `normalizeUsage`
 * (src/agents/usage.ts in the pinned core) reads it: the same field aliases,
 * and the same rule that a cache read or write already inside a provider's
 * prompt count is taken out of `input`. Null when nothing is countable.
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cacheRead = count(
    raw.cacheRead ?? raw.cache_read ?? raw.cache_read_input_tokens ?? raw.cached_input_tokens ?? raw.cached
      ?? raw.cached_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens,
  );
  const cacheWrite = count(
    raw.cacheWrite ?? raw.cache_write ?? raw.cache_creation_input_tokens ?? raw.cache_write_input_tokens
      ?? raw.input_tokens_details?.cache_write_tokens ?? raw.prompt_tokens_details?.cache_write_tokens
      ?? raw.prompt_tokens_details?.cache_creation_input_tokens,
  );
  const directInput = finite(raw.input);
  const rawInput = finite(
    raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens ?? raw.prompt_n
      ?? raw.timings?.prompt_n,
  );
  const cliCacheReadInInput = raw.cached_input_tokens !== undefined || raw.cached !== undefined;
  const openAiCacheReadInInput = raw.cached_tokens !== undefined
    || raw.input_tokens_details?.cached_tokens !== undefined
    || raw.prompt_tokens_details?.cached_tokens !== undefined;
  const cacheWriteInInput = raw.cache_write_input_tokens !== undefined
    || raw.input_tokens_details?.cache_write_tokens !== undefined
    || raw.prompt_tokens_details?.cache_write_tokens !== undefined
    || raw.prompt_tokens_details?.cache_creation_input_tokens !== undefined;
  const input = count(
    rawInput === undefined
      ? undefined
      : rawInput
        - (openAiCacheReadInInput || (directInput === undefined && cliCacheReadInInput) ? cacheRead ?? 0 : 0)
        - (directInput === undefined && cacheWriteInInput ? cacheWrite ?? 0 : 0),
  );
  const output = count(
    raw.output ?? raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens ?? raw.completion_tokens
      ?? raw.predicted_n ?? raw.timings?.predicted_n,
  );
  const total = count(raw.total ?? raw.totalTokens ?? raw.total_tokens);
  if ([input, output, cacheRead, cacheWrite, total].every((v) => v === undefined)) return null;
  const i = input ?? 0;
  const o = output ?? 0;
  const r = cacheRead ?? 0;
  const w = cacheWrite ?? 0;
  return { input: i, output: o, cacheRead: r, cacheWrite: w, totalTokens: total ?? i + o + r + w };
}

/** The usage, model and time of one transcript event, when it is a model call. */
export function assistantCall(event) {
  if (!event || typeof event !== "object" || event.type !== "message") return null;
  const message = event.message;
  if (!message || typeof message !== "object" || message.role !== "assistant") return null;
  const usage = normalizeUsage(message.usage ?? event.usage);
  if (!usage) return null;
  let ts = finite(message.timestamp);
  if (ts === undefined && typeof event.timestamp === "string") {
    const parsed = Date.parse(event.timestamp);
    if (Number.isFinite(parsed)) ts = parsed;
  }
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    ts,
    provider: str(message.provider) ?? str(event.provider) ?? "unknown",
    model: str(message.model) ?? str(event.model) ?? "unknown",
    // One provider response is one call, wherever a fork or a rewind copied it.
    key: str(message.responseId) ?? (str(event.id) ? `${event.id}@${ts ?? ""}` : undefined),
    usage,
  };
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const emptyRow = () => ({ sessions: new Set(), calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

/** Sums calls into per-agent, per-model and per-agent×model rows. */
export function createAccumulator() {
  const agents = new Map();
  const models = new Map();
  const pairs = new Map();
  const total = emptyRow();
  const bump = (map, key, seed) => {
    let row = map.get(key);
    if (!row) {
      row = { ...seed, ...emptyRow() };
      map.set(key, row);
    }
    return row;
  };
  return {
    /** `calls` model calls of one model in one session, with their summed usage. */
    add({ agentId, sessionId, provider, model, calls = 1, usage }) {
      const session = `${agentId}\u0000${sessionId}`;
      const modelKey = `${provider}/${model}`;
      for (const row of [
        bump(agents, agentId, { agentId }),
        bump(models, modelKey, { provider, model }),
        bump(pairs, `${agentId}\u0000${modelKey}`, { agentId, provider, model }),
        total,
      ]) {
        row.sessions.add(session);
        row.calls += calls;
        for (const f of TOKEN_FIELDS) row[f] += usage[f] ?? 0;
      }
    },
    /** Rows with session counts, biggest first. */
    finish() {
      const out = (row) => {
        const { sessions, ...rest } = row;
        return { ...rest, sessions: sessions.size };
      };
      const order = (a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls;
      return {
        agents: [...agents.values()].map(out).sort((a, b) => order(a, b) || a.agentId.localeCompare(b.agentId)),
        models: [...models.values()].map(out).sort((a, b) => order(a, b) || `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)),
        agentModels: [...pairs.values()].map(out).sort((a, b) => a.agentId.localeCompare(b.agentId) || order(a, b)),
        totals: out(total),
      };
    },
  };
}

// ── Source: the gateway's own report ────────────────────────────────────────

/**
 * The openclaw CLI, found the way src/lib/openclaw-config.ts finds it.
 * @param {Env} [env]
 */
export function findOpenclawBin(env = process.env) {
  if (env.OPENCLAW_BIN?.trim()) return env.OPENCLAW_BIN.trim();
  const home = env.HOME || os.homedir();
  const candidates = [
    path.join(home, ".npm-global", "bin", "openclaw"),
    path.join(path.dirname(process.execPath), "openclaw"),
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? "openclaw";
}

/** sessions.usage params for the window, in the mode both sources share. */
export function gatewayParams(window, agent) {
  return {
    ...(agent ? { agentId: agent } : { agentScope: "all" }),
    startDate: window.startDate,
    endDate: window.endDate,
    mode: "utc",
    limit: GATEWAY_SESSION_LIMIT,
  };
}

/**
 * Report rows from a sessions.usage answer, and whether it was complete. Each
 * session row carries its agent and `usage.modelUsage[]` (provider, model,
 * count, totals); a session counts toward a model when it called it.
 */
export function reportFromGateway(result, window) {
  if (!result || typeof result !== "object" || !Array.isArray(result.sessions)) {
    throw new Error("sessions.usage answered without a sessions list");
  }
  const acc = createAccumulator();
  const notes = [];
  let computing = 0;
  for (const session of result.sessions) {
    const agentId = typeof session?.agentId === "string" && session.agentId ? session.agentId : "main";
    const sessionId = session?.sessionId ?? session?.key ?? "";
    const usage = session?.usage;
    if (!usage) {
      if (session?.computing) computing += 1;
      continue;
    }
    const counted = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    for (const entry of Array.isArray(usage.modelUsage) ? usage.modelUsage : []) {
      const totals = entry?.totals ?? {};
      const row = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, count(totals[f]) ?? 0]));
      const calls = count(entry?.count) ?? 0;
      if (calls === 0 && TOKEN_FIELDS.every((f) => row[f] === 0)) continue;
      acc.add({
        agentId,
        sessionId,
        provider: entry?.provider || "unknown",
        model: entry?.model || "unknown",
        calls,
        usage: row,
      });
      for (const f of TOKEN_FIELDS) counted[f] += row[f];
    }
    // Usage the core could not attribute to a model still belongs to the agent.
    const rest = Object.fromEntries(TOKEN_FIELDS.map((f) => [f, Math.max(0, (count(usage[f]) ?? 0) - counted[f])]));
    if (TOKEN_FIELDS.some((f) => rest[f] > 0)) {
      acc.add({ agentId, sessionId, provider: "unknown", model: "unknown", calls: 0, usage: rest });
    }
  }
  const cache = result.cacheStatus;
  const fresh = !cache || cache.status === undefined || cache.status === "fresh";
  if (!fresh) {
    notes.push(`the gateway's usage cache is ${cache.status} (${cache.pendingFiles ?? 0} transcript(s) pending): totals may be incomplete`);
  }
  if (computing > 0) notes.push(`${computing} session(s) still being computed by the gateway`);
  const truncated = result.sessions.length >= GATEWAY_SESSION_LIMIT;
  if (truncated) notes.push(`more than ${GATEWAY_SESSION_LIMIT} sessions: the list was cut`);
  // Totals for another range than the one asked are not this window's: the
  // header and the JSON `window` name the request, so a clamped or shifted
  // answer is incomplete (and `auto` counts from the databases instead).
  const otherRange = (result.startDate !== undefined && result.startDate !== window.startDate)
    || (result.endDate !== undefined && result.endDate !== window.endDate);
  if (otherRange) {
    notes.push(`the gateway answered for ${result.startDate ?? "?"} .. ${result.endDate ?? "?"}, not ${window.startDate} .. ${window.endDate}`);
  }
  return { ...acc.finish(), notes, complete: fresh && computing === 0 && !truncated && !otherRange };
}

/**
 * Ask the running gateway for sessions.usage through the core's own CLI.
 * @param {{ window: ReturnType<typeof usageWindow>, agent: string | null, stateDir: string, timeoutMs: number, env?: Env }} params
 */
export function callGatewayUsage({ window, agent, stateDir, timeoutMs, env = process.env }) {
  const bin = findOpenclawBin(env);
  const args = [
    "gateway", "call", "sessions.usage",
    "--params", JSON.stringify(gatewayParams(window, agent)),
    "--json", "--timeout", String(timeoutMs),
  ];
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: timeoutMs + 30_000,
    maxBuffer: 512 * 1024 * 1024,
    env: { ...env, OPENCLAW_STATE_DIR: stateDir, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw new Error(`${path.basename(bin)}: ${res.error.code === "ENOENT" ? "not installed" : res.error.message}`);
  if (res.status !== 0) {
    const why = `${res.stderr || ""}${res.stdout || ""}`.trim().split("\n").filter(Boolean).slice(-1)[0] || `exit ${res.status}`;
    throw new Error(`gateway call failed: ${why.slice(0, 300)}`);
  }
  // `--json` prints the method's payload; a warning line may come first.
  const text = res.stdout.trim();
  const start = text.startsWith("{") ? 0 : text.indexOf("\n{") + 1;
  if (start === 0 && !text.startsWith("{")) throw new Error("gateway call printed no JSON");
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    throw new Error("gateway call printed no JSON");
  }
  return parsed;
}

// ── Source: the agent databases, read-only ──────────────────────────────────

const nodeSqlite = () => {
  const mod = process.getBuiltinModule?.("node:sqlite");
  if (typeof mod?.DatabaseSync !== "function") {
    throw new Error(`node:sqlite is not available on Node ${process.versions.node} (needs Node >= 22.13)`);
  }
  return mod;
};

/** Every agent database under `<state>/agents`, or just `agent`'s. */
export function listAgentDatabases(stateDir, agent = null) {
  const agentsDir = path.join(stateDir, "agents");
  let names;
  try {
    names = fs.readdirSync(agentsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => AGENT_ID_RE.test(name) && (!agent || name === agent))
    .map((agentId) => ({ agentId, dbPath: path.join(agentsDir, agentId, "agent", AGENT_DB_NAME) }))
    .filter(({ dbPath }) => {
      try {
        return fs.statSync(dbPath).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * Open a live agent database without writing or locking it: `mode=ro` sees
 * the WAL the gateway writes and takes only a reader's slot; `query_only`
 * refuses any write this script could ever issue. When even that cannot open
 * (no access to the WAL index), `immutable=1` reads the main file alone — it
 * may miss the newest, uncheckpointed rows, and the report says so. A BUSY or
 * LOCKED database is never read that way: it is one a writer holds, and
 * reading its main file without the lock could read a half-written
 * transaction — it is waited for (`busyTimeoutMs`), then refused.
 * @param {string} dbPath
 * @param {{ busyTimeoutMs?: number }} [options]
 */
export function openReadOnly(dbPath, { busyTimeoutMs = 2000 } = {}) {
  const { DatabaseSync } = nodeSqlite();
  const url = pathToFileURL(dbPath).href;
  let db;
  let immutable = false;
  try {
    db = new DatabaseSync(`${url}?mode=ro`, { readOnly: true });
    // Before the first read, so the probe below waits out a writer too.
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))}`);
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (err) {
    try {
      db?.close();
    } catch {
      /* already unusable */
    }
    if (isBusy(err)) throw err;
    db = new DatabaseSync(`${url}?immutable=1`, { readOnly: true });
    immutable = true;
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  }
  db.exec("PRAGMA query_only = 1");
  return { db, immutable };
}

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), extended codes included. */
function isBusy(err) {
  const code = Number(/** @type {{ errcode?: unknown }} */ (err)?.errcode);
  if (Number.isFinite(code) && [5, 6].includes(code & 0xff)) return true;
  return /database (table )?is locked|database is busy/i.test(String(/** @type {Error} */ (err)?.message ?? ""));
}

const hasZstd = () => typeof zlib.zstdDecompressSync === "function";

function decodeZstd(blob, rawBytes) {
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const options = rawBytes ? { maxOutputLength: Math.max(rawBytes, 1) } : undefined;
  return zlib.zstdDecompressSync(buf, options).toString("utf8");
}

/**
 * The transcript events in one cold archive that can be assistant messages,
 * each with its row's `created_at`. The pinned core's cold-storage worker
 * writes an archive as zstd of JSON lines: a `header` record first
 * (`version: 1`, the session id), one `event` record per transcript row —
 * `row: { seq, event_json, created_at }`, the event itself a JSON STRING —
 * then the `identity`, `active`, `index` and `fts` records it restores with.
 * Its `raw_bytes` counts the events' JSON only, not the lines around them, so
 * it does not bound the decoded size. Anything else throws, and the archive
 * is named as not read: none of it is counted, rather than part of it.
 */
function coldArchiveEvents(blob, sessionId) {
  const lines = decodeZstd(blob, COLD_ARCHIVE_MAX_BYTES).trimEnd().split("\n");
  const header = JSON.parse(lines[0]);
  if (header?.kind !== "header" || header.version !== 1 || header.sessionId !== sessionId) {
    throw new Error("not a version-1 cold transcript archive of this session");
  }
  const events = [];
  for (const line of lines.slice(1)) {
    // Inside the record the event's quotes are escaped.
    if (!line.includes('\\"assistant\\"')) continue;
    const record = JSON.parse(line);
    if (record?.kind !== "event") continue;
    events.push({ event: JSON.parse(record.row.event_json), createdAt: Number(record.row.created_at) });
  }
  return events;
}

const isPrimaryTranscriptName = (name) =>
  name.endsWith(".jsonl") && !name.endsWith(".trajectory.jsonl") && !CHECKPOINT_TRANSCRIPT_RE.test(name);

/** The session id of a transcript file the core counts in usage, else null. */
export function usageCountedSessionId(name) {
  if (isPrimaryTranscriptName(name)) return name.slice(0, -".jsonl".length);
  const bare = name.endsWith(".zst") ? name.slice(0, -".zst".length) : name;
  for (const reason of ["reset", "deleted"]) {
    const marker = `.jsonl.${reason}.`;
    const at = bare.lastIndexOf(marker);
    if (at > 0 && ARCHIVE_STAMP_RE.test(bare.slice(at + marker.length))) {
      const sessionId = bare.slice(0, at);
      return isPrimaryTranscriptName(`${sessionId}.jsonl`) ? sessionId : null;
    }
  }
  return null;
}

/**
 * The counted transcript files in an agent's sessions directory that were
 * written since `sinceMs` — the core skips older ones too: a file is written
 * after its last event. One that vanished meanwhile is skipped, as the core
 * skips it; one that cannot be looked at (or the directory itself) is
 * `unreadable`, so the count is not called complete.
 */
function usageCountedTranscriptFiles(sessionsDir, sinceMs) {
  const files = [];
  const unreadable = [];
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== "ENOENT") unreadable.push(path.basename(sessionsDir));
    return { files, unreadable };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const sessionId = usageCountedSessionId(entry.name);
    if (!sessionId) continue;
    const file = path.join(sessionsDir, entry.name);
    let st;
    try {
      st = fs.statSync(file);
    } catch (err) {
      if (err?.code !== "ENOENT") unreadable.push(entry.name);
      continue;
    }
    if (st.mtimeMs < sinceMs) continue;
    files.push({ name: entry.name, file, sessionId, size: st.size, packed: entry.name.endsWith(".zst") });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, unreadable };
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

/**
 * Count one agent database's model calls inside the window into `acc`.
 * Returns what it saw, for the notes.
 */
export function scanAgentDatabase({ db, agentId, window, acc, dbPath }) {
  const seen = new Set();
  const stats = {
    windows: 0, sessions: 0, rowsRead: 0, decoded: 0, undecodable: 0, calls: 0,
    coldRead: 0, coldSkipped: [], archivesRead: 0, archivesSkipped: [],
  };
  const canDecode = hasZstd();
  const count1 = (sessionId, event, fallbackTs) => {
    const call = assistantCall(event);
    if (!call) return;
    const ts = call.ts ?? fallbackTs;
    if (ts === undefined || ts < window.startMs || ts > window.endMs) return;
    if (call.key) {
      const key = `${call.provider}/${call.model}\u0000${call.key}`;
      if (seen.has(key)) return;
      seen.add(key);
    }
    acc.add({ agentId, sessionId, provider: call.provider, model: call.model, usage: call.usage });
    stats.calls += 1;
  };
  // A reset or deleted session has left the database; its transcript lives on
  // as an archive file beside it, plain transcript lines (zstd with `.zst`).
  // The core's usage report counts those files, and a file-era transcript,
  // unless the session is still a live SQLite transcript it reads instead
  // (listUsageCountedTranscriptSources finds the files apart from SQLite):
  // without them this source read less than the gateway on any box where a
  // chat was reset, or whose database predates the SQLite transcript store.
  const countTranscriptFiles = (live) => {
    const sessionsDir = path.join(path.dirname(path.dirname(dbPath)), "sessions");
    const { files: archives, unreadable } = usageCountedTranscriptFiles(sessionsDir, window.startMs);
    stats.archivesSkipped.push(...unreadable);
    for (const archive of archives) {
      if (live.has(archive.sessionId)) continue;
      if ((archive.packed && !canDecode) || archive.size > TRANSCRIPT_ARCHIVE_MAX_BYTES) {
        stats.archivesSkipped.push(archive.name);
        continue;
      }
      try {
        const bytes = fs.readFileSync(archive.file);
        const text = archive.packed ? decodeZstd(bytes, TRANSCRIPT_ARCHIVE_MAX_BYTES) : bytes.toString("utf8");
        stats.archivesRead += 1;
        for (const line of text.split("\n")) {
          if (!line.includes('"assistant"')) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          count1(archive.sessionId, event, undefined);
        }
      } catch {
        stats.archivesSkipped.push(archive.name);
      }
    }
  };
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
  );
  if (!tables.has("transcript_events") || !tables.has("session_windows")) {
    // No SQLite transcripts at all: every counted transcript file is the record.
    stats.missingTables = true;
    countTranscriptFiles(new Set());
    return stats;
  }
  const cols = tableColumns(db, "transcript_events");
  const zstdCol = cols.has("event_zstd");
  const navCol = cols.has("navigation_json");
  // Only rows that can hold an assistant message reach JavaScript: a plain row
  // must mention "assistant"; a compressed row must be a message (its
  // navigation facts say so without decoding the body).
  const rowSql = `SELECT created_at AS createdAt,
      CASE WHEN event_json IS NOT NULL AND instr(event_json, '"assistant"') > 0 THEN event_json END AS text,
      ${zstdCol
        ? `CASE WHEN event_zstd IS NOT NULL${navCol
          ? ` AND (navigation_json IS NULL OR NOT json_valid(navigation_json)
               OR json_extract(navigation_json, '$.report.kind') IS NOT 'canonical'
               OR json_extract(navigation_json, '$.report.entry.type') = 'message')`
          : ""} THEN event_zstd END`
        : "NULL"} AS packed,
      ${cols.has("event_utf8_bytes") ? "event_utf8_bytes" : "NULL"} AS rawBytes
    FROM transcript_events WHERE session_id = ? ORDER BY seq DESC`;
  const rows = db.prepare(rowSql);
  // A window the core has not written to since the window began has nothing
  // in it; its watermarks say so without reading a single transcript row.
  const winCols = tableColumns(db, "session_windows");
  const marks = [
    winCols.has("updated_at") ? "updated_at" : null,
    winCols.has("transcript_updated_at") ? "coalesce(transcript_updated_at, 0)" : null,
  ].filter(Boolean);
  stats.windows = Number(db.prepare("SELECT count(*) AS n FROM session_windows").get().n);
  const sessionIds = marks.length
    ? db.prepare(`SELECT session_id AS sessionId FROM session_windows WHERE max(${marks.join(", ")}, 0) >= ?`).all(window.startMs)
    : db.prepare("SELECT session_id AS sessionId FROM session_windows").all();
  for (const { sessionId } of sessionIds) {
    stats.sessions += 1;
    let old = 0;
    for (const row of rows.iterate(sessionId)) {
      stats.rowsRead += 1;
      const createdAt = Number(row.createdAt);
      if (createdAt < window.startMs) {
        if (++old >= STOP_AFTER_OLD_ROWS) break;
        continue;
      }
      old = 0;
      let text = row.text;
      if (text == null && row.packed != null) {
        if (!canDecode) {
          stats.undecodable += 1;
          continue;
        }
        try {
          text = decodeZstd(row.packed, Number(row.rawBytes) || 0);
          stats.decoded += 1;
        } catch {
          stats.undecodable += 1;
          continue;
        }
        if (!text.includes('"assistant"')) continue;
      }
      if (text == null) continue;
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        continue;
      }
      count1(sessionId, event, createdAt);
    }
  }
  // Windows the core moved to cold storage after the window began can still
  // hold calls inside it; older archives cannot (a window is archived after
  // its last event).
  if (tables.has("session_transcript_cold_archives")) {
    const cold = db.prepare(`SELECT session_id AS sessionId, archive_name AS name, storage, raw_bytes AS rawBytes,
        archive_bytes AS archiveBytes, archive_blob AS blob
      FROM session_transcript_cold_archives WHERE archived_at >= ?`);
    for (const archive of cold.iterate(window.startMs)) {
      const rawBytes = Number(archive.rawBytes) || 0;
      if (!canDecode || rawBytes > COLD_ARCHIVE_MAX_BYTES) {
        stats.coldSkipped.push(archive.name);
        continue;
      }
      try {
        const blob = archive.storage === "sqlite"
          ? archive.blob
          : fs.readFileSync(path.join(path.dirname(path.dirname(dbPath)), "sessions", "cold", path.basename(archive.name)));
        const events = coldArchiveEvents(blob, archive.sessionId);
        stats.coldRead += 1;
        for (const { event, createdAt } of events) count1(archive.sessionId, event, createdAt);
      } catch {
        stats.coldSkipped.push(archive.name);
      }
    }
  }
  countTranscriptFiles(new Set(sessionIds.map(({ sessionId }) => sessionId)));
  return stats;
}

/**
 * The whole `db` source: every agent database, read-only. `complete` is false
 * when any of it went unread — a database that would not open or scan, rows or
 * archives that could not be decoded, a read without the WAL.
 * @param {{ stateDir: string, window: ReturnType<typeof usageWindow>, agent: string | null, busyTimeoutMs?: number }} params
 */
export function reportFromDatabases({ stateDir, window, agent, busyTimeoutMs }) {
  const acc = createAccumulator();
  const notes = [];
  let complete = true;
  const dbs = listAgentDatabases(stateDir, agent);
  if (dbs.length === 0) {
    notes.push(`no OpenClaw agent database under ${path.join(stateDir, "agents")}${agent ? ` for agent ${agent}` : ""}`);
  }
  if (!hasZstd()) {
    notes.push(`Node ${process.versions.node} has no zstd: compressed transcript rows were skipped (Node >= 22.15 reads them)`);
  }
  const scanned = [];
  for (const { agentId, dbPath } of dbs) {
    let handle;
    try {
      handle = openReadOnly(dbPath, { busyTimeoutMs });
    } catch (err) {
      notes.push(`agent ${agentId}: could not open its database read-only: ${err.message}`);
      complete = false;
      continue;
    }
    try {
      if (handle.immutable) notes.push(`agent ${agentId}: read without its WAL (no access to it): the newest rows may be missing`);
      const stats = scanAgentDatabase({ db: handle.db, agentId, window, acc, dbPath });
      if (stats.missingTables) notes.push(`agent ${agentId}: no transcript tables (database not migrated to the SQLite session store)`);
      if (stats.undecodable) notes.push(`agent ${agentId}: ${stats.undecodable} compressed row(s) could not be decoded`);
      if (stats.coldSkipped.length) notes.push(`agent ${agentId}: ${stats.coldSkipped.length} cold archive(s) not read: ${stats.coldSkipped.slice(0, 3).join(", ")}`);
      if (stats.archivesSkipped.length) {
        notes.push(`agent ${agentId}: ${stats.archivesSkipped.length} reset/deleted transcript archive(s) not read: ${stats.archivesSkipped.slice(0, 3).join(", ")}`);
      }
      scanned.push({ agentId, ...stats, coldSkipped: stats.coldSkipped.length, archivesSkipped: stats.archivesSkipped.length });
      if (handle.immutable || stats.undecodable || stats.coldSkipped.length || stats.archivesSkipped.length) complete = false;
    } catch (err) {
      notes.push(`agent ${agentId}: ${err.message}`);
      complete = false;
    } finally {
      try {
        handle.db.close();
      } catch {
        /* closing a read-only handle cannot lose anything */
      }
    }
  }
  return { ...acc.finish(), notes, scanned, complete };
}

// ── The report ──────────────────────────────────────────────────────────────

/**
 * Gather the report from the source(s) `opts` asks for.
 * @param {Options} opts
 * @param {{ env?: Env, nowMs?: number, gateway?: (params: Parameters<typeof callGatewayUsage>[0]) => any }} [deps]
 */
export function buildReport(opts, { env = process.env, nowMs = Date.now(), gateway = callGatewayUsage } = {}) {
  const stateDir = opts.stateDir ?? resolveStateDir(env);
  const window = usageWindow(opts.days, nowMs);
  const base = { window: { ...window, timeZone: "UTC" }, stateDir, agentFilter: opts.agent };
  const fallbackNotes = [];
  if (opts.source !== "db") {
    let skip = null;
    // The gateway is asked as the account that owns the state dir: the core's
    // CLI run as anyone else (root, say) would open THAT account's ~/.openclaw.
    try {
      const owner = fs.statSync(stateDir).uid;
      if (typeof process.getuid === "function" && process.getuid() !== owner) {
        skip = `not asked: run this as the owner of ${stateDir}`;
      }
    } catch {
      skip = `not asked: ${stateDir} does not exist`;
    }
    if (!skip) {
      const started = Date.now();
      try {
        const result = gateway({ window, agent: opts.agent, stateDir, timeoutMs: opts.timeoutMs, env });
        const report = reportFromGateway(result, window);
        if (report.complete || opts.source === "gateway") {
          return { ...base, source: "gateway", ...report, elapsedMs: Date.now() - started };
        }
        fallbackNotes.push(`gateway answer incomplete (${report.notes.join("; ")}); counted from the agent databases instead`);
      } catch (err) {
        if (opts.source === "gateway") throw err;
        fallbackNotes.push(`gateway not used (${err.message}); counted from the agent databases instead`);
      }
    } else if (opts.source === "gateway") {
      throw new Error(`gateway ${skip}`);
    } else {
      fallbackNotes.push(`gateway ${skip}; counted from the agent databases instead`);
    }
  }
  const started = Date.now();
  const report = reportFromDatabases({ stateDir, window, agent: opts.agent });
  return {
    ...base,
    source: "db",
    ...report,
    notes: [...fallbackNotes, ...report.notes],
    elapsedMs: Date.now() - started,
  };
}

const grouped = (n) => Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function table(headers, rows, rightFrom) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells
    .map((c, i) => (i >= rightFrom ? c.padStart(widths[i]) : c.padEnd(widths[i])))
    .join("  ")
    .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

const NUMBERS = ["SESSIONS", "CALLS", "INPUT", "OUTPUT", "CACHE READ", "CACHE WRITE", "TOTAL"];
const numberCells = (r) => [r.sessions, r.calls, r.input, r.output, r.cacheRead, r.cacheWrite, r.totalTokens].map(grouped);

/** The human-readable report. */
export function formatReport(report) {
  const w = report.window;
  const source = report.source === "gateway" ? "gateway (sessions.usage)" : "agent databases (read-only)";
  const out = [
    `OpenClaw token usage — last ${w.days} day${w.days === 1 ? "" : "s"}, ${w.startDate} .. ${w.endDate} UTC — source: ${source}`,
  ];
  if (report.totals.calls === 0 && report.totals.totalTokens === 0) {
    out.push("", "No model calls in this window.");
  } else {
    const modelName = (r) => (r.provider === "unknown" && r.model === "unknown" ? "unknown" : `${r.provider}/${r.model}`);
    out.push(
      "",
      table(["AGENT", ...NUMBERS], report.agents.map((r) => [r.agentId, ...numberCells(r)]), 1),
      "",
      table(["MODEL", ...NUMBERS], report.models.map((r) => [modelName(r), ...numberCells(r)]), 1),
      "",
      table(["AGENT", "MODEL", ...NUMBERS], report.agentModels.map((r) => [r.agentId, modelName(r), ...numberCells(r)]), 2),
      "",
      table(["", ...NUMBERS], [["TOTAL", ...numberCells(report.totals)]], 1),
    );
  }
  for (const note of report.notes ?? []) out.push(`note: ${note}`);
  return `${out.join("\n")}\n`;
}

/** The JSON report: the same rows, plus where they came from. */
export function jsonReport(report) {
  const { scanned, ...rest } = report;
  return `${JSON.stringify({ ...rest, ...(scanned ? { scanned } : {}) }, null, 2)}\n`;
}

/**
 * @param {string[]} [argv]
 * @param {{ out: { write(text: string): unknown }, err: { write(text: string): unknown }, env: Env }} [io]
 */
export function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr, env: process.env }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err.write(`${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    io.out.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const report = buildReport(opts, { env: io.env });
    io.out.write(opts.json ? jsonReport(report) : formatReport(report));
    return 0;
  } catch (err) {
    io.err.write(`clawbox tokens: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = main();
}
