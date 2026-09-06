import { exec as execCb, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { readFile, realpath, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { get, getKnown, set, setMany } from "./config-store";
import {
  findOpenclawBin,
  GATEWAY_PORT,
  restartGateway,
  runOpenclawConfigSet,
  runOpenclawConfigSetBatch,
  openclawIsAbsent,
  gatewayIsAbsent,
} from "./openclaw-config";
import { hasHermesHarness, readEdition, type EditionName } from "./edition-source";
import { runHermesCli } from "./hermes-cli";
import { waitForPortOpen } from "./port-probe";
import { parseHermesVersion } from "./version-utils";
import { isSafeBranch } from "./update-branch";
import { startRootStep } from "./root-step-runner";
import { setUpdateLock, clearUpdateLock, isUpdateLocked } from "./update-lock";

/**
 * "An update was accepted and then lost its process" — written where the lock
 * is released, so the verdict outlives the process that reached it.
 *
 * The fault this records is a web server being replaced, so a verdict kept only
 * in memory is one the next replacement erases; the box has to remember. It is
 * cleared when a new run starts and when the owner dismisses the result.
 */
const UPDATE_INTERRUPTED_KEY = "update_interrupted_at";

// The sentence an interrupted run is reported with, from the client-safe
// module: it is the IDENTITY of that verdict, and the route and the tests have
// to be able to name it without pulling this file's Node built-ins in with it.
export { INTERRUPTED_MESSAGE } from "./update-constants";
import { INTERRUPTED_MESSAGE } from "./update-constants";
import { collectBuildIdentity, resolveBuildDir } from "./build-identity";
import type { AuthProfileEntries } from "./subscription-surface";
import { OFFICIAL_CHANNEL_PLUGINS } from "./openclaw-channels";
import {
  CHATGPT_AGENT_RUNTIME_ID,
  hasChatgptOauthProfile,
  isLegacyChatgptProvider,
  isLegacyCodexRef,
  profileProviderId,
} from "./chatgpt-subscription";

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
  options: { timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) {
  return execFile(
    "git",
    ["-c", `safe.directory=${projectDir}`, "-C", projectDir, ...args],
    options,
  );
}

/**
 * git's own switch for "never ask a human for a credential".
 *
 * Every ClawBox fetches this repository anonymously and has no credential to
 * offer. Without this, a git run that inherits a tty — a support engineer's
 * `install.sh` in a terminal, a root unit started from one — blocks on a
 * username prompt nobody is there to type, and the update hangs instead of
 * failing. With it the refusal is deterministic and immediate.
 */
const GIT_NO_PROMPT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };

/**
 * How this device's network reach to the update remote actually went.
 *
 * `reachable: false` is the fact /update/versions used to lose: the fetch was
 * swallowed, HEAD was compared against a STALE `origin/<branch>` and the box
 * told its owner "You're up to date" while it had not managed to ask.
 */
export interface RemoteReachability {
  reachable: boolean;
  /**
   * GitHub answered a public repository's anonymous `git-upload-pack` with
   * 401. git words that as "could not read Username", which names credentials
   * a ClawBox never has — so it is classified here rather than shown raw.
   */
  refusedAnonymously?: boolean;
  /** One owner-facing sentence. Absent when the remote answered. */
  reason?: string;
}

const REMOTE_REACHABLE: RemoteReachability = { reachable: true };

/**
 * Measured on the dev network, 2026-09-02 (TASK-655): GitHub answers git's
 * protocol-v2 POST to `/git-upload-pack` with `HTTP 401` and a body reading
 * "Repository not found." — for a PUBLIC repository — once an address has used
 * up its anonymous allowance. On the day it was measured the GET to
 * `/info/refs` kept answering while the POST did not, which is why the fetch
 * failed and `ls-remote` did not. That was the state that afternoon, NOT a
 * property of the endpoint: the GET is refused too, which is why it is retried
 * and why getTargetVersion has a branch for it being unreachable.
 *
 * git reports it as `fatal: could not read Username for 'https://github.com'`.
 * That sentence points at credentials; the cause is an anonymous-access
 * refusal, and no ClawBox has a credential to add. Two people lost an
 * afternoon to that wording before it was measured.
 *
 * Narrow on purpose. `Authentication failed` and `terminal prompts disabled`
 * are the same 401 seen through another git version, but they ALSO fire on a
 * QA box pointed at a private fork — where "the repository is public and the
 * device needs no password" would be a false diagnosis. Only the measured
 * signature earns that sentence; see refusalReason().
 */
function isAnonymousFetchRefusal(text: string): boolean {
  return /could not read Username|could not read Password|Repository not found/i.test(text);
}

/** The same 401 in a spelling that does not prove the remote is public. */
function isCredentialRefusal(text: string): boolean {
  return isAnonymousFetchRefusal(text)
    || /Authentication failed|terminal prompts disabled/i.test(text);
}

/**
 * No DNS — this box is not on the network at all.
 *
 * Told apart from a refusal because the answers differ: a refusal is worth
 * asking again in a moment; "there is no network" is not, and retrying it only
 * spends the owner's time on a question already answered.
 */
function isOffline(text: string): boolean {
  return /Could not resolve host|Temporary failure in name resolution|Network is unreachable/i.test(text);
}

/**
 * The remote answered, and what it said is that this ref does not exist.
 *
 * A CONFIGURATION answer, not a network one: an operator who pinned Settings →
 * System Update → Advanced to a branch that has since been deleted has a pin
 * problem, and reporting it as "could not reach GitHub" sends them to the
 * router instead of to the setting.
 */
function isMissingRef(text: string): boolean {
  return /couldn't find remote ref|Remote branch .* not found/i.test(text);
}

/** A refusal, a timeout or a transient fault — all worth asking again. */
function isRetryableRemoteFailure(err: unknown, text: string): boolean {
  if (isOffline(text) || isMissingRef(text)) return false;
  if (isCredentialRefusal(text)) return true;
  // A git killed by execFile's own timeout has usually printed nothing, so
  // there is no text to classify — and a stalled connection is the case a
  // retry helps most. `killed`/`signal` is the only evidence there is.
  const e = err as { killed?: boolean; signal?: string } | undefined;
  if (e?.killed || e?.signal) return true;
  return /Connection (?:timed out|refused|reset)|early EOF|RPC failed|The requested URL returned error: 5\d\d|unable to access/i
    .test(text);
}

function errorText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string } | undefined;
  return [e?.stderr, e?.stdout, e?.message].filter(Boolean).join("\n").trim();
}

/**
 * Attempts and backoff for a refused fetch.
 *
 * Measured (TASK-655, 19:27): with GitHub letting roughly one anonymous fetch
 * in three through, and one in-app update needing three separate fetches to
 * succeed in a row, an update had a few percent chance of completing. git has
 * no retry of its own — neither 2.34 (the boxes) nor 2.43 (the dev PC) carries
 * a `fetch.retry`/`http.retry` knob — so it lives here.
 *
 * TWO budgets, because the callers pay different prices for the wrong one. The
 * UPDATE path is a one-shot operation the owner is watching and losing it costs
 * a whole run, so it gets the full three attempts. The VERSION CHECK is polled
 * by four surfaces: a long retry there is dead time on every poll, and the
 * refusal it is answering is caused by too many anonymous requests from this
 * address — which a blanket 3x would feed. It asks twice, briefly, and it
 * spends those two asks on the call it reads the answer from rather than
 * splitting them: hence the third budget below, which is what the advisory tag
 * fetch gets so the check's total stays where it was.
 */
const REMOTE_FETCH_ATTEMPTS = 3;
const REMOTE_CHECK_ATTEMPTS = 2;
/**
 * The advisory tag fetch asks ONCE, and the retry it used to hold is spent on
 * the `ls-remote` the tag answer is actually read from. That keeps the number
 * of anonymous requests a version check can make exactly where it was — which
 * matters, because the refusal being retried is caused by too many of them.
 */
const REMOTE_ADVISORY_ATTEMPTS = 1;
/**
 * An override that is not a non-negative number of milliseconds is replaced
 * with the default, and said out loud.
 *
 * `Number("garbage")` is NaN, `Number(" ")` is 0, and a negative value stays
 * negative; `setTimeout` treats all three as 0, so the retries would still run
 * but back-to-back — removing the one thing the policy depends on, and sending
 * the anonymous requests in the burst that causes the refusal being retried.
 *
 * The upper bound is here for the opposite reason, and it is why this clamps a
 * RANGE where the shell knobs deliberately do not: `setTimeout` above
 * 2^31 - 1 ms does not wait longer, it fires on the next tick with a
 * `TimeoutOverflowWarning`. A huge value would therefore be INVERTED into no
 * delay at all rather than honoured, and `reachOrigin` multiplies by the
 * attempt number on top. Ten minutes is far past any sane version-check
 * backoff and leaves the product three orders of magnitude clear of the limit.
 */
const MAX_RETRY_DELAY_MS = 600_000;

function retryDelayMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_RETRY_DELAY_MS) {
    console.warn(`[Updater] ${name}="${raw}" is not a number of milliseconds `
      + `between 0 and ${MAX_RETRY_DELAY_MS}, using ${fallback}`);
    return fallback;
  }
  return parsed;
}

const REMOTE_RETRY_DELAY_MS = retryDelayMsFromEnv("UPDATER_REMOTE_RETRY_DELAY_MS", 4000);
const REMOTE_CHECK_RETRY_DELAY_MS = retryDelayMsFromEnv("UPDATER_REMOTE_CHECK_RETRY_DELAY_MS", 1200);

const ANONYMOUS_REFUSAL_REASON =
  "GitHub refused this ClawBox's anonymous request for the update repository. "
  + "The repository is public and the device needs no password — GitHub answers 401 to anonymous git "
  + "requests from an address that has made too many. Try again in a few minutes.";

/** One owner-facing sentence for a failed reach. */
function refusalReason(err: unknown, text: string): string {
  if (isAnonymousFetchRefusal(text)) return ANONYMOUS_REFUSAL_REASON;
  if (isCredentialRefusal(text)) {
    return "The update repository refused this device's request for credentials it does not have. "
      + "If this box is pointed at a private fork, it needs a remote it can read anonymously.";
  }
  if (isOffline(text)) {
    return "This ClawBox could not look up github.com — check the network connection and try again.";
  }
  if (isMissingRef(text)) {
    return "The update branch this ClawBox is pinned to no longer exists on GitHub. "
      + "Choose a different branch in System Update → Advanced options.";
  }
  const e = err as { killed?: boolean; signal?: string } | undefined;
  if (e?.killed || e?.signal) {
    return "The update repository did not answer in time — the connection may be slow or blocked. Try again.";
  }
  // Last resort. errorText() on a spawn failure is Node's own
  // `Command failed: git -c safe.directory=…`: an argv is not an explanation,
  // so only its last line goes out, and only when there is nothing better.
  return `Could not reach the update repository: ${text.split("\n").pop() || "unknown error"}`;
}

/**
 * Run a git network command, retrying a refused or transient attempt.
 *
 * Returns how it went rather than throwing: every caller here wants to carry
 * on and SAY the remote could not be reached, which is the whole point — the
 * old `.catch(() => {})` is what turned a refusal into "up to date".
 */
async function reachOrigin(
  projectDir: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number; attempts?: number; retryDelayMs?: number },
): Promise<RemoteReachability> {
  return (await readFromOrigin(projectDir, args, options)).remote;
}

/**
 * The same policy, for a call whose OUTPUT is the answer.
 *
 * `RemoteReachability` travels into the /update/versions payload, so git's
 * stdout is returned beside it rather than added to it.
 */
async function readFromOrigin(
  projectDir: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number; attempts?: number; retryDelayMs?: number },
): Promise<{ remote: RemoteReachability; stdout: string }> {
  const attempts = options.attempts ?? REMOTE_FETCH_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? REMOTE_RETRY_DELAY_MS;
  let lastText = "";
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { stdout } = await execGit(projectDir, args, {
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        env: { ...process.env, ...GIT_NO_PROMPT_ENV },
      });
      return { remote: REMOTE_REACHABLE, stdout: String(stdout ?? "") };
    } catch (err) {
      lastErr = err;
      lastText = errorText(err);
      if (attempt === attempts || !isRetryableRemoteFailure(err, lastText)) break;
      console.warn(
        `[Updater] git ${args[0]} attempt ${attempt}/${attempts} failed, retrying: `
        + lastText.split("\n").pop(),
      );
      await delay(retryDelayMs * attempt);
    }
  }
  return {
    remote: {
      reachable: false,
      refusedAnonymously: isAnonymousFetchRefusal(lastText),
      reason: refusalReason(lastErr, lastText),
    },
    stdout: "",
  };
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
import {
  clawboxDisabledEntryId,
  clearPluginRepair,
  readPluginRepairs,
  recordPluginRepair,
} from "./plugin-repair";
// The id rule, from the PURE module rather than through `plugin-repair`: it is
// string work with no `fs` behind it, and taking it from the reader would tie a
// pure helper to that module's surface for no reason.
import { canonicalPluginId } from "./plugin-repair-id";

// Ceiling for the rebuild/restart hand-off: bun build alone runs minutes on a
// Jetson, plus the config/redeploy steps before it and the reboot after.
//
// 20 min, raised from 15 (TASK-670). `do_rebuild` may now run `next build` a
// SECOND time when the first died on a file that changed under its own file
// trace, and nothing extends this deadline once the wait has started: past it
// `waitForRebuildToTakeOver` throws AND clears `update_needs_continuation`, so
// a rebuild that actually worked would be reported red and post_update,
// hermes_edition and gateway_verify would never run. One extra build is 2-4
// min on a Jetson; this covers it with the same margin the original carried.
const REBUILD_TAKEOVER_TIMEOUT_MS = 1_200_000;

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

/**
 * Read the BUILD_ID of the build the SERVER RUNS FROM.
 *
 * The service runs with cwd `.next/standalone`, so the assets it serves come
 * from `.next/standalone/.next` — and `.next` "can be a newer half-finished
 * build", as build-identity.ts's own comment puts it. Reading the wrong tree
 * would answer "the rebuild produced a new build" about a directory nobody
 * serves.
 *
 * The serving tree is chosen by the ENTRY POINT, not by `resolveBuildDir`.
 * That helper picks the standalone tree only when its BUILD_ID is present and
 * otherwise falls back to `.next` — which is precisely the state a failed
 * rebuild leaves: the standalone tree exists and its BUILD_ID does not. Falling
 * back there would read a `.next/BUILD_ID` nobody serves, `buildMissing` would
 * be false, and the continuation would mark the update complete over a box that
 * cannot boot. `standalone/server.js` is what production-server.js requires, so
 * its presence is what says which tree is the serving one.
 *
 * …and the entry is followed through `realpath` rather than assumed to sit at
 * `.next/standalone`. `postbuild` (package.json) SEARCHES for it — Next nests
 * the standalone tree whenever `outputFileTracingRoot` resolves above the
 * project — copies the assets and the identity stamp beside the real entry, and
 * symlinks `.next/standalone/server.js` at it. On such a box
 * `.next/standalone/.next/BUILD_ID` does not exist, so reading the literal path
 * would answer "" and turn every successful update into "the device restarted
 * with no build at all": a false failure over a rebuild that worked.
 */
async function readBuildId(): Promise<string> {
  try {
    const entry = path.join(PROJECT_DIR, ".next", "standalone", "server.js");
    const serving = existsSync(entry)
      ? path.join(path.dirname(await realpath(entry)), ".next")
      : await resolveBuildDir(PROJECT_DIR);
    return (await readFile(path.join(serving, "BUILD_ID"), "utf-8")).trim();
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

/**
 * systemd's own lifecycle notes, which `journalctl -u` interleaves with the
 * step's output. Everything a unit says about itself carries the unit name and
 * a colon ("…service: Main process exited…", "…service: Failed with result…",
 * "…service: Consumed 8.523s CPU time."); the start/stop announcements name
 * the unit's DESCRIPTION instead, so they are matched by their opening verb.
 */
const SYSTEMD_LIFECYCLE_LINE =
  /^(?:Starting|Started|Stopping|Stopped|Reloading|Reloaded|Failed to start|Scheduled restart job|Triggering OnFailure|Deactivated successfully)\b/;

/**
 * sudo/su/PAM bookkeeping. install.sh runs most of the rebuild through
 * `as_clawbox_login`, and every one of those logs a session-open and a
 * session-close into the same unit's journal — so even after systemd's own
 * lines are gone, the last line is often "session closed for user clawbox".
 */
const SESSION_BOOKKEEPING_LINE =
  /^(?:pam_\w+\(|\(to \S+\) \S+ on |\S+ : (?:TTY|PWD|USER)=)/;

/**
 * The line that says WHY a root step failed.
 *
 * The LAST line never is: systemd's accounting epilogue always follows the
 * exit. On 2026-09-05 the restart step recorded
 * "clawbox-root-update@rebuild_reboot.service: Consumed 8.523s CPU time." as
 * the failure while `Error: rebuild failed (exit 137)` — the OOM-killed build —
 * sat four lines above it, and that is the sentence the System Update page
 * showed the owner. install.sh says every fatal thing as `echo "Error: …" >&2`,
 * so the newest of those wins; failing that, the last line the STEP itself
 * wrote, once systemd's and sudo's lines are out of the way.
 */
function getStepFailureLine(logText: string, unit: string): string | null {
  const lines = logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith(`${unit}:`)
      && !SYSTEMD_LIFECYCLE_LINE.test(line)
      && !SESSION_BOOKKEEPING_LINE.test(line));
  if (lines.length === 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^(?:error|fatal)\b/i.test(lines[i])) return lines[i];
  }
  return lines[lines.length - 1];
}

async function readRootStepFailure(stepId: string): Promise<string | null> {
  const unit = `clawbox-root-update@${stepId}.service`;
  try {
    const { stdout } = await execFile(
      "/usr/bin/journalctl",
      ["-u", unit, "-n", "40", "--no-pager", "-o", "cat"],
      { timeout: 10_000 },
    );
    return getStepFailureLine(stdout, unit);
  } catch {
    return null;
  }
}

/**
 * Start a root systemd service in fire-and-forget mode.
 * Used for steps that will kill the current process (rebuild, reboot).
 */
async function startRootServiceFireAndForget(stepId: string): Promise<void> {
  await startRootStep(stepId, { noBlock: true, timeoutMs: 10_000 });
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
  // NO fetch here. This used to be the THIRD anonymous fetch of one update —
  // after the Node updater's own and step 0's (`bootstrap_updater` →
  // install.sh `sync_repo_to_update_target`) — and the heaviest, because it
  // asked for ALL refs. Step 0 is `failFast` and has already fetched origin AND
  // hard-reset this tree to `upstream`, so this one could only ever re-fetch
  // refs the run already has, while giving GitHub a third chance to refuse the
  // whole update: an attempt on 2026-09-02 got through the first two, ran
  // steps 1-8 for three and a half minutes, and died here (TASK-655).
  //
  // What replaces it is the question the reset actually depends on — is the ref
  // on this device? — asked of the refs already on disk. Dropping the fetch
  // without asking that would be a false success: `reset --hard` to a ref that
  // was never fetched fails with git's own argv, and nothing would say why.
  try {
    await execGit(PROJECT_DIR, ["rev-parse", "--verify", `${upstream}^{commit}`], gitOptions);
  } catch {
    throw new Error(
      `This ClawBox has no local copy of ${upstream}. Step 1 of this update was supposed to fetch it — `
      + "run the update again, and if it keeps failing, GitHub may be refusing this address's anonymous requests.",
    );
  }
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
const GATEWAY_HEALTH_WAIT_MS = Number(process.env.GATEWAY_HEALTH_WAIT_MS || "30000");
const GATEWAY_RECOVERY_WAIT_MS = Number(process.env.GATEWAY_RECOVERY_WAIT_MS || "45000");
const GATEWAY_WAIT_INTERVAL_MS = Number(process.env.GATEWAY_WAIT_INTERVAL_MS || "1500");
// The unit's own TimeoutStartSec (config/clawbox-gateway.service), not a
// tunable: a pre-start still running at this point is killed by systemd
// itself, so the wait below never outlives the thing it waits for.
const GATEWAY_PRE_START_TIMEOUT_MS = 600_000;
const DOCTOR_FIX_TIMEOUT_MS = 90_000;
const ROOT_STEP_SETTLE_TIMEOUT_MS = Number(process.env.ROOT_STEP_SETTLE_TIMEOUT_MS || "7200000");
const LEGACY_GATEWAY_BLOCKER_RE =
  /installs\.json|conflicting plugin install metadata|carl_pir|belongs to agent piper/i;
// The core names the plugin in its refusal — `Plugin "discord" requires
// capability consent…` — so the id is captured rather than hard-coded, and
// `managedPluginNeedingConsent` decides whether it is one ClawBox may answer
// for. Not global: `.match()` and `.test()` share this object.
const PLUGIN_CAPABILITY_CONSENT_RE =
  /Plugin\s+["']?([A-Za-z0-9@._/-]+?)["']?\s+requires capability consent/i;
// The OTHER refusal, and the one a core upgrade produces (TASK-602). Plugin
// payloads live under `~/.openclaw/npm/projects/openclaw-<id>-<hash>__
// openclaw-generation__g-<generation>`, keyed to the core that installed them,
// so a core bump leaves them unreachable. The core's startup verification then
// refuses readiness with its own sentence — `formatStartupPluginSmokeFailure`
// in the installed 2026.8.1 bundle prints
//
//     - Plugin "discord": configured plugin payload verification failed
//       (<reason>): <detail>. Run `openclaw update repair` to retry plugin repair.
//
// — and consent is not what is missing: the package is not on disk to consent
// to. Matched on the core's own words rather than on the reason code, which is
// an internal enum. Not global, for the same reason as the pattern above.
const PLUGIN_PAYLOAD_VERIFICATION_RE =
  /Plugin\s+["']?([A-Za-z0-9@._/-]+?)["']?\s*:\s*configured plugin payload verification failed/i;
const CURRENT_GATEWAY_PRE_START = path.join(PROJECT_DIR, "scripts", "gateway-pre-start.sh");
const GATEWAY_QUIESCED_ROOT_STEPS = new Set(["openclaw_install", "post_update"]);

// A serialized root step deliberately leaves the gateway stopped. Its next
// health check must repair/start it instead of accepting a stale listener or
// spending the normal readiness window waiting for a service we stopped.
let gatewayNeedsRecovery = false;

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForGateway(timeoutMs: number): Promise<boolean> {
  return waitForPortOpen(GATEWAY_PORT, "127.0.0.1", {
    timeoutMs,
    intervalMs: GATEWAY_WAIT_INTERVAL_MS,
    probeTimeoutMs: 1_000,
  });
}

/**
 * Where this device's OpenClaw tree is, in one place.
 *
 * The two-line derivation below appeared three times — in `openclawChildEnv`,
 * in `runCurrentGatewayPreStart` and in `readOpenclawConfigForRepair` — and
 * three copies of a rule is two chances for them to disagree about which
 * config a repair is reasoning over.
 *
 * PURE, and it returns the paths only. It deliberately does NOT build an
 * environment: the three callers set genuinely different ones and one shared
 * env would be wrong for all of them. `runCurrentGatewayPreStart` spawns a bash
 * script that reads ClawBox's own names and must pin those; `openclawChildEnv`
 * feeds the core CLI, which reads only `OPENCLAW_CONFIG_PATH` /
 * `OPENCLAW_STATE_DIR`; `readOpenclawConfigForRepair` spawns nothing at all and
 * only wants a path to read.
 *
 * `OPENCLAW_HOME` is read here as a FALLBACK and must never be exported to a
 * child: ClawBox uses that name for the `.openclaw` directory itself, while the
 * OpenClaw CLI reads it as the ACCOUNT home and builds its tree at
 * `$OPENCLAW_HOME/.openclaw`. Each caller that spawns something deletes it.
 */
function openclawTreePaths(): { home: string; openclawHome: string } {
  const home = process.env.CLAWBOX_HOME_DIR || process.env.HOME || "/home/clawbox";
  const openclawHome = process.env.CLAWBOX_OPENCLAW_HOME
    || process.env.OPENCLAW_HOME
    || path.join(home, ".openclaw");
  return { home, openclawHome };
}

/**
 * The environment that pins an `openclaw` child to THIS device's real config.
 *
 * Same rule as `runCurrentGatewayPreStart`: the CLI reads `OPENCLAW_HOME` as
 * the ACCOUNT home and builds its tree at `$OPENCLAW_HOME/.openclaw`, while
 * ClawBox uses that name for the `.openclaw` directory itself — so an
 * inherited one makes the core answer about a second, empty config. That does
 * not matter for a command whose answer is thrown away; it matters a great
 * deal for one whose answer is printed to the owner as the reason his gateway
 * is dead.
 */
function openclawChildEnv(): NodeJS.ProcessEnv {
  const { home, openclawHome } = openclawTreePaths();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    OPENCLAW_STATE_DIR: openclawHome,
    OPENCLAW_CONFIG_PATH: path.join(openclawHome, "openclaw.json"),
  };
  delete env.OPENCLAW_HOME;
  return env;
}

/** Everything a failed child said, whichever stream it said it on. */
function commandOutput(err: unknown): string {
  const detail = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return [detail.stdout, detail.stderr, detail.message]
    .map((part) => (typeof part === "string" ? part : ""))
    .join("\n");
}

/**
 * Run the core's own repair, and RECORD whether it worked.
 *
 * Still non-fatal, and that is load-bearing: doctor exiting non-zero because
 * the gateway holds its state directory is the gateway proving it is alive
 * (install.sh:step_gateway_legacy_state_recovery, measured 2026-09-06), so the
 * restart + positive port probe that follows remains the verdict, not the exit
 * code — which is why neither caller branches on this, and it returns nothing.
 * What changed is that the exit code is no longer DISCARDED: a doctor that
 * could not finish is the single most useful fact about an update that then
 * finds no gateway, and swallowing it silently is what left a customer box
 * dark for 25 hours with "Applying system fixups — completed" on screen
 * (TASK-737).
 */
async function runOpenclawDoctorFix(): Promise<void> {
  // No openclaw binary on the Hermes edition — nothing to doctor.
  if (openclawIsAbsent()) return;
  try {
    await execFile(OPENCLAW_BIN, ["doctor", "--fix", "--yes", "--non-interactive"], {
      timeout: DOCTOR_FIX_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      env: openclawChildEnv(),
    });
  } catch (err) {
    warnUpdate("openclaw-doctor-fix-failed", `\`openclaw doctor --fix\` did not complete. `
      + `Config and session migrations it performs may still be pending: ${describeDoctorFailure(err)}`);
  }
}

/**
 * Why doctor did not finish, in words worth reading.
 *
 * NOT `err.message`: node sets it to `Command failed: <the whole argv>`, so a
 * warning built from its first line would name the command back at the owner
 * and nothing else. Doctor states its own blocker — `Legacy exec approvals
 * exist at …` is the one this card is about — and it states it in the output,
 * so that is what is quoted. A killed child is called killed, because a 90 s
 * timeout and a refusal are not the same problem.
 */
function describeDoctorFailure(err: unknown): string {
  if ((err as { killed?: boolean } | null)?.killed) {
    return `it was still running after ${Math.round(DOCTOR_FIX_TIMEOUT_MS / 1000)}s and was stopped`;
  }
  const said = commandOutput(err)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // Its own summary frame is drawn with box-drawing characters and says
    // nothing; the sentence that names the blocker is plain text.
    .filter((line) => !/^[\u2500-\u257f\u25c6\u2502]/.test(line) && !line.startsWith("Command failed:"));
  return said.at(-1) ?? "it gave no reason";
}

/**
 * The core's own verdict object, or null when it could not be asked.
 *
 * One place, because the answer has two readers with opposite interests: the
 * diagnosis below wants `issues[]` on a config the core REFUSES (exit 1), and
 * the plugin repair wants `warnings[]` on one it ACCEPTS (exit 0) — measured on
 * 2026.8.1, a config whose entries name plugins that are not installed is
 * `{"valid":true,…,"warnings":[…]}` with exit 0. Reading the payload on both
 * exits is what lets one CLI call answer either question.
 *
 * Null for "no answer", never an invented one: a half-installed core whose node
 * engine is wrong exits non-zero here too, and treating that as a verdict would
 * be a false failure over a config that is fine.
 */
interface CoreConfigVerdict {
  /** The CLI exited 0 — the core's own "the gateway will load this". */
  accepted: boolean;
  /** Its JSON payload, or null when there was none to read. */
  payload: Record<string, unknown> | null;
}

/** Run `openclaw config validate --json` once and hand back what it said. */
async function askCoreToValidateConfig(): Promise<CoreConfigVerdict | null> {
  if (openclawIsAbsent()) return null;
  let accepted = true;
  let text: string;
  try {
    const { stdout } = await execFile(OPENCLAW_BIN, ["config", "validate", "--json"], {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      // SIGKILL at the deadline, the counterpart of the `-k 5` the boot
      // script's validate bounds carry (TASK-741): node's `execFile` sends
      // `killSignal` ONCE and never escalates, so the default SIGTERM leaves a
      // validator that ignores it running with nothing to stop it, holding this
      // recovery open past its bound. Safe here and only here — `config
      // validate` writes nothing. The doctor bound above keeps SIGTERM for the
      // opposite reason: a SIGKILL mid-import is what leaves an
      // `exec-approvals.json.doctor-importing` claim behind, which then blocks
      // every later doctor exactly as the original file does.
      killSignal: "SIGKILL",
      env: openclawChildEnv(),
    });
    text = stdout ?? "";
  } catch (err) {
    // The core prints the verdict as JSON on stdout and exits 1 when it
    // refuses. Any other non-zero exit carries no verdict at all.
    accepted = false;
    text = commandOutput(err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return { accepted, payload: null };
  }
  const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  return { accepted, payload };
}

/**
 * Ask the CORE whether it will accept this device's configuration.
 *
 * HARNESS FIRST. `openclaw config validate --json` is the core's own answer to
 * "would the gateway start?" — `{valid, path, issues[]}` — and until TASK-737
 * nothing in ClawBox ever asked it: not the updater, not install.sh, not the
 * boot script. That gap is the whole of the incident: OpenClaw 2026.8 REFUSES
 * a 2026.7-layout config instead of migrating it on load (`Unrecognized
 * keys`, gateway exit 78), so a box whose migration did not run has a gateway
 * that provably cannot start — and ClawBox reported "not listening on port
 * 18789", which is true, unactionable, and indistinguishable from a dozen
 * other causes.
 *
 * `--json`, not the human output: that goes to stderr and marks each issue
 * with a themed `×` glyph any `FORCE_COLOR` in the environment repaints, so
 * scraping it would be reading presentation as a contract.
 *
 * Returns the core's own reasons when it refuses, and null when it accepts,
 * when there is no core to ask (Hermes), or when the validator could not be
 * run at all. Null is deliberately the "say nothing" answer: this is a
 * DIAGNOSIS of an update that has already failed, so a validator we could not
 * reach must never invent a cause of its own — a half-installed core whose
 * node engine is wrong exits non-zero here too, and calling that a bad config
 * would be a false failure over a config that is fine.
 */
async function getOpenclawConfigRefusal(): Promise<string | null> {
  const verdict = await askCoreToValidateConfig();
  // EXIT 0 IS ACCEPTANCE, and it is answered without reading the payload — the
  // behaviour this function has had since TASK-737 and the one the boot script
  // is being aligned to, not away from.
  if (!verdict || verdict.accepted || !verdict.payload) return null;
  const { valid, issues } = verdict.payload as { valid?: unknown; issues?: unknown };
  if (valid !== false) return null;
  const reasons = (Array.isArray(issues) ? issues : [])
    .map((issue) => {
      const { path: at, message } = (issue ?? {}) as { path?: unknown; message?: unknown };
      return [at, message].filter((part) => typeof part === "string" && part).join(": ");
    })
    .filter(Boolean);
  return reasons.length > 0 ? reasons.join("; ") : "the core gave no reason";
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
 * Let a gateway that is still in its ExecStartPre finish it before it is
 * stopped. Called with the runtime mask already in place: a masked unit
 * cannot be started again, so nothing can enter `start-pre` behind this
 * wait — checked, then masked, would leave that gap open.
 *
 * WHY. clawbox-gateway.service and clawbox-setup.service start together at
 * boot, and gateway-pre-start.sh can spend minutes in a plugin install on a
 * cold box. The second half of an update is resumed from boot now, and its
 * first act is to quiesce the gateway: `systemctl stop` on a unit in
 * `start-pre` kills the pre-start halfway through the same migration that
 * ensureGatewayHealthy budgets 600 s for precisely so it is never killed.
 * `start-pre` is the only sub-state that matters — `auto-restart` is also
 * `activating` but nothing runs in it, and Type=simple leaves `start` at once.
 *
 * A query that fails says nothing about the pre-start, so it is asked again:
 * stopping on an unanswered query would kill the very migration this wait
 * protects. A unit that cannot be seen out of `start-pre` by the ceiling is
 * left running and the step fails instead.
 */
async function waitForGatewayPreStart(): Promise<void> {
  const deadline = Date.now() + GATEWAY_PRE_START_TIMEOUT_MS;
  let announced = false;
  while (Date.now() < deadline) {
    let subState: string | null = null;
    try {
      const { stdout } = await execFile(
        "/usr/bin/systemctl",
        ["show", "clawbox-gateway.service", "-p", "SubState", "--value"],
        { timeout: 10_000 },
      );
      subState = stdout.trim();
    } catch {
      // Unanswered is not "finished": a query that times out under a cold
      // box's load says nothing about the pre-start. Ask again.
    }
    if (subState !== null && subState !== "start-pre") return;
    if (!announced) {
      announced = true;
      console.log("[Updater] waiting for clawbox-gateway to finish its pre-start before stopping it");
    }
    // Never sleep past the ceiling: the gateway is masked while this waits.
    await delay(Math.min(GATEWAY_WAIT_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  // systemd's own TimeoutStartSec has killed any pre-start by now, so this is
  // a unit whose state could not be confirmed for ten minutes. Leave it alone:
  // the step fails and the mask is lifted, the gateway is not stopped.
  throw new Error("clawbox-gateway did not leave its pre-start within the unit's ceiling — not stopping it");
}

/**
 * Keep systemd from starting the gateway while an OpenClaw writer is active.
 * Mask comes before stop so a root update step cannot race the stop with its
 * own restart, and before the pre-start wait so no new activation can slip
 * into `start-pre` behind it. The runtime mask is always removed, including
 * failure paths.
 */
async function withGatewayQuiesced<T>(operation: () => Promise<T>): Promise<T> {
  if (gatewayIsAbsent()) return operation();

  let masked = false;
  let outcome!: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    await setGatewayMaintenanceMask(true);
    masked = true;
    await waitForGatewayPreStart();
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

/**
 * Every plugin id the pre-start says it put back, normalised.
 *
 * The script prints `  <id> plugin payload reinstalled (<spec>)` for each one.
 * Reading its own report is what stops this file re-issuing the identical npm
 * install a moment later for a package that is already back on disk.
 */
function pluginPayloadsRepairedByPreStart(preStartOutput: string): Set<string> {
  const repaired = new Set<string>();
  const re = /^\s*(\S+) plugin payload reinstalled \(/gim;
  for (const match of preStartOutput.matchAll(re)) {
    repaired.add(normalizeManagedPluginId(match[1]));
  }
  return repaired;
}

/** Run the newly checked-out pre-start repair while the gateway is stopped. */
async function runCurrentGatewayPreStart(): Promise<string> {
  if (!existsSync(CURRENT_GATEWAY_PRE_START)) return "";
  const { home, openclawHome } = openclawTreePaths();
  // Never `OPENCLAW_HOME` in a child's environment. ClawBox reads that name as
  // the .openclaw directory; the OpenClaw CLI reads it as the ACCOUNT home and
  // puts its tree at `$OPENCLAW_HOME/.openclaw`. Exported here it made every
  // `openclaw` the pre-start (and the embeddings script it detaches) ran write
  // a second config under ~/.openclaw/.openclaw/ and report success, while the
  // real file stayed half-switched (2026-09-04). The pre-start reads
  // CLAWBOX_OPENCLAW_HOME instead, and the two canonical CLI overrides pin
  // every child to the real tree even if some ancestor set the misread name.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAWBOX_HOME_DIR: home,
    CLAWBOX_ROOT: PROJECT_DIR,
    CLAWBOX_OPENCLAW_HOME: openclawHome,
    OPENCLAW_STATE_DIR: openclawHome,
    OPENCLAW_CONFIG_PATH: path.join(openclawHome, "openclaw.json"),
  };
  delete env.OPENCLAW_HOME;
  const { stdout } = await execFile("/bin/bash", [CURRENT_GATEWAY_PRE_START], {
    // Match the unit's 600s TimeoutStartSec with a little process overhead.
    // Killing this halfway through a plugin migration recreates the lock race
    // this maintenance path exists to avoid.
    timeout: 650_000,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
  return stdout ?? "";
}

/**
 * The plugins ClawBox installs, and may therefore consent for.
 *
 * The whitelist is the point. Consenting on the owner's behalf is only
 * defensible for a package ClawBox chose, pinned and installed — codex and the
 * DeepSeek provider from `scripts/gateway-pre-start.sh`, discord and whatsapp
 * from `openclaw-channels.ts` when the owner asked for that channel in
 * Settings, and `clawbox-email-directives`, which is ClawBox's own plugin
 * copied out of the checkout. A plugin the owner installed from the Terminal
 * has an owner who can answer for it, and the updater must not answer in his
 * place — which is also why this is not `openclaw update repair
 * --accept-capabilities`, the harness's own command for this recovery: that one
 * consents for everything blocked, including his.
 */
const CLAWBOX_MANAGED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  // The ones `scripts/gateway-pre-start.sh` installs and owns the repair for.
  "codex",
  "deepseek",
  "clawbox-email-directives",
  // …and every channel the Settings panel can install, read from the map it
  // installs from rather than copied: a channel added there and forgotten here
  // would be classified as the OWNER's plugin and logged as one ClawBox may
  // not answer for, over a package ClawBox itself put on the box.
  ...Object.keys(OFFICIAL_CHANNEL_PLUGINS),
]);

/**
 * The npm package behind each managed plugin whose payload this file may
 * reinstall, keyed by the normalised plugin id.
 *
 * Only the plugins that are an npm `<package>@<version>` spec, because that is
 * what the repair is: the core generation is what orphaned the payload, so the
 * replacement has to be built for the core now on the box.
 * `OFFICIAL_CHANNEL_PLUGINS` is the same map the Settings panel installs from,
 * imported rather than copied — a second list here would be one more place to
 * forget when a channel is added.
 *
 * The two managed plugins deliberately absent are absent for their SHAPE, not
 * for who repairs them: `deepseek` is a ClawHub spec (`clawhub:@openclaw/…`)
 * and `clawbox-email-directives` is copied out of the checkout, so an
 * `@openclaw/<id>@<version>` guess would fetch a package that is not the
 * plugin. `scripts/gateway-pre-start.sh` owns both, and
 * `runCurrentGatewayPreStart()` has just run it.
 */
const MANAGED_PLUGIN_NPM_PACKAGES: ReadonlyMap<string, string> = new Map([
  ["codex", "@openclaw/codex"],
  ...Object.entries(OFFICIAL_CHANNEL_PLUGINS),
]);

/**
 * `@openclaw/discord` and `openclaw-discord` are the same plugin as `discord`.
 *
 * The core names its own normalised plugin id in the refusal, which on a
 * measured box is the bare one — but `ensureChannelPlugin` already handles a
 * registry that calls the Discord plugin `openclaw-discord`
 * (`openclaw-channels.ts`, and a test pins it), so the membership test must not
 * be the thing that decides a box gets no repair.
 */
function normalizeManagedPluginId(id: string): string {
  return id.replace(/^@openclaw\//, "").replace(/^openclaw-/, "");
}

/** Every plugin a refusal of one shape in this journal names, split by who owns it. */
function pluginsNamedInRefusals(
  journal: string,
  pattern: RegExp,
): { managed: string[]; unmanaged: string[] } {
  // A GLOBAL copy of the shared pattern, built here so the shared one keeps a
  // stable `lastIndex` for its `.test()` callers. Reading only the FIRST match
  // was a live dead end: the journal tail spans the whole boot (`-b`) and the
  // gateway restarts several times during an update, so a stale `codex` line
  // ahead of a live `discord` one had the repair fix codex while
  // `getGatewayFailureDetail` — which scans in REVERSE — handed the owner the
  // discord sentence.
  const namesRe = new RegExp(pattern.source, "gi");
  // KEYED by the normalised id, VALUED by the first raw id seen for it. One
  // boot's journal can name the same plugin twice under different spellings —
  // `codex` from one start, `@openclaw/codex` from another — and a set of raw
  // ids would then repair it twice, giving the pinned force-install two
  // separate six-minute budgets back to back on a Jetson. The repair runs
  // under the raw name because that is what the registry answers to.
  const managed = new Map<string, string>();
  const unmanaged = new Map<string, string>();
  for (const match of journal.matchAll(namesRe)) {
    const id = match[1];
    const key = normalizeManagedPluginId(id);
    const bucket = CLAWBOX_MANAGED_PLUGIN_IDS.has(key) ? managed : unmanaged;
    if (!bucket.has(key)) bucket.set(key, id);
  }
  return { managed: [...managed.values()], unmanaged: [...unmanaged.values()] };
}

/**
 * Respect an owner-disabled plugin even if the journal still mentions it.
 *
 * The sibling of `codexCapabilityRepairIsAllowed`, and needed for the same
 * reason. `plugins enable` is not a consent-only verb — it writes
 * `plugins.entries.<id>.enabled = true` — and the journal tail is the whole
 * boot, captured BEFORE the pre-start runs. So an owner who opened the Terminal
 * and ran `openclaw plugins disable discord` to get his box back would have had
 * the channel switched on again, with consent granted in his name, by the very
 * next update. Explicitly `false` is the only answer that stops the repair;
 * absent or unreadable is not an opt-out.
 */
async function pluginConsentRepairIsAllowed(pluginId: string): Promise<boolean> {
  const cfg = await readOpenclawConfigForRepair();
  if (!cfg) return true;
  const plugins = cfg.plugins && typeof cfg.plugins === "object"
    ? cfg.plugins as Record<string, unknown>
    : {};
  const entries = plugins.entries && typeof plugins.entries === "object"
    ? plugins.entries as Record<string, unknown>
    : {};
  // Matched on the NORMALISED id, not the literal one. The journal names the
  // core's own plugin id while `plugins.entries` can be keyed under the alias
  // `ensureChannelPlugin` writes (`openclaw-discord`), and a lookup that missed
  // the alias would read an owner's explicit `enabled: false` as "no opinion"
  // and switch his channel back on.
  const wanted = normalizeManagedPluginId(pluginId);
  const switchedOff = Object.entries(entries).some(([key, entry]) =>
    normalizeManagedPluginId(key) === wanted
    && !!entry
    && typeof entry === "object"
    && (entry as Record<string, unknown>).enabled === false,
  );
  if (!switchedOff) return true;
  // …UNLESS CLAWBOX SWITCHED IT OFF ITSELF (TASK-606). The boot script now
  // writes the same `enabled: false` when it cannot consent a plugin, so the
  // gateway can start — and from here that is indistinguishable from a person
  // running `openclaw plugins disable discord`. Without this the repair TASK-603
  // built for exactly the 2026-09-01 Discord outage would skip the plugin for
  // ever, on the grounds that the box had disabled it a boot earlier.
  //
  // `plugin-repair.json` is the only thing on the device that knows the
  // difference: a row with `disabled: true` for this plugin is ClawBox's own
  // switch-off, and the repair must still run.
  return await clawboxSwitchedPluginOff(wanted);
}

/**
 * True when `data/plugin-repair.json` says ClawBox switched this plugin off.
 *
 * `canonicalPluginId` on BOTH sides, which is the same rule `clawboxDisabledEntryId`
 * and `clearPluginRepair` use. `normalizeManagedPluginId` strips only the two
 * prefixes, so a row filed as `@openclaw/deepseek-provider` was found by one
 * marker reader and not the other. Not reachable with ClawBox's own writers —
 * the deepseek block marks the literal `deepseek` — but two ids for one file is
 * how the alias bug this card already fixed got in.
 */
async function clawboxSwitchedPluginOff(pluginId: string): Promise<boolean> {
  try {
    const wanted = canonicalPluginId(pluginId);
    const repairs = await readPluginRepairs();
    return Object.values(repairs).some(
      (row) => canonicalPluginId(row.id) === wanted && row.disabled,
    );
  } catch {
    // An unreadable marker is not consent: fall back to respecting the config,
    // which is the pre-TASK-606 behaviour.
    return false;
  }
}

/**
 * `plugin not installed: <id>` — the core's own warning, and the only thing on
 * the box that can tell "this plugin's package is not here" from "this
 * plugin's reviewed capability surface is stale".
 *
 * Both states refuse gateway readiness, and the GATEWAY names them the same
 * way: `Plugin "<id>" requires capability consent`. They need opposite repairs.
 * `plugins enable` answers a stale surface; against a package that was never
 * installed it answers "Plugin not found", which is how the incident box stayed
 * dark through a repair that had already run.
 */
const CORE_PLUGIN_NOT_INSTALLED_RE = /plugin not installed\b/i;
/** The package the core itself names in that warning, for the owner's Retry. */
const CORE_PLUGIN_INSTALL_SPEC_RE = /openclaw\s+plugins\s+install\s+(\S+)/i;
/**
 * …and what a package spec may look like before it is written down.
 *
 * The capture above is `\S+` against a sentence, so a reworded core — one that
 * ends the line with a backtick, a full stop or a closing quote — would hand
 * the Retry an argv the registry cannot resolve, and the owner would meet a
 * 502 on a button that can never work. A spec this does not recognise is
 * dropped rather than guessed at: the row still goes up with the core's own
 * sentence on it, and the Retry answers `no_spec` instead of running something
 * shaped like a command.
 */
const NPM_PACKAGE_SPEC_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._+-]*)?$/;
/** `plugins.entries.<id>` — the warning's `path`, which is the CONFIG's key. */
const CORE_PLUGIN_WARNING_PATH_RE = /^plugins\.entries\.(.+)$/;

interface CoreMissingPlugin {
  /** The key as `plugins.entries` carries it — what `config set` addresses. */
  configuredId: string;
  /** The core's own sentence, shown to the owner unchanged. */
  reason: string;
  /** `@openclaw/<pkg>` when the core named one, else "". */
  spec: string;
}

/**
 * Which of these plugin ids the core says have no package on the box.
 *
 * HARNESS FIRST. `openclaw config validate --json` is the core's own detector
 * and it already existed; nothing here re-derives it, and no list of "plugins
 * OpenClaw 2 stopped bundling" is kept in this repo, which would be a second
 * and staler copy of the core's bundle manifest. Measured on 2026.8.1
 * (2026-09-06, throwaway OPENCLAW_HOME):
 *
 *     {"valid":true,"path":"…","warnings":[
 *       {"path":"plugins.entries.byteplus",
 *        "message":"plugin not installed: byteplus — install the official
 *                   external plugin with: openclaw plugins install
 *                   @openclaw/byteplus-provider"}]}
 *
 * Keyed by the NORMALISED id so the caller can match it against the id the
 * gateway's refusal named, which need not be the config's spelling.
 *
 * Asked once, and only for a box whose gateway has already refused readiness
 * over a plugin ClawBox does not manage — a healthy update never pays for it.
 */
async function coreReportedMissingPlugins(): Promise<Map<string, CoreMissingPlugin> | null> {
  const payload = (await askCoreToValidateConfig())?.payload;
  // NULL, not an empty map. "The core could not be asked" and "the core
  // answered and named none of them" are different facts and the caller says
  // different things about them — an empty map here would put the sentence
  // "the core knows this plugin's package" in the update log of a box whose
  // validator never ran.
  if (!payload) return null;
  const found = new Map<string, CoreMissingPlugin>();
  // Read on BOTH exits. The measured shape is `valid: true` with exit 0 — an
  // entry with no package behind it is a warning, not a refusal — but a config
  // that is refused for some other reason carries the same warnings, and a box
  // in that state is exactly one that must not stay dark over a second cause.
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  for (const warning of warnings) {
    const { path: at, message } = (warning ?? {}) as { path?: unknown; message?: unknown };
    if (typeof message !== "string" || !CORE_PLUGIN_NOT_INSTALLED_RE.test(message)) continue;
    const configuredId = typeof at === "string"
      ? (CORE_PLUGIN_WARNING_PATH_RE.exec(at)?.[1] ?? "")
      : "";
    if (!configuredId) continue;
    // `canonicalPluginId`, the rule every other reader of this marker uses —
    // it strips the `-provider` suffix as well as the two prefixes. Matching
    // on `normalizeManagedPluginId` here and `canonicalPluginId` everywhere
    // else meant a config key of `@openclaw/foo-provider` and a refusal naming
    // `foo` did not meet, and the box stayed dark. `deepseek` is filed exactly
    // that way, which is why the canonical rule exists at all.
    const spec = CORE_PLUGIN_INSTALL_SPEC_RE.exec(message)?.[1] ?? "";
    found.set(canonicalPluginId(configuredId), {
      configuredId,
      reason: message,
      spec: NPM_PACKAGE_SPEC_RE.test(spec) ? spec : "",
    });
  }
  return found;
}

/**
 * Is this entry SWITCHED OFF, by the core's own rule?
 *
 * `enabled === false` and nothing else. An entry with no `enabled` key at all
 * is ACTIVE on 2026.8.1 — `resolvePluginActivationDecisionShared` short-circuits
 * only on an explicit `false` and otherwise falls through to its default
 * decision — so reading "off" from a missing key would skip exactly the entries
 * a provider-config flow writes (`{ "config": { … } }`, no `enabled`), leave
 * the gateway refusing readiness over them and say nothing. The same rule
 * `pluginConsentRepairIsAllowed` already applies one function away: absent or
 * unreadable is not an opt-out.
 *
 * Deliberately NOT `pluginEntryEnabled`, whose strict `=== true` belongs to its
 * own caller — the post-`plugins enable` read-back, where "we could not read
 * the config" must answer "not proved" and keep the badge.
 *
 * A config that cannot be read answers FALSE here, and that is right for both
 * uses: as the guard it means "try the switch-off" (the core has just told us
 * the entry is there), and as the read-back it means "this is not proved", so
 * the row says the write did not land rather than claiming it did.
 */
async function pluginEntryExplicitlyDisabled(configuredId: string): Promise<boolean> {
  const cfg = await readOpenclawConfigForRepair();
  if (!cfg) return false;
  const plugins = cfg.plugins && typeof cfg.plugins === "object"
    ? cfg.plugins as Record<string, unknown>
    : {};
  const entries = plugins.entries && typeof plugins.entries === "object"
    ? plugins.entries as Record<string, unknown>
    : {};
  const entry = entries[configuredId];
  return !!entry && typeof entry === "object"
    && (entry as Record<string, unknown>).enabled === false;
}

/**
 * Switch the stranded entries off through the REPO's own config writer.
 *
 * `runOpenclawConfigSetBatch` rather than a bare spawn, and not for tidiness:
 * it is the writer this repo already owns for this exact key (the Retry route
 * writes `plugins.entries["<id>"].enabled` with it). It retries
 * `ConfigMutationConflictError` — whose own doc names back-to-back `config set`
 * calls as the trigger, which is precisely what eleven stranded entries would
 * otherwise be — it settles a write killed at its deadline against the config
 * on disk, and the batch form spends ONE CLI cold start instead of eleven.
 * That last part is downtime: this runs inside `withGatewayQuiesced`, with the
 * gateway stopped, so ~12 s and ~2 minutes are the same difference to the owner.
 *
 * The batch is ATOMIC, which is the one thing that could make it worse than
 * the loop: one entry the CLI refuses would take the other ten down with it and
 * leave the box dark. So a failed batch falls back to one write per entry, and
 * a single entry that cannot be written costs only itself.
 *
 * `openclawChildEnv()` is passed through, and its `delete OPENCLAW_HOME` does
 * NOT survive `spawnOpenclaw`'s own `{ HOME, ...process.env, ...options.env }`
 * merge — an inherited `OPENCLAW_HOME` is re-admitted. That is harmless here
 * for the reason `runCurrentGatewayPreStart` gives: `OPENCLAW_STATE_DIR` and
 * `OPENCLAW_CONFIG_PATH` are the two canonical CLI overrides and they pin the
 * child to the real tree whatever else is set.
 */
async function switchOffStrandedEntries(entries: readonly CoreMissingPlugin[]): Promise<void> {
  const writes = entries.map((entry) =>
    [`plugins.entries["${entry.configuredId}"].enabled`, "false", "--strict-json"]);
  const options = { timeoutMs: 60_000, env: openclawChildEnv() };
  try {
    await runOpenclawConfigSetBatch(writes, options);
    return;
  } catch (err) {
    if (writes.length === 1) {
      console.warn(
        `[Updater] \`config set\` did not complete for "${entries[0].configuredId}"; `
        + "reading the config back anyway:",
        err instanceof Error ? err.message : err,
      );
      return;
    }
    console.warn(
      "[Updater] the batched switch-off of the stranded plugin entries did not complete; "
      + "writing them one at a time so a single refusal cannot keep the rest enabled:",
      err instanceof Error ? err.message : err,
    );
  }
  for (const write of writes) {
    await runOpenclawConfigSet(write, options).catch((err) => {
      console.warn(
        `[Updater] \`config set\` did not complete for ${write[0]}; reading the config back anyway:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
}

/**
 * The entries a core bump stranded: enabled, blocking readiness, and with no
 * package behind them (TASK-738).
 *
 * WHAT THE RULE ACTUALLY IS. Not "an older core bundled it" and not "the owner
 * never asked for it" — neither is knowable here. It is: the gateway's refusal
 * named this plugin, ClawBox does not manage it, and the installed core says it
 * has no package for the entry. Whoever put the entry there, the box cannot
 * load it and cannot report ready while it is on. The blast radius is bounded
 * by the core's own wording: `plugin not installed: <id> — install the official
 * external plugin with …` is emitted only for the OFFICIAL EXTERNAL CATALOG; a
 * genuinely third-party entry gets `plugin not found: <id> (stale config entry
 * ignored…)`, which `CORE_PLUGIN_NOT_INSTALLED_RE` does not match. So what this
 * can switch off is an official plugin — one an older core bundled, or one the
 * owner installed himself and this core bump stranded — and his route back is
 * the row it files, whose Retry runs the core's own install.
 *
 * WHY DISABLE RATHER THAN INSTALL. `plugins install` WITHOUT
 * `--accept-capabilities` leaves the gateway refusing readiness for exactly the
 * same entry, so the install only helps if ClawBox also consents on the owner's
 * behalf for a plugin it neither chose nor pinned — precisely what
 * `CLAWBOX_MANAGED_PLUGIN_IDS` exists to prevent — and eleven npm fetches on a
 * Jetson mid-update is the wrong cost for a provider nobody may use. So the
 * entry is switched off, the box comes back, and the install the core named is
 * offered on a Settings row where the owner's press supplies the consent:
 * `/setup-api/plugins/repair` runs `openclaw plugins install <spec> --force
 * --accept-capabilities`, bounded, with the package the CORE named rather than
 * one guessed from the id.
 *
 * Nothing of the owner's is deleted or overwritten: only `enabled` moves, and
 * an entry that is already explicitly `enabled: false` is not touched at all —
 * the core warns about those too (measured), and writing over one would be
 * answering a question he has already answered.
 */
async function disableStrandedPluginEntries(blockingIds: Iterable<string>): Promise<void> {
  const wanted = new Set<string>();
  for (const id of blockingIds) wanted.add(canonicalPluginId(id));
  if (wanted.size === 0) return;
  const missing = await coreReportedMissingPlugins();
  const stranded: CoreMissingPlugin[] = [];
  for (const key of wanted) {
    // Said out loud in every arm rather than skipped in silence: the update log
    // is where a support session looks for why nothing happened, and each of
    // these means something different.
    if (!missing) {
      console.info(
        `[Updater] "${key}" is blocking gateway readiness and is not a ClawBox-managed plugin; `
        + "the core could not be asked whether its package is even installed — leaving it to its owner",
      );
      continue;
    }
    const entry = missing.get(key);
    if (!entry) {
      console.info(
        `[Updater] "${key}" is blocking gateway readiness and is not a ClawBox-managed plugin — leaving it to its owner`,
      );
      continue;
    }
    if (await pluginEntryExplicitlyDisabled(entry.configuredId)) {
      // ALREADY OFF, and no row is filed for it here. From the config alone
      // this state is indistinguishable from "the owner switched it off
      // himself", and badging his own decision as "needs repair" is the false
      // failure this whole surface exists to avoid. The gap it leaves — a row
      // ClawBox owed and could not write — is closed at the other end instead,
      // by filing the row BEFORE the switch-off.
      console.info(
        `[Updater] "${entry.configuredId}" has no package on this core and is already switched off; leaving it alone`,
      );
      continue;
    }
    stranded.push(entry);
  }
  if (stranded.length === 0) return;
  // THE ROW FIRST, saying nothing has been changed yet. The switch-off is what
  // the owner sees the consequence of, so the record of it must not depend on a
  // write that happens afterwards: a marker write that failed once would
  // otherwise leave the entry off with nothing on screen, and the next pass
  // cannot tell that state from an entry the owner disabled himself. Written
  // again below with what the read-back proved, which is the only field that
  // can still change.
  for (const entry of stranded) await recordMissingPluginRow(entry, false);
  await switchOffStrandedEntries(stranded);
  for (const entry of stranded) {
    // PROVED AGAINST THE FILE, never against an exit code — the same read-back
    // the boot script's own `clawbox_plugin_disable` does, and the reason this
    // is a separate pass: `runOpenclawConfigSetBatch` verifies its own writes,
    // but the per-entry fallback above can leave some landed and some not.
    const disabled = await pluginEntryExplicitlyDisabled(entry.configuredId);
    if (disabled) {
      console.info(
        `[Updater] "${entry.configuredId}" has no package on this core and was blocking gateway readiness; `
        + "switched it off so the gateway can start — Settings shows it as needing repair",
      );
    } else {
      console.warn(
        `[Updater] "${entry.configuredId}" has no package on this core and could not be switched off; `
        + "the gateway may go on refusing readiness until it is repaired",
      );
    }
    // …and updated only when the switch-off landed: the row written above
    // already says `disabled: false`, which is exactly right for an entry this
    // pass could not switch off.
    if (disabled) await recordMissingPluginRow(entry, true);
  }
}

/**
 * File the Settings row for one stranded entry.
 *
 * Never fatal — the gateway coming back outranks the bookkeeping — but never
 * silent either: a row that was not written is a plugin switched off with
 * nothing on screen to say so, and the update log is the only place left to
 * say it.
 *
 * Called twice per entry — once before the switch-off and once after a proved
 * one — so the row exists whatever the second write does. `disabled` is the
 * only field that changes between the two, and it is what tells the Retry
 * whether it has an entry of ClawBox's to switch back on.
 */
async function recordMissingPluginRow(
  entry: CoreMissingPlugin,
  disabled: boolean,
): Promise<void> {
  try {
    await recordPluginRepair({
      id: entry.configuredId,
      stage: "not-installed",
      reason: entry.reason,
      disabled,
      spec: entry.spec,
    });
  } catch (err) {
    console.warn(
      `[Updater] the "${entry.configuredId}" repair record could not be written; `
      + "Settings will show the row as simply not connected:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Repair every ClawBox-managed plugin a concrete gateway refusal names.
 *
 * WHY THIS IS NOT CODEX-ONLY ANY MORE (TASK-603). The gateway refuses readiness
 * for ANY enabled plugin whose declared capability surface has not been
 * consented to, and it names the plugin in the refusal. Until now this repair
 * matched the literal word `codex`, so a box blocked on `discord` or `whatsapp`
 * — the channel plugins the Settings panel installs — went through the whole
 * recovery untouched and ended at `getGatewayFailureDetail`, which handed the
 * owner the core's own sentence: "rerun with --accept-capabilities". That is
 * advice about a CLI he never ran, over a box that will not come back until
 * somebody runs it for him. This is the tool doing the thing itself.
 *
 * WHY THERE ARE TWO REFUSALS (TASK-602). Consent is the refusal a plugin gets
 * when its package is on disk and its reviewed surface is stale. A CORE UPGRADE
 * produces the other one: plugin payloads live in npm project directories keyed
 * to the core generation, so a bump strands the packages installed under the
 * old one and the core's startup verification refuses over a payload that is
 * not there. `plugins enable` cannot answer that, which is why the outage of
 * 2026-09-01 survived a repair that only knew the consent sentence — the
 * gateway then failed 21 times, systemd gave up, and the owner was left on
 * "Connecting to gateway…" with no route back short of a hand-run CLI.
 *
 * WHY NOT `openclaw update repair --accept-capabilities`, which IS the harness's
 * own post-core convergence and DOES take that flag on the pinned 2026.8.1: it
 * consents for everything blocked, the owner's own plugins included. The
 * whitelist is the point, so ClawBox drives the same underlying verbs per
 * plugin instead. The core runs that convergence itself at startup
 * (`runStartupUpgradeConvergence`), and it is exactly the capability-consent
 * callback it has no way to answer there; the installed bundle exposes no
 * config key and no environment variable for it, only the CLI flag.
 */
interface PluginRepairOptions {
  /**
   * Consent only — no npm install.
   *
   * For the path where the pre-start FAILED: a payload reinstall is up to six
   * minutes per plugin (`gateway_verify` is a `customRun` step, so its
   * `timeoutMs` is unenforced and nothing bounds the total), spent after a
   * pre-start that just died — possibly mid plugin migration, with OpenClaw's
   * five-minute state leases held — and ending in that pre-start's failure
   * anyway. `plugins enable` is local, ~12 s and safe there.
   */
  consentOnly?: boolean;
  /** Normalised ids whose payload the gateway pre-start has already put back. */
  alreadyRepaired?: Iterable<string>;
}

async function repairPluginsBlockingReadiness(
  journal: string,
  options: PluginRepairOptions = {},
): Promise<void> {
  const payload = options.consentOnly
    ? { managed: [], unmanaged: [] }
    : pluginsNamedInRefusals(journal, PLUGIN_PAYLOAD_VERIFICATION_RE);
  const consent = pluginsNamedInRefusals(journal, PLUGIN_CAPABILITY_CONSENT_RE);
  // A plugin ClawBox does not manage is still not something a box may be left
  // dark over. The core is asked which of them have no package at all, and
  // those entries — and only those — are switched off; the rest are the
  // owner's, and are logged and left (TASK-738).
  //
  // RUN ON THE `consentOnly` PATH TOO, deliberately, although that option
  // exists to keep minutes of CLI work off a failed pre-start. This is one
  // `config validate` and one batched `config set` — seconds, not the six
  // minutes per plugin an npm reinstall costs — and unlike a consent record it
  // is the write that lets the NEXT boot come up, on a path that is about to
  // report the pre-start's failure either way.
  await disableStrandedPluginEntries([...payload.unmanaged, ...consent.unmanaged]);
  // Payloads FIRST, and the plugins they repaired are then skipped by the
  // consent pass below: `plugins install --accept-capabilities` puts the
  // package back AND records the reviewed surface, so a following `enable`
  // would be a second ~12 s CLI cold start for a question already answered.
  // Only a reinstall that SUCCEEDED counts: `plugins enable` is the one repair
  // here that touches no registry, and skipping it because a network install
  // was attempted would drop the repair that could still have worked on a box
  // whose network is why the update is being repaired.
  const repaired = new Set<string>(options.alreadyRepaired ?? []);
  for (const pluginId of payload.managed) {
    const key = normalizeManagedPluginId(pluginId);
    // The pre-start reinstalls the channel payloads too, and it ran a moment
    // ago against this same box. Re-issuing the byte-identical install would
    // pay a second npm fetch per plugin for a package already back on disk.
    if (repaired.has(key)) {
      console.info(`[Updater] "${pluginId}" payload was already reinstalled by the gateway pre-start`);
      continue;
    }
    if (await repairManagedPluginPayload(pluginId)) repaired.add(key);
  }
  for (const pluginId of consent.managed) {
    if (repaired.has(normalizeManagedPluginId(pluginId))) continue;
    // Codex answers a consent refusal with the same pinned force-install it
    // answers a missing payload with: a v1 migration can leave that ONE plugin
    // as a project declaration with no `node_modules`, where `enable` says
    // "Plugin not found".
    if (normalizeManagedPluginId(pluginId) === "codex") {
      // Codex has its own opt-out test, which also asks whether Codex is in
      // use at all.
      if (!(await codexCapabilityRepairIsAllowed())) continue;
      if (options.consentOnly) {
        // After a FAILED pre-start, the local verb — like every other managed
        // plugin here. Codex's pinned reinstall exists because a migrated v1
        // project can leave the declaration without `node_modules`, where
        // `enable` answers "Plugin not found"; that is worth minutes of npm on
        // the path that can restart the gateway afterwards, and not on the one
        // that is about to report the pre-start's failure either way.
        await recordPluginCapabilityConsent(pluginId);
        continue;
      }
      // One spec, not two: the unpinned fallback exists for a payload that is
      // GONE and may not be published under the pin's build suffix. Here the
      // package is on disk and only its consent record is stale.
      //
      // AND CLEAR THE MARKER, the same statement `recordPluginCapabilityConsent`
      // makes after its own `enable`: the boot script's row is the only thing
      // telling Settings this plugin needs repair, and one that only the boot
      // script ever cleared is a permanent badge on a plugin this update has
      // just put back (TASK-606).
      if (await reinstallManagedPluginPayload("@openclaw/codex", false)) {
        await clearRepairMarkerAfterPayloadRepair(pluginId);
      }
      continue;
    }
    if (!(await pluginConsentRepairIsAllowed(pluginId))) continue;
    await recordPluginCapabilityConsent(pluginId);
  }
}

/**
 * Put the entry back and THEN clear the marker, after a payload reinstall.
 *
 * `openclaw plugins install` deliberately leaves an entry whose
 * `plugins.entries.<id>.enabled` is explicitly `false` alone — and that is what
 * the boot script's own boot-without wrote when it could not install the plugin.
 * So a successful reinstall is not yet a plugin that loads: clearing the badge
 * on it alone takes the only visible sign off a plugin that is still switched
 * off. `plugins enable` is the harness's own verb for the pair, and it
 * re-records the consent surface at the same time.
 *
 * Only for a row that says CLAWBOX switched it off. `disabled: false` means a
 * failure was recorded and nothing was changed, and an entry the owner turned
 * off is his.
 *
 * If the re-enable fails the marker STAYS: the badge is then the only true
 * thing on the owner's screen, and the Retry it offers is his way to try again.
 */
async function clearRepairMarkerAfterPayloadRepair(pluginId: string): Promise<void> {
  // `clawboxDisabledEntryId` matches on the canonical id and answers the key the
  // row was written under, so an alias (`@openclaw/discord`) is enabled under
  // the spelling the registry knows.
  const switchedOff = await clawboxDisabledEntryId(pluginId).catch(() => null);
  if (switchedOff) {
    try {
      await execFile(
        OPENCLAW_BIN,
        ["plugins", "enable", switchedOff, "--accept-capabilities"],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (err) {
      console.warn(
        `[Updater] "${switchedOff}" was reinstalled but could not be switched back on; `
        + "leaving its repair record in place:",
        err instanceof Error ? err.message : err,
      );
      return;
    }
    // PROVED AGAINST THE FILE, not against the exit code — the same read-back
    // the boot script's own re-enable does. This whole card exists because an
    // exit code was read as an outcome, and a `plugins enable` that returns 0
    // without writing would otherwise clear the badge over an entry still off.
    if (!(await pluginEntryEnabled(switchedOff))) {
      console.warn(
        `[Updater] "${switchedOff}" still reads as switched off after \`plugins enable\`; `
        + "leaving its repair record in place",
      );
      return;
    }
  }
  await clearRepairMarker(pluginId);
}

/**
 * Clear a TASK-606 repair marker after a repair that actually worked — and SAY
 * so when the clear itself fails.
 *
 * Never fatal: the repair happened, and failing an update over the bookkeeping
 * would be a false failure. But a marker left behind is a "Needs repair" badge
 * on a plugin that is now fine, which the owner cannot act on because the Retry
 * it offers will succeed and change nothing he can see — so it goes in the
 * update log, where that is looked for.
 */
async function clearRepairMarker(pluginId: string): Promise<void> {
  try {
    await clearPluginRepair(pluginId);
  } catch (err) {
    console.warn(
      `[Updater] the "${pluginId}" repair marker could not be cleared; Settings may still offer a Retry:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Put a managed plugin's payload back, pinned to the core now on the box.
 *
 * Returns whether the package is believed to be back. False covers both
 * "nothing was tried" — the owner switched the plugin off, Codex is not in
 * use, the payload is not this file's to replace — and "the install failed",
 * because both leave the consent repair below worth attempting.
 */
async function repairManagedPluginPayload(
  pluginId: string,
  options: { fallbackToUnpinned?: boolean } = {},
): Promise<boolean> {
  const key = normalizeManagedPluginId(pluginId);
  const npmPackage = MANAGED_PLUGIN_NPM_PACKAGES.get(key);
  if (!npmPackage) {
    // The pre-start owns this one, and `runCurrentGatewayPreStart()` has just
    // run it. Saying so beats a silent skip: if the refusal survived that, the
    // update log is where the reason will be looked for.
    console.info(
      `[Updater] "${pluginId}" failed payload verification; its install is the gateway pre-start's, which has already run`,
    );
    return false;
  }
  // Codex has its own opt-out test, which also asks whether Codex is in use at
  // all — an owner who moved to another provider must not have a stale journal
  // line buy him a six-minute npm install on every update.
  const allowed = key === "codex"
    ? await codexCapabilityRepairIsAllowed()
    : await pluginConsentRepairIsAllowed(pluginId);
  if (!allowed) return false;
  const installed = await reinstallManagedPluginPayload(npmPackage, options.fallbackToUnpinned !== false);
  // Same reason as the Codex arm above: a payload this update put back is not
  // a plugin Settings should go on offering a Retry for.
  if (installed) await clearRepairMarkerAfterPayloadRepair(pluginId);
  return installed;
}

/**
 * `plugins install <pkg>@<core target> --force --accept-capabilities`.
 *
 * Pinned to the core the box is on, because both states this repairs are about
 * the core: a migrated v1 install can leave only the managed-project
 * declaration without node_modules, and a core BUMP re-keys the npm project
 * directories so the payloads built for the old generation are unreachable
 * (TASK-602). `enable` answers neither — it says "Plugin not found" — while a
 * pinned force-install rebuilds the project and records consent in one
 * idempotent operation. OpenClaw state leases live for five minutes after a
 * killed startup, so this budget must outlast that bounded stale lease.
 */
async function reinstallManagedPluginPayload(
  npmPackage: string,
  fallbackToUnpinned: boolean,
): Promise<boolean> {
  let target = OPENCLAW_VERSION_FALLBACK;
  try {
    target = (await readFile(OPENCLAW_TARGET_FILE, "utf-8")).trim().split(/\s+/)[0] || target;
  } catch {
    // The compiled fallback is the same pin used by the installer.
  }
  // Pinned first, then unpinned — the shape `deepseekPluginSpecs` already uses
  // in this repo, and for its reason: npm republishes a release under a build
  // suffix (2026.7.1 -> 2026.7.1-2), and a plugin published only under the base
  // version 404s on a pin carrying one. The unpinned spec is safe as a LAST
  // resort because the core checks the plugin's own `compat.pluginApi` against
  // the running host and refuses a mismatch.
  const specs = fallbackToUnpinned
    ? [`${npmPackage}@${target}`, npmPackage]
    : [`${npmPackage}@${target}`];
  let lastError: unknown;
  for (const spec of specs) {
    try {
      await execFile(
        OPENCLAW_BIN,
        ["plugins", "install", spec, "--force", "--accept-capabilities"],
        { timeout: 360_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return true;
    } catch (err) {
      lastError = err;
    }
  }
  // Best effort: the clean restart and positive port probe below decide the
  // result. This must not replace a preceding pre-start failure either.
  console.warn(
    `[Updater] payload repair for "${npmPackage}" did not complete:`,
    lastError instanceof Error ? lastError.message : lastError,
  );
  return false;
}

/**
 * Record consent for an already-installed managed plugin.
 *
 * `plugins enable` rather than a reinstall, for the reason
 * `scripts/gateway-pre-start.sh` gives at its own codex consent branch: it is
 * the idempotent local operation that records the current reviewed surface and
 * leaves an already-consented plugin alone, and it touches no registry — which
 * matters here, because this runs mid-update on a box whose network may be
 * exactly why the update is being repaired. The Codex arm above reinstalls
 * instead only because a v1 migration can leave that ONE plugin as a project
 * declaration with no `node_modules`, a state its own pin repairs.
 *
 * LIMIT, deliberately not papered over: if a managed plugin is in that partial
 * state, `enable` answers "Plugin not found" and this warns rather than
 * fetching an unpinned package from npm mid-update. The gateway's own refusal
 * then still reaches the owner through `getGatewayFailureDetail`; what he does
 * not get is a silent claim that ClawBox repaired it.
 */
async function recordPluginCapabilityConsent(pluginId: string): Promise<void> {
  try {
    await execFile(
      OPENCLAW_BIN,
      ["plugins", "enable", pluginId, "--accept-capabilities"],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    // The OTHER repair path for the same state (TASK-606). A marker the boot
    // script wrote and only the boot script cleared would leave a permanent
    // "Needs repair" badge on a plugin this update just consented — the false
    // failure that costs a support ticket over a box that is now fine.
    await clearRepairMarker(pluginId);
  } catch (err) {
    // Best effort, like the Codex branch above: the clean restart and the
    // positive port probe decide the result, and this must not replace a
    // preceding pre-start failure.
    console.warn(
      `[Updater] capability consent for "${pluginId}" did not complete:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * openclaw.json as the consent repairs read it, or null when it cannot be read.
 *
 * Null is "no explicit opt-out on record", never "switched off": a missing or
 * malformed config must not be what stops a box from coming back.
 */
async function readOpenclawConfigForRepair(): Promise<Record<string, unknown> | null> {
  // `OPENCLAW_CONFIG` first, and the helper deliberately does not settle it:
  // this caller READS a file, `runCurrentGatewayPreStart` passes `process.env`
  // through to a script that prefers the same name, and `openclawChildEnv`
  // alone ignores it because the core CLI reads `OPENCLAW_CONFIG_PATH` instead.
  // Nothing on a box sets `OPENCLAW_CONFIG` — it is a test-only name — but
  // folding three different rules into one shared one is how they would come to
  // address different files.
  const configPath = process.env.OPENCLAW_CONFIG
    || path.join(openclawTreePaths().openclawHome, "openclaw.json");
  try {
    return JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Does openclaw.json now say this plugin's entry is enabled?
 *
 * False for a config that cannot be read: an unverifiable write is not a
 * verified one, and the caller's answer to that is to keep the repair record —
 * a badge that is one boot stale beats a badge removed over a plugin still off.
 */
async function pluginEntryEnabled(pluginId: string): Promise<boolean> {
  const cfg = await readOpenclawConfigForRepair();
  if (!cfg) return false;
  const plugins = cfg.plugins && typeof cfg.plugins === "object"
    ? cfg.plugins as Record<string, unknown>
    : {};
  const entries = plugins.entries && typeof plugins.entries === "object"
    ? plugins.entries as Record<string, unknown>
    : {};
  const entry = entries[pluginId];
  return !!entry && typeof entry === "object"
    && (entry as Record<string, unknown>).enabled === true;
}

/** Respect an owner-disabled unused Codex plugin even if old logs mention it. */
async function codexCapabilityRepairIsAllowed(): Promise<boolean> {
  try {
    const cfg = await readOpenclawConfigForRepair();
    if (!cfg) return true;
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
    // The same TASK-606 caveat as `pluginConsentRepairIsAllowed`: a `false`
    // ClawBox wrote at boot so the gateway could start is not the owner's veto,
    // and reading it as one would leave Codex permanently unrepairable.
    if (await clawboxSwitchedPluginOff("codex")) return true;

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
    // The retired namespaces, asked once from the module that owns them. On
    // the pinned core the canonical reference is `openai/<id>` and the signal
    // is the runtime arm below — these still hold for a box mid-migration.
    if (modelRefs.some((ref) => typeof ref === "string" && isLegacyCodexRef(ref))) return true;

    const models = defaults.models && typeof defaults.models === "object"
      ? defaults.models as Record<string, unknown>
      : {};
    if (Object.values(models).some((settings) => {
      if (!settings || typeof settings !== "object") return false;
      const runtime = (settings as Record<string, unknown>).agentRuntime;
      return !!runtime && typeof runtime === "object"
        && String((runtime as Record<string, unknown>).id || "").toLowerCase() === CHATGPT_AGENT_RUNTIME_ID;
    })) return true;

    const auth = cfg.auth && typeof cfg.auth === "object"
      ? cfg.auth as Record<string, unknown>
      : {};
    const profiles = auth.profiles && typeof auth.profiles === "object"
      ? auth.profiles as Record<string, unknown>
      : {};
    // The OpenClaw 2 sign-in counts too, and on its own: a box with
    // `openai:chatgpt` but no runtime arm — the isLocalScope save path, a
    // hand-edited config, or the dual-credential box the boot seed
    // deliberately skips — used to answer "codex not in use" here and have the
    // capability repair skipped on every update.
    if (hasChatgptOauthProfile(profiles as AuthProfileEntries)) return true;
    return Object.entries(profiles).some(([id, profile]) =>
      isLegacyChatgptProvider(id.split(":")[0])
        || isLegacyChatgptProvider(
          profileProviderId(id, profile as { provider?: string } | undefined),
        ),
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
  // Order is priority, not chronology: the FIRST pattern with a match wins.
  // A payload that is not on disk outranks a consent question about it, and
  // both outrank systemd's own "Start request repeated too quickly", which is
  // what `lines.at(-1)` hands back once the unit has hit its start limit —
  // true, and nothing the owner can act on (TASK-602).
  for (const pattern of [
    PLUGIN_PAYLOAD_VERIFICATION_RE,
    PLUGIN_CAPABILITY_CONSENT_RE,
    /SQLite transaction lock wait failed/i,
  ]) {
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
    let preStartOutput: string;
    try {
      preStartOutput = await runCurrentGatewayPreStart();
    } catch (err) {
      // If an earlier pre-start migration fails, still record the narrowly
      // scoped consent named by the existing journal. Do not restart after a
      // partial pre-start; propagate its failure once the repair is recorded.
      // Consent only here — see PluginRepairOptions.
      await repairPluginsBlockingReadiness(journal, { consentOnly: true });
      throw err;
    }
    await repairPluginsBlockingReadiness(journal, {
      alreadyRepaired: pluginPayloadsRepairedByPreStart(preStartOutput),
    });
    await runOpenclawDoctorFix();
  });
  // `awaitReady: false` on both restarts in this function, and only here: the
  // recovery below IS the readiness wait, with a longer budget and a journal
  // read that turns "not listening" into a diagnosis. A throw from inside
  // restartGateway would abort the function before the legacy-state quarantine
  // it exists to perform ever ran.
  await restartGateway({ awaitReady: false });
  if (await waitForGateway(GATEWAY_RECOVERY_WAIT_MS)) return;

  const beforeRecoveryLog = await readGatewayJournalTail();
  if (!LEGACY_GATEWAY_BLOCKER_RE.test(beforeRecoveryLog)) {
    throw new Error(await describeDeadGateway(beforeRecoveryLog));
  }

  await withGatewayQuiesced(async () => {
    await quarantineLegacyOpenclawState();
    await runOpenclawDoctorFix();
  });
  await restartGateway({ awaitReady: false });
  if (await waitForGateway(GATEWAY_RECOVERY_WAIT_MS)) return;

  const afterRecoveryLog = await readGatewayJournalTail();
  throw new Error(
    await describeDeadGateway(afterRecoveryLog, "OpenClaw gateway still offline after legacy state recovery"),
  );
}

/**
 * Say WHY the gateway is not there, in the order of what the owner can act on.
 *
 * A configuration the core refuses outranks anything in the journal, because
 * it is a cause rather than a symptom and it is the one the journal states
 * worst. On a 2026.7 → 2026.8 core upgrade whose migration did not run, the
 * gateway's own last line is `Run "openclaw doctor --fix" to repair the
 * config, then retry.` — advice for a command ClawBox has just run and that
 * has just failed — and `getGatewayFailureDetail` hands exactly that line back
 * as the cause (measured against 2026.8.1 on 2026-09-06). The keys the core
 * actually named are three lines further up and were never reported at all.
 *
 * Asked only here, on a path where the update has already failed: a healthy
 * update never pays for the extra CLI call.
 */
async function describeDeadGateway(
  journal: string,
  prefix = `OpenClaw gateway is not listening on port ${GATEWAY_PORT}`,
): Promise<string> {
  // Asked again rather than reusing the plugin repair's answer: that one was
  // taken BEFORE the repair rewrote the config, and this is a diagnosis of the
  // state the gateway just failed from.
  const refusal = await getOpenclawConfigRefusal();
  if (refusal) {
    return `${prefix}: OpenClaw refuses this device's configuration — ${refusal}`;
  }
  const lastLog = getGatewayFailureDetail(journal);
  return lastLog ? `${prefix}: ${lastLog}` : prefix;
}

const UPDATE_STEPS: UpdateStepDef[] = [
  {
    id: "bootstrap_updater",
    label: "Refreshing updater scripts",
    // 180 s, raised from 120: this step's fetch now retries (install.sh
    // `git_with_retry`, up to 3 attempts with 3 s + 6 s of backoff). A retry
    // that gets the fetch through on attempt 3 only to be killed by the budget
    // it needed would turn an intermittent refusal into a hard failure, which
    // is the retry paying for itself and then being billed for it. TASK-655.
    timeoutMs: 180_000,
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
 * service. The main service runs as clawbox with NoNewPrivileges=true, so the
 * escalation is systemd's: the template service runs as root.
 *
 * Through the root-owned launcher, not `systemctl start` directly. This used to
 * be an unprivileged systemctl call authorised by the unscoped polkit
 * `manage-units` grant -- the same action that authorises `systemd-run`, i.e.
 * arbitrary root with no password. TASK-539.
 */
async function execAsRoot(stepId: string, timeoutMs: number): Promise<void> {
  const serviceName = `clawbox-root-update@${stepId}.service`;
  const startedAt = Date.now();
  try {
    await startRootStep(stepId, { timeoutMs: timeoutMs + 30_000 });
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
  /**
   * Whether this check could actually reach the update remote.
   *
   * Without it "no update available" is unfalsifiable: a device GitHub is
   * refusing produces exactly the same payload as a device that is genuinely
   * current, and the one screen whose job is "should I update?" answers
   * "You're up to date" (TASK-655, fleet-wide, measured 2026-09-02).
   */
  remote: RemoteReachability;
}

/**
 * How the last real tag lookup went. Kept beside `cachedTargetVersion` and
 * invalidated with it, so a cached version and the reachability that produced
 * it can never disagree.
 */
let lastTagRemote: RemoteReachability = REMOTE_REACHABLE;

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
  lastTagRemote = REMOTE_REACHABLE;
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
 *
 * TASK-613: remove once hermes-agent#104275 lands (HERMES_DISABLE_UPDATE_CHECK
 * / updates.check). `hermes --version` is the one hermes call that runs the
 * agent's passive update check, and every six hours the first probe pays for a
 * `git fetch` plus a GitHub compare inside the 10 s allowed for the whole call
 * — after which this reads a timeout and answers null over an agent that is
 * running perfectly. `silenceUpdateCheck` asks for the same banner without it,
 * and falls back to the plain call if it cannot.
 */
async function readHermesVersion(): Promise<string | null> {
  try {
    const { code, stdout } = await runHermesCli(["--version"], {
      timeoutMs: 10_000,
      silenceUpdateCheck: true,
    });
    if (code !== 0) return null;
    return parseHermesVersion(stdout);
  } catch {
    return null;
  }
}

interface PinnedBranchCheck {
  target: { branch: string; currentSha: string; targetSha: string } | null;
  remote: RemoteReachability;
}

/**
 * Compare the device against its pinned branch on origin.
 *
 * The fetch outcome is RETURNED, not swallowed. It used to be
 * `.catch(() => {})`, after which HEAD was compared against whatever
 * `origin/<branch>` the last successful fetch had left: on a box GitHub was
 * refusing, that is HEAD itself, so the answer was "no update" and the About
 * screen said "You're up to date" about a check that never happened
 * (TASK-655).
 */
async function getPinnedBranchTarget(projectDir: string): Promise<PinnedBranchCheck> {
  let branch: string;
  try {
    branch = (await readFile(path.join(projectDir, ".update-branch"), "utf-8")).trim();
  } catch {
    return { target: null, remote: REMOTE_REACHABLE };
  }
  if (!branch || !isSafeBranch(branch)) return { target: null, remote: REMOTE_REACHABLE };

  const remote = await reachOrigin(projectDir, ["fetch", "--quiet", "origin", branch], {
    timeout: 20_000,
    attempts: REMOTE_CHECK_ATTEMPTS,
    retryDelayMs: REMOTE_CHECK_RETRY_DELAY_MS,
  });
  try {
    const [{ stdout: currentOut }, { stdout: targetOut }] = await Promise.all([
      execGit(projectDir, ["rev-parse", "HEAD"], { timeout: 10_000 }),
      execGit(projectDir, ["rev-parse", `origin/${branch}`], { timeout: 10_000 }),
    ]);
    const currentSha = currentOut.trim();
    const targetSha = targetOut.trim();
    if (!currentSha || !targetSha || currentSha === targetSha) return { target: null, remote };
    return { target: { branch, currentSha, targetSha }, remote };
  } catch {
    return { target: null, remote };
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
  const { target: pinnedBranchTarget, remote: pinnedRemote } = await getPinnedBranchTarget(PROJECT_DIR);
  // Two independent reads of the same remote — the tag list (getTargetVersion's
  // `ls-remote`, a GET to /info/refs) and the pinned branch's fetch (a POST to
  // /git-upload-pack). BOTH can be refused; the POST far more often, which is
  // what the card measured. Either failing means this check did not see the
  // remote, so the worse of the two is what the device reports.
  const remote = !pinnedRemote.reachable ? pinnedRemote : lastTagRemote;

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
    // Hermes IS pinned by ClawBox — `HERMES_PIN_COMMIT` in install.sh, which
    // `step_hermes_install` re-checks and repairs on every update, exactly as
    // `config/openclaw-target.txt` does for OpenClaw. What it has no target for
    // is this payload: the pin is a 40-char commit SHA and `hermes --version`
    // answers a release string, so there is nothing here the two can be
    // compared on. `target: null` therefore means "not comparable", not
    // "installed from somewhere ClawBox does not control".
    ...(hasHermes
      ? { hermes: { current: hermesCurrent, target: null, updateAvailable: false } }
      : {}),
    edition,
    remote,
  };
  versionInfoCacheTime = Date.now();
  return cachedVersionInfo;
}

export async function getTargetVersion(): Promise<string | null> {
  if (Date.now() - targetVersionCacheTime < TARGET_VERSION_CACHE_TTL) return cachedTargetVersion;
  try {
    // The tag fetch is ADVISORY: `ls-remote` below asks origin directly, so the
    // answer is not read from the local tag refs this call updates. Its refusal
    // is logged, never promoted — reporting the remote unreachable because an
    // advisory call was refused while the authoritative one answered is the
    // false-failure half of the same bug.
    const tagFetch = await reachOrigin(
      PROJECT_DIR,
      ["fetch", "--quiet", "--tags", "origin"],
      // The delay is explicit even at one attempt: dropping it would fall back
      // to the UPDATE path's 4 s budget, so raising REMOTE_ADVISORY_ATTEMPTS
      // later would silently put a 4 s sleep on every polled version check.
      { timeout: 20_000, attempts: REMOTE_ADVISORY_ATTEMPTS, retryDelayMs: REMOTE_CHECK_RETRY_DELAY_MS },
    );
    if (!tagFetch.reachable) console.warn(`[Updater] advisory tag fetch did not land: ${tagFetch.reason}`);
    // The AUTHORITATIVE call, and so the one that is retried. It used to get a
    // single attempt: one refused ls-remote then made every surface say the
    // update server could not be reached, and TARGET_VERSION_CACHE_TTL held
    // that answer for 60 s over a refusal that clears in seconds.
    const lsRemote = await readFromOrigin(
      PROJECT_DIR,
      ["ls-remote", "--tags", "--refs", "origin"],
      { timeout: 10_000, attempts: REMOTE_CHECK_ATTEMPTS, retryDelayMs: REMOTE_CHECK_RETRY_DELAY_MS },
    );
    if (!lsRemote.remote.reachable) {
      lastTagRemote = lsRemote.remote;
      cachedTargetVersion = null;
      targetVersionCacheTime = Date.now();
      return null;
    }
    const stdout = lsRemote.stdout;
    // origin answered, on the call the tag answer depends on.
    lastTagRemote = REMOTE_REACHABLE;
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
  } catch (err) {
    const text = errorText(err);
    lastTagRemote = {
      reachable: false,
      refusedAnonymously: isAnonymousFetchRefusal(text),
      reason: refusalReason(err, text),
    };
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
// The continuation being read, if one is. Assigned before that read's first
// await and cleared when it settles: `running` covers a launched run, this
// covers the reads before it, so two callers in one tick — the boot hook and
// a status poll — share one resume instead of each running their own, and no
// full run can start underneath it.
let continuationInFlight: Promise<boolean> | null = null;

/** An update owns the box: one is running, or a continuation is being read. */
function updateOwned(): boolean {
  return running || continuationInFlight !== null;
}

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
  continuationInFlight = null;
}

export type DismissOutcome =
  | { dismissed: true }
  | { dismissed: false; reason: "in-progress" | "not-written"; error: string };

/**
 * Forget a run that has already settled, at the owner's request.
 *
 * The state lives in this process's memory, so a failed run sits in it until
 * the web server restarts — and on 2026-09-05 the step that FAILED was the
 * restart. The System Update page now adopts a failure it did not start
 * (otherwise the owner is shown "1 update available" over a dead update), so
 * without this its Dismiss button could only hide the panel until the window
 * was reopened.
 *
 * Refuses while an update owns the box: this clears no `running` flag on
 * purpose — `resetUpdateState` does, and doing that here would let a second
 * run start beside the one still going. Answers WHY it refused, so the route
 * can say 409 over a live run and 500 over a store that would not take the
 * write, rather than one answer for two different things.
 *
 * The write is AWAITED. It used to be `void set(...)` with an unconditional
 * `true` beside it: the route answered 200, the owner's Dismiss looked like it
 * took, and the record was still on disk for the next poll to raise the same
 * failure from — the false-success class, on the one button whose whole job is
 * to make something go away.
 */
export async function dismissSettledUpdate(): Promise<DismissOutcome> {
  if (updateOwned() || state.phase === "running") {
    return { dismissed: false, reason: "in-progress", error: "An update is in progress" };
  }
  // The interrupted-run record is part of the result being dismissed. Without
  // this the next idle poll re-reads it and raises the same failure again,
  // which would make it undismissable — so the record goes FIRST, and the
  // in-memory state is only cleared once the disk agrees.
  //
  // …but only when there IS one. Most settled failures carry no record at all —
  // the rebuild-evidence verdict, any failed step, "No internet connection" —
  // and for those the write is a no-op deletion whose failure says nothing
  // about the thing being dismissed. Letting it refuse would make a failed
  // update UNDISMISSABLE on a box whose disk is full: the panel is re-adopted
  // on every reload, and the owner cannot reach the button that retries the
  // update. `getKnown` because "the store could not be read" is not evidence
  // that the key is unset — that store may well hold a record.
  const record = await getKnown(UPDATE_INTERRUPTED_KEY);
  if (!record.known || record.value !== undefined) {
    try {
      await set(UPDATE_INTERRUPTED_KEY, undefined);
    } catch (err) {
      console.warn(
        "[Updater] Could not forget the settled run:",
        err instanceof Error ? err.message : err,
      );
      // The reason travels; the store's own words do NOT. A write that failed
      // on the READ half is a JSON.parse error, and its message quotes a window
      // of data/config.json — which holds both bot tokens and the mailbox
      // password. That belongs in the log, not in an HTTP response body.
      return {
        dismissed: false,
        reason: "not-written",
        error: "The device could not save that change — see the server log.",
      };
    }
  }
  // Re-asked after the await: a run can claim the box while the write is in
  // flight, and resetting the state under it would show an empty step list
  // over an update that is going. Through `getUpdateState()` because the
  // compiler holds its narrowing of this module-level binding across the await
  // and would call the second read impossible — which is the whole race.
  if (updateOwned() || getUpdateState().phase === "running") {
    return { dismissed: false, reason: "in-progress", error: "An update is in progress" };
  }
  state = createInitialState(applicableSteps());
  return { dismissed: true };
}

/**
 * Is this state the remembered-interruption verdict, rather than a failure with
 * a cause of its own?
 *
 * Only that verdict may be taken back by a completion: a rebuild that failed is
 * a different finding, decided from evidence the markers say nothing about.
 */
export function isInterruptedVerdict(reported: UpdateState): boolean {
  return reported.phase === "failed" && reported.error === INTERRUPTED_MESSAGE;
}

/** The two durable records of how the last run ended. */
interface SettledMarkers {
  interruptedAt: string | null;
  completed: boolean;
  completedAt: string | null;
}

/**
 * …or `null` when the store could not be read.
 *
 * Through `getKnown`, not `get`: the forgiving reader answers `{}` to an
 * EACCES, a half-written file and a non-object JSON alike, and "we could not
 * read the file" is not evidence that a key is unset (config-store.ts says so
 * in as many words). Read the other way, an unreadable store would look like a
 * box with no interruption on it — and the caller would retract a verdict it
 * still has every reason to hold. `data/config.json` being briefly unreadable
 * is exactly what `post_update` can do to it.
 */
async function readSettledMarkers(): Promise<SettledMarkers | null> {
  const [interruptedAt, completed, completedAt] = await Promise.all([
    getKnown(UPDATE_INTERRUPTED_KEY),
    getKnown("update_completed"),
    getKnown("update_completed_at"),
  ]);
  if (!interruptedAt.known || !completed.known || !completedAt.known) return null;
  return {
    interruptedAt: typeof interruptedAt.value === "string" ? interruptedAt.value : null,
    completed: Boolean(completed.value),
    completedAt: typeof completedAt.value === "string" ? completedAt.value : null,
  };
}

/**
 * Drop the record, reporting a store that would not take the write.
 *
 * Never fatal to the reader: failing to FORGET a verdict that has already been
 * suppressed in memory must not turn a status poll into a 500, on a box whose
 * config.json is the thing that is broken.
 */
async function forgetInterruption(): Promise<void> {
  try {
    await set(UPDATE_INTERRUPTED_KEY, undefined);
  } catch (err) {
    console.warn(
      "[Updater] Could not clear the interruption a later update overtook:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Did a completion come AFTER the interruption the box remembers?
 *
 * Both records carry a time, so the newer one is the true one. Strictly newer,
 * and only with a date on both sides: older boxes carried `update_completed =
 * true` for ever with no `update_completed_at` beside it, and "some completion
 * happened at some point" cannot prove it came after this interruption —
 * guessing that it did would be the silence TASK-731 exists to end.
 *
 * Every uncertain answer is `false`, which KEEPS the failure showing: an
 * unparseable date, an undated completion, equal times. The clock is the one
 * assumption left — a box whose time is stepped BACKWARDS between the two
 * writes reads its own completion as older — and that is the direction to fail
 * in, since the next run's prologue clears both markers anyway.
 */
function completionOutranksInterruption(markers: SettledMarkers): boolean {
  if (!markers.interruptedAt || !markers.completed || !markers.completedAt) return false;
  const completedAt = Date.parse(markers.completedAt);
  const interruptedAt = Date.parse(markers.interruptedAt);
  return Number.isFinite(completedAt) && Number.isFinite(interruptedAt) && completedAt > interruptedAt;
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
      // The lock is released here and nowhere else on the success path. This
      // does NOT run when do_rebuild kills the server mid-run — the process
      // simply ends — which is exactly right: the flag stays on disk and the
      // desktop is still locked when the box comes back for post_update.
      void clearUpdateLock();
    });
}

/**
 * Whether an update owns the box right now: one is running, or one has
 * rebooted the box and is waiting for its second half to be resumed. Boot
 * hooks that touch what post_update repairs — the OpenClaw store above all —
 * ask this before they start.
 */
export async function updateInFlight(): Promise<boolean> {
  if (updateOwned()) return true;
  const needsContinuation = await get("update_needs_continuation");
  // An update may have claimed the box while the flag was being read.
  return updateOwned() || Boolean(needsContinuation);
}

/**
 * Check if a post-restart continuation is needed and trigger it.
 * Called once from the server boot path (src/instrumentation.ts) and from
 * the status route on every idle poll as the fallback. Single-flight:
 * overlapping callers share one resume and get its one answer, so a status
 * poll that lands on the boot hook's read answers "running", not "idle".
 */
export function checkContinuation(): Promise<boolean> {
  if (running) return Promise.resolve(false);
  if (!continuationInFlight) {
    continuationInFlight = resumeContinuation().finally(() => {
      continuationInFlight = null;
    });
  }
  return continuationInFlight;
}

async function resumeContinuation(): Promise<boolean> {
  const needsContinuation = await get("update_needs_continuation");
  if (!needsContinuation) {
    // Boot safety. A run that died between setting the lock and writing its
    // continuation flag would otherwise leave the desktop locked with nothing
    // left to unlock it — there is no update to resume, so there is no lock to
    // hold. This is the one release path that does not follow a finished run.
    //
    // But releasing the lock is only half an answer, and the missing half is
    // TASK-731. The lock is on disk and the step list is not: an update whose
    // web server was replaced between `runUpdate`'s `setUpdateLock()` and the
    // rebuild step (which writes the continuation flag) leaves the lock held
    // and nothing to resume. This branch then cleared it and answered IDLE —
    // indistinguishable from a box nobody ever asked to update, over a run the
    // route had already accepted with `{ started: true }`. The e2e-install
    // upgrade spec then polls a state machine that cannot move for its whole
    // 45-minute budget.
    //
    // Two things are needed and neither is enough alone. The lock IS the
    // evidence, so it is read before it is cleared — and the verdict is
    // WRITTEN BACK, because the fault being detected is "the web server keeps
    // being replaced": a process that reports it in memory and then dies takes
    // the only record with it, and the next one finds a clean disk and answers
    // idle again, for good. `update_interrupted_at` is that record; it is
    // cleared by the next `startUpdate()` and by a Dismiss.
    //
    // An update that FINISHED and then failed its release is not an
    // interruption. `clearUpdateLock` is documented to fail softly, and
    // `launchUpdate` fires it unawaited, so a leftover flag is a real state —
    // and `update_completed` with no continuation flag is what tells the two
    // apart. Reporting there would tell an owner to re-run a ten-minute update
    // that already worked.
    //
    // …and the record is judged AGAINST that completion by time, which is the
    // 2026-09-06 follow-up. The state this branch reads — locked, nothing to
    // resume, not completed — is also what the SECOND HALF of an ordinary
    // update looks like to a reader that is not the process running it, so an
    // interruption gets stamped on the normal path of every update. Measured on
    // the Hermes box: `update_interrupted_at` 71 seconds BEFORE
    // `update_completed_at`, on an update that worked, and the box answered
    // "Update failed" with every step pending from then on. A completion newer
    // than the record voids it, here and on disk.
    // The release only when the lock was actually HELD. `set` is a
    // read-modify-write of the whole of data/config.json and this branch now
    // runs on every status poll, so an unconditional clear would rewrite that
    // file every two seconds — beside install.sh and the gateway, which have it
    // open by their own paths.
    const released = (await isUpdateLocked()) && (await clearUpdateLock());
    const markers = await readSettledMarkers();
    // A store that could not be read decides NOTHING — it neither stamps a
    // record nor retracts the verdict this process is already holding.
    if (!markers) return false;
    const overtaken = completionOutranksInterruption(markers);
    if (overtaken) await forgetInterruption();
    const remembered = Boolean(markers.interruptedAt) && !overtaken;
    if ((released && !markers.completed) || remembered) {
      if (!remembered) {
        // Asked once more, immediately before the stamp. The run can finish
        // between the read above and this line, and a record dated after the
        // completion it describes would outrank it for ever — the very defect
        // this branch is being fixed for, through a window of milliseconds.
        const now = await readSettledMarkers();
        if (!now || now.completed) return false;
        // Only on the transition, so the record keeps the time it happened.
        await set(UPDATE_INTERRUPTED_KEY, new Date().toISOString());
      }
      state = createInitialState(applicableSteps());
      state.warnings = await restoreWarnings();
      state.phase = "failed";
      state.error = INTERRUPTED_MESSAGE;
      console.error(`[Updater] ${INTERRUPTED_MESSAGE}`);
    } else if (isInterruptedVerdict(state)) {
      // This process is still holding a verdict whose record is gone — cleared
      // by the completion above, by the next run's prologue, or by a Dismiss in
      // another copy of this module. A failure the box has no evidence for is
      // not one to keep showing.
      state = createInitialState(applicableSteps());
    }
    return false;
  }

  // The restart this is resuming is the one the update ASKED FOR: the flag is
  // written by the rebuild step itself. So anything a reader stamped while that
  // replacement was under way describes the update's own normal path, and goes
  // with the flag rather than outliving it.
  await setMany({
    update_needs_continuation: undefined,
    [UPDATE_INTERRUPTED_KEY]: undefined,
  });

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
  // must be present AND differ from the one recorded before the rebuild
  // (systemd unit state resets across reboots, so the Result check alone can be
  // erased by a power cycle; the BUILD_ID can't). Legacy boolean flags (written
  // by the previous updater version) carry no build identity — for those the
  // unit check and the "is there a build at all" check apply.
  const unitFailed = rootStepResultFailed(await getRootStepResult(REBUILD_ROOT_STEP));
  const recordedBuildId = typeof needsContinuation === "string" ? needsContinuation : null;
  const currentBuildId = await readBuildId();
  const buildUnchanged = recordedBuildId !== null && recordedBuildId === currentBuildId;
  // ...and NO build id is never evidence of a build. `do_rebuild` used to
  // delete `.next` before building, so an OOM-killed build left the box with
  // nothing — and an absent id compares UNEQUAL to the recorded one, which the
  // check above read as "the build changed". A box with no dashboard at all
  // then resumed and stamped itself complete. Measured on the OpenClaw dev box
  // 2026-09-04, TASK-709.
  const buildMissing = currentBuildId === "";
  if (unitFailed || buildUnchanged || buildMissing) {
    const message = unitFailed
      ? (await readRootStepFailure(REBUILD_ROOT_STEP)) ?? "Rebuild failed before the restart"
      : buildMissing
        ? "The device restarted with no build at all (.next/BUILD_ID is missing) — see clawbox-root-update@rebuild_reboot logs"
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
    await clearUpdateLock();
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
  if (updateOwned()) {
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
  if (updateOwned()) {
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
  // Lock the desktop FIRST, AWAITED, before anything that can take time.
  //
  // It used to sit below the internet check and the drift baseline — up to two
  // 10 s ICMP attempts, an 8 s HTTPS HEAD and a `git` shell-out — and the
  // update was already accepted (`{started:true}`) for that whole window. A web
  // server replaced in it left NO trace on disk, so the run was lost and the
  // box reported "nothing is running" (TASK-731). The lock is the only durable
  // record that a run exists, so it goes on disk before the run can be lost.
  //
  // Scoped to the flow that contains the RESTART step: that is the one that
  // runs `git reset --hard` and `git clean -fd` over the project. The
  // OpenClaw-only flow reinstalls a package and bounces the gateway, and
  // locking the owner's desktop for that would be over-reach. It also covers
  // the continuation, whose flag survived the reboot but may not have on a box
  // that was power-cycled instead.
  const ownsTheDesktop = steps.some((s) => s.id === RESTART_STEP_ID);
  if (ownsTheDesktop) {
    await setUpdateLock();
    // AND clear what the last run left behind, in the same awaited prologue.
    //
    // `update_completed` is the discriminator resumeContinuation uses to tell
    // "an update was interrupted" from "one finished and only failed to release
    // its lock". Left standing, a FORCED run started after a successful one
    // (exactly what e2e-install's upgrade spec does, twice) would take the
    // lock, die before the rebuild writes its continuation flag, and be read as
    // the finished one — swallowing the very report the branch exists to make.
    // The box is not "completed" while it is updating, and the run writes both
    // again when it is.
    //
    // HERE rather than in startUpdate, and awaited: the window this whole
    // change is about begins when the first step runs, and by then the markers
    // are gone. A restart in the microseconds before this line finds no lock
    // either — both are written in the same prologue — so resumeContinuation
    // correctly says nothing.
    //
    // Reported and not fatal, the same rule setUpdateLock follows: refusing to
    // update a box because a marker could not be cleared is the worse outcome
    // by some way, and a config store that cannot be written is exactly the
    // state an update exists to repair. What it costs, said out loud, is that a
    // later interrupted run may be read as this one having finished.
    try {
      await setMany({
        [UPDATE_INTERRUPTED_KEY]: undefined,
        update_completed: undefined,
        update_completed_at: undefined,
      });
    } catch (err) {
      console.warn(
        "[Updater] Could not clear the previous run's markers - an interruption of THIS run may be reported as a completed update:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (startFrom === 0 && !(await checkInternet())) {
    state.phase = "failed";
    state.error = "No internet connection. Check your WiFi and try again.";
    state.currentStepIndex = -1;
    await clearUpdateLock();
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

    // Re-assert the lock at every step boundary, because another PROCESS can
    // drop it. config-store.set is an unlocked read-modify-write of the whole
    // of data/config.json, and post_update runs install.sh and restarts the
    // gateway — both of which have that file open by their own paths
    // (install.sh:2894, scripts/gateway-pre-start.sh's CLAWBOX_DEVICE_STORE).
    // A writer that READ the file before we set the flag and wrote after
    // silently removes it, and nothing in this process would ever know.
    //
    // Observed on hardware, 2026-09-04: the flag was set at 17:44, gone by
    // 17:51, and the run did not finish until 17:53:29 — so the owner's
    // desktop unlocked while post_update was still rewriting the box, which is
    // the one thing this lock exists to prevent. One cheap write per step
    // heals that within a step instead of leaving it lost for the rest of a
    // ten-minute run.
    if (ownsTheDesktop) await setUpdateLock();

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
      // In the SAME write, so the two records can never disagree: an
      // interruption stamped while this run was going describes this run, and
      // this run finished. Left standing it is read as the newer fact for ever
      // — "Update failed", every step pending, over an update that worked
      // (measured on the Hermes box, 2026-09-06).
      [UPDATE_INTERRUPTED_KEY]: undefined,
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
