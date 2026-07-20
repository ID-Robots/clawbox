import { exec as execCb, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";
import { get, set, setMany } from "./config-store";
import { findOpenclawBin, restartGateway } from "./openclaw-config";
import { isPortOpen } from "./port-probe";

const PROJECT_DIR = "/home/clawbox/clawbox";
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
const OPENCLAW_VERSION_FALLBACK = "2026.7.1";

const execShell = promisify(execCb);
const execFile = promisify(execFileCb);

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
   * painting "Update failed" on a successful update is worse than letting
   * the unit finish in the background. Genuine unit failures still fail.
   */
  advisoryOnOverrun?: boolean;
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

export interface UpdateState {
  phase: UpdatePhase;
  steps: StepState[];
  currentStepIndex: number;
  error?: string;
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
    if ((await getRootStepResult(REBUILD_ROOT_STEP)) === "failed") {
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

/** Validate branch name — only safe git ref characters allowed (prevents shell injection). */
const SAFE_BRANCH = /^[A-Za-z0-9._\-/]+$/;

/**
 * Determine which branch to update to, in priority order:
 * 1. `.update-branch` file in project root (survives factory reset + git reset)
 * 2. Current branch if it tracks a remote
 * 3. "main" as the default fallback
 */
interface ResolvedBranch {
  /** Local branch to checkout */
  local: string;
  /** Full upstream ref to reset to (e.g. "origin/feature/foo") */
  upstream: string;
}

async function resolveUpdateBranch(gitCmd: string): Promise<ResolvedBranch> {
  const main: ResolvedBranch = { local: "main", upstream: "origin/main" };

  // 1. Check .update-branch file
  try {
    const pinned = (await readFile(UPDATE_BRANCH_FILE, "utf-8")).trim();
    if (pinned && SAFE_BRANCH.test(pinned)) {
      return { local: pinned, upstream: `origin/${pinned}` };
    }
  } catch { /* file doesn't exist */ }

  // 2. Check current branch's configured upstream via git
  try {
    const { stdout: branchOut } = await execShell(
      `${gitCmd} symbolic-ref --short HEAD`,
      { timeout: 10_000 },
    );
    const current = branchOut.trim();
    if (!current || current === "main" || !SAFE_BRANCH.test(current)) return main;

    const { stdout: upstreamOut } = await execShell(
      `${gitCmd} rev-parse --abbrev-ref ${current}@{u}`,
      { timeout: 10_000 },
    );
    const upstream = upstreamOut.trim();
    if (upstream && SAFE_BRANCH.test(upstream)) {
      return { local: current, upstream };
    }
  } catch {
    // No upstream configured — fall back to main
  }

  // 3. Default
  return main;
}

async function updateClawBoxAndReboot(): Promise<void> {
  // Fix .git ownership — previous root operations (install.sh) may have
  // created root-owned files (e.g. FETCH_HEAD) that block git pull as clawbox.
  await execAsRoot("fix_git_perms", 30_000);

  const gitCmd = `git -c safe.directory=${PROJECT_DIR} -C ${PROJECT_DIR}`;
  const { local, upstream } = await resolveUpdateBranch(gitCmd);

  console.log(`[Updater] Updating to branch: ${local} (upstream: ${upstream})`);

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
  await execShell(
    `${gitCmd} fetch origin` +
    ` && ${gitCmd} reset --hard HEAD` +
    ` && (${gitCmd} checkout ${local} 2>/dev/null || ${gitCmd} checkout -b ${local} ${upstream})` +
    ` && ${gitCmd} reset --hard ${upstream}` +
    ` && ${gitCmd} clean -fd`,
    { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
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
const GATEWAY_WAIT_INTERVAL_MS = 1_500;
const LEGACY_GATEWAY_BLOCKER_RE =
  /installs\.json|conflicting plugin install metadata|carl_pir|belongs to agent piper/i;

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

async function readGatewayJournalTail(): Promise<string> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/journalctl",
      ["-u", "clawbox-gateway.service", "-n", "160", "--no-pager"],
      { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return "";
  }
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
  if (options.restartFirst) {
    await restartGateway();
  }

  if (await waitForGateway(30_000)) return;

  await runOpenclawDoctorFix();
  await restartGateway().catch(() => {});
  if (await waitForGateway(30_000)) return;

  const beforeRecoveryLog = await readGatewayJournalTail();
  if (!LEGACY_GATEWAY_BLOCKER_RE.test(beforeRecoveryLog)) {
    const lastLog = getLastLogLine(beforeRecoveryLog);
    throw new Error(
      lastLog
        ? `OpenClaw gateway is not listening on port ${GATEWAY_PORT}: ${lastLog}`
        : `OpenClaw gateway is not listening on port ${GATEWAY_PORT}`,
    );
  }

  await quarantineLegacyOpenclawState();
  await runOpenclawDoctorFix();
  await restartGateway();
  if (await waitForGateway(45_000)) return;

  const afterRecoveryLog = await readGatewayJournalTail();
  const lastLog = getLastLogLine(afterRecoveryLog);
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
  },
  {
    id: "openclaw_patch",
    label: "Patching OpenClaw gateway",
    timeoutMs: 30_000,
    requiresRoot: true,
  },
  {
    id: "gateway_setup",
    label: "Configuring gateway service",
    timeoutMs: 30_000,
    requiresRoot: true,
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
    // minutes is advisory: the unit finishes on its own (TimeoutStartSec is
    // 30 min) and everything inside it is non-fatal by design.
    id: "post_update",
    label: "Applying system fixups",
    timeoutMs: 300_000,
    requiresRoot: true,
    advisoryOnOverrun: true,
  },
  {
    id: "gateway_verify",
    label: "Verifying gateway health",
    timeoutMs: 90_000,
    customRun: () => ensureGatewayHealthy(),
    failFast: true,
  },
];

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

async function getPinnedBranchTarget(gitCmd: string): Promise<{
  branch: string;
  currentSha: string;
  targetSha: string;
} | null> {
  let branch: string;
  try {
    branch = (await readFile(UPDATE_BRANCH_FILE, "utf-8")).trim();
  } catch {
    return null;
  }
  if (!branch || !SAFE_BRANCH.test(branch)) return null;

  try {
    await execShell(`${gitCmd} fetch --quiet origin ${branch}`, { timeout: 20_000 }).catch(() => {});
    const [{ stdout: currentOut }, { stdout: targetOut }] = await Promise.all([
      execShell(`${gitCmd} rev-parse HEAD`, { timeout: 10_000 }),
      execShell(`${gitCmd} rev-parse origin/${branch}`, { timeout: 10_000 }),
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

  const gitCmd = `git -c safe.directory=${PROJECT_DIR} -C ${PROJECT_DIR}`;
  const [targetVersion, openclawCurrent, openclawTarget, rawVersion] = await Promise.all([
    getTargetVersion(),
    execFile(OPENCLAW_BIN, ["--version"], { timeout: 10_000 })
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
  ]);
  const pinnedBranchTarget = await getPinnedBranchTarget(gitCmd);

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
  };
  versionInfoCacheTime = Date.now();
  return cachedVersionInfo;
}

export async function getTargetVersion(): Promise<string | null> {
  if (Date.now() - targetVersionCacheTime < TARGET_VERSION_CACHE_TTL) return cachedTargetVersion;
  try {
    await execShell(
      `git -c safe.directory=${PROJECT_DIR} -C ${PROJECT_DIR} fetch --quiet --tags origin`,
      { timeout: 20_000 },
    ).catch(() => {});
    const { stdout } = await execShell(
      `git -c safe.directory=${PROJECT_DIR} -C ${PROJECT_DIR} ls-remote --tags --refs origin`,
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

function createInitialState(): UpdateState {
  return {
    phase: "idle",
    steps: createStepStates(UPDATE_STEPS),
    currentStepIndex: -1,
  };
}

let state: UpdateState = createInitialState();
let running = false;

export function getUpdateState(): UpdateState {
  return { ...state, steps: state.steps.map((s) => ({ ...s })) };
}

export function resetUpdateState(): void {
  state = createInitialState();
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

  const restartIndex = UPDATE_STEPS.findIndex((s) => s.id === RESTART_STEP_ID);
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
  const unitFailed = (await getRootStepResult(REBUILD_ROOT_STEP)) === "failed";
  const recordedBuildId = typeof needsContinuation === "string" ? needsContinuation : null;
  const buildUnchanged = recordedBuildId !== null && recordedBuildId === (await readBuildId());
  if (unitFailed || buildUnchanged) {
    const message = unitFailed
      ? (await readRootStepFailure(REBUILD_ROOT_STEP)) ?? "Rebuild failed before the restart"
      : "The device restarted without producing a new build — see clawbox-root-update@rebuild_reboot logs";
    state = createInitialState();
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
  state = createInitialState();
  state.phase = "running";
  for (let i = 0; i <= restartIndex; i++) {
    state.steps[i].status = "completed";
  }
  state.currentStepIndex = startFrom;

  launchUpdate(UPDATE_STEPS, startFrom, { markCompleted: true });
  return true;
}

export function startUpdate(): { started: boolean; error?: string } {
  if (running) {
    return { started: false, error: "Update already in progress" };
  }

  running = true;
  state = createInitialState();
  state.phase = "running";
  state.currentStepIndex = 0;

  launchUpdate(UPDATE_STEPS, 0, { markCompleted: true });
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
        await execAsRoot(step.id, step.timeoutMs);
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
      // An overrun on an advisory step doesn't fail the update: the unit is
      // still running and will finish on its own — mark the step completed
      // and move on, instead of painting "Update failed" (with a Retry that
      // would re-run the whole update) over a successful one.
      if (err instanceof BudgetOverrunError && step.advisoryOnOverrun) {
        state.steps[i].status = "completed";
        console.warn(`[Updater] ${step.label}: ${message} — treating as advisory`);
        continue;
      }
      // Only let the unit's journal override the error when the unit actually
      // FAILED — on a budget overrun it's still running, and its last log line
      // is just whatever fixup happened to finish most recently.
      if (step.requiresRoot && (await getRootStepResult(step.id)) === "failed") {
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
  // Force the next /update/versions poll to refetch — both the device's
  // installed versions and the desktop notification depend on it.
  invalidateVersionCache();
  console.log("[Updater] Update process finished");
}
