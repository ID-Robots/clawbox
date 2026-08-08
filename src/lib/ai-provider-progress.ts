export interface OverlayProgressState {
  phase: number;
  detail: string | null;
  progressPercent: number | null;
}

export interface OllamaProgressInput {
  pulling: boolean;
  saving: boolean;
  pullProgress: {
    status: string;
    completed?: number;
    total?: number;
  } | null;
}

function clampPhase(phase: number, stepCount: number): number {
  return Math.max(0, Math.min(phase, Math.max(0, stepCount - 1)));
}

function calculateProgressPercent(completed?: number, total?: number): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((completed || 0) / total) * 100)));
}

export function getOllamaOverlayProgress(
  input: OllamaProgressInput,
  stepCount: number,
): OverlayProgressState {
  const { pulling, saving, pullProgress } = input;
  if (saving) {
    return {
      phase: clampPhase(2, stepCount),
      detail: "Applying ClawBox configuration...",
      progressPercent: null,
    };
  }

  if (!pulling) {
    return {
      phase: 0,
      detail: "Preparing Ollama...",
      progressPercent: null,
    };
  }

  const status = pullProgress?.status?.trim() || "Downloading model files...";
  const normalized = status.toLowerCase();
  const phase = normalized.includes("pulling manifest") || normalized.includes("verifying")
    ? 0
    : 1;

  return {
    phase: clampPhase(phase, stepCount),
    detail: status,
    progressPercent: calculateProgressPercent(pullProgress?.completed, pullProgress?.total),
  };
}

// The install route tags long-running provisioning lines as
// `<phase-stable prefix> — <raw journal line>`. The prefix keeps the step
// indicator pinned (raw cmake/hf/apt output matches no phase keyword and would
// bounce the wizard back to step 1); the tail is what the user actually wants
// to read while a multi-minute build runs.
const DETAIL_SEPARATOR = " — ";

function splitStatusDetail(status: string): string | null {
  const index = status.indexOf(DETAIL_SEPARATOR);
  if (index < 0) return null;
  const detail = status.slice(index + DETAIL_SEPARATOR.length).trim();
  return detail || null;
}

export function getLlamaCppOverlayProgress(
  status: string | null,
  stepCount: number,
): OverlayProgressState {
  const normalizedStatus = status?.trim() || "Preparing llama.cpp runtime...";
  const normalized = normalizedStatus.toLowerCase();

  let phase = 0;
  if (
    normalized.includes("installed, running, and configured")
    || normalized.includes("ready and configured")
  ) {
    phase = 4;
  } else if (
    normalized.includes("applying clawbox configuration")
    || normalized.includes("applying configuration")
  ) {
    phase = 3;
  } else if (
    normalized.includes("starting llama-server")
    || normalized.includes("starting preinstalled gemma")
    || normalized.includes("starting llama.cpp")
    || normalized.includes("already starting")
    || normalized.includes("waiting for it to become ready")
  ) {
    phase = 2;
  } else if (
    normalized.includes("downloading")
    || normalized.includes("installing gemma 4")
    || normalized.includes("installing llama.cpp and gemma 4")
    || normalized.includes("repairing the llama.cpp runtime")
  ) {
    phase = 1;
  }

  return {
    phase: clampPhase(phase, stepCount),
    detail: splitStatusDetail(normalizedStatus),
    progressPercent: null,
  };
}
