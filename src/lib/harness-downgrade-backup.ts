/**
 * The override's half of a harness downgrade (see src/lib/harness-downgrade.ts):
 * back the assistant's data up FIRST, then tell the installer which core it may
 * set newer databases aside for.
 *
 * THE BACKUP. ClawKeep when the box is paired with it — the owner's own backup,
 * kept off the box — and otherwise each harness's own backup command, run with
 * the version that is installed now (the newer one, which can still read its
 * data): `openclaw backup create --verify --no-include-workspace` and
 * `hermes backup`. Both are written under ~/clawbox-harness-backups/<UTC stamp>/,
 * and that same directory is where the installer moves the databases the older
 * core cannot open, so everything the downgrade puts out of reach is in one place.
 * No backup, no downgrade: every failure here refuses the override with its reason.
 *
 * THE AUTHORISATION. `data/harness-downgrade.json`, read by
 * scripts/openclaw-db-maintenance.py's `preflight` inside install.sh's
 * `openclaw_install`. It names the core version, the backup directory and the
 * moment it was given, and the installer honours it only for that version,
 * within DOWNGRADE_AUTHORIZATION_TTL_MS, while the directory exists. Its
 * boundary is the clawbox account, which owns both the file and the databases
 * it lets the installer move: nothing here can do what that account cannot.
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import os from "node:os";
import path from "./runtime-path";
import { HARNESS_LABEL, type HarnessDowngrade } from "./harness-downgrade";
import { findOpenclawBin } from "./openclaw-config";
import { runHermesCli } from "./hermes-cli";

const execFile = promisify(execFileCb);

/** How long an authorisation stands: longer than any update, shorter than a forgotten one. */
export const DOWNGRADE_AUTHORIZATION_TTL_MS = 12 * 60 * 60 * 1000;
/** A verified archive of a ~10 GB box takes minutes; this is the ceiling, not the plan. */
const LOCAL_BACKUP_TIMEOUT_MS = 60 * 60 * 1000;

export function downgradeAuthorizationFile(): string {
  return path.join(process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox", "data", "harness-downgrade.json");
}

export function downgradeBackupRoot(): string {
  return path.join(process.env.HOME || os.homedir(), "clawbox-harness-backups");
}

export type DowngradeBackupResult =
  | { ok: true; kind: "clawkeep" | "local"; dir: string; summary: string }
  | { ok: false; reason: string };

function stampOf(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function tail(text: unknown): string {
  const lines = String(text ?? "").trim().split("\n").filter(Boolean);
  return lines.slice(-3).join(" ").slice(0, 400);
}

/** ClawKeep's answer: null when the box is not paired, so the local backup is the one. */
async function clawkeepBackup(): Promise<{ ok: boolean; reason: string } | null> {
  // Loaded only here: the updater imports this module, and ClawKeep's client is
  // a large one that no other update path needs.
  const clawkeep = await import("./clawkeep");
  if (!(await clawkeep.readToken().catch(() => null))) return null;
  try {
    const result = await clawkeep.runBackup({ label: "Before installing an older assistant version" });
    if (result.exitCode === 0) return { ok: true, reason: "" };
    return { ok: false, reason: `ClawKeep exited ${result.exitCode}: ${tail(result.stderr) || tail(result.stdout)}` };
  } catch (err) {
    // Unpaired between the token read and the run: the local backup is the one.
    if (err instanceof Error && err.name === "ClawKeepNotPairedError") return null;
    return { ok: false, reason: `ClawKeep: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * `env` is the updater's `openclawChildEnv()`: the child must archive the tree
 * ClawBox runs (HOME, OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH pinned, no
 * inherited OPENCLAW_HOME), or a verified archive of some other, empty tree
 * would pass for this box's backup.
 */
async function openclawLocalBackup(dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const out = path.join(dir, "openclaw");
  await mkdir(out, { recursive: true, mode: 0o700 });
  try {
    await execFile(
      findOpenclawBin(),
      ["backup", "create", "--verify", "--no-include-workspace", "--output", out, "--json"],
      { timeout: LOCAL_BACKUP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
    );
    return null;
  } catch (err) {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: string };
    return `openclaw backup create failed: ${tail(e.stderr) || tail(e.stdout) || e.message || "unknown error"}`;
  }
}

async function hermesLocalBackup(dir: string): Promise<string | null> {
  try {
    const { code, stdout, stderr } = await runHermesCli(
      ["backup", "--output", path.join(dir, "hermes-backup.zip")],
      { timeoutMs: LOCAL_BACKUP_TIMEOUT_MS },
    );
    return code === 0 ? null : `hermes backup exited ${code}: ${tail(stderr) || tail(stdout)}`;
  } catch (err) {
    return `hermes backup failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Back up the data of every harness in `downgrades`, ClawKeep first. Never
 * throws: the caller turns `{ok: false}` into the refusal the owner reads.
 */
export async function backUpBeforeDowngrade(
  downgrades: HarnessDowngrade[],
  openclawEnv: NodeJS.ProcessEnv,
  now: Date = new Date(),
): Promise<DowngradeBackupResult> {
  try {
    return await backUp(downgrades, openclawEnv, now);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function backUp(downgrades: HarnessDowngrade[], openclawEnv: NodeJS.ProcessEnv, now: Date): Promise<DowngradeBackupResult> {
  const dir = path.join(downgradeBackupRoot(), stampOf(now));
  const moving = downgrades.map((d) => `${HARNESS_LABEL[d.harness]} ${d.installed ?? "?"} -> ${d.target}`).join(", ");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, reason: `could not create ${dir}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const clawkeep = await clawkeepBackup().catch((err) => ({ ok: false, reason: String(err) }));
  if (clawkeep?.ok) {
    await writeFile(path.join(dir, "README.txt"), `Installing an older assistant: ${moving}.\n`
      + `A ClawKeep backup was taken first (${now.toISOString()}); restore it from ClawKeep.\n`
      + "Databases the older version cannot open are moved into openclaw-newer-schema/ here.\n").catch(() => {});
    return {
      ok: true,
      kind: "clawkeep",
      dir,
      summary: `Before installing an older assistant (${moving}), its data was backed up to ClawKeep. `
        + `Anything the older version cannot open is set aside in ${dir}.`,
    };
  }
  for (const d of downgrades) {
    const failure = d.harness === "openclaw" ? await openclawLocalBackup(dir, openclawEnv) : await hermesLocalBackup(dir);
    if (failure) {
      return { ok: false, reason: clawkeep && !clawkeep.ok ? `${clawkeep.reason}; then ${failure}` : failure };
    }
  }
  await writeFile(path.join(dir, "README.txt"), `Installing an older assistant: ${moving}.\n`
    + `Backed up first (${now.toISOString()}) with each harness's own backup command:\n`
    + "  openclaw/            openclaw backup create --verify --no-include-workspace\n"
    + "  hermes-backup.zip    hermes backup\n"
    + "Databases the older version cannot open are moved into openclaw-newer-schema/ here.\n").catch(() => {});
  return {
    ok: true,
    kind: "local",
    dir,
    summary: `Before installing an older assistant (${moving}), its data was backed up to ${dir}, `
      + "where anything the older version cannot open is also set aside.",
  };
}

interface DowngradeAuthorization {
  version: 1;
  openclaw: string | null;
  hermes: string | null;
  /** The Hermes pin's commit: what install.sh's own sync guard compares. */
  hermesCommit: string | null;
  backupDir: string;
  authorizedAt: string;
  authorizedAtEpoch: number;
}

/** Tell the installer which core may set newer databases aside, and where to. */
export async function writeDowngradeAuthorization(
  grant: { openclaw: string | null; hermes: string | null; hermesCommit: string | null; backupDir: string },
  now: Date = new Date(),
): Promise<void> {
  const file = downgradeAuthorizationFile();
  const body: DowngradeAuthorization = {
    version: 1,
    ...grant,
    authorizedAt: now.toISOString(),
    authorizedAtEpoch: Math.floor(now.getTime() / 1000),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

/**
 * Withdraw an authorisation, if any. Never throws — not even synchronously —
 * because every update asks it: an absent file is the goal, and a guard may
 * not be the thing that fails an update.
 */
export async function clearDowngradeAuthorization(): Promise<void> {
  try {
    await rm(downgradeAuthorizationFile(), { force: true });
  } catch (err) {
    console.warn("[Updater] could not withdraw an earlier downgrade authorisation:", err instanceof Error ? err.message : err);
  }
}

/** Whether a standing authorisation already names this OpenClaw core. */
export async function downgradeAuthorizedFor(openclaw: string, now: Date = new Date()): Promise<boolean> {
  try {
    const body = JSON.parse(await readFile(downgradeAuthorizationFile(), "utf-8")) as Partial<DowngradeAuthorization>;
    const age = now.getTime() / 1000 - Number(body.authorizedAtEpoch);
    return body.version === 1 && body.openclaw === openclaw && age >= 0 && age <= DOWNGRADE_AUTHORIZATION_TTL_MS / 1000;
  } catch {
    return false;
  }
}
