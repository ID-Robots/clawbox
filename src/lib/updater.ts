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
  required?: boolean;
  requiresRoot?: boolean;
  customRun?: () => Promise<void>;
}

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

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
  | "failed"
  | "skipped";

export interface UpdateState {
  phase: UpdatePhase;
  steps: StepState[];
  currentStepIndex: number;
}

const UPDATE_STEPS: UpdateStepDef[] = [
  {
    id: "internet_check",
    label: "Checking internet connectivity",
    command: "",
    timeoutMs: 10_000,
    required: true,
    customRun: async () => {
      for (const target of PING_TARGETS) {
        try {
          await execFile("ping", ["-c", "1", "-W", "5", target], { timeout: 10_000 });
          return;
        } catch {
          // try next target
        }
      }
      throw new Error("All ping targets unreachable");
    },
  },
  {
    id: "git_pull",
    label: "Fetching latest ClawBox code",
    command: "git -c safe.directory=/home/clawbox/clawbox -C /home/clawbox/clawbox pull --ff-only",
    timeoutMs: 60_000,
  },
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
    id: "rebuild",
    label: "Rebuilding ClawBox",
    command: "",
    timeoutMs: 300_000,
    customRun: async () => {
      const BUN = "/home/clawbox/.bun/bin/bun";
      const cwd = "/home/clawbox/clawbox";
      await execFile(BUN, ["install"], { cwd, timeout: 120_000 });
      await execFile(BUN, ["run", "build"], { cwd, timeout: 180_000 });
    },
  },
  {
    id: "openclaw_install",
    label: "Updating OpenClaw",
    command: "npm install -g openclaw --prefix /home/clawbox/.npm-global",
    timeoutMs: 120_000,
  },
  {
    id: "openclaw_patch",
    label: "Patching OpenClaw gateway for ClawBox",
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
      //    The gateway clears all scopes when no device identity is present
      //    (insecure context). This sed patch keeps scopes when
      //    allowControlUiBypass is already true.
      const { stdout: files } = await execFile("grep", [
        "-rl", "if (scopes.length > 0) {", GATEWAY_DIST,
      ], { timeout: 10_000 });
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
  {
    id: "restart",
    label: "Restarting ClawBox",
    command: "",
    timeoutMs: 30_000,
    customRun: async () => {
      // Persist completion BEFORE restart kills our process
      await set("update_completed", true);
      await set("update_completed_at", new Date().toISOString());
      // Fire-and-forget: systemd will SIGTERM us during restart
      execFile("systemctl", ["restart", "clawbox-setup.service"], {
        timeout: 30_000,
      }).catch(() => {});
      // Wait for systemd to receive the command and kill us
      await new Promise((r) => setTimeout(r, 5000));
    },
  },
];

/**
 * Runs a root-privileged step via the clawbox-root-update@ systemd template
 * service. The main service runs as clawbox with NoNewPrivileges=true, so
 * privilege escalation is handled by systemd: the template service runs as
 * root, and polkit (49-clawbox-updates.rules) authorizes the clawbox user
 * to start it.
 */
async function execAsRoot(stepId: string, timeoutMs: number): Promise<void> {
  const serviceName = `clawbox-root-update@${stepId}.service`;
  // Clear any previous failed state so systemd allows a fresh start
  await execFile("systemctl", ["reset-failed", serviceName], {
    timeout: 10_000,
  }).catch(() => {});
  // systemctl start blocks for oneshot services until completion
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
      status: "pending" as StepStatus,
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

export function startUpdate(): { started: boolean; error?: string } {
  if (running) {
    return { started: false, error: "Update already in progress" };
  }

  // Reset state for fresh or retry run
  running = true;
  state = createInitialState();
  state.phase = "running";
  state.currentStepIndex = 0;

  // Run async without awaiting
  runUpdate()
    .catch((err) => {
      console.error("[Updater] Unexpected error:", err);
      state.phase = "failed";
    })
    .finally(() => {
      running = false;
    });

  return { started: true };
}

async function runUpdate(): Promise<void> {
  let hasFailures = false;

  for (let i = 0; i < UPDATE_STEPS.length; i++) {
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

      if (stepDef.required) {
        // Required step failed — skip remaining
        state.phase = "skipped";
        for (let j = i + 1; j < UPDATE_STEPS.length; j++) {
          state.steps[j].status = "skipped";
        }
        state.currentStepIndex = -1;
        return;
      }

      hasFailures = true;
    }
  }

  state.currentStepIndex = -1;
  state.phase = hasFailures ? "failed" : "completed";

  // Only persist completion when all steps succeeded
  if (!hasFailures) {
    await set("update_completed", true);
    await set("update_completed_at", new Date().toISOString());
  }
  console.log("[Updater] Update process finished");
}
