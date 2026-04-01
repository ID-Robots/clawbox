import { exec as execCb, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import path from "path";
import { get, set, setMany } from "./config-store";
import { findOpenclawBin } from "./openclaw-config";

const PROJECT_DIR = "/home/clawbox/clawbox";
const UPDATE_BRANCH_FILE = path.join(PROJECT_DIR, ".update-branch");

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
  customRun?: () => Promise<void>;
}

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

const RESTART_STEP_ID = "restart";

/** Wait indefinitely for systemd to SIGTERM us (during rebuild/reboot). */
function waitForTermination(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30_000));
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

  await execShell(
    `${gitCmd} fetch origin` +
    ` && ${gitCmd} checkout ${local}` +
    ` && ${gitCmd} reset --hard ${upstream}`,
    { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
  await set("update_needs_continuation", true);
  await startRootServiceFireAndForget("rebuild_reboot");
  await waitForTermination();
}

const UPDATE_STEPS: UpdateStepDef[] = [
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
    timeoutMs: 120_000,
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
    timeoutMs: 90_000,
    customRun: updateClawBoxAndReboot,
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
  await execFile("/usr/bin/systemctl", ["start", serviceName], {
    timeout: timeoutMs + 30_000,
  });
}

let cachedTargetVersion: string | null = null;
let targetVersionCacheTime = 0;
const TARGET_VERSION_CACHE_TTL = 60_000; // Cache failures for 60s to avoid repeated git ls-remote

const OPENCLAW_BIN = findOpenclawBin();
const OPENCLAW_PKG = "/home/clawbox/.npm-global/lib/node_modules/openclaw/package.json";

interface VersionInfo {
  clawbox: { current: string; target: string | null };
  openclaw: { current: string | null; target: string | null };
}

let cachedVersionInfo: VersionInfo | null = null;
let versionInfoCacheTime = 0;

export async function getVersionInfo(): Promise<VersionInfo> {
  if (cachedVersionInfo && Date.now() - versionInfoCacheTime < TARGET_VERSION_CACHE_TTL) {
    return cachedVersionInfo;
  }

  const [targetVersion, openclawCurrent, openclawTarget] = await Promise.all([
    getTargetVersion(),
    execFile(OPENCLAW_BIN, ["--version"], { timeout: 10_000 })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() =>
        // Fallback: read version from installed package.json
        readFile(OPENCLAW_PKG, "utf-8")
          .then((raw) => (JSON.parse(raw) as { version?: string }).version ?? null)
          .catch(() => null)
      ),
    execShell("bun pm view openclaw version 2>/dev/null || npm view openclaw version --registry https://registry.npmjs.org", { timeout: 10_000 })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null),
  ]);

  // git describe gives "v2.2.0-3-gad4bf5a" for commits after a tag;
  // extract the base tag so we can compare properly with the target tag
  const rawVersion = process.env.NEXT_PUBLIC_APP_VERSION || "unknown";
  const baseTag = rawVersion.match(/^(v\d+\.\d+\.\d+)/)?.[1] ?? rawVersion;

  cachedVersionInfo = {
    clawbox: {
      current: rawVersion,
      target: targetVersion && targetVersion === baseTag ? null : targetVersion,
    },
    openclaw: {
      current: openclawCurrent,
      target: openclawTarget && openclawCurrent && openclawCurrent.includes(openclawTarget) ? null : openclawTarget,
    },
  };
  versionInfoCacheTime = Date.now();
  return cachedVersionInfo;
}

export async function getTargetVersion(): Promise<string | null> {
  if (Date.now() - targetVersionCacheTime < TARGET_VERSION_CACHE_TTL) return cachedTargetVersion;
  try {
    const { stdout } = await execShell(
      "git -c safe.directory=/home/clawbox/clawbox -C /home/clawbox/clawbox ls-remote --tags --refs origin",
      { timeout: 10_000 },
    );
    const tags = stdout
      .trim()
      .split("\n")
      .map((line) => line.match(/refs\/tags\/(v.+)$/)?.[1])
      .filter((t): t is string => !!t);
    // Only consider strict semver tags (vX.Y.Z)
    const semverTags = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
    if (semverTags.length === 0) {
      cachedTargetVersion = null;
      targetVersionCacheTime = Date.now();
      return null;
    }
    semverTags.sort((a, b) => {
      const pa = a.replace(/^v/, "").split(".").map(Number);
      const pb = b.replace(/^v/, "").split(".").map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });
    cachedTargetVersion = semverTags[semverTags.length - 1];
    targetVersionCacheTime = Date.now();
    return cachedTargetVersion;
  } catch {
    cachedTargetVersion = null;
    targetVersionCacheTime = Date.now();
    return null;
  }
}

function createInitialState(): UpdateState {
  return {
    phase: "idle",
    steps: UPDATE_STEPS.map((s) => ({
      id: s.id,
      label: s.label,
      status: "pending" as const,
    })),
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

/**
 * Launch runUpdate in the background with shared error handling.
 * Used by both startUpdate (fresh run) and checkContinuation (post-reboot).
 */
function launchUpdate(startFrom: number): void {
  runUpdate(startFrom)
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

  running = true;
  state = createInitialState();
  state.phase = "running";
  for (let i = 0; i <= restartIndex; i++) {
    state.steps[i].status = "completed";
  }
  state.currentStepIndex = startFrom;

  launchUpdate(startFrom);
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

  launchUpdate(0);
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
  return false;
}

async function runUpdate(startFrom: number): Promise<void> {
  if (startFrom === 0 && !(await checkInternet())) {
    state.phase = "failed";
    state.error = "No internet connection. Check your WiFi and try again.";
    state.currentStepIndex = -1;
    return;
  }

  let failed = false;

  for (let i = startFrom; i < UPDATE_STEPS.length; i++) {
    const step = UPDATE_STEPS[i];
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
      const message = err instanceof Error ? err.message : "Unknown error";
      state.steps[i].status = "failed";
      state.steps[i].error = message;
      console.error(`[Updater] Failed: ${step.label} — ${message}`);
      failed = true;
    }
  }

  state.currentStepIndex = -1;
  state.phase = failed ? "failed" : "completed";

  if (!failed) {
    await setMany({
      update_completed: true,
      update_completed_at: new Date().toISOString(),
    });
  }
  console.log("[Updater] Update process finished");
}
