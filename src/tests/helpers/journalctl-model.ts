/**
 * `journalctl`, answered from its ARGV, the way the two generations the fleet
 * runs answer it.
 *
 * Canned journalctl stdout answers every read the same, whatever it asked
 * for, and that is how a reader that asked for the wrong END of a window
 * passed every suite: `--since T -n N` is the FIRST N entries of the window on
 * systemd up to 253 (the boxes' 249.11 tests `--since` before `-n`), and the
 * LAST N from 254 on. A box showed npm's "npm notice" banner from the start of
 * a failed step instead of the installer's `Error:` line at its end.
 *
 * What is modelled, for a unit's entries in journal order (oldest first):
 * - `--since @<seconds>`: entries stamped before it are out (an entry with no
 *   stamp is always in, which is what a canned journal means);
 * - `-n N` with `--since` and no `--reverse`: the first N on 249, the last N
 *   on 255, oldest first;
 * - `-n N` with no `--since`: the last N, oldest first, on both;
 * - `--reverse`: newest first; with `-n N`, the newest N;
 * - `-g <pattern>`: matching entries only (smart case, as journalctl does);
 *   no match exits 1. Beside `-n` it is not modelled, and says so;
 * - nothing to show prints `-- No entries --` unless quiet: `-q`, or an output
 *   mode that implies it (`cat`, the JSON modes, `export`), as journalctl does.
 * Output is `-o cat` form whatever `-o` says: one message per line.
 */

export type JournalctlGeneration = 249 | 255;

export interface JournalEntry {
  message: string;
  /** When the entry was written, `Date.now()`-style. Unstamped entries are inside every window. */
  atMs?: number;
}

export type ModelJournal = readonly (string | JournalEntry)[];

export type ExecAnswer = { stdout: string; stderr: string } | Error;

const QUIET_OUTPUT_MODES = new Set(["cat", "json", "json-pretty", "json-sse", "json-seq", "export"]);

function valueOf(args: readonly string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i >= 0) return args[i + 1];
  }
  return undefined;
}

/** What `journalctl <args>` prints over `entries`, the unit's whole journal in order. */
export function answerJournalctl(
  entries: ModelJournal,
  args: readonly string[],
  generation: JournalctlGeneration = 249,
): ExecAnswer {
  const since = valueOf(args, "--since", "-S");
  if (since !== undefined && !since.startsWith("@")) {
    throw new Error(`journalctl model: --since ${since} is not modelled (only @<seconds>)`);
  }
  const sinceMs = since === undefined ? -Infinity : Number(since.slice(1)) * 1000;
  const n = valueOf(args, "-n", "--lines");
  const lines = n === undefined ? undefined : Number(n);
  const reverse = args.includes("--reverse") || args.includes("-r");
  // `-o cat`, the JSON modes and `export` set quiet by themselves (journalctl's
  // parse_argv, 249.11 through 257).
  const quiet = args.includes("-q") || args.includes("--quiet")
    || QUIET_OUTPUT_MODES.has(valueOf(args, "-o", "--output") ?? "short");
  const pattern = valueOf(args, "-g", "--grep");
  if (pattern !== undefined && lines !== undefined) {
    throw new Error("journalctl model: -g beside -n is not modelled");
  }

  let window = entries
    .map((entry) => (typeof entry === "string" ? { message: entry } : entry))
    .filter((entry) => entry.atMs === undefined || entry.atMs >= sinceMs);
  if (pattern !== undefined) {
    const re = new RegExp(pattern, /[A-Z]/.test(pattern) ? "" : "i");
    window = window.filter((entry) => re.test(entry.message));
  }

  let shown: typeof window;
  if (lines === undefined) shown = reverse ? [...window].reverse() : window;
  else if (lines <= 0) shown = [];
  else if (reverse) shown = window.slice(-lines).reverse();
  else if (since !== undefined && generation === 249) shown = window.slice(0, lines);
  else shown = window.slice(-lines);

  if (shown.length === 0) {
    const stdout = quiet ? "" : "-- No entries --\n";
    return pattern === undefined
      ? { stdout, stderr: "" }
      : Object.assign(new Error("Command failed: /usr/bin/journalctl"), { code: 1, stdout, stderr: "" });
  }
  return { stdout: `${shown.map((entry) => entry.message).join("\n")}\n`, stderr: "" };
}

/**
 * An execFile answer for the units it is given, by the exact `-u <unit>`: so
 * `openclaw_install` never answers for `openclaw_install_fast`. Any other
 * journalctl read (another unit, an invocation-id read) answers nothing, as
 * the canned answers it replaces did.
 */
export function journalctlModel(
  units: Record<string, ModelJournal>,
  generation: JournalctlGeneration = 249,
): (cmd: string, args: readonly string[]) => ExecAnswer {
  return (_cmd, args) => {
    const unit = valueOf(args, "-u", "--unit");
    const entries = unit === undefined ? undefined : units[unit];
    return entries ? answerJournalctl(entries, args, generation) : { stdout: "", stderr: "" };
  };
}

/** A canned journal (one entry per line, oldest first), answered by argv for whichever read is routed to it. */
export function cannedJournal(
  text: string | readonly string[],
  generation: JournalctlGeneration = 249,
): (cmd: string, args: readonly string[]) => ExecAnswer {
  const entries = (typeof text === "string" ? text.split("\n") : [...text]).filter((line, i, all) =>
    // Only the trailing newline's empty element goes: a blank line inside is an entry.
    !(line === "" && all.slice(i).every((rest) => rest === "")));
  return (_cmd, args) => answerJournalctl(entries, args, generation);
}

/** `count` entries, `make(i)` for i = 1..count: a long window without a long fixture. */
export function numberedEntries(count: number, make: (i: number) => string): string[] {
  return Array.from({ length: count }, (_, i) => make(i + 1));
}
