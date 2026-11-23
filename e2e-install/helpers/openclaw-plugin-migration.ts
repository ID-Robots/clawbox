/**
 * Reads for the upgrade spec's core crossing with a plugin that owes a state
 * migration: the OpenClaw CLI as the box's own account, the core's record of
 * one plugin's deferred migration, and one root step's journal from a cursor
 * on. Everything here reads; the only writes are the CLI calls the spec makes.
 */
import { dockerExec } from "./container";

/** The managed core's CLI, as 07-runtime-pin and 22-anthropic-accounts run it. */
const OPENCLAW_BIN = "/home/clawbox/.npm-global/bin/openclaw";

/** `<stateDir>/state/openclaw.sqlite` (the pinned core's openclaw-state-db.paths). */
const STATE_DB = "/home/clawbox/.openclaw/state/openclaw.sqlite";

/**
 * The phrase every phase of the core's DeferredPluginMigrationConflictError
 * starts with ("…changed during migration input publication", "…during
 * migration settlement", …): recorded, never asserted.
 */
const DOCTOR_CONFLICT = "Plugin migration obligations changed during";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CliResult {
  stdout: string;
  stderr: string;
  exit: number;
}

/** Runs "$@", then prints its stderr after a marker and its exit status last. */
const RUN_SPLIT = [
  'err="$(mktemp)"',
  '"$@" 2>"$err" </dev/null',
  "rc=$?",
  "printf '\\n__stderr__\\n'",
  'cat "$err"',
  'rm -f "$err"',
  "printf '\\n__exit=%s\\n' \"$rc\"",
].join("; ");

/**
 * The core's two admission refusals while an offline maintenance run owns the
 * state database both end in this instruction (07-runtime-pin asks again the
 * same way).
 */
const MAINTENANCE_RETRY = /retry (?:when it|after maintenance) finishes/;

/**
 * One `openclaw` call as clawbox with its own HOME. A non-zero exit is returned,
 * not thrown, so the caller's assertion can name what the CLI said; stdout is
 * kept apart from stderr so a warning cannot break a `--json` answer.
 */
export async function openclawCli(args: string[], timeoutMs: number): Promise<CliResult> {
  let result: CliResult = { stdout: "", stderr: "", exit: -1 };
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const raw = await dockerExec(
      ["env", "HOME=/home/clawbox", "bash", "-lc", RUN_SPLIT, "bash", OPENCLAW_BIN, ...args],
      { user: "clawbox", timeoutMs },
    );
    const marker = raw.lastIndexOf("\n__stderr__\n");
    const exit = /\n__exit=(\d+)\n*$/.exec(raw);
    result = {
      stdout: marker >= 0 ? raw.slice(0, marker) : raw,
      stderr: marker >= 0 ? raw.slice(marker + "\n__stderr__\n".length, exit?.index ?? raw.length) : "",
      exit: exit ? Number(exit[1]) : -1,
    };
    if (!MAINTENANCE_RETRY.test(result.stdout + result.stderr)) break;
    await sleep(5_000);
  }
  return result;
}

/** The JSON document a `--json` call printed. */
export function parseJsonOut(stdout: string): unknown {
  return JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
}

/** `2026.11.5-1` → `2026.11.5`: npm republishes share their base's runtime API. */
export const baseVersion = (version: string) => version.split("-")[0];

export interface MigrationRow {
  status: string;
  startedAt: number;
  finishedAt: number | null;
  report: string;
}

export interface MigrationRowRead {
  /** The state database exists. */
  db: boolean;
  /** It has a `migration_runs` table. */
  table?: boolean;
  /** The row, or null when there is none. */
  row?: MigrationRow | null;
}

const READ_MIGRATION_ROW = String.raw`
import json, os, sqlite3, sys
path, run_id = sys.argv[1], sys.argv[2]
if not os.path.exists(path):
    print(json.dumps({"db": False}))
    sys.exit(0)
con = sqlite3.connect("file:" + path + "?mode=ro", uri=True, timeout=30)
try:
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration_runs'").fetchone():
        print(json.dumps({"db": True, "table": False}))
        sys.exit(0)
    row = con.execute(
        "SELECT status, started_at, finished_at, report_json FROM migration_runs WHERE id = ?", (run_id,)
    ).fetchone()
finally:
    con.close()
print(json.dumps({"db": True, "table": True, "row": None if row is None else {
    "status": row[0], "startedAt": row[1], "finishedAt": row[2], "report": row[3]}}))
`;

/**
 * The core's own record of one plugin's deferred migration, opened read-only.
 *
 * Read from the database because the pinned core has no read of a SETTLED
 * obligation: `openclaw update status --json` lists pending ones only. The row
 * `deferred-plugin-migration:<id>` is written when the core records an
 * obligation and kept, with its final status, when the owner resolves it
 * (dist deferred-plugin-migrations: RUN_PREFIX, recordDeferredPluginMigrationsInTransaction).
 */
export async function readMigrationRow(pluginId: string): Promise<MigrationRowRead> {
  const out = await dockerExec(
    ["python3", "-I", "-c", READ_MIGRATION_ROW, STATE_DB, `deferred-plugin-migration:${pluginId}`],
    { user: "clawbox", timeoutMs: 60_000 },
  );
  return JSON.parse(out) as MigrationRowRead;
}

/**
 * A journal position that always exists: the newest entry of the whole
 * journal. Read back with `-u`, it bounds a unit's journal to what came after
 * it, whether or not that unit had logged anything before.
 */
export async function journalCursor(): Promise<string | null> {
  const out = await dockerExec(["journalctl", "--no-pager", "-n", "1", "--show-cursor", "-o", "cat"], {
    user: "root",
  });
  const cursors = [...out.matchAll(/^-- cursor: (\S+)$/gm)];
  return cursors.length > 0 ? cursors[cursors.length - 1][1] : null;
}

export interface JournalLine {
  atUs: number;
  message: string;
}

function parseJournalJson(out: string): JournalLine[] {
  const lines: JournalLine[] = [];
  for (const raw of out.split("\n")) {
    if (!raw.trim()) continue;
    let entry: { MESSAGE?: unknown; __REALTIME_TIMESTAMP?: unknown };
    try {
      entry = JSON.parse(raw) as typeof entry;
    } catch {
      continue;
    }
    // journald hands a message that is not valid UTF-8 over as a byte array.
    const message = typeof entry.MESSAGE === "string"
      ? entry.MESSAGE
      : Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE as number[]).toString("utf8") : "";
    lines.push({ atUs: Number(entry.__REALTIME_TIMESTAMP ?? 0), message });
  }
  return lines;
}

/** `unit`'s journal after `cursor`, oldest first. */
export async function journalAfter(unit: string, cursor: string): Promise<JournalLine[]> {
  const out = await dockerExec(
    ["journalctl", "--no-pager", "-u", unit, "--after-cursor", cursor, "-o", "json"],
    { user: "root", timeoutMs: 60_000 },
  );
  return parseJournalJson(out);
}

export interface DoctorSummary {
  entries: number;
  /** "Running openclaw doctor --fix …": every installer prints one per pass it starts. */
  runLines: number;
  /** "openclaw doctor --fix pass N ended with exit R": only an installer that numbers its passes. */
  passEnds: string[];
  passes: number;
  conflict: boolean;
  /** First to last entry: the step's own wall time. */
  spanSeconds: number | null;
  /** Index of the first doctor line, or -1. */
  doctorStart: number;
}

export function summarizeDoctor(lines: JournalLine[]): DoctorSummary {
  const passEnds: string[] = [];
  let runLines = 0;
  let doctorStart = -1;
  lines.forEach((line, index) => {
    if (/Running openclaw doctor --fix/.test(line.message)) {
      runLines += 1;
      if (doctorStart < 0) doctorStart = index;
    }
    const end = /openclaw doctor --fix pass (\d+) ended with exit (\d+)/.exec(line.message);
    if (end) passEnds.push(`pass ${end[1]} exit ${end[2]}`);
  });
  return {
    entries: lines.length,
    runLines,
    passEnds,
    passes: passEnds.length || runLines,
    conflict: lines.some((line) => line.message.includes(DOCTOR_CONFLICT)),
    spanSeconds: lines.length > 1 ? Math.round((lines[lines.length - 1].atUs - lines[0].atUs) / 1e6) : null,
    doctorStart,
  };
}
