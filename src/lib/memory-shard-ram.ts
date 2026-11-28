/**
 * "Keep the Memory Shard index in RAM" — `data/config.json`
 * `memory_shard_index_in_ram`, OFF by default; off is exactly the box without
 * it. On, the index files are read through often enough that the operating
 * system keeps them in its page cache, so a memory search does not wait on
 * the disk: every {@link WARM_INTERVAL_MS} each file is read twice (the
 * second read marks its pages active) by a child process at the lowest CPU
 * and I/O priority (`nice -n 19 ionice -c 3 cat`), never on the web server's
 * event loop.
 *
 * Which files: on the edition with OpenClaw its index lives inside each
 * agent's database (`<state dir>/agents/<id>/agent/openclaw-agent.sqlite`,
 * beside the sessions and transcripts), and on the edition without it,
 * ClawBox's own store (`data/memory-index/index.sqlite`) — each with its WAL.
 * They are only ever READ as plain files: never opened with SQLite, never
 * written, never locked, because OpenClaw (or the indexer) owns them.
 *
 * These files can be many GB on an 8 GB box: switching on measures their
 * total size against MemAvailable and is refused while the size is more than
 * half of it; every cycle measures again and switches itself off, with the
 * reason recorded for the app, once that becomes true. Off stops the reading;
 * the kernel then frees the cache as other programs need it (nothing here can
 * free it at once).
 *
 * The timer and the child live in `processStore`: the boot layer starts it
 * and the route stops it, and the two are separate module copies.
 *
 * SERVER ONLY.
 */

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "@/lib/runtime-path";
import { get as configGet, set as configSet } from "@/lib/config-store";
import { LOCAL_INDEX_PATH } from "@/lib/memory-index-local";
import { openclawIsAbsent } from "@/lib/openclaw-config";
import { openclawStateDir } from "@/lib/openclaw-state-store";
import { processStore } from "@/lib/process-store";

export const INDEX_IN_RAM_KEY = "memory_shard_index_in_ram";
/** Why the box switched it off by itself (the app says so), cleared when it is switched on again. */
export const INDEX_IN_RAM_STOPPED_KEY = "memory_shard_index_in_ram_stopped";
/** How often the files are read again: often enough that the kernel keeps them. */
export const WARM_INTERVAL_MS = 2 * 60 * 1000;

export type IndexInRamRefusal = "too_big" | "memory_unknown";

export interface IndexInRamStop {
  reason: IndexInRamRefusal;
  bytes: number;
  availableBytes: number | null;
  /** ISO time it switched itself off. */
  at: string;
}

export interface IndexInRamState {
  on: boolean;
  /** The index files' total size: what is held while it is on. */
  bytes: number;
  files: number;
  /** MemAvailable now; null where it cannot be read. */
  availableBytes: number | null;
  /** Set when the box switched it off by itself, and why. */
  stopped: IndexInRamStop | null;
}

/** What a cycle runs with; tests hand in their own. */
export interface WarmDeps {
  files: () => string[];
  memAvailable: () => number | null;
  spawn: (command: string, args: string[]) => ChildProcess;
  now: () => Date;
}

/** The index files on this box: regular files only (a symlink is never followed), each with its WAL when there is one. */
export function indexFiles(): string[] {
  const dbs: string[] = [];
  if (openclawIsAbsent()) {
    dbs.push(LOCAL_INDEX_PATH);
  } else {
    const agents = path.join(openclawStateDir(), "agents");
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(agents, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      /* no agents yet */
    }
    for (const id of ids) dbs.push(path.join(agents, id, "agent", "openclaw-agent.sqlite"));
  }
  return dbs.flatMap((db) => [db, `${db}-wal`]).filter((f) => {
    try {
      return fs.lstatSync(f).isFile();
    } catch {
      return false;
    }
  });
}

/** MemAvailable from /proc/meminfo, bytes; null when it cannot be read. */
export function memAvailableBytes(meminfo: string | null = readMeminfo()): number | null {
  const m = meminfo ? /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo) : null;
  return m ? Number(m[1]) * 1024 : null;
}

function readMeminfo(): string | null {
  try {
    return fs.readFileSync("/proc/meminfo", "utf8");
  } catch {
    return null;
  }
}

function totalBytes(files: readonly string[]): number {
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(f).size;
    } catch {
      /* gone since it was listed */
    }
  }
  return bytes;
}

/** Why the files may not be held now, or null: more than half of MemAvailable, or no MemAvailable to compare with. */
export function indexInRamRefusal(bytes: number, availableBytes: number | null): IndexInRamRefusal | null {
  if (availableBytes === null) return "memory_unknown";
  return bytes > availableBytes / 2 ? "too_big" : null;
}

const defaultDeps: WarmDeps = {
  files: indexFiles,
  memAvailable: () => memAvailableBytes(),
  spawn: (command, args) => spawn(command, args, { stdio: "ignore" }),
  now: () => new Date(),
};

interface Warmer {
  timer: ReturnType<typeof setInterval> | null;
  child: ChildProcess | null;
  deps: WarmDeps;
}

const warmer = processStore("memory-shard:index-in-ram", (): Warmer => ({ timer: null, child: null, deps: defaultDeps }));

/** The command a cycle runs: every file read twice in a row, at the lowest CPU and I/O priority, its output thrown away. */
export function warmCommand(files: readonly string[]): { command: string; args: string[] } {
  return { command: "nice", args: ["-n", "19", "ionice", "-c", "3", "cat", "--", ...files.flatMap((f) => [f, f])] };
}

/**
 * One cycle: measure again, switch off (with the reason) when the files no
 * longer fit, else read them through once more — unless the last read is
 * still running.
 */
export async function warmOnce(): Promise<void> {
  // Switched off by any other way than the route (a hand edit): the cycles stop too.
  if ((await configGet(INDEX_IN_RAM_KEY)) !== true) return stopWarming();
  if (!warmer.timer) return;
  const { deps } = warmer;
  const files = deps.files();
  const bytes = totalBytes(files);
  const availableBytes = deps.memAvailable();
  const refusal = indexInRamRefusal(bytes, availableBytes);
  if (refusal) {
    stopWarming();
    await configSet(INDEX_IN_RAM_KEY, false);
    await configSet(INDEX_IN_RAM_STOPPED_KEY, { reason: refusal, bytes, availableBytes, at: deps.now().toISOString() } satisfies IndexInRamStop);
    console.warn(`[memory-shard] the index is no longer kept in RAM: ${bytes} bytes against ${availableBytes ?? "unknown"} available`);
    return;
  }
  if (files.length === 0 || warmer.child) return;
  const { command, args } = warmCommand(files);
  const child = deps.spawn(command, args);
  warmer.child = child;
  const done = () => {
    if (warmer.child === child) warmer.child = null;
  };
  child.once("exit", done);
  child.once("error", (err) => {
    done();
    console.warn(`[memory-shard] could not read the index into RAM: ${err.message}`);
  });
}

/** Read now and then every {@link WARM_INTERVAL_MS}; a second call while it runs changes nothing. */
export function startWarming(): void {
  if (warmer.timer) return;
  warmer.timer = setInterval(() => void warmOnce().catch(() => undefined), WARM_INTERVAL_MS);
  warmer.timer.unref?.();
  void warmOnce().catch(() => undefined);
}

/** No more reading: the timer is cleared and a read in progress is ended. */
export function stopWarming(): void {
  if (warmer.timer) clearInterval(warmer.timer);
  warmer.timer = null;
  const child = warmer.child;
  warmer.child = null;
  if (child && child.exitCode === null) child.kill("SIGTERM");
}

/** Is a cycle armed (tests, and the state the route answers)? */
export function warming(): boolean {
  return warmer.timer !== null;
}

/** For tests: what a cycle runs with (null puts the box's own back). */
export function _setWarmDepsForTests(deps: Partial<WarmDeps> | null): void {
  stopWarming();
  warmer.deps = deps ? { ...defaultDeps, ...deps } : defaultDeps;
}

function readStop(v: unknown): IndexInRamStop | null {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (!o || (o.reason !== "too_big" && o.reason !== "memory_unknown") || typeof o.bytes !== "number" || typeof o.at !== "string") return null;
  return { reason: o.reason, bytes: o.bytes, availableBytes: typeof o.availableBytes === "number" ? o.availableBytes : null, at: o.at };
}

export async function readIndexInRam(): Promise<IndexInRamState> {
  const files = warmer.deps.files();
  return {
    on: (await configGet(INDEX_IN_RAM_KEY)) === true,
    bytes: totalBytes(files),
    files: files.length,
    availableBytes: warmer.deps.memAvailable(),
    stopped: readStop(await configGet(INDEX_IN_RAM_STOPPED_KEY)),
  };
}

/**
 * Switch it on or off. On is refused (nothing written) while the files are
 * more than half of MemAvailable, or MemAvailable cannot be read.
 */
export async function setIndexInRam(on: boolean): Promise<{ ok: true; state: IndexInRamState } | { ok: false; refusal: IndexInRamRefusal; state: IndexInRamState }> {
  if (!on) {
    stopWarming();
    await configSet(INDEX_IN_RAM_KEY, false);
    return { ok: true, state: await readIndexInRam() };
  }
  const files = warmer.deps.files();
  const refusal = indexInRamRefusal(totalBytes(files), warmer.deps.memAvailable());
  if (refusal) return { ok: false, refusal, state: await readIndexInRam() };
  await configSet(INDEX_IN_RAM_KEY, true);
  await configSet(INDEX_IN_RAM_STOPPED_KEY, null);
  startWarming();
  return { ok: true, state: await readIndexInRam() };
}

/** At web-server boot: warm again when it was left on. */
export async function startIndexInRamIfOn(): Promise<void> {
  if ((await configGet(INDEX_IN_RAM_KEY)) === true) startWarming();
}
