/**
 * Whether OpenClaw's databases are on the schema the installed core expects —
 * the answer `/setup-api/gateway/health` carries beside "the port is open".
 *
 * SERVER ONLY.
 *
 * WHY THE PORT IS NOT ENOUGH. A box updated from OpenClaw 2026.9 to 2026.10
 * whose agent databases had not been migrated (the migration needs tens of GB
 * free on a box with ~10 GB agent databases, and ran out of disk) came up with
 * a gateway that listened and reported ready while every agent was degraded:
 * each turn was refused, and every surface here said "running". OpenClaw starts
 * degraded by design ("advisory readiness warnings allow degraded startup"); it
 * was ClawBox that turned that into a silent ready.
 *
 * WHO WRITES IT. `scripts/openclaw-db-maintenance.py` — at every gateway
 * pre-start (the stopped gateway is when the databases can be read safely),
 * from each database's `PRAGMA user_version` against the installed core's
 * `openclaw.schemaVersions`, and from install.sh at the migration itself (its
 * disk pre-flight's refusal, doctor's verdict). This module only reads it, per
 * call, like `plugin-repair.ts` reads the pre-start's other record.
 *
 * WHAT IT ANSWERS. `null` for everything that is not a problem the owner can act
 * on: no file, an unreadable or malformed one, `ok`, `unknown` (a core that
 * declares no schema), or a box whose active harness is Hermes — a dual box
 * keeps the file from the OpenClaw half, and a notice about a harness that is
 * not running would send the owner after the wrong one. An unknown `reason` is
 * dropped the same way: a notice must say something true or nothing.
 */

import fs from "fs/promises";
import path from "@/lib/runtime-path";
import { getActiveHarness, type Harness } from "@/lib/harness";
import { formatBytesApart } from "@/lib/format-bytes";

export type OpenclawMigrationState = "degraded" | "blocked";

export type OpenclawMigrationReason =
  /** Databases on an older schema than the core: the migration has not run (or not finished). */
  | "schema-behind"
  /** A database written by a NEWER core than the one installed. */
  | "schema-newer"
  /** Every schema is current, but the last `doctor --fix` for this core reported an incomplete migration. */
  | "migration-incomplete"
  /** The migration needs more free disk than there is (pre-flight refusal, or measured at the pre-start). */
  | "insufficient-disk";

export interface OpenclawMigrationStatus {
  state: OpenclawMigrationState;
  reason: OpenclawMigrationReason;
  /** What the migration needs free, when that is the problem. */
  requiredBytes: number | null;
  /** What is free beside the databases, when that is the problem. */
  freeBytes: number | null;
  /** When the writer last looked, ISO 8601. */
  updatedAt: string | null;
}

const STATES: ReadonlySet<string> = new Set<OpenclawMigrationState>(["degraded", "blocked"]);
const REASONS: ReadonlySet<string> = new Set<OpenclawMigrationReason>([
  "schema-behind",
  "schema-newer",
  "migration-incomplete",
  "insufficient-disk",
]);

/**
 * Where the writer puts it: `$CLAWBOX_ROOT/data/openclaw-migration-status.json`,
 * resolved the way `pluginRepairPath()` resolves its sibling — from the
 * environment, not `config-store`, and per call so a suite can move it.
 */
export function openclawMigrationStatusPath(): string {
  const root = process.env.CLAWBOX_ROOT
    || (process.env.NODE_ENV === "development" ? process.cwd() : "/home/clawbox/clawbox");
  return path.join(root, "data", "openclaw-migration-status.json");
}

function byteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** The status when there is something to tell the owner, otherwise null. */
export async function readOpenclawMigrationStatus(): Promise<OpenclawMigrationStatus | null> {
  if ((await getActiveHarness().catch(() => "openclaw" as Harness)) === "hermes") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(openclawMigrationStatusPath(), "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.state !== "string" || !STATES.has(raw.state)) return null;
  if (typeof raw.reason !== "string" || !REASONS.has(raw.reason)) return null;
  return {
    state: raw.state as OpenclawMigrationState,
    reason: raw.reason as OpenclawMigrationReason,
    requiredBytes: byteCount(raw.requiredBytes),
    freeBytes: byteCount(raw.freeBytes),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

/**
 * The status as one sentence for the update's own warnings list (English, like
 * every other updater warning): a gateway that answers after a core update is
 * not yet a working assistant, and "Completed" over agents that refuse every
 * turn is the silent ready this exists to end.
 */
export function describeOpenclawMigration(status: OpenclawMigrationStatus): string {
  switch (status.reason) {
    case "insufficient-disk": {
      if (status.requiredBytes !== null && status.freeBytes !== null) {
        const [required, free] = formatBytesApart(status.requiredBytes, status.freeBytes);
        return `OpenClaw's agent data could not be migrated: the migration needs about ${required} of free disk and ${free} is free. Free up space, then run the update again.`;
      }
      return "OpenClaw's agent data could not be migrated: there is not enough free disk. Free up space, then run the update again.";
    }
    case "migration-incomplete":
      return "OpenClaw reported its migration of the agents' data as incomplete, so the agents may not answer. Run the update again.";
    case "schema-newer":
      return "The agents' data was written by a newer OpenClaw than the one installed, so the agents cannot open it. Update ClawBox to a build that installs that OpenClaw or newer.";
    case "schema-behind":
    default:
      return "OpenClaw has not finished migrating the agents' data to the installed core's format, so the agents may not answer. Run the update again.";
  }
}

/**
 * How much OpenClaw's SQLite databases weigh under a state directory: every
 * `agents/<id>/agent/openclaw-agent.sqlite` and the shared
 * `state/openclaw.sqlite`, each with its WAL. What a schema migration has to
 * copy and rewrite, so what the updater scales its wait for one by. Anything it
 * cannot read counts as nothing — the caller's floor is the old fixed budget.
 */
export async function openclawDatabaseBytes(stateDir: string): Promise<number> {
  const size = async (file: string) => {
    try {
      const st = await fs.lstat(file);
      return st.isFile() ? st.size : 0;
    } catch {
      return 0;
    }
  };
  const files = [path.join(stateDir, "state", "openclaw.sqlite")];
  try {
    for (const id of await fs.readdir(path.join(stateDir, "agents"))) {
      files.push(path.join(stateDir, "agents", id, "agent", "openclaw-agent.sqlite"));
    }
  } catch {
    // No agents directory: only the shared state database, if any.
  }
  let total = 0;
  for (const file of files) total += (await size(file)) + (await size(`${file}-wal`));
  return total;
}

/**
 * A wait that grows with the databases a migration has to rewrite: `baseMs`
 * plus `perGibMs` for every started GiB, never past `capMs`. A size that is not
 * a size counts as none, so the answer is never below the base.
 */
export function migrationBudgetMs(
  databaseBytes: number,
  budget: { baseMs: number; perGibMs: number; capMs: number },
): number {
  const bytes = Number.isFinite(databaseBytes) && databaseBytes > 0 ? databaseBytes : 0;
  const gib = Math.ceil(bytes / 1024 ** 3);
  return Math.min(budget.capMs, budget.baseMs + gib * budget.perGibMs);
}

/**
 * What one `openclaw doctor --fix` costs per GiB of agent database on a Jetson
 * Nano, rounded up. Doctor reads every database it repairs, and the first run
 * under a core converts each one to incremental auto_vacuum — a full VACUUM
 * plus `quick_check`/`integrity_check` (sqlite-maintenance in the pinned docs).
 * The compaction measured beside it in scripts/openclaw-db-maintenance.py runs
 * at ~16 MiB/s, a minute a GiB for the copy alone; the checks read it again.
 */
export const DOCTOR_FIX_MS_PER_GIB = 120_000;
/**
 * The longest any `doctor --fix` is given, however large the databases. The
 * gateway is stopped for the whole run, so this is how long an owner's agents
 * may be dark for a repair; a database that needs longer is a schema
 * migration, which the update's `openclaw_install` step owns with its own
 * budget (`openclawInstallTimeoutFor`).
 */
export const DOCTOR_FIX_CAP_MS = 1_200_000;

/**
 * The bound for one `openclaw doctor --fix`: the caller's old flat `baseMs`
 * plus two minutes for every started GiB of database, never past twenty
 * minutes (nor below `baseMs`). A flat 90 s was cut off on every ~3 GB box, and
 * a doctor stopped half-way leaves its repairs for the next start to redo.
 */
export function doctorFixBudgetMs(databaseBytes: number, baseMs: number): number {
  return migrationBudgetMs(databaseBytes, {
    baseMs,
    perGibMs: DOCTOR_FIX_MS_PER_GIB,
    capMs: Math.max(baseMs, DOCTOR_FIX_CAP_MS),
  });
}
