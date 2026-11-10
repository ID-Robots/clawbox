/**
 * Which local embedding model this box can run, and why not when it cannot
 * (TASK-2411). PURE and client-safe: the facts come in, the verdict goes out,
 * so the route, the MCP answer, the unit tests and the picker all read the one
 * rule. The facts are read by `local-embedding-model.ts` (server only).
 *
 * THE RULE
 *
 *  - Qwen3-Embedding-0.6B runs everywhere it ran before: the gate never
 *    refuses it, so no box loses the model it has.
 *  - Qwen3-Embedding-4B needs an x86 PC with an NVIDIA GPU holding at least
 *    6 GB of free memory. Q8_0 (4.3 GB) when 8 GB or more is free, Q4_K_M
 *    (2.5 GB) otherwise — the quant only decides what is DOWNLOADED; a variant
 *    already on disk is used whenever the 4B is allowed at all, because both
 *    fit in 6 GB with the 1024-token batch (measured, see the PR).
 *  - A Jetson Orin Nano Super is refused: its 8 GB is ONE pool shared by the system,
 *    the gateway, the desktop and every model, and the 4B embedder alone holds
 *    about 5 GB while it is awake.
 *  - A CPU-only PC is refused too (decision, TASK-2411): a full re-embed of a
 *    few thousand passages runs for hours on the CPU and holds every core it
 *    is given while the owner works, and search waits on a 4B forward pass per
 *    query. The 0.6B is the model for a PC without a GPU.
 *
 * The model that is ALREADY active is never refused for memory: its own
 * weights are what is using the GPU, so "free" under-counts it.
 */

import {
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  localEmbeddingModelSpec,
  type LocalEmbeddingModelId,
  type LocalEmbeddingQuant,
} from "./embed-runtime-ids";

/** What the gate needs to know about the machine. */
export interface EmbedHardware {
  /** `process.arch`: "x64", "arm64", … */
  arch: string;
  /** /etc/nv_tegra_release is present (install.sh's own "this is a Jetson"). */
  jetson: boolean;
  /** The first NVIDIA GPU nvidia-smi reports, or null when it reports none. */
  gpu: { name: string; totalMiB: number; freeMiB: number } | null;
}

/** Why the 4B is not on offer, in words a caller can branch on. */
export type LocalModelUnavailableReason = "jetson" | "not_x86" | "no_gpu" | "gpu_memory";

export interface LocalModelGate {
  available: boolean;
  /** The quant a download would fetch; null when the model is not on offer. */
  quant: LocalEmbeddingQuant | null;
  reason: LocalModelUnavailableReason | null;
  /** One plain sentence for the owner, null when available. */
  detail: string | null;
}

export const MIN_FREE_VRAM_MIB_4B = 6 * 1024;
export const Q8_FREE_VRAM_MIB_4B = 8 * 1024;

const gib = (mib: number) => (mib / 1024).toFixed(1);

export function gateLocalEmbeddingModel(
  id: LocalEmbeddingModelId,
  hw: EmbedHardware,
  opts: { active?: boolean } = {},
): LocalModelGate {
  if (id === DEFAULT_LOCAL_EMBEDDING_MODEL_ID) {
    return { available: true, quant: "Q8_0", reason: null, detail: null };
  }
  const label = localEmbeddingModelSpec(id).label;
  if (hw.jetson) {
    return {
      available: false,
      quant: null,
      reason: "jetson",
      detail: `${label} does not fit on a Jetson Orin Nano Super: its 8 GB is shared by the system, the assistant and every model, and this model alone needs about 5 GB while it runs. Qwen3-Embedding-0.6B is the model for this box.`,
    };
  }
  if (hw.arch !== "x64") {
    return {
      available: false,
      quant: null,
      reason: "not_x86",
      detail: `${label} runs only on an x86 PC with an NVIDIA GPU (6 GB of free GPU memory).`,
    };
  }
  if (!hw.gpu) {
    return {
      available: false,
      quant: null,
      reason: "no_gpu",
      detail: `${label} needs an NVIDIA GPU with 6 GB of free memory. On the CPU alone, embedding every file again takes hours and keeps the processor busy, so this PC stays on Qwen3-Embedding-0.6B.`,
    };
  }
  const quant: LocalEmbeddingQuant = hw.gpu.freeMiB >= Q8_FREE_VRAM_MIB_4B ? "Q8_0" : "Q4_K_M";
  if (opts.active) return { available: true, quant, reason: null, detail: null };
  if (hw.gpu.freeMiB < MIN_FREE_VRAM_MIB_4B) {
    return {
      available: false,
      quant: null,
      reason: "gpu_memory",
      detail: `${label} needs 6 GB of free GPU memory; the ${hw.gpu.name} has ${gib(hw.gpu.freeMiB)} GB free right now. Stop other local models and try again.`,
    };
  }
  return { available: true, quant, reason: null, detail: null };
}

/**
 * One row of the picker, as GET /setup-api/clawkeep/memory/provider answers
 * it in `localModels` and the MCP tool reports it.
 */
export interface LocalEmbeddingModelOption {
  id: LocalEmbeddingModelId;
  label: string;
  dimensions: number;
  /** The model the embedder runs (or will run) when the index is local. */
  active: boolean;
  /** A verified GGUF for it is on disk. */
  installed: boolean;
  /** Bytes the download would fetch (the gate's quant), or of the copy on disk. */
  bytes: number | null;
  /** The quant on disk when installed, else the one a download would fetch. */
  quant: LocalEmbeddingQuant | null;
  available: boolean;
  reason: LocalModelUnavailableReason | null;
  detail: string | null;
}

const REASONS: readonly LocalModelUnavailableReason[] = ["jetson", "not_x86", "no_gpu", "gpu_memory"];

/** Read the `localModels` rows defensively; an older server sends none. */
export function parseLocalEmbeddingModelOptions(raw: unknown): LocalEmbeddingModelOption[] {
  if (!Array.isArray(raw)) return [];
  const out: LocalEmbeddingModelOption[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.id !== "qwen3-embedding-0.6b" && r.id !== "qwen3-embedding-4b") continue;
    const spec = localEmbeddingModelSpec(r.id);
    out.push({
      id: r.id,
      label: typeof r.label === "string" ? r.label : spec.label,
      dimensions: typeof r.dimensions === "number" ? r.dimensions : spec.dimensions,
      active: r.active === true,
      installed: r.installed === true,
      bytes: typeof r.bytes === "number" ? r.bytes : null,
      quant: r.quant === "Q8_0" || r.quant === "Q4_K_M" ? r.quant : null,
      available: r.available === true,
      reason: REASONS.find((x) => x === r.reason) ?? null,
      detail: typeof r.detail === "string" ? r.detail : null,
    });
  }
  return out;
}
