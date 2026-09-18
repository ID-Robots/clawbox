/**
 * How far `openclaw memory index` has got — read off the CLI's own reporter.
 *
 * SERVER ONLY: the filesystem and sqlite.
 *
 * The CLI has no machine-readable progress: `memory index --help` offers
 * `--agent`, `--force` and `--verbose`, nothing else. It does report progress,
 * through `createCliProgress` (OpenClaw 2026.8.1 and 2026.9.3 alike), and that
 * reporter decides its face from ONE fact — whether its stream is a terminal.
 * On a pipe it is the no-op reporter unless the caller asked for the `log`
 * fallback, and `runMemoryIndex` asks for `line` (with `--verbose`) or for the
 * spinner. No environment variable changes that: `FORCE_COLOR`, `CI` and the
 * rest are not consulted. So the only way to get the numbers without patching
 * the installed core is to give the CLI a terminal, which is what `script`
 * (util-linux, on every box — `flock` comes from the same package) is for.
 *
 * With `--verbose` on a terminal the `line` face writes, once a second and at
 * every file, `\r\x1b[2K<label> <n>%`, and the label is built by the memory
 * manager as `<phase>… <done>/<total>` and then by the command as
 * `… · elapsed m:ss[ · eta m:ss]`. The two counts are the files the pass has
 * finished with and the files its scan found, which is exactly what the card's
 * bar needs. The percentage beside them is derived from the same two numbers
 * and is not read.
 *
 * CHUNKS are not in that line. They are counted in the index the pass is
 * writing: a full reindex builds a scratch copy beside the agent database
 * (`<db>.memory-reindex-<uuid>`) and swaps it in at the end, an incremental
 * pass writes the live one. Read-only, with no busy wait — the reader runs on
 * the web server's event loop, and a tick whose count cannot be had keeps the
 * previous one.
 */

import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireNodeSqlite } from "@/lib/openclaw-session-store";

/** The two counts the line reporter carries. */
export interface IndexLineProgress {
  filesDone: number;
  filesTotal: number;
}

/**
 * `<done>/<total> · elapsed` — the counts, and the elapsed clock the command
 * appends right after them. Anchoring on the clock is what keeps a path in a
 * verbose header line ("memory/2024/10") from ever reading as a count.
 */
const COUNTS_RE = /(\d{1,9})\/(\d{1,9})\s+·\s+elapsed\b/;

/**
 * CSI sequences (`\x1b[2K`, `\x1b[?25l`, colours), OSC sequences (the
 * terminal-progress `\x1b]9;4;…` a capable terminal gets) and the two-byte
 * escapes. A reader that left any of these in would see a count glued to a
 * colour code.
 */
const TERMINAL_CONTROL_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

/** Enough to keep one whole reporter write however long its label grows. */
const MAX_PENDING_CHARS = 2_000;
/** The same budget the pass's stderr tail has always had. */
const MAX_TAIL_CHARS = 4_000;

/** One reporter write, as counts; null when it carries none or they cannot be right. */
export function parseIndexProgressSegment(segment: string): IndexLineProgress | null {
  const match = COUNTS_RE.exec(segment);
  if (!match) return null;
  const filesDone = Number(match[1]);
  const filesTotal = Number(match[2]);
  // A total of zero is a scan that found nothing, and done past total is a
  // bar past its end: neither is a fraction worth drawing.
  if (!(filesTotal > 0) || filesDone > filesTotal) return null;
  return { filesDone, filesTotal };
}

export interface IndexProgressReader {
  /** Feed decoded text as it arrives, in chunks of any size. */
  push(text: string): void;
  /** The newest counts seen, or null before the scan has reported any. */
  latest(): IndexLineProgress | null;
  /** What the CLI said last, as plain lines, for the device log. */
  tail(): string;
}

/**
 * Follows the PTY stream: control bytes stripped, split on the `\r` the
 * reporter redraws with as well as on newlines.
 *
 * The segment still being written is parsed too, not only the finished ones:
 * the reporter never ends its line, so the newest count on screen is always in
 * the unfinished segment. That is safe because a count cut short by a chunk
 * boundary has not reached its `· elapsed` yet and does not match.
 */
export function createIndexProgressReader(): IndexProgressReader {
  let pending = "";
  let latest: IndexLineProgress | null = null;
  let tail = "";
  const take = (segment: string) => {
    const counts = parseIndexProgressSegment(segment);
    if (counts) latest = counts;
  };
  return {
    push(text: string) {
      pending += text;
      // An escape cut in half by a chunk boundary would be left behind as
      // stray bytes; hold an unfinished one back until the rest arrives.
      const lastEsc = pending.lastIndexOf("\x1b");
      let ready = pending;
      let held = "";
      if (lastEsc !== -1 && pending.length - lastEsc < 32 && !/[@-~\x07]/.test(pending.slice(lastEsc + 2))) {
        ready = pending.slice(0, lastEsc);
        held = pending.slice(lastEsc);
      }
      const clean = ready.replace(TERMINAL_CONTROL_RE, "");
      const parts = clean.split(/\r\n|\r|\n/);
      const unfinished = parts.pop() ?? "";
      for (const part of parts) {
        take(part);
        tail += `${part}\n`;
      }
      take(unfinished);
      tail = tail.slice(-MAX_TAIL_CHARS);
      pending = (unfinished + held).slice(-MAX_PENDING_CHARS);
    },
    latest: () => latest,
    tail: () => `${tail}${pending.replace(TERMINAL_CONTROL_RE, "")}`.slice(-MAX_TAIL_CHARS),
  };
}

/** Single-quoted for `sh`, whatever the argument holds. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * `script`'s arguments for running `argv` on a pseudo-terminal.
 *
 * `-e` returns the command's own exit code, so `flock -E 75`'s "busy" and
 * every other code the caller maps survive the extra layer; `-q` keeps script's
 * own banner out of the stream; the typescript goes to /dev/null. `exec` makes
 * the command replace the shell, so the process under script is the command
 * itself — with `flock --no-fork`, the indexer.
 */
export function ptyHostArgs(argv: string[]): string[] {
  return ["-q", "-e", "-c", `exec ${argv.map(shellQuote).join(" ")}`, "/dev/null"];
}

/**
 * The agent database `openclaw memory index --agent main` writes.
 *
 * Not configurable in OpenClaw's memory settings: both versions resolve it as
 * `<state dir>/agents/<id>/agent/openclaw-agent.sqlite`, the state directory
 * being `OPENCLAW_STATE_DIR` or `~/.openclaw` — and the pass is spawned with
 * this process's environment, so it resolves the same one.
 */
export function openclawAgentDbPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.CLAWKEEP_MEMORY_AGENT_DB?.trim();
  if (override) return override;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
}

/** mtime slack for a scratch file created in the same second the pass started. */
const SCRATCH_CLOCK_SLACK_MS = 2_000;

/**
 * The scratch index THIS pass is building, if it has started one: the newest
 * `<db>.memory-reindex-<uuid>` touched since the pass began. An older one is a
 * previous pass's leftover and says nothing about this pass.
 */
function currentScratchIndex(dbPath: string, sinceMs: number): string | null {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.memory-reindex-`;
  let best: { file: string; mtimeMs: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^[0-9a-f-]{8,64}$/i.test(name.slice(prefix.length))) continue;
    try {
      const stat = statSync(path.join(dir, name));
      if (!stat.isFile() || stat.mtimeMs < sinceMs - SCRATCH_CLOCK_SLACK_MS) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file: path.join(dir, name), mtimeMs: stat.mtimeMs };
    } catch { /* gone between the listing and the stat */ }
  }
  return best?.file ?? null;
}

/**
 * Chunks in the index the pass is writing, or null when that cannot be read
 * right now — no database yet, a writer holding it, a schema this does not
 * know. Never throws, and never waits.
 *
 * `rebuild` is a pass that is known to build a fresh index (`--force`): until
 * its scratch copy exists there is nothing of THIS pass's to count, and the
 * live index's figure — the one about to be replaced — would read as progress
 * that then fell back to zero.
 */
export function countIndexChunks(dbPath: string, sinceMs: number, { rebuild = false } = {}): number | null {
  const scratch = currentScratchIndex(dbPath, sinceMs);
  if (!scratch && rebuild) return null;
  const target = scratch ?? dbPath;
  try {
    if (!statSync(target).isFile()) return null;
  } catch {
    return null;
  }
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(target, { readOnly: true });
    // No busy wait: this is synchronous, on the web server's event loop.
    db.exec("PRAGMA busy_timeout = 0");
    const row = db.prepare("SELECT COUNT(*) AS n FROM memory_index_chunks").get() as { n?: unknown } | undefined;
    const n = Number(row?.n);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* nothing more to do */ }
  }
}
