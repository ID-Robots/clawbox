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
    command: "git config --global --add safe.directory /home/clawbox/clawbox && git -C /home/clawbox/clawbox pull --ff-only",
    timeoutMs: 60_000,
  },
  {
    id: "apt_update",
    label: "Updating system packages",
    command: "apt-get update",
    timeoutMs: 120_000,
  },
  {
    id: "nvidia_jetpack",
    label: "Installing NVIDIA JetPack",
    command: "apt-get install -y nvidia-jetpack",
    timeoutMs: 600_000,
  },
  {
    id: "performance_mode",
    label: "Enabling max performance mode",
    command: "nvpmodel -m 0 && jetson_clocks",
    timeoutMs: 60_000,
  },
  {
    id: "openclaw_install",
    label: "Updating OpenClaw",
    command: "npm install -g openclaw --prefix /home/clawbox/.npm-global",
    timeoutMs: 120_000,
  },
  {
    id: "models_update",
    label: "Configuring AI models",
    command: "/home/clawbox/.npm-global/bin/openclaw models",
    timeoutMs: 600_000,
  },
];

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
