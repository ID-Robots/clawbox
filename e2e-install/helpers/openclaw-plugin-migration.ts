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

/**
 * install.sh's rule for a managed plugin's version under a pin: the pin itself,
 * or a correction pin's base (a trailing numeric -N or +N removed, the cohort
 * the pinned core moves version-bound plugins to). A pre-release is not the
 * stable pin, and a republished X.Y.Z-1 is not the pin X.Y.Z.
 */
export const atPinRelease = (version: string, pin: string) =>
  version === pin || version === pin.replace(/[-+][0-9]+$/, "");

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
    // Doctor colours its notes; the escapes would split the phrases matched below.
    lines.push({ atUs: Number(entry.__REALTIME_TIMESTAMP ?? 0), message: message.replace(/\x1b\[[0-9;]*m/g, "") });
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

/** Every installer prints this once per doctor pass it starts ("…again (pass 2 of 2)" too). */
const PASS_START = /Running openclaw doctor --fix/;

/** One doctor pass, read from its output (offsets are into the pass's joined text; -1 is absent). */
export interface DoctorPass {
  /** From the installer's "pass N ended with exit R"; null when this installer does not print it. */
  exit: number | null;
  /** The config held a key this core does not know (pinned 2026.11.5 retired every heartbeat key). */
  retiredKey: boolean;
  /** Doctor refreshed the stale codex package itself, in plugin convergence. */
  refreshed: boolean;
  /** Doctor rewrote codex's obligation to "has not confirmed …" (its plugin-migration step). */
  rewriteAt: number;
  /** Doctor committed the automatic legacy-config repair planned from its earlier snapshot. */
  automaticRepairAt: number;
  migratedLegacyKeys: boolean;
  /** Doctor deferred the heartbeat repair because the cron partition was not ready. */
  cronDeferral: boolean;
  /** "migration input publication", "migration settlement", …, or null. */
  conflictPhase: string | null;
  conflictLine: string | null;
  complete: boolean;
}

export interface DoctorSummary {
  entries: number;
  passes: DoctorPass[];
  /** First to last entry: the step's own wall time. */
  spanSeconds: number | null;
}

function readPass(lines: JournalLine[]): DoctorPass {
  // Doctor frames its notes and wraps them: with the frame and the line breaks
  // taken out, a wrapped sentence reads whole.
  const text = lines
    .map((line) => line.message.replace(/^[\s─-╿■-◿]+|[\s─-╿■-◿]+$/g, ""))
    .join(" ")
    .replace(/\s+/g, " ");
  const exit = /openclaw doctor --fix pass \d+ ended with exit (\d+)/.exec(text);
  const conflict = /Plugin migration obligations changed during ([^.]+)\./.exec(text);
  return {
    exit: exit ? Number(exit[1]) : null,
    retiredKey: /Unrecognized key: "heartbeat"/.test(text),
    refreshed: /Refreshed stale configured plugin "codex"/.test(text),
    rewriteAt: text.search(/"codex" data\/settings upgrade is unfinished: The installed plugin has not confirmed/),
    automaticRepairAt: text.indexOf("Doctor: automatic config repair"),
    migratedLegacyKeys: text.includes("Migrated legacy config keys in the active openclaw.json"),
    cronDeferral: /select the cron partition and migrate heartbeat settings|cron and heartbeat data migration is deferred/
      .test(text),
    conflictPhase: conflict ? conflict[1] : null,
    conflictLine: lines.find((line) => line.message.includes(DOCTOR_CONFLICT))?.message.trim() ?? null,
    complete: text.includes("Doctor complete."),
  };
}

/** The bounded journal, split at each pass's start line (which is not part of the pass). */
export function summarizeDoctor(lines: JournalLine[]): DoctorSummary {
  const passes: JournalLine[][] = [];
  for (const line of lines) {
    if (PASS_START.test(line.message)) passes.push([]);
    else if (passes.length > 0) passes[passes.length - 1].push(line);
  }
  return {
    entries: lines.length,
    passes: passes.map(readPass),
    spanSeconds: lines.length > 1 ? Math.round((lines[lines.length - 1].atUs - lines[0].atUs) / 1e6) : null,
  };
}

/**
 * Why the first pass did NOT exercise the path a retired config key opens, or
 * null when it did. The path, in the pinned core's order: the config holds a
 * key the new core does not know, so doctor plans an automatic repair from a
 * snapshot; it refreshes the stale codex and records its obligation; it then
 * rewrites that obligation; and only after that commits the repair, carrying
 * the obligation list of the earlier snapshot.
 */
export function retiredKeyPathMissed(pass: DoctorPass | undefined): string | null {
  if (!pass) return "fixture: no doctor pass in openclaw_install's journal after the trigger";
  if (pass.cronDeferral) {
    return "fixture: the container's cron partition is not ready; doctor deferred the heartbeat repair";
  }
  if (!pass.retiredKey || pass.automaticRepairAt < 0) {
    return "fixture: the config held no key the new core retires; the conflict path was not exercised";
  }
  if (!pass.refreshed) return "fixture: doctor did not refresh the stale codex plugin in its first pass";
  if (pass.rewriteAt < 0 || pass.automaticRepairAt < pass.rewriteAt) {
    return "fixture: the config repair did not follow codex's obligation rewrite; the conflict path was not exercised";
  }
  return null;
}

/** One line per pass, for the job log and the annotations. */
export function describePass(pass: DoctorPass, index: number): string {
  const yes = (value: boolean) => (value ? "yes" : "no");
  return `pass ${index + 1}: exit ${pass.exit ?? "not printed by this installer"}; ` +
    `retired key at start ${yes(pass.retiredKey)}; codex refreshed ${yes(pass.refreshed)}; ` +
    `obligation rewrite ${yes(pass.rewriteAt >= 0)}; automatic config repair ${yes(pass.automaticRepairAt >= 0)}; ` +
    `legacy keys migrated ${yes(pass.migratedLegacyKeys)}; cron deferral ${yes(pass.cronDeferral)}; ` +
    `conflict ${pass.conflictPhase ? `during ${pass.conflictPhase}` : "none"}; doctor complete ${yes(pass.complete)}`;
}

/**
 * What the installer's plugin refresh after doctor did, from its own rows in
 * the openclaw_install journal: codex's row and how many rows of each kind. A
 * bare row is printed BEFORE the CLI runs, so it is an attempt; the line under
 * it says how it ended (`updated`, or the installer's `WARN: not updated`).
 * Never a verdict: a refresh that printed no rows, or another installer's
 * wording, reads as such.
 */
export function describeRefresh(lines: readonly JournalLine[]): string {
  const messages = lines.map((line) => line.message.trim());
  const start = messages.findIndex((message) => message.startsWith("Refreshing OpenClaw plugins to match core"));
  if (start < 0) {
    const other = messages.find((message) =>
      message === "No external plugins to refresh" || message.startsWith("CLAWBOX-WARN[openclaw-plugin-refresh-skipped]"));
    return other ?? "no refresh rows in the journal";
  }
  const rows: { text: string; outcome: "left" | "attempted" | "reinstalled" | "failed" | "other" }[] = [];
  for (const message of messages.slice(start + 1)) {
    const last = rows[rows.length - 1];
    if (message.startsWith("- ")) {
      const text = message.slice(2);
      rows.push({ text, outcome: text.includes(" (already at ") ? "left" : /^\S+$/.test(text) ? "attempted" : "other" });
    } else if (last?.outcome === "attempted" && message === "updated") {
      last.outcome = "reinstalled";
    } else if (last?.outcome === "attempted" && message.startsWith("WARN: not updated")) {
      last.outcome = "failed";
    }
  }
  const count = (outcome: string) => rows.filter((row) => row.outcome === outcome).length;
  const codex = rows.find((row) => row.text.startsWith("@openclaw/codex@"));
  const codexSaid = !codex ? "no row"
    : codex.outcome === "left" ? `left: ${codex.text}`
      : codex.outcome === "attempted" ? `attempted, no outcome printed: ${codex.text}`
        : `${codex.outcome}: ${codex.text}`;
  return `codex ${codexSaid}; ${rows.length} rows: ${count("left")} already at the release, ` +
    `${count("reinstalled")} reinstalled, ${count("failed")} failed, ${count("attempted")} with no outcome printed`;
}

/** The lines worth reading in the job log: every doctor phase and the lines the checks above read. */
export const KEY_LINE =
  /Doctor[: ]|\[state-migrations\]|Config warnings|Unrecognized key|Migrated legacy config keys|Retired heartbeat|Refreshed stale|Plugin migration obligations changed|ended with exit|Running openclaw doctor|\[db-maintenance\]|cron partition|heartbeat data migration/;
