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
  command: string;
  timeoutMs: number;
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

const UPDATE_STEPS: UpdateStepDef[] = [
  {
    id: "apt_update",
    label: "Updating system packages",
    command: "",
    timeoutMs: 120_000,
    requiresRoot: true,
  },
  {
    id: "nvidia_jetpack",
    label: "Installing NVIDIA JetPack",
    command: "",
    timeoutMs: 600_000,
    requiresRoot: true,
  },
  {
    id: "performance_mode",
    label: "Enabling max performance mode",
    command: "",
    timeoutMs: 60_000,
    requiresRoot: true,
  },
  {
    id: "chrome_install",
    label: "Installing Chromium",
    command: "",
    timeoutMs: 300_000,
    requiresRoot: true,
  },
  {
    id: "git_pull",
    label: "Updating ClawBox",
    command: "git -c safe.directory=/home/clawbox/clawbox -C /home/clawbox/clawbox pull --ff-only",
    timeoutMs: 60_000,
  },
  {
    id: RESTART_STEP_ID,
    label: "Rebuilding & Restarting ClawBox",
    command: "",
    timeoutMs: 30_000,
    customRun: async () => {
      // Mark that post-restart steps still need to run
      await set("update_needs_continuation", true);
      // Fire-and-forget: root service stops server, rebuilds, starts server
      const service = "clawbox-root-update@rebuild.service";
      execFile("systemctl", ["reset-failed", service], {
        timeout: 10_000,
      }).catch(() => {});
      execFile("systemctl", ["start", "--no-block", service], {
        timeout: 10_000,
      }).catch(() => {});
      // Wait for systemd to SIGTERM us during the rebuild
      await new Promise((r) => setTimeout(r, 10_000));
    },
  },
  {
    id: "openclaw_install",
    label: "Updating OpenClaw",
    command: "",
    timeoutMs: 120_000,
    requiresRoot: true,
  },
  {
    id: "openclaw_patch",
    label: "Patching OpenClaw gateway",
    command: "",
    timeoutMs: 30_000,
    customRun: async () => {
      const OPENCLAW_BIN = "/home/clawbox/.npm-global/bin/openclaw";
      const GATEWAY_DIST =
        "/home/clawbox/.npm-global/lib/node_modules/openclaw/dist";

      // 1. Enable insecure auth so Control UI works over plain HTTP
      await execFile(OPENCLAW_BIN, [
        "config", "set", "gateway.controlUi.allowInsecureAuth", "true", "--json",
      ], { timeout: 10_000 });

      // 2. Patch gateway JS to preserve operator scopes for token-only auth.
      let files = "";
      try {
        const result = await execFile("grep", [
          "-rl", "if (scopes.length > 0) {", GATEWAY_DIST,
        ], { timeout: 10_000 });
        files = result.stdout;
      } catch {
        // grep exits 1 when no matches found — already patched or pattern changed
      }
      const targets = files.trim().split("\n").filter(Boolean);
      if (targets.length === 0) {
        console.log("[Updater] Gateway scope patch: pattern not found (may already be patched)");
        return;
      }
      for (const file of targets) {
        await execFile("sed", [
          "-i",
          "s/if (scopes.length > 0) {/if (scopes.length > 0 \\&\\& !(isControlUi \\&\\& allowControlUiBypass)) {/",
          "--",
          file,
        ], { timeout: 10_000 });
      }
      console.log(`[Updater] Gateway scope patch applied to ${targets.length} file(s)`);
    },
  },
  {
    id: "models_update",
    label: "Configuring AI models",
    command: "/home/clawbox/.npm-global/bin/openclaw models",
    timeoutMs: 600_000,
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
      status: "pending",
    })),
    currentStepIndex: -1,
  };
}

let state: UpdateState = createInitialState();
let running = false;

export function getUpdateState(): UpdateState {
  return { ...state, steps: state.steps.map((s) => ({ ...s })) };
}

export async function isUpdateCompleted(): Promise<boolean> {
  return !!(await get("update_completed"));
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
  // Mark all pre-restart steps (including restart) as completed
  for (let i = 0; i <= restartIndex; i++) {
    state.steps[i].status = "completed";
  }
  state.currentStepIndex = startFrom;

  runUpdate(startFrom)
    .catch((err) => {
      console.error("[Updater] Unexpected error:", err);
      state.phase = "failed";
    })
    .finally(() => {
      running = false;
    });

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

  runUpdate(0)
    .catch((err) => {
      console.error("[Updater] Unexpected error:", err);
      state.phase = "failed";
    })
    .finally(() => {
      running = false;
    });

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

  let hasFailures = false;

  for (let i = startFrom; i < UPDATE_STEPS.length; i++) {
    const stepDef = UPDATE_STEPS[i];
    state.currentStepIndex = i;
    state.steps[i].status = "running";
    state.steps[i].error = undefined;

    console.log(`[Updater] Running step: ${stepDef.label}`);

    try {
      if (stepDef.customRun) {
        await stepDef.customRun();
      } else if (stepDef.requiresRoot) {
        await execAsRoot(stepDef.id, stepDef.timeoutMs);
      } else {
        await execShell(stepDef.command, {
          timeout: stepDef.timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        });
      }
      state.steps[i].status = "completed";
      console.log(`[Updater] Completed: ${stepDef.label}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      state.steps[i].status = "failed";
      state.steps[i].error = message;
      console.error(`[Updater] Failed: ${stepDef.label} — ${message}`);
      hasFailures = true;
    }
  }

  state.currentStepIndex = -1;
  state.phase = hasFailures ? "failed" : "completed";

  if (!hasFailures) {
    await set("update_completed", true);
    await set("update_completed_at", new Date().toISOString());
  }
  console.log("[Updater] Update process finished");
}
