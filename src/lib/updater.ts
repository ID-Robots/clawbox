import { exec as execCb, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { get, set } from "./config-store";

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
  execFile("systemctl", ["reset-failed", service], {
    timeout: 10_000,
  }).catch(() => {});
  await execFile("systemctl", ["start", "--no-block", service], {
    timeout: 10_000,
  });
}

async function updateClawBoxAndReboot(): Promise<void> {
  await execShell(
    "git -c safe.directory=/home/clawbox/clawbox -C /home/clawbox/clawbox pull --ff-only",
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
    id: "chrome_install",
    label: "Installing Chromium",
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
    id: "openclaw_models",
    label: "Configuring AI models",
    timeoutMs: 600_000,
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
  await execFile("systemctl", ["reset-failed", serviceName], {
    timeout: 10_000,
  }).catch(() => {});
  await execFile("systemctl", ["start", serviceName], {
    timeout: timeoutMs + 30_000,
  });
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
    await set("update_completed", true);
    await set("update_completed_at", new Date().toISOString());
  }
  console.log("[Updater] Update process finished");
}
