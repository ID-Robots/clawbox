/**
 * OpenClaw agent database maintenance, as the web server drives it.
 *
 * OpenClaw keeps sessions, transcripts and its memory index in one SQLite
 * database per agent (`agents/<id>/agent/openclaw-agent.sqlite`). On a box
 * whose agent database had grown to ~8 GB the gateway logged `slow SQLite
 * transaction hold` and `liveness heartbeat delayed` until it was killed and
 * restarted, again and again; the core's own compaction took the file to 5 GB
 * and the stalls stopped. The gateway pre-start already runs that compaction,
 * but only inside a gateway START and only with what is left of its 600 s —
 * so the biggest databases, and every box whose gateway simply keeps running,
 * were never compacted.
 *
 * Everything that touches the databases or the gateway is
 * `scripts/openclaw-db-maintenance.py` (`maintain`, `status`): it measures
 * read-only, compacts with `openclaw doctor --session-sqlite|--state-sqlite
 * compact` only when a database needs it and the disk can hold the copy, asks
 * the core whether the gateway is idle (`openclaw gateway suspend`) before it
 * stops it, holds it down with the updater's guard, and starts it again. This
 * module is the web server's side: the owner's schedule (on, 04:30 local by
 * default — `openclaw-db-maintenance-scheduler.ts` arms it), the status the
 * Settings card shows, and the launch, which goes into a transient unit of the
 * user's systemd manager so a web-server restart (an update, a crash) does not
 * take a run that holds the gateway down with it.
 *
 * SERVER ONLY.
 */

import { execFile, spawn } from "child_process";
import fs from "fs";
import path from "./runtime-path";
import { CONFIG_ROOT, DATA_DIR, get, set } from "./config-store";

/** Where the owner's schedule lives in the device store. */
export const DB_MAINTENANCE_KEY = "openclaw_db_maintenance";

export interface DbMaintenanceSchedule {
  enabled: boolean;
  /** Local `HH:MM`. */
  time: string;
}

/** Off-hours, after Prime Radiant's 03:00 nightly pass and before a morning's first chat. */
export const DEFAULT_DB_MAINTENANCE_SCHEDULE: DbMaintenanceSchedule = { enabled: true, time: "04:30" };

/** The transient user unit a run goes into; one at a time, by name. */
export const DB_MAINTENANCE_UNIT = "clawbox-openclaw-db-maintenance";

const RECORD_FILE = "openclaw-db-maintenance.json";
const STATUS_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 10_000;

export type DbMaintenanceTrigger = "scheduled" | "manual";

export interface DbMaintenanceDatabase {
  key: string;
  label: string;
  kind: "agent" | "state";
  agentId: string | null;
  bytes: number;
  fileBytes: number;
  walBytes: number;
  freeBytes: number | null;
  freeRatio: number | null;
  autoVacuum: number | null;
  error: string | null;
  /** Why a maintenance run would compact it, or null when it would not. */
  needs: string | null;
  /** Why it cannot be compacted now (low disk, an older schema), or null. */
  blocked: string | null;
}

export interface DbMaintenanceRun {
  trigger?: string;
  outcome: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  seconds?: number;
  beforeBytes?: number;
  afterBytes?: number;
  gatewayStopped?: boolean;
  gatewayRestarted?: boolean;
  downtimeSeconds?: number;
}

export interface DbMaintenanceStatus {
  /** False on a box with no OpenClaw (the Hermes edition): nothing else is filled in. */
  available: boolean;
  core: string | null;
  /** The installed core has the offline compaction ClawBox drives (2026.10 or later). */
  supported: boolean;
  totalBytes: number;
  diskFreeBytes: number | null;
  databases: DbMaintenanceDatabase[];
  running: { trigger?: string; phase?: string; startedAt?: string } | null;
  lastRun: DbMaintenanceRun | null;
  schedule: DbMaintenanceSchedule;
  /** When the next scheduled check fires, unix ms; null when the schedule is off. */
  nextRunAt: number | null;
}

export function parseDbMaintenanceTime(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** A stored schedule, with the default for anything absent or malformed. */
export function normaliseDbMaintenanceSchedule(raw: unknown): DbMaintenanceSchedule {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_DB_MAINTENANCE_SCHEDULE.enabled,
    time: parseDbMaintenanceTime(value.time) ? String(value.time).trim() : DEFAULT_DB_MAINTENANCE_SCHEDULE.time,
  };
}

export async function readDbMaintenanceSchedule(): Promise<DbMaintenanceSchedule> {
  return normaliseDbMaintenanceSchedule(await get(DB_MAINTENANCE_KEY));
}

export class DbMaintenanceScheduleError extends Error {}

export async function writeDbMaintenanceSchedule(next: { enabled?: unknown; time?: unknown }): Promise<DbMaintenanceSchedule> {
  const current = await readDbMaintenanceSchedule();
  if (next.enabled !== undefined && typeof next.enabled !== "boolean") throw new DbMaintenanceScheduleError("enabled must be true or false");
  if (next.time !== undefined && !parseDbMaintenanceTime(next.time)) throw new DbMaintenanceScheduleError("time must be HH:MM");
  const schedule: DbMaintenanceSchedule = {
    enabled: typeof next.enabled === "boolean" ? next.enabled : current.enabled,
    time: next.time !== undefined ? String(next.time).trim() : current.time,
  };
  await set(DB_MAINTENANCE_KEY, schedule);
  return schedule;
}

function helperScript(): string {
  return path.join(CONFIG_ROOT, "scripts", "openclaw-db-maintenance.py");
}

/** The places the pre-start passes the same helper, resolved the way the web server finds them. */
async function helperPaths(): Promise<string[]> {
  const { CONFIG_PATH, OPENCLAW_HOME, findOpenclawBin } = await import("./openclaw-config");
  const { openclawStateDir } = await import("./openclaw-state-store");
  const args = [
    "--state-dir", openclawStateDir(OPENCLAW_HOME),
    "--config", CONFIG_PATH,
    "--data-dir", DATA_DIR,
    "--device-store", path.join(DATA_DIR, "config.json"),
  ];
  const bin = findOpenclawBin();
  if (path.isAbsolute(bin)) {
    args.push("--openclaw-bin", bin, "--core-pkg", path.join(path.dirname(bin), "..", "lib", "node_modules", "openclaw", "package.json"));
  }
  return args;
}

async function noOpenclaw(): Promise<boolean> {
  const { gatewayIsAbsent } = await import("./openclaw-config");
  return gatewayIsAbsent();
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readRecord(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, RECORD_FILE), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A maintenance run is in progress, by the record it keeps while it runs
 * (`run.pid`, alive) — or holds the gateway down (`hold.pid`, alive).
 * Synchronous: `startUpdate` asks it, and an update must not start under a
 * compaction, whose guard the updater's own would lift halfway through.
 */
export function dbMaintenanceRunning(): boolean {
  const record = readRecord();
  if (!record) return false;
  const run = record.run as { pid?: unknown } | undefined;
  const hold = record.hold as { pid?: unknown } | undefined;
  return pidAlive(run?.pid) || pidAlive(hold?.pid);
}

async function nextRunAt(schedule: DbMaintenanceSchedule): Promise<number | null> {
  if (!schedule.enabled) return null;
  const { nextRunAtMs, computeNextDbMaintenanceMs } = await import("./openclaw-db-maintenance-scheduler");
  return nextRunAtMs() || computeNextDbMaintenanceMs(schedule, new Date()) || null;
}

/** What the Settings card shows. Throws when the helper cannot answer. */
export async function readDbMaintenanceStatus(): Promise<DbMaintenanceStatus> {
  const schedule = await readDbMaintenanceSchedule();
  const empty: DbMaintenanceStatus = {
    available: false, core: null, supported: false, totalBytes: 0, diskFreeBytes: null,
    databases: [], running: null, lastRun: null, schedule, nextRunAt: null,
  };
  if (await noOpenclaw()) return empty;
  const args = ["-I", helperScript(), "status", "--json", ...(await helperPaths())];
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("python3", args, { timeout: STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error(`database status failed: ${String(errOut || err.message).trim().slice(-300)}`));
      else resolve(out);
    });
  });
  const report = JSON.parse(stdout) as Partial<DbMaintenanceStatus> & { databases?: DbMaintenanceDatabase[] };
  return {
    available: true,
    core: report.core ?? null,
    supported: report.supported === true,
    totalBytes: typeof report.totalBytes === "number" ? report.totalBytes : 0,
    diskFreeBytes: typeof report.diskFreeBytes === "number" ? report.diskFreeBytes : null,
    databases: Array.isArray(report.databases) ? report.databases : [],
    running: report.running ?? null,
    lastRun: report.lastRun ?? null,
    schedule,
    nextRunAt: await nextRunAt(schedule),
  };
}

export type DbMaintenanceStart =
  | { started: true; survivesRestart: boolean }
  | { started: false; code: "no_openclaw" | "already_running" | "update_in_progress" | "spawn_failed"; detail?: string };

/** systemd expands `$VAR` in a transient unit's command line; `$$` is a literal dollar. */
function systemdArgv(argv: string[]): string[] {
  return argv.map((a) => a.replace(/\$/g, "$$$$"));
}

/** The environment the core's CLI resolves its state from, passed on to the run. */
function runEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "CLAWBOX_OPENCLAW_HOME", "CLAWBOX_ROOT"]) {
    const value = process.env[key];
    if (typeof value === "string" && value) env[key] = value;
  }
  return env;
}

function launchDetached(argv: string[]): DbMaintenanceStart {
  try {
    const child = spawn("python3", argv, { detached: true, stdio: "ignore", env: process.env });
    child.on("error", (err) => console.warn("[db-maintenance] could not start:", err.message));
    child.unref();
    return { started: true, survivesRestart: false };
  } catch (err) {
    return { started: false, code: "spawn_failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Start a maintenance run in the background. The run itself decides whether
 * anything needs doing and whether the gateway is idle; this refuses only what
 * it can see from here — no OpenClaw, a run already going, an update.
 */
export async function startDbMaintenance(trigger: DbMaintenanceTrigger): Promise<DbMaintenanceStart> {
  if (await noOpenclaw()) return { started: false, code: "no_openclaw" };
  if (dbMaintenanceRunning()) return { started: false, code: "already_running" };
  try {
    const { updateInFlight } = await import("./updater");
    if (await updateInFlight()) return { started: false, code: "update_in_progress" };
  } catch {
    // An updater that cannot be asked is not an update; the run checks the store itself.
  }
  const argv = ["-I", helperScript(), "maintain", "--trigger", trigger, ...(await helperPaths())];
  const { probeSystemdRun, scopeEnv } = await import("./coding-run-unit");
  const probe = await probeSystemdRun();
  if (!probe.available || !probe.path) return launchDetached(argv);
  const env = runEnv();
  const setenv = Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`);
  return new Promise((resolve) => {
    execFile(
      probe.path as string,
      [
        "--user", `--unit=${DB_MAINTENANCE_UNIT}`, "--collect", "--quiet",
        "--description=ClawBox OpenClaw database maintenance", "--property=Nice=10",
        ...setenv, "--", "/usr/bin/env", "python3", ...systemdArgv(argv),
      ],
      { env: scopeEnv(env) as NodeJS.ProcessEnv, timeout: LAUNCH_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve({ started: true, survivesRestart: true });
          return;
        }
        if (/already (exists|loaded)/i.test(String(stderr))) {
          resolve({ started: false, code: "already_running" });
          return;
        }
        // The user manager refused the unit: still a run, tied to the web
        // server's lifetime — which the run survives by restarting the
        // gateway on its way out.
        console.warn("[db-maintenance] systemd-run refused the run, starting it directly:", String(stderr || err.message).trim().slice(0, 300));
        resolve(launchDetached(argv));
      },
    );
  });
}
