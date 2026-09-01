import { exec as execCb, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { get, set, setMany } from "./config-store";
import {
  findOpenclawBin,
  restartGateway,
  openclawIsAbsent,
  gatewayIsAbsent,
} from "./openclaw-config";
import { hasHermesHarness, readEdition, type EditionName } from "./edition-source";
import { runHermesCli } from "./hermes-cli";
import { isPortOpen } from "./port-probe";
import { parseHermesVersion } from "./version-utils";
import { isSafeBranch } from "./update-branch";
import { collectBuildIdentity } from "./build-identity";

const PROJECT_DIR = process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox";
const UPDATE_BRANCH_FILE = path.join(PROJECT_DIR, ".update-branch");
// Pinned OpenClaw version — single source of truth shared with install.sh
// so the in-UI "Latest" column reflects the ClawBox-approved release, not
// whatever npm last published. Bump the file in a PR → beta → main and the
// fleet follows. See install.sh::step_openclaw_install for the matching read.
const OPENCLAW_TARGET_FILE = path.join(PROJECT_DIR, "config", "openclaw-target.txt");
// Hardcoded fallback used only when the pin file is missing or unreadable.
// MUST stay in sync with install.sh::OPENCLAW_VERSION so the UI's "Latest"
// column reports the same version that `install.sh --step openclaw_install`
// would actually deploy. Without this both sides diverged: the UI returned
// null and reported "no update", while install.sh would still install
// 2026.5.3-1 — confusing.
const OPENCLAW_VERSION_FALLBACK = "2026.8.1";

const execShell = promisify(execCb);
const execFile = promisify(execFileCb);

/**
 * Run git without a shell.
 *
 * `CLAWBOX_ROOT` is an environment-provided path and update branches come from
 * a persisted preference. Passing both as argv keeps shell metacharacters inert
 * (branch grammar is validated separately by isSafeBranch) and centralizes the
 * repository/safe-directory arguments every updater git call requires.
 */
function execGit(
  projectDir: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number },
) {
  return execFile(
    "git",
    ["-c", `safe.directory=${projectDir}`, "-C", projectDir, ...args],
    options,
  );
}

const VALID_HOST = /^[A-Za-z0-9.\-:]+$/;
const PING_TARGETS = (process.env.PING_TARGETS || "8.8.8.8,1.1.1.1")
  .split(",")
  .map((t) => t.trim())
  .filter((t) => t && VALID_HOST.test(t));

interface UpdateStepDef {
  id: string;
  label: string;
  timeoutMs: number;
  command?: string;
  requiresRoot?: boolean;
  failFast?: boolean;
  customRun?: () => Promise<void>;
  /**
   * A budget overrun doesn't fail the update for this step — it's marked
   * completed and the run carries on. For steps whose content is non-fatal
   * by design (post_update: every fixup inside is `|| warn`), an overrun
   * painting "Update failed" on a successful update is misleading. The
   * quiesced runner still waits for the root unit to settle before advancing;
   * genuine unit failures still fail.
   */
  advisoryOnOverrun?: boolean;
  /**
   * Whether this step applies to the device it is about to run on. Absent
   * means "always applies".
   *
   * install.sh's step bodies already no-op per edition, but they cannot answer
   * this question: by the time bash runs, the UI line exists and the step's
   * timeout is already ticking. A predicate here lets the runner DROP the step
   * from the list entirely, so a Hermes owner is never shown OpenClaw work
   * being "completed" on a box that has no OpenClaw.
   */
  applies?: () => boolean;
}

/** Thrown by execAsRoot when OUR wait budget expired but the unit runs on. */
class BudgetOverrunError extends Error {}

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface StepState {
  id: string;
  label: string;
  status: StepStatus;
  error?: string;
}

export type UpdatePhase =
  | "idle"
  | "running"
  | "completed"
  | "failed";

/**
 * A non-fatal problem the update noticed and worked around.
 *
 * Krasi's ruling on build drift is WARN + AUTO-REPIN, not block: a box whose
 * deployed build or checkout has wandered still updates, but it has to SAY so
 * — silently converging is how the drift went unnoticed for a fortnight. The
 * `code` is machine-readable so a caller can act on it; `message` is the line
 * shown in the update log, written server-side alongside the step labels.
 */
export interface UpdateWarning {
  code: string;
  message: string;
}

export interface UpdateState {
  phase: UpdatePhase;
  steps: StepState[];
  currentStepIndex: number;
  error?: string;
  /**
   * Warnings raised during this run, oldest first. Optional rather than
   * required so every existing construction of an UpdateState — and every
   * client reading one — keeps compiling and behaving exactly as before.
   */
  warnings?: UpdateWarning[];
}

export { RESTART_STEP_ID } from "./update-constants";
import { RESTART_STEP_ID } from "./update-constants";

// Ceiling for the rebuild/restart hand-off: bun build alone runs minutes on a
// Jetson, plus the config/redeploy steps before it and the reboot after.
const REBUILD_TAKEOVER_TIMEOUT_MS = 900_000;

// The root unit that performs the rebuild + restart. Distinct from
// RESTART_STEP_ID ("restart"), which is the UI step's identity — querying
// `clawbox-root-update@restart.service` would hit a unit that doesn't exist
// (and `systemctl show -p Result` reports "success" for unloaded units, which
// would silently disable the failure detection below).
const REBUILD_ROOT_STEP = "rebuild_reboot";

/** `systemctl show <unit> -p Result --value`, or null if unqueryable. */
async function getRootStepResult(stepId: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/systemctl",
      ["show", `clawbox-root-update@${stepId}.service`, "-p", "Result", "--value"],
      { timeout: 10_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function rootStepResultFailed(result: string | null): boolean {
  return result !== null && result !== "success";
}

/** Read .next/BUILD_ID — regenerated on every successful `next build`. */
async function readBuildId(): Promise<string> {
  try {
    return (await readFile(path.join(PROJECT_DIR, ".next", "BUILD_ID"), "utf-8")).trim();
  } catch {
    return "";
  }
}

/**
 * Wait for the rebuild_reboot root unit to take this process down (it
 * restarts clawbox-setup / reboots the box on success). The old
 * implementation was a blind 30s sleep that resolved SUCCESS — so a rebuild
 * that failed (or merely outlived the sleep) let the update march on to
 * "Update complete" while the box kept serving the old build, with the
 * promised restart never coming. Watch the unit instead: a failure surfaces
 * as a failed step with the real error, and only systemd killing us counts
 * as success — this function never returns normally.
 */
async function waitForRebuildToTakeOver(): Promise<never> {
  const deadline = Date.now() + REBUILD_TAKEOVER_TIMEOUT_MS;
  let message = "Rebuild did not restart the device within the expected window";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (rootStepResultFailed(await getRootStepResult(REBUILD_ROOT_STEP))) {
      const lastLog = await readRootStepFailure(REBUILD_ROOT_STEP);
      message = lastLog
        ? `Rebuild failed: ${lastLog}`
        : "Rebuild failed — see clawbox-root-update@rebuild_reboot logs";
      break;
    }
  }
  // Either way the restart isn't coming — clear the flag so the next server
  // start doesn't "continue" a rebuild that never happened.
  await set("update_needs_continuation", undefined);
  throw new Error(message);
}

function getLastLogLine(logText: string): string | null {
  const lines = logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

async function readRootStepFailure(stepId: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/journalctl",
      ["-u", `clawbox-root-update@${stepId}.service`, "-n", "40", "--no-pager", "-o", "cat"],
      { timeout: 10_000 },
    );
    return getLastLogLine(stdout);
  } catch {
    return null;
  }
}

/**
 * Start a root systemd service in fire-and-forget mode.
 * Used for steps that will kill the current process (rebuild, reboot).
 */
async function startRootServiceFireAndForget(stepId: string): Promise<void> {
  const service = `clawbox-root-update@${stepId}.service`;
  execFile("/usr/bin/systemctl", ["reset-failed", service], {
    timeout: 10_000,
  }).catch(() => {});
  await execFile("/usr/bin/systemctl", ["start", "--no-block", service], {
    timeout: 10_000,
  });
}

/**
 * Determine which branch to update to, in priority order:
 * 1. `.update-branch` file in project root (survives factory reset + git reset)
 * 2. Current branch if it tracks a remote (or if origin carries it)
 * 3. DETACHED HEAD: the branch the device can be shown to have come from
 * 4. "main", only where main is not a guess about somebody else's device
 *
 * Rule 1 survives a factory reset because the reset route wipes `data/`,
 * `~/.openclaw`, `~/.clawkeep` and a list of home dotfiles — never the project
 * root itself — and survives `git reset --hard` because the file is gitignored.
 * Both are pinned by src/tests/unit/install-update-branch-pin.test.ts.
 *
 * The pin is written by install.sh (persist_update_branch_pin) and by the
 * operator through /setup-api/system/update-branch. install.sh writes it for an
 * explicit CLAWBOX_BRANCH, and — when the device carries no pin at all — adopts
 * the branch the checkout is already sitting on, because rule 2 is weak: a
 * branch's upstream *link* does not survive a re-clone even though the branch
 * does, and an unpinned device then falls silently through to `main`.
 *
 * Rules 2 and 4 are why a rejected pin is worse than no pin: an unreadable or
 * malformed value does not fail the update, it quietly becomes `main`. The
 * validator is therefore shared with the Settings route and mirrored by
 * install.sh's `is_safe_git_ref` — see src/lib/update-branch.ts.
 *
 * RULE 3 exists because `main` is the fleet release channel, so resolving to it
 * without evidence is not an update — it is a channel change, and the auto-repin
 * then makes it permanent. `git symbolic-ref HEAD` FAILS on a detached HEAD,
 * which is what a support engineer leaves behind after `git checkout <sha>`, and
 * that failure used to land straight on the `main` default: one debugging
 * checkout silently retargeted (and, since PR #463, permanently repinned) a beta
 * device onto main (hwtest-round1, 2026-08-24). A detached device is now
 * resolved from what it can prove about itself, and refuses the update if it can
 * prove nothing — a refusal an operator can fix in one click is better than a
 * silent move nobody sees.
 */
export type BranchSource =
  /** `.update-branch` — the operator's/installer's explicit record. */
  | "pin-file"
  /** `git symbolic-ref HEAD` — the branch the checkout is on. */
  | "checkout-branch"
  /** Detached HEAD, resolved from the build stamp / refs that contain HEAD. */
  | "detached-recovered"
  /** Nothing said otherwise: `main`. Never auto-pinned. */
  | "default";

export interface ResolvedBranch {
  /** Local branch to checkout */
  local: string;
  /** Full upstream ref to reset to (e.g. "origin/feature/foo") */
  upstream: string;
  /** How the answer was reached. Only evidence-backed sources may be pinned. */
  source: BranchSource;
}

/**
 * Thrown when the device cannot say which branch it belongs to and the only
 * remaining answer would be a guess. Fails the update step with a message the
 * owner can act on, instead of moving the device to another channel.
 */
export class UnresolvableUpdateBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvableUpdateBranchError";
  }
}

/**
 * git output, or null when the command failed OR answered nothing. Every caller
 * here wants a ref name, so an empty answer is as useless as a failure.
 *
 * execFile with an argument array, never a shell string — `projectDir` and the
 * branch names below are interpolated into git refs.
 */
async function gitRef(projectDir: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execGit(
      projectDir,
      args,
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function originHasBranch(projectDir: string, branch: string): Promise<boolean> {
  return !!(await gitRef(projectDir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`));
}

/** The branch the DEPLOYED build was compiled from, per its own stamp. */
async function stampedBuildBranch(projectDir: string): Promise<string | null> {
  for (const dir of [path.join(projectDir, ".next", "standalone", ".next"), path.join(projectDir, ".next")]) {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(dir, "build-info.json"), "utf-8"));
      const branch = (raw as { branch?: unknown })?.branch;
      if (typeof branch === "string" && branch.trim() && branch.trim() !== "HEAD") return branch.trim();
    } catch {
      // No stamp in this tree — try the next one.
    }
  }
  return null;
}

/**
 * Which branch does a detached checkout belong to? Three independent kinds of
 * evidence, best first:
 *
 *   1. the build stamp — what the running build was compiled from. Written at
 *      build time on this device, so it survives the checkout that detached
 *      HEAD and describes what the box has actually been serving;
 *   2. local branches that CONTAIN HEAD — git's own record that this commit is
 *      on that branch;
 *   3. `git name-rev` against origin's refs — the same question asked of the
 *      remote-tracking refs, which is all a re-clone leaves.
 *
 * `main` is accepted only when it appears as evidence, never as a fallback, and
 * is ordered last so a box that carries any other candidate keeps its channel.
 * A candidate is only used when origin actually carries the branch: resolving
 * to a branch that has no upstream would fail the update at
 * `reset --hard origin/<branch>` instead of at this readable message.
 */
async function recoverDetachedBranch(projectDir: string): Promise<string | null> {
  const candidates: string[] = [];

  const stamped = await stampedBuildBranch(projectDir);
  if (stamped) candidates.push(stamped);

  const contains = await gitRef(
    projectDir, "for-each-ref", "--format=%(refname:short)", "--contains", "HEAD", "refs/heads",
  );
  if (contains) candidates.push(...contains.split("\n").map((l) => l.trim()).filter(Boolean));

  const named = await gitRef(projectDir, "name-rev", "--name-only", "--refs=refs/remotes/origin/*", "HEAD");
  if (named && named !== "undefined") {
    const cleaned = named.replace(/^remotes\//, "").replace(/^origin\//, "").replace(/[~^].*$/, "").trim();
    if (cleaned) candidates.push(cleaned);
  }

  const ordered = [
    ...candidates.filter((c) => c !== "main"),
    ...candidates.filter((c) => c === "main"),
  ];

  for (const candidate of ordered) {
    if (!isSafeBranch(candidate) || candidate === "HEAD") continue;
    if (await originHasBranch(projectDir, candidate)) return candidate;
  }
  return null;
}

export async function resolveUpdateBranch(projectDir: string = PROJECT_DIR): Promise<ResolvedBranch> {
  const main: ResolvedBranch = { local: "main", upstream: "origin/main", source: "default" };

  // 1. Check .update-branch file
  try {
    const pinned = (await readFile(path.join(projectDir, ".update-branch"), "utf-8")).trim();
    if (pinned && isSafeBranch(pinned)) {
      return { local: pinned, upstream: `origin/${pinned}`, source: "pin-file" };
    }
  } catch { /* file doesn't exist */ }

  const current = await gitRef(projectDir, "symbolic-ref", "--short", "HEAD");

  // 2. On a branch: its configured upstream, else origin's copy of it.
  if (current) {
    // Sitting on main IS evidence — it just happens to agree with the default.
    // Distinguished from it so the fleet's main devices do not each report a
    // "could not tell which branch this is" warning every update.
    if (current === "main") return { ...main, source: "checkout-branch" };
    if (!isSafeBranch(current)) return main;

    const upstream = await gitRef(projectDir, "rev-parse", "--abbrev-ref", `${current}@{u}`);
    if (upstream && isSafeBranch(upstream)) {
      return { local: current, upstream, source: "checkout-branch" };
    }
    // The upstream LINK does not survive a re-clone even though the branch
    // does. origin/<current> existing is the same evidence by another route,
    // and using it keeps a re-cloned beta box on beta instead of main.
    if (await originHasBranch(projectDir, current)) {
      return { local: current, upstream: `origin/${current}`, source: "checkout-branch" };
    }
    // A branch origin does not carry: updating to it would fail at the reset.
    return main;
  }

  // Not a git checkout at all (a fresh install about to clone) — main is the
  // repository's default branch, not a guess about a device.
  if (!(await gitRef(projectDir, "rev-parse", "--git-dir"))) return main;

  // 3. Detached HEAD — resolve from evidence, or refuse.
  const recovered = await recoverDetachedBranch(projectDir);
  if (recovered) {
    return { local: recovered, upstream: `origin/${recovered}`, source: "detached-recovered" };
  }

  throw new UnresolvableUpdateBranchError(
    "This device is not on a branch (detached HEAD), carries no update pin, and nothing on it "
    + "records which branch it was built from. Refusing to update, because the only remaining "
    + "answer is \"main\" — the fleet release channel — and moving this device there would be a "
    + "channel change, not an update. Set the update branch in System Update → Advanced options "
    + "(or check out the branch this device belongs to) and run the update again.",
  );
}

/**
 * Record a warning on the running update: journal + update log.
 *
 * De-duplicated by code, because the same condition can be observed twice in
 * one run (before the rebuild and again by the post-update verification) and a
 * doubled line reads like two separate problems.
 */
function warnUpdate(code: string, message: string): void {
  console.warn(`[Updater] WARNING: ${message}`);
  if (!state.warnings) state.warnings = [];
  if (state.warnings.some((w) => w.code === code)) return;
  state.warnings.push({ code, message });
}

/**
 * Persist this run's warnings across the reboot the rebuild step performs.
 *
 * Drift is detected BEFORE the rebuild and the device restarts moments later,
 * so without this the one line the owner most needs to see is the one line the
 * reboot eats.
 */
async function persistWarnings(): Promise<void> {
  await set("update_warnings", state.warnings?.length ? JSON.stringify(state.warnings) : undefined);
}

async function restoreWarnings(): Promise<UpdateWarning[]> {
  try {
    const raw = await get("update_warnings");
    if (typeof raw !== "string") return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (w): w is UpdateWarning =>
        !!w && typeof (w as UpdateWarning).code === "string" && typeof (w as UpdateWarning).message === "string",
    );
  } catch {
    return [];
  }
}

/**
 * AUTO-REPIN. A device with no usable `.update-branch` is not blocked and is
 * not left as it was: it is pinned to the branch this very update resolved,
 * so the next one converges on the tested commit by record rather than by
 * whatever `git symbolic-ref` happens to answer after a re-clone.
 *
 * This writes the same file install.sh's persist_update_branch_pin writes and
 * that resolveUpdateBranch reads — one pin mechanism, not a second one. An
 * existing, VALID pin is never overwritten: that value is the operator's
 * choice (Settings → update branch) and repinning it would silently move a QA
 * box off the branch it was put on.
 *
 * Returns the warnings to raise rather than raising them, so the decision can
 * be tested against a throwaway directory without a running update.
 *
 * `projectDir` is a parameter for that reason alone; every caller passes
 * PROJECT_DIR.
 *
 * `source` is the load-bearing argument: a pin is a RECORD, so it may only be
 * written from evidence. A branch reached by falling through to the default is
 * a guess, and pinning a guess makes it permanent — that is how one
 * `git checkout <sha>` on a beta device turned into "pinned to main forever"
 * (hwtest-round1, 2026-08-24). `main` itself is never auto-pinned even when it
 * IS the evidence: it is already the fallback, so a pin changes nothing today
 * and would only freeze a device an operator later moves by hand — the same
 * rule install.sh's adoptable_checkout_branch applies.
 */
export async function repinUpdateBranch(
  resolved: string,
  projectDir: string = PROJECT_DIR,
  source: BranchSource = "checkout-branch",
): Promise<UpdateWarning[]> {
  if (source === "default") {
    return [{
      code: "repin-skipped",
      message:
        `This box carries no update pin and nothing on it records which branch it belongs to — `
        + `updating from "${resolved}" this once, without pinning a guess.`,
    }];
  }
  if (resolved === "main") return [];

  const pinFile = path.join(projectDir, ".update-branch");
  let existing: string | null = null;
  try {
    existing = (await readFile(pinFile, "utf-8")).trim();
  } catch {
    // No pin file at all — the common unpinned case.
  }

  if (existing && isSafeBranch(existing)) return [];

  if (!isSafeBranch(resolved)) {
    return [{
      code: "repin-refused",
      message: `Cannot pin this device: "${resolved}" is not a usable branch name.`,
    }];
  }

  try {
    await writeFile(pinFile, `${resolved}\n`, { mode: 0o644 });
    return [{
      code: "repinned",
      message: existing
        ? `This box carried an unusable update pin ("${existing}") — re-pinned to the tested branch "${resolved}".`
        : `This box carried no update pin — pinned to the tested branch "${resolved}" so future updates are repeatable.`,
    }];
  } catch (err) {
    return [{
      code: "repin-failed",
      message: `Could not write the update pin: ${err instanceof Error ? err.message : "unknown error"}`,
    }];
  }
}

/**
 * Report — never block — a box whose deployed build or checkout has drifted.
 *
 * The condition this exists for: a device serving assets built from one commit
 * while its source tree sits on another. Two features 404'd on such a box for
 * a fortnight and nothing anywhere said why. Returns one warning per problem,
 * and an empty list for a healthy box.
 */
export async function collectDriftWarnings(
  projectDir: string = PROJECT_DIR,
): Promise<UpdateWarning[]> {
  try {
    const { drift } = await collectBuildIdentity(projectDir);
    return drift.codes
      .map((code, i) => ({ code: code as string, message: drift.reasons[i] as string | undefined }))
      .filter((w): w is UpdateWarning => !!w.message);
  } catch (err) {
    // Never fail an update because the diagnosis failed.
    console.warn("[Updater] Could not read build identity before sync:", err);
    return [];
  }
}

/**
 * Take the drift diagnosis BEFORE the first step touches the repository.
 *
 * The warnings used to be collected inside the `restart` step — step 7 of 9 —
 * on the assumption that nothing before it moved the tree. Step 1
 * (`bootstrap_updater` → install.sh `sync_repo_to_update_target`) does exactly
 * that: `fetch`, `reset --hard HEAD`, `checkout`, `reset --hard <upstream>`. By
 * the time step 7 asked, the customer's tree was clean and at the remote head,
 * so the WARN named the POST-sync commit and a whole class of drift reported
 * nothing at all: a tracked-file modification (discarded by step 1) and
 * `checkout-behind-pin` (resolved by step 1) both arrived invisible. A box 71
 * commits behind its own pin completed an update without one word about it
 * (hwtest-round1, 2026-08-24).
 *
 * So the diagnosis is taken here, first, and persisted immediately — the run
 * reboots halfway through and only persisted warnings survive it. The step-7
 * collection stays as a second sample; `warnUpdate` de-duplicates by code, so
 * the FIRST observation — this one, the customer's actual state — is the one
 * that reaches the log.
 */
async function captureDriftBaseline(): Promise<void> {
  for (const w of await collectDriftWarnings()) warnUpdate(w.code, w.message);
  await persistWarnings();
}

/**
 * Delete the orphan `.deployed-sha` marker if this device carries one.
 *
 * Nothing in this repository writes or reads it — it is left over from the
 * pre-3.9 hand-deploy method — but an untracked file in the project root makes
 * `git status --porcelain` non-empty, which the drift engine reads as "the code
 * on disk matches no commit". A QA box therefore raised the About-screen drift
 * banner while its build, checkout and BUILD_ID all agreed, and it cost two
 * rounds of QA a false lead (hwtest-round1, 2026-08-24).
 *
 * It is also in .gitignore now, which stops it faking drift — and stops
 * `git clean -fd` from removing it, since -fd spares ignored paths. So the
 * updater removes it explicitly, after the baseline diagnosis above has already
 * recorded what the box looked like on arrival.
 *
 * Never throws: a device that cannot delete a stale marker still updates.
 */
export async function removeOrphanDeployedSha(projectDir: string = PROJECT_DIR): Promise<boolean> {
  const marker = path.join(projectDir, ".deployed-sha");
  try {
    await rm(marker, { force: true });
    return true;
  } catch (err) {
    console.warn(`[Updater] Could not remove stale .deployed-sha: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Run scripts/verify-build-identity.sh against `projectDir`.
 *
 * Delegating to the script rather than reimplementing the comparison here is
 * the point: CI gates pull requests with the same code path, so the device and
 * the pipeline cannot come to different conclusions about the same build.
 *
 * "skipped" is not "passed" — it means the script was not there to run, which
 * is reported as a warning rather than a failure.
 */
export async function runBuildIdentityCheck(
  projectDir: string = PROJECT_DIR,
): Promise<{ status: "ok" | "skipped"; detail: string } | { status: "failed"; detail: string }> {
  const script = path.join(projectDir, "scripts", "verify-build-identity.sh");
  if (!existsSync(script)) {
    return { status: "skipped", detail: "scripts/verify-build-identity.sh is missing" };
  }
  try {
    const { stdout } = await execFile("/bin/bash", [script, "--project-dir", projectDir], {
      timeout: 60_000,
    });
    return { status: "ok", detail: stdout.trim() };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || "").trim().split("\n").filter(Boolean).pop()
      || "build identity could not be verified";
    return { status: "failed", detail };
  }
}

/**
 * The loud half of the ruling: after the rebuild, the build MUST be the code
 * on disk. Everything before this warns and carries on; this one fails.
 */
async function verifyBuildIdentityAfterUpdate(): Promise<void> {
  const result = await runBuildIdentityCheck();
  if (result.status === "ok") {
    console.log(`[Updater] ${result.detail}`);
    return;
  }
  if (result.status === "skipped") {
    warnUpdate(
      "verify-script-missing",
      `Could not verify the new build's identity: ${result.detail}.`,
    );
    return;
  }
  throw new Error(
    `The device rebooted onto a build that does not match its own source — ${result.detail}`,
  );
}

async function updateClawBoxAndReboot(): Promise<void> {
  // Fix .git ownership — previous root operations (install.sh) may have
  // created root-owned files (e.g. FETCH_HEAD) that block git pull as clawbox.
  await execAsRoot("fix_git_perms", 30_000);

  // Throws UnresolvableUpdateBranchError rather than retargeting a device that
  // cannot say which branch it belongs to; this step is failFast, so the owner
  // gets the message instead of a silent channel change.
  const { local, upstream, source } = await resolveUpdateBranch(PROJECT_DIR);

  console.log(`[Updater] Updating to branch: ${local} (upstream: ${upstream}, resolved from: ${source})`);

  // WARN + AUTO-REPIN, in that order. The WARN is a SECOND sample — the one
  // that carries the diagnosis was taken by captureDriftBaseline() before step
  // 1 moved the tree, and warnUpdate keeps the first observation of each code.
  // Neither step can stop the update.
  for (const w of await collectDriftWarnings()) warnUpdate(w.code, w.message);
  // Only pin what the device can prove about itself — see repinUpdateBranch.
  for (const w of await repinUpdateBranch(local, PROJECT_DIR, source)) warnUpdate(w.code, w.message);
  await persistWarnings();

  // The orphan marker fakes a dirty tree; drop it now that the baseline
  // diagnosis has already recorded the state the box arrived in.
  await removeOrphanDeployedSha(PROJECT_DIR);

  // Hard-sync to upstream. The device is an appliance — the working tree
  // must always match what we ship, period. Local edits made via SSH /
  // partial earlier updates / branch flips are discarded.
  //
  // Order matters:
  //   1. fetch — pull the new refs.
  //   2. reset --hard HEAD — drop any modifications to currently-tracked
  //      files. Without this, `git checkout` aborts with "Your local
  //      changes to the following files would be overwritten" the moment
  //      a tracked file diverges from the target branch's version of
  //      that file. That was the historical update failure mode users
  //      reported on stuck devices.
  //   3. checkout — switch to the target branch, creating it from the
  //      upstream ref if it doesn't yet exist locally (covers fresh
  //      clones that only have the original branch).
  //   4. reset --hard <upstream> — force the branch ref + working tree
  //      to exactly match upstream.
  //   5. clean -fd — drop untracked files (stale build artefacts, scripts
  //      from a partial merge, etc.) so they can't shadow new code. -fd
  //      not -fdx: gitignored dirs (data/, .env, node_modules, .next)
  //      are preserved so we don't nuke user state or force a multi-
  //      minute rebuild.
  const gitOptions = { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 };
  await execGit(PROJECT_DIR, ["fetch", "origin"], gitOptions);
  await execGit(PROJECT_DIR, ["reset", "--hard", "HEAD"], gitOptions);
  try {
    await execGit(PROJECT_DIR, ["checkout", local], gitOptions);
  } catch {
    await execGit(PROJECT_DIR, ["checkout", "-b", local, upstream], gitOptions);
  }
  await execGit(PROJECT_DIR, ["reset", "--hard", upstream], gitOptions);
  await execGit(PROJECT_DIR, ["clean", "-fd"], gitOptions);
  // Record the pre-rebuild build identity in the flag: BUILD_ID changes on
  // every successful `next build`, so the continuation can demand positive
  // evidence the rebuild actually happened. Without it, a power cycle in the
  // few seconds between unit failure and our watcher noticing would reset the
  // unit's systemd state and let the continuation fake a completed update.
  await set("update_needs_continuation", (await readBuildId()) || "no-previous-build");
  await startRootServiceFireAndForget(REBUILD_ROOT_STEP);
  await waitForRebuildToTakeOver();
}

// First-time `npm install -g openclaw` on cold Jetson caches routinely runs
// 2-3 min; shared across both UPDATE_STEPS and OPENCLAW_UPDATE_STEPS so the
// two flows can't drift apart.
const OPENCLAW_INSTALL_TIMEOUT_MS = 300_000;
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || "18789");
const GATEWAY_HEALTH_WAIT_MS = Number(process.env.GATEWAY_HEALTH_WAIT_MS || "30000");
const GATEWAY_RECOVERY_WAIT_MS = Number(process.env.GATEWAY_RECOVERY_WAIT_MS || "45000");
const GATEWAY_WAIT_INTERVAL_MS = Number(process.env.GATEWAY_WAIT_INTERVAL_MS || "1500");
const ROOT_STEP_SETTLE_TIMEOUT_MS = Number(process.env.ROOT_STEP_SETTLE_TIMEOUT_MS || "7200000");
const LEGACY_GATEWAY_BLOCKER_RE =
  /installs\.json|conflicting plugin install metadata|carl_pir|belongs to agent piper/i;
const CODEX_CAPABILITY_CONSENT_RE =
  /Plugin\s+["']?codex["']?\s+requires capability consent/i;
const CURRENT_GATEWAY_PRE_START = path.join(PROJECT_DIR, "scripts", "gateway-pre-start.sh");
const GATEWAY_QUIESCED_ROOT_STEPS = new Set(["openclaw_install", "post_update"]);

// A serialized root step deliberately leaves the gateway stopped. Its next
// health check must repair/start it instead of accepting a stale listener or
// spending the normal readiness window waiting for a service we stopped.
let gatewayNeedsRecovery = false;

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGateway(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(GATEWAY_PORT, "127.0.0.1", 1_000)) return true;
    await delay(GATEWAY_WAIT_INTERVAL_MS);
  }
  return false;
}

async function runOpenclawDoctorFix(): Promise<void> {
  // No openclaw binary on the Hermes edition — nothing to doctor.
  if (openclawIsAbsent()) return;
  try {
    await execFile(OPENCLAW_BIN, ["doctor", "--fix", "--yes", "--non-interactive"], {
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    // Doctor can still repair some state before exiting non-zero. Continue
    // into a restart + positive gateway probe rather than trusting exit code.
  }
}

async function setGatewayMaintenanceMask(masked: boolean): Promise<void> {
  const options = { timeout: 30_000, maxBuffer: 1024 * 1024 };
  if (masked) {
    await execFile(
      "/usr/bin/sudo",
      ["-n", "/usr/bin/systemctl", "--runtime", "mask", "clawbox-gateway.service"],
      options,
    );
    return;
  }
  await execFile(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/systemctl", "--runtime", "unmask", "clawbox-gateway.service"],
    options,
  );
}

async function stopGatewayForMaintenance(): Promise<void> {
  await execFile(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/systemctl", "stop", "clawbox-gateway.service"],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
}

async function removeGatewayMaintenanceMask(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await setGatewayMaintenanceMask(false);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 3) await delay(250);
    }
  }
  throw lastError;
}

/**
 * Keep systemd from starting the gateway while an OpenClaw writer is active.
 * Mask comes before stop so a root update step cannot race the stop with its
 * own restart. The runtime mask is always removed, including failure paths.
 */
async function withGatewayQuiesced<T>(operation: () => Promise<T>): Promise<T> {
  if (gatewayIsAbsent()) return operation();

  let masked = false;
  let outcome!: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    await setGatewayMaintenanceMask(true);
    masked = true;
    await stopGatewayForMaintenance();
    outcome = { ok: true, value: await operation() };
  } catch (err) {
    outcome = { ok: false, error: err };
  }

  let cleanupFailed = false;
  let cleanupError: unknown;
  if (masked) {
    try {
      await removeGatewayMaintenanceMask();
    } catch (unmaskErr) {
      cleanupFailed = true;
      cleanupError = unmaskErr;
      console.error(
        "[Updater] Failed to remove the gateway maintenance mask:",
        unmaskErr instanceof Error ? unmaskErr.message : unmaskErr,
      );
    }
  }

  // Preserve the operation's real error when both failed. If cleanup is the
  // only failure, surface it: success would leave the gateway masked to reboot.
  if (!outcome.ok) throw outcome.error;
  if (cleanupFailed) throw cleanupError;
  return outcome.value;
}

/** Run the newly checked-out pre-start repair while the gateway is stopped. */
async function runCurrentGatewayPreStart(): Promise<void> {
  if (!existsSync(CURRENT_GATEWAY_PRE_START)) return;
  const home = process.env.CLAWBOX_HOME_DIR || process.env.HOME || "/home/clawbox";
  const openclawHome = process.env.CLAWBOX_OPENCLAW_HOME
    || process.env.OPENCLAW_HOME
    || path.join(home, ".openclaw");
  await execFile("/bin/bash", [CURRENT_GATEWAY_PRE_START], {
    // Match the unit's 600s TimeoutStartSec with a little process overhead.
    // Killing this halfway through a plugin migration recreates the lock race
    // this maintenance path exists to avoid.
    timeout: 650_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: home,
      CLAWBOX_HOME_DIR: home,
      CLAWBOX_ROOT: PROJECT_DIR,
      OPENCLAW_HOME: openclawHome,
    },
  });
}

/** Accept only the ClawBox-managed plugin named by a concrete gateway error. */
async function repairCodexCapabilityConsent(journal: string): Promise<void> {
  if (!CODEX_CAPABILITY_CONSENT_RE.test(journal)) return;
  if (!(await codexCapabilityRepairIsAllowed())) return;
  let target = OPENCLAW_VERSION_FALLBACK;
  try {
    target = (await readFile(OPENCLAW_TARGET_FILE, "utf-8")).trim().split(/\s+/)[0] || target;
  } catch {
    // The compiled fallback is the same pin used by the installer.
  }
  try {
    // A migrated v1 install can leave only the managed-project declaration,
    // without node_modules. `enable` then says "Plugin not found"; a pinned
    // force-install repairs that partial project and records consent in one
    // idempotent operation. OpenClaw state leases live for five minutes after
    // a killed startup, so this budget must outlast that bounded stale lease.
    await execFile(
      OPENCLAW_BIN,
      [
        "plugins",
        "install",
        `@openclaw/codex@${target}`,
        "--force",
        "--accept-capabilities",
      ],
      { timeout: 360_000, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (err) {
    // Best effort: the clean restart and positive port probe below decide the
    // result. This must not replace a preceding pre-start failure either.
    console.warn(
      "[Updater] Codex capability repair did not complete:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Respect an owner-disabled unused Codex plugin even if old logs mention it. */
async function codexCapabilityRepairIsAllowed(): Promise<boolean> {
  const home = process.env.CLAWBOX_HOME_DIR || process.env.HOME || "/home/clawbox";
  const openclawHome = process.env.CLAWBOX_OPENCLAW_HOME
    || process.env.OPENCLAW_HOME
    || path.join(home, ".openclaw");
  const configPath = process.env.OPENCLAW_CONFIG || path.join(openclawHome, "openclaw.json");
  try {
    const cfg = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
    const plugins = cfg.plugins && typeof cfg.plugins === "object"
      ? cfg.plugins as Record<string, unknown>
      : {};
    const entries = plugins.entries && typeof plugins.entries === "object"
      ? plugins.entries as Record<string, unknown>
      : {};
    const codex = entries.codex && typeof entries.codex === "object"
      ? entries.codex as Record<string, unknown>
      : null;
    if (codex?.enabled !== false) return true;

    const agents = cfg.agents && typeof cfg.agents === "object"
      ? cfg.agents as Record<string, unknown>
      : {};
    const defaults = agents.defaults && typeof agents.defaults === "object"
      ? agents.defaults as Record<string, unknown>
      : {};
    const model = defaults.model && typeof defaults.model === "object"
      ? defaults.model as Record<string, unknown>
      : {};
    const modelRefs = [model.primary, ...(Array.isArray(model.fallbacks) ? model.fallbacks : [])];
    if (modelRefs.some((ref) =>
      typeof ref === "string" && /^(?:codex|openai-codex)\//i.test(ref.trim()),
    )) return true;

    const models = defaults.models && typeof defaults.models === "object"
      ? defaults.models as Record<string, unknown>
      : {};
    if (Object.values(models).some((settings) => {
      if (!settings || typeof settings !== "object") return false;
      const runtime = (settings as Record<string, unknown>).agentRuntime;
      return !!runtime && typeof runtime === "object"
        && String((runtime as Record<string, unknown>).id || "").toLowerCase() === "codex";
    })) return true;

    const auth = cfg.auth && typeof cfg.auth === "object"
      ? cfg.auth as Record<string, unknown>
      : {};
    const profiles = auth.profiles && typeof auth.profiles === "object"
      ? auth.profiles as Record<string, unknown>
      : {};
    return Object.entries(profiles).some(([id, profile]) =>
      /^(?:codex|openai-codex):/i.test(id)
        || (!!profile && typeof profile === "object"
          && /^(?:codex|openai-codex)$/i.test(
            String((profile as Record<string, unknown>).provider || ""),
          )),
    );
  } catch {
    // Missing/malformed config has no explicit opt-out. The concrete current-
    // boot gateway refusal remains the authority in that recovery case.
    return true;
  }
}

async function readGatewayJournalTail(): Promise<string> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/journalctl",
      ["-u", "clawbox-gateway.service", "-b", "-n", "160", "--no-pager"],
      { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return "";
  }
}

function getGatewayFailureDetail(logText: string): string | null {
  const lines = logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const pattern of [CODEX_CAPABILITY_CONSENT_RE, /SQLite transaction lock wait failed/i]) {
    const match = [...lines].reverse().find((line) => pattern.test(line));
    if (match) return match;
  }
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

async function quarantineLegacyOpenclawState(): Promise<void> {
  const script = `
set -u
CLAWBOX_HOME="/home/clawbox"
TS="$(date +%Y%m%d-%H%M%S)"
QDIR="$CLAWBOX_HOME/openclaw-legacy-quarantine-$TS"
mkdir -p "$QDIR"
/usr/bin/sudo /usr/bin/systemctl stop clawbox-gateway.service || true
mv -v "$CLAWBOX_HOME/.openclaw/plugins/installs.json"* "$QDIR/" 2>/dev/null || true
mv -v "$CLAWBOX_HOME/.openclaw/memory/carl_pir.sqlite"* "$QDIR/" 2>/dev/null || true
mv -v "$CLAWBOX_HOME/.openclaw/agents/carl_pir/agent/openclaw-agent.sqlite"* "$QDIR/" 2>/dev/null || true
`;
  await execFile("/bin/bash", ["-lc", script], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function ensureGatewayHealthy(options: { restartFirst?: boolean } = {}): Promise<void> {
  const recoverImmediately = options.restartFirst || gatewayNeedsRecovery;
  gatewayNeedsRecovery = false;
  if (!recoverImmediately && await waitForGateway(GATEWAY_HEALTH_WAIT_MS)) return;

  // post_update and the standalone OpenClaw updater both run several config,
  // doctor and plugin commands. Do all remaining repair against a stopped,
  // masked gateway so the v2 SQLite store has one writer. A pre-start timeout
  // is fatal here: restarting after killing a migration midway is unsafe.
  await withGatewayQuiesced(async () => {
    const journal = await readGatewayJournalTail();
    try {
      await runCurrentGatewayPreStart();
    } catch (err) {
      // If an earlier pre-start migration fails, still record the narrowly
      // scoped consent named by the existing journal. Do not restart after a
      // partial pre-start; propagate its failure once the repair is recorded.
      await repairCodexCapabilityConsent(journal);
      throw err;
    }
    await repairCodexCapabilityConsent(journal);
    await runOpenclawDoctorFix();
  });
  await restartGateway();
  if (await waitForGateway(GATEWAY_RECOVERY_WAIT_MS)) return;

  const beforeRecoveryLog = await readGatewayJournalTail();
  if (!LEGACY_GATEWAY_BLOCKER_RE.test(beforeRecoveryLog)) {
    const lastLog = getGatewayFailureDetail(beforeRecoveryLog);
    throw new Error(
      lastLog
        ? `OpenClaw gateway is not listening on port ${GATEWAY_PORT}: ${lastLog}`
        : `OpenClaw gateway is not listening on port ${GATEWAY_PORT}`,
    );
  }

  await withGatewayQuiesced(async () => {
    await quarantineLegacyOpenclawState();
    await runOpenclawDoctorFix();
  });
  await restartGateway();
  if (await waitForGateway(GATEWAY_RECOVERY_WAIT_MS)) return;

  const afterRecoveryLog = await readGatewayJournalTail();
  const lastLog = getGatewayFailureDetail(afterRecoveryLog);
  throw new Error(
    lastLog
      ? `OpenClaw gateway still offline after legacy state recovery: ${lastLog}`
      : "OpenClaw gateway still offline after legacy state recovery",
  );
}

const UPDATE_STEPS: UpdateStepDef[] = [
  {
    id: "bootstrap_updater",
    label: "Refreshing updater scripts",
    timeoutMs: 120_000,
    requiresRoot: true,
    failFast: true,
  },
  {
    id: "apt_update",
    label: "Updating system packages",
    timeoutMs: 120_000,
    requiresRoot: true,
  },
  {
    id: "nvidia_jetpack",
    label: "Installing NVIDIA JetPack",
    timeoutMs: 600_000,
    requiresRoot: true,
  },
  {
    id: "performance_mode",
    label: "Enabling max performance mode",
    timeoutMs: 60_000,
    requiresRoot: true,
  },
  {
    id: "chromium_install",
    label: "Installing Chromium",
    timeoutMs: 300_000,
    requiresRoot: true,
  },
  {
    id: "vnc_install",
    label: "Installing VNC (Remote Desktop)",
    timeoutMs: 300_000,
    requiresRoot: true,
  },
  {
    id: "openclaw_install",
    label: "Updating OpenClaw",
    timeoutMs: OPENCLAW_INSTALL_TIMEOUT_MS,
    requiresRoot: true,
    // Keyed on the binary, not the edition: there is nothing to install where
    // no `openclaw` ships. (Hermes today; the two predicates can diverge.)
    applies: () => !openclawIsAbsent(),
  },
  {
    id: "openclaw_patch",
    label: "Patching OpenClaw gateway",
    timeoutMs: 30_000,
    requiresRoot: true,
    applies: () => !openclawIsAbsent(),
  },
  {
    id: "gateway_setup",
    label: "Configuring gateway service",
    timeoutMs: 30_000,
    requiresRoot: true,
    // Keyed on the unit, not the binary: clawbox-gateway.service is removed
    // and masked by step_edition_gateway_state, so there is none to configure.
    applies: () => !gatewayIsAbsent(),
  },
  {
    id: RESTART_STEP_ID,
    label: "Updating ClawBox and restarting",
    // timeoutMs is unenforced for customRun steps; the real budget lives in
    // REBUILD_TAKEOVER_TIMEOUT_MS inside waitForRebuildToTakeOver — same
    // constant, so it can't drift.
    timeoutMs: REBUILD_TAKEOVER_TIMEOUT_MS,
    customRun: updateClawBoxAndReboot,
    // If the rebuild failed, the new install.sh never deployed — running
    // post_update fixups from a half-applied state helps nobody. Stop here
    // and surface the error.
    failFast: true,
  },
  {
    // Runs after reboot via checkContinuation — picks up dispatcher scripts,
    // sysctls, and other root fixups that landed in the new install.sh.
    // 5 min, not 60s: on a freshly-installed device the fixups run on cold
    // caches (clawkeep pip force-reinstall, vnc apt work) and routinely
    // outlive a 1-minute budget — which painted a false-red step on an
    // otherwise successful update. The fixups can legitimately wait even
    // longer (wait_for_apt alone allows 900s), so an overrun past these 5
    // minutes is advisory once the root unit has settled; everything inside
    // it is non-fatal by design.
    // 15 min, raised from 5. post_update now also REPAIRS a device that a
    // pre-fix factory reset left without its Hermes agent install or its
    // offline Gemma GGUF (step_hermes_install + step_llamacpp_model at the end
    // of step_post_update). On a healthy box both are sub-second no-ops and
    // nothing about the timing changes; on a broken one they are a git clone +
    // venv build (~90s measured) and a 3.2 GB model download, on top of the
    // fixups that already routinely outlive a minute.
    //
    // The runner now keeps the gateway quiesced and waits for an overrun unit
    // to settle before moving on. This budget still covers the healthy repair
    // path so the UI does not sit beyond its advertised estimate.
    //
    // Still well inside the unit's own ceiling (TimeoutStartSec=7200 in
    // config/clawbox-root-update@.service), and advisoryOnOverrun stays as the
    // backstop for the genuinely pathological case.
    id: "post_update",
    label: "Applying system fixups",
    timeoutMs: 900_000,
    requiresRoot: true,
    advisoryOnOverrun: true,
  },
  {
    // Re-provision the Hermes side: dashboard + proxy units, dashboard auth,
    // shared identity, MCP registration, gateway removal.
    //
    // Ordering is load-bearing: AFTER post_update, so step_systemd_services has
    // already refreshed the unit files this reinstalls and restarts, and after
    // the rebuild, so it is the NEW install.sh being dispatched.
    id: "hermes_edition",
    label: "Provisioning Hermes edition",
    timeoutMs: 300_000,
    requiresRoot: true,
    applies: () => hasHermesHarness(),
  },
  {
    id: "gateway_verify",
    label: "Verifying gateway health",
    timeoutMs: 90_000,
    customRun: () => ensureGatewayHealthy(),
    failFast: true,
    // The gateway is absent by design on this SKU — port 18789 is closed and
    // the unit is masked — so this step could only ever throw. It also
    // directly contradicted the step before it: post_update's smoke test
    // fails the install if anything IS listening on 18789.
    applies: () => !gatewayIsAbsent(),
  },
  {
    // The only hard gate this feature adds. Everything before it warns and
    // carries on; a device that has finished rebuilding and STILL does not
    // serve its own source has a problem no warning covers — that is the
    // state in which fixes look shipped and are not.
    //
    // Last, and after the reboot: it can only be answered once the new build
    // is the one on disk.
    id: "verify_build_identity",
    label: "Verifying the new build matches the code",
    timeoutMs: 60_000,
    customRun: verifyBuildIdentityAfterUpdate,
  },
];

/**
 * Evaluated per run, never memoized: the edition is read from a root-owned
 * file that post_update itself can re-bake (step_edition_lock migrates a
 * pre-3.x box onto /etc/clawbox/edition.env), so a list frozen at module load
 * could describe the wrong SKU.
 *
 * Callers must resolve this ONCE and feed the same array to both `state.steps`
 * and the runner — `runUpdate` addresses `state.steps[i]` by position, so two
 * independently-filtered lists would silently label every step after the first
 * omission with its neighbour's name.
 */
function applicableSteps(): UpdateStepDef[] {
  return UPDATE_STEPS.filter((step) => !step.applies || step.applies());
}

/**
 * Runs a root-privileged step via the clawbox-root-update@ systemd template
 * service. The main service runs as clawbox with NoNewPrivileges=true, so
 * privilege escalation is handled by systemd: the template service runs as
 * root, and polkit authorizes the clawbox user to start it.
 */
async function execAsRoot(stepId: string, timeoutMs: number): Promise<void> {
  const serviceName = `clawbox-root-update@${stepId}.service`;
  await execFile("/usr/bin/systemctl", ["reset-failed", serviceName], {
    timeout: 10_000,
  }).catch(() => {});
  const startedAt = Date.now();
  try {
    await execFile("/usr/bin/systemctl", ["start", serviceName], {
      timeout: timeoutMs + 30_000,
    });
  } catch (err) {
    // When OUR timeout kills the blocking `systemctl start`, the unit itself
    // usually keeps running (it has its own much larger TimeoutStartSec) and
    // often finishes fine in the background. Report that as a budget overrun
    // — otherwise the caller dresses up the unit's most recent (often
    // successful) log line as the failure, which is how a healthy update
    // once showed "failed: Linkdown routing sysctl installed".
    if ((err as { killed?: boolean }).killed) {
      const waitedS = Math.round((Date.now() - startedAt) / 1000);
      throw new BudgetOverrunError(
        `${stepId} was still running after ${waitedS}s — gave up waiting (it may finish on its own in the background)`,
      );
    }
    throw err;
  }
}

async function waitForRootStepToSettle(stepId: string): Promise<void> {
  const serviceName = `clawbox-root-update@${stepId}.service`;
  const deadline = Date.now() + ROOT_STEP_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFile(
        "/usr/bin/systemctl",
        ["show", serviceName, "-p", "ActiveState", "--value"],
        { timeout: 10_000 },
      );
      if (/^(?:inactive|failed)$/.test(stdout.trim())) return;
    } catch {
      // A transient systemd query failure must not unmask a still-running
      // writer. Keep the gateway quiesced and retry within the unit ceiling.
    }
    await delay(2_000);
  }
  throw new Error(`${stepId} did not settle before its root service timeout`);
}

/** Run root steps that mutate OpenClaw without a live gateway/SQLite writer. */
async function execAsRootWithGatewayQuiesced(stepId: string, timeoutMs: number): Promise<void> {
  await withGatewayQuiesced(async () => {
    gatewayNeedsRecovery = true;
    try {
      await execAsRoot(stepId, timeoutMs);
    } catch (err) {
      if (!(err instanceof BudgetOverrunError)) throw err;

      // The blocking systemctl client timed out, not the root unit. Keep the
      // runtime mask in place until the unit truly exits, otherwise the
      // advisory-overrun path would launch gateway_verify against it.
      await waitForRootStepToSettle(stepId);
      if (rootStepResultFailed(await getRootStepResult(stepId))) {
        throw new Error(
          (await readRootStepFailure(stepId)) ?? `${stepId} failed after exceeding its wait budget`,
        );
      }
      throw err;
    }
  });
}

let cachedTargetVersion: string | null = null;
let targetVersionCacheTime = 0;
const TARGET_VERSION_CACHE_TTL = 60_000; // Cache failures for 60s to avoid repeated git ls-remote

const OPENCLAW_BIN = findOpenclawBin();
const OPENCLAW_PKG = "/home/clawbox/.npm-global/lib/node_modules/openclaw/package.json";
const CLAWBOX_PKG = path.join(PROJECT_DIR, "package.json");

interface ComponentVersionInfo {
  current: string | null;
  target: string | null;
  updateAvailable?: boolean;
}

interface VersionInfo {
  clawbox: ComponentVersionInfo & { current: string };
  openclaw: ComponentVersionInfo;
  /**
   * The Hermes agent, reported ONLY on the SKUs that ship it (`hermes` and
   * `dual`). Absent — not null — on `openclaw`, so the field's presence is
   * itself the "this device has a Hermes to talk about" signal and the UI
   * never has to guess.
   */
  hermes?: ComponentVersionInfo;
  /**
   * Which harnesses this device actually has. The About screen needs it to
   * decide which version rows are meaningful: a Hermes box has no OpenClaw
   * at all, so an "OpenClaw: not installed" row there is noise, not news.
   *
   * Additive: an older client that ignores this field renders exactly as
   * before.
   */
  edition: EditionName;
}

let cachedVersionInfo: VersionInfo | null = null;
let versionInfoCacheTime = 0;

export function invalidateVersionCache(): void {
  cachedVersionInfo = null;
  versionInfoCacheTime = 0;
  // Also drop the git ls-remote / npm view cache so a "force" refresh
  // actually re-fetches origin tags and the npm registry, not just the
  // memoized result of the last lookup.
  cachedTargetVersion = null;
  targetVersionCacheTime = 0;
}

/**
 * Compare two semver tags ("v2.2.3" vs "v2.2.2"). Returns negative if a<b,
 * positive if a>b, 0 if equal. Non-semver inputs sort as 0.
 *
 * Splits on both "." and "-" so a re-release suffix like "2026.5.3-1" sorts
 * *after* "2026.5.3" — without this, "3-1" parses as NaN→0 and the newer
 * release reads as older.
 */
function compareSemverTags(a: string, b: string): number {
  const parse = (t: string) => t.replace(/^v/, "").split(/[.-]/).map((n) => Number(n) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Read the `version` field from a package.json, or null if unreadable. */
async function readPkgVersion(pkgPath: string): Promise<string | null> {
  try {
    const raw = await readFile(pkgPath, "utf-8");
    return (JSON.parse(raw) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The installed ClawBox version, read from package.json at runtime.
 *
 * Deliberately NOT `NEXT_PUBLIC_APP_VERSION`: that's baked at build time from
 * `git describe`, so when a device syncs new code + package.json without a
 * clean Next rebuild, the baked value goes stale — the device then mis-reports
 * its own version and keeps offering an update it already installed. package.json
 * is rewritten by the git sync, so it always reflects the running release.
 * Falls back to the build-time value, then "unknown", if the file is unreadable.
 */
async function readClawboxVersion(): Promise<string> {
  const v = await readPkgVersion(CLAWBOX_PKG);
  if (v) return v.startsWith("v") ? v : `v${v}`;
  return process.env.NEXT_PUBLIC_APP_VERSION || "unknown";
}

/**
 * The installed Hermes agent version, or null if it cannot be determined.
 *
 * The caller MUST gate this on the edition: `openclaw` boxes have no Hermes
 * binary, and spawning one there would be a guaranteed ENOENT on every
 * version read. It is only ever reached from getVersionInfo(), whose whole
 * result is cached for TARGET_VERSION_CACHE_TTL, so the About screen polling
 * for versions cannot turn into a subprocess storm.
 *
 * Never throws: a device mid-upgrade (the Hermes installer briefly replaces
 * the venv the shim execs) should report an unknown version for a few
 * seconds, not fail the whole version endpoint that ClawBox's own update
 * tile also depends on.
 */
async function readHermesVersion(): Promise<string | null> {
  try {
    const { code, stdout } = await runHermesCli(["--version"], { timeoutMs: 10_000 });
    if (code !== 0) return null;
    return parseHermesVersion(stdout);
  } catch {
    return null;
  }
}

async function getPinnedBranchTarget(projectDir: string): Promise<{
  branch: string;
  currentSha: string;
  targetSha: string;
} | null> {
  let branch: string;
  try {
    branch = (await readFile(path.join(projectDir, ".update-branch"), "utf-8")).trim();
  } catch {
    return null;
  }
  if (!branch || !isSafeBranch(branch)) return null;

  try {
    await execGit(projectDir, ["fetch", "--quiet", "origin", branch], { timeout: 20_000 }).catch(() => {});
    const [{ stdout: currentOut }, { stdout: targetOut }] = await Promise.all([
      execGit(projectDir, ["rev-parse", "HEAD"], { timeout: 10_000 }),
      execGit(projectDir, ["rev-parse", `origin/${branch}`], { timeout: 10_000 }),
    ]);
    const currentSha = currentOut.trim();
    const targetSha = targetOut.trim();
    if (!currentSha || !targetSha || currentSha === targetSha) return null;
    return { branch, currentSha, targetSha };
  } catch {
    return null;
  }
}

export async function getVersionInfo(): Promise<VersionInfo> {
  if (cachedVersionInfo && Date.now() - versionInfoCacheTime < TARGET_VERSION_CACHE_TTL) {
    return cachedVersionInfo;
  }

  const edition = readEdition();
  const hasHermes = hasHermesHarness();
  const [targetVersion, openclawCurrent, openclawTarget, rawVersion, hermesCurrent] = await Promise.all([
    getTargetVersion(),
    // The Hermes edition ships no openclaw binary, so skip the spawn and read
    // the version from the installed package.json (absent there too → null,
    // which is correct: there is no OpenClaw version to report on Hermes).
    openclawIsAbsent()
      ? readPkgVersion(OPENCLAW_PKG)
      : execFile(OPENCLAW_BIN, ["--version"], { timeout: 10_000 })
          .then(({ stdout }) => stdout.trim() || null)
          // Fallback: read version from the installed package.json
          .catch(() => readPkgVersion(OPENCLAW_PKG)),
    // Read the ClawBox-pinned target — NOT npm's latest. The pin file is
    // the canonical source for which OpenClaw the fleet should converge on.
    // Env override (`OPENCLAW_PIN_VERSION`) mirrors install.sh for QA flows.
    (async (): Promise<string | null> => {
      const envPin = process.env.OPENCLAW_PIN_VERSION?.trim();
      if (envPin) return envPin;
      try {
        const raw = await readFile(OPENCLAW_TARGET_FILE, "utf-8");
        return raw.trim().split(/\s+/)[0] || OPENCLAW_VERSION_FALLBACK;
      } catch {
        return OPENCLAW_VERSION_FALLBACK;
      }
    })(),
    readClawboxVersion(),
    // Gated on the edition, not on a try/catch: the `openclaw` SKU has no
    // hermes binary, so this must never spawn there.
    hasHermes ? readHermesVersion() : Promise.resolve(null),
  ]);
  const pinnedBranchTarget = await getPinnedBranchTarget(PROJECT_DIR);

  // rawVersion is the installed release (e.g. "v3.1.0"); extract the base tag
  // so it compares cleanly against the target tag.
  const baseTag = rawVersion.match(/^(v\d+\.\d+\.\d+)/)?.[1] ?? rawVersion;

  // Only report a target if it's strictly newer than the device's base tag.
  // (A dev box can sit on a local tag ahead of origin's latest release.)
  const taggedClawboxTarget = targetVersion && compareSemverTags(targetVersion, baseTag) > 0
    ? targetVersion
    : null;
  const clawboxTarget = pinnedBranchTarget
    ? `${pinnedBranchTarget.branch}@${pinnedBranchTarget.targetSha.slice(0, 7)}`
    : taggedClawboxTarget;

  cachedVersionInfo = {
    clawbox: {
      current: rawVersion,
      target: clawboxTarget,
      updateAvailable: !!clawboxTarget,
    },
    openclaw: {
      current: openclawCurrent,
      target: openclawTarget && openclawCurrent && openclawCurrent.includes(openclawTarget) ? null : openclawTarget,
      updateAvailable: !!(openclawTarget && openclawCurrent && !openclawCurrent.includes(openclawTarget)),
    },
    // Hermes ships from its own upstream installer, not from a ClawBox pin, so
    // there is no target to converge on and nothing to offer an update for —
    // only the installed version is reportable.
    ...(hasHermes
      ? { hermes: { current: hermesCurrent, target: null, updateAvailable: false } }
      : {}),
    edition,
  };
  versionInfoCacheTime = Date.now();
  return cachedVersionInfo;
}

export async function getTargetVersion(): Promise<string | null> {
  if (Date.now() - targetVersionCacheTime < TARGET_VERSION_CACHE_TTL) return cachedTargetVersion;
  try {
    await execGit(
      PROJECT_DIR,
      ["fetch", "--quiet", "--tags", "origin"],
      { timeout: 20_000 },
    ).catch(() => {});
    const { stdout } = await execGit(
      PROJECT_DIR,
      ["ls-remote", "--tags", "--refs", "origin"],
      { timeout: 10_000 },
    );
    const tags = stdout
      .trim()
      .split("\n")
      .map((line) => line.match(/refs\/tags\/(v.+)$/)?.[1])
      .filter((t): t is string => !!t);
    const semverTags = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
    if (semverTags.length === 0) {
      cachedTargetVersion = null;
      targetVersionCacheTime = Date.now();
      return null;
    }
    semverTags.sort(compareSemverTags);
    // ClawBox is an appliance: the updater hard-syncs to the configured
    // upstream release branch before rebuilding. Do not require the current
    // device HEAD to be an ancestor of the latest tag; factory-reset or
    // branch-pinned boxes can legitimately sit on a sibling/ref-history path,
    // and the old ancestry guard made those devices show "Latest: -" and
    // "You're up to date" while a newer release was published.
    cachedTargetVersion = semverTags[semverTags.length - 1];
    targetVersionCacheTime = Date.now();
    return cachedTargetVersion;
  } catch {
    cachedTargetVersion = null;
    targetVersionCacheTime = Date.now();
    return null;
  }
}

function createStepStates(steps: UpdateStepDef[]): StepState[] {
  return steps.map((s) => ({ id: s.id, label: s.label, status: "pending" as const }));
}

function createInitialState(steps: UpdateStepDef[]): UpdateState {
  return {
    phase: "idle",
    steps: createStepStates(steps),
    currentStepIndex: -1,
    warnings: [],
  };
}

let state: UpdateState = createInitialState(applicableSteps());
let running = false;

export function getUpdateState(): UpdateState {
  return {
    ...state,
    steps: state.steps.map((s) => ({ ...s })),
    warnings: (state.warnings ?? []).map((w) => ({ ...w })),
  };
}

export function resetUpdateState(): void {
  state = createInitialState(applicableSteps());
  running = false;
}

export async function isUpdateCompleted(): Promise<boolean> {
  return !!(await get("update_completed"));
}

interface RunOptions {
  /** Persist `update_completed` after a successful full run. */
  markCompleted: boolean;
}

/**
 * Launch runUpdate in the background with shared error handling.
 * Used by startUpdate (fresh run), checkContinuation (post-reboot), and
 * startOpenclawUpdate (scoped run with a different step list).
 */
function launchUpdate(steps: UpdateStepDef[], startFrom: number, options: RunOptions): void {
  runUpdate(steps, startFrom, options)
    .catch((err) => {
      console.error("[Updater] Unexpected error:", err);
      state.phase = "failed";
    })
    .finally(() => {
      running = false;
    });
}

/**
 * Check if a post-restart continuation is needed and trigger it.
 * Called from the status route on first poll after restart.
 */
export async function checkContinuation(): Promise<boolean> {
  if (running) return false;
  const needsContinuation = await get("update_needs_continuation");
  if (!needsContinuation) return false;

  await set("update_needs_continuation", undefined);

  // Resolve the list ONCE and reuse it for the state, the resume index and the
  // runner. The edition is stable across the reboot (post_update re-bakes the
  // same value), so this matches the list the pre-restart half ran.
  const steps = applicableSteps();
  const restartIndex = steps.findIndex((s) => s.id === RESTART_STEP_ID);
  const startFrom = restartIndex + 1;

  // The flag only proves the rebuild unit was STARTED, not that it rebuilt
  // and restarted anything. Resuming blindly would stamp "Update complete"
  // on a box still running its old build. Demand evidence the rebuild
  // happened: the unit must not sit in `failed`, and the on-disk BUILD_ID
  // must differ from the one recorded before the rebuild (systemd unit state
  // resets across reboots, so the Result check alone can be erased by a
  // power cycle; the BUILD_ID can't). Legacy boolean flags (written by the
  // previous updater version) carry no build identity — for those only the
  // unit check applies.
  const unitFailed = rootStepResultFailed(await getRootStepResult(REBUILD_ROOT_STEP));
  const recordedBuildId = typeof needsContinuation === "string" ? needsContinuation : null;
  const buildUnchanged = recordedBuildId !== null && recordedBuildId === (await readBuildId());
  if (unitFailed || buildUnchanged) {
    const message = unitFailed
      ? (await readRootStepFailure(REBUILD_ROOT_STEP)) ?? "Rebuild failed before the restart"
      : "The device restarted without producing a new build — see clawbox-root-update@rebuild_reboot logs";
    state = createInitialState(steps);
    state.warnings = await restoreWarnings();
    state.phase = "failed";
    for (let i = 0; i < restartIndex; i++) {
      state.steps[i].status = "completed";
    }
    state.steps[restartIndex].status = "failed";
    state.steps[restartIndex].error = message;
    state.error = message;
    return false;
  }

  running = true;
  state = createInitialState(steps);
  // The drift warnings were raised before the rebuild, one reboot ago. Carry
  // them into the second half of the run so the owner still sees why their
  // box was repinned.
  state.warnings = await restoreWarnings();
  state.phase = "running";
  for (let i = 0; i <= restartIndex; i++) {
    state.steps[i].status = "completed";
  }
  state.currentStepIndex = startFrom;

  launchUpdate(steps, startFrom, { markCompleted: true });
  return true;
}

export function startUpdate(): { started: boolean; error?: string } {
  if (running) {
    return { started: false, error: "Update already in progress" };
  }

  running = true;
  const steps = applicableSteps();
  state = createInitialState(steps);
  state.phase = "running";
  state.currentStepIndex = 0;

  launchUpdate(steps, 0, { markCompleted: true });
  return { started: true };
}

// Scoped update path: re-installs OpenClaw + re-applies the gateway patch
// and bounces the gateway, without touching ClawBox itself. Reuses the
// same global state machine so the existing UpdateOverlay UI renders it.
const OPENCLAW_UPDATE_STEPS: UpdateStepDef[] = [
  {
    id: "openclaw_install",
    label: "Updating OpenClaw",
    timeoutMs: OPENCLAW_INSTALL_TIMEOUT_MS,
    requiresRoot: true,
  },
  {
    id: "openclaw_patch",
    label: "Patching OpenClaw gateway",
    timeoutMs: 30_000,
    requiresRoot: true,
  },
  {
    id: "gateway_restart",
    label: "Restarting OpenClaw gateway",
    timeoutMs: 30_000,
    customRun: () => ensureGatewayHealthy({ restartFirst: true }),
  },
];

export function startOpenclawUpdate(): { started: boolean; error?: string } {
  if (running) {
    return { started: false, error: "Update already in progress" };
  }
  // Every step in this list is OpenClaw's, so there is no filtered version of
  // it worth running — the whole flow is inapplicable. Refuse honestly instead
  // of no-opping the two install steps and then failing on a gateway this SKU
  // does not have. The UI never offers this on Hermes (getVersionInfo reports
  // no OpenClaw update), but the endpoint is reachable regardless.
  if (openclawIsAbsent()) {
    return { started: false, error: "This edition does not ship OpenClaw." };
  }

  running = true;
  state = {
    phase: "running",
    steps: createStepStates(OPENCLAW_UPDATE_STEPS),
    currentStepIndex: 0,
  };

  launchUpdate(OPENCLAW_UPDATE_STEPS, 0, { markCompleted: false });
  return { started: true };
}

async function checkInternet(): Promise<boolean> {
  for (const target of PING_TARGETS) {
    try {
      await execFile("ping", ["-c", "1", "-W", "5", target], { timeout: 10_000 });
      return true;
    } catch {
      // try next target
    }
  }
  // ICMP is blocked on some networks (hotel WiFi, cloud runners, corporate
  // egress). Fall back to an HTTPS probe before giving up — if the device
  // can talk to github.com it can certainly run the updater.
  try {
    const res = await fetch("https://github.com/", {
      method: "HEAD",
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok || (res.status >= 300 && res.status < 400)) return true;
  } catch {
    // no HTTPS path either
  }
  return false;
}

async function runUpdate(steps: UpdateStepDef[], startFrom: number, options: RunOptions): Promise<void> {
  if (startFrom === 0 && !(await checkInternet())) {
    state.phase = "failed";
    state.error = "No internet connection. Check your WiFi and try again.";
    state.currentStepIndex = -1;
    return;
  }

  // Diagnose the box BEFORE step 1 refreshes the repo — step 1 is what erases
  // the evidence. Only on a fresh run of the full flow: a continuation restores
  // the warnings this call persisted, and the OpenClaw-only flow never syncs
  // the repo, so there is nothing for it to observe.
  if (startFrom === 0 && steps.some((s) => s.id === RESTART_STEP_ID)) {
    await captureDriftBaseline();
  }

  let failed = false;

  for (let i = startFrom; i < steps.length; i++) {
    const step = steps[i];
    state.currentStepIndex = i;
    state.steps[i].status = "running";
    state.steps[i].error = undefined;

    console.log(`[Updater] Running step: ${step.label}`);

    try {
      if (step.customRun) {
        await step.customRun();
      } else if (step.requiresRoot) {
        if (GATEWAY_QUIESCED_ROOT_STEPS.has(step.id) && !gatewayIsAbsent()) {
          await execAsRootWithGatewayQuiesced(step.id, step.timeoutMs);
        } else {
          await execAsRoot(step.id, step.timeoutMs);
        }
      } else if (step.command) {
        await execShell(step.command, {
          timeout: step.timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        });
      }
      state.steps[i].status = "completed";
      console.log(`[Updater] Completed: ${step.label}`);
    } catch (err) {
      let message = err instanceof Error ? err.message : "Unknown error";
      // An overrun on an advisory step doesn't fail the update. Serialized
      // gateway writers have already waited for the root unit to settle before
      // reaching this catch, so advancing cannot overlap its remaining work.
      if (err instanceof BudgetOverrunError && step.advisoryOnOverrun) {
        state.steps[i].status = "completed";
        console.warn(`[Updater] ${step.label}: ${message} — treating as advisory`);
        continue;
      }
      // Only let the unit's journal override the error when the unit actually
      // FAILED — on a generic budget overrun its last journal line can still
      // be whatever fixup happened to finish most recently.
      if (step.requiresRoot && rootStepResultFailed(await getRootStepResult(step.id))) {
        const rootFailure = await readRootStepFailure(step.id);
        if (rootFailure) message = rootFailure;
      }
      state.steps[i].status = "failed";
      state.steps[i].error = message;
      console.error(`[Updater] Failed: ${step.label} — ${message}`);
      failed = true;
      if (step.failFast) {
        state.error = message;
        break;
      }
    }
  }

  state.currentStepIndex = -1;
  state.phase = failed ? "failed" : "completed";

  if (!failed && options.markCompleted) {
    await setMany({
      update_completed: true,
      update_completed_at: new Date().toISOString(),
    });
  }
  // The warnings have been carried across the reboot and are now in the live
  // state; drop the persisted copy so the NEXT update starts from a clean
  // sheet rather than re-showing a condition it already fixed.
  await set("update_warnings", undefined);

  // Force the next /update/versions poll to refetch — both the device's
  // installed versions and the desktop notification depend on it.
  invalidateVersionCache();
  console.log("[Updater] Update process finished");
}
