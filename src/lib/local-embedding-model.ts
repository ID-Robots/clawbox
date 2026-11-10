import { execFile } from "child_process";
import fs from "fs/promises";
import { existsSync } from "fs";
import { promisify } from "util";
import path from "./runtime-path";
import {
  getEmbedLaunchSpec,
  getEmbedModelDir,
  readActiveLocalEmbeddingModel,
  type LocalEmbeddingSelection,
} from "./embed-server";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  LOCAL_EMBEDDING_MODELS,
  localEmbeddingModelSpec,
  localEmbeddingVariant,
  type LocalEmbeddingModelId,
  type LocalEmbeddingVariant,
} from "./embed-runtime-ids";
import {
  gateLocalEmbeddingModel,
  type EmbedHardware,
  type LocalEmbeddingModelOption,
  type LocalModelGate,
} from "./local-embedding-gating";

/**
 * The machine facts behind the local-model gate, and the picker's rows
 * (TASK-2411). The RULE is `local-embedding-gating.ts`; this reads the facts.
 *
 * SERVER ONLY.
 */

const execFileAsync = promisify(execFile);

/** install.sh's and install-x64.sh's own marker for "this is a Jetson". */
const TEGRA_RELEASE = "/etc/nv_tegra_release";
/** Free GPU memory moves; a reading is reused this long and no longer. */
const HARDWARE_TTL_MS = 10_000;

let cached: { at: number; value: EmbedHardware } | null = null;

/**
 * The first GPU of `nvidia-smi --query-gpu=name,memory.total,memory.free
 * --format=csv,noheader,nounits`, or null for anything that is not a reading
 * (a Jetson answers "[N/A]" for both memory fields).
 */
export function parseNvidiaSmiGpu(stdout: string): EmbedHardware["gpu"] {
  const line = stdout.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const parts = line.split(",").map((p) => p.trim());
  if (parts.length < 3) return null;
  const totalMiB = Number(parts[parts.length - 2]);
  const freeMiB = Number(parts[parts.length - 1]);
  const name = parts.slice(0, parts.length - 2).join(",");
  if (!name || !Number.isFinite(totalMiB) || !Number.isFinite(freeMiB) || totalMiB <= 0 || freeMiB < 0) return null;
  return { name, totalMiB, freeMiB };
}

async function readGpu(): Promise<EmbedHardware["gpu"]> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 5_000 },
    );
    return parseNvidiaSmiGpu(stdout);
  } catch {
    // No driver, no GPU, or no nvidia-smi: a CPU-only PC as far as the gate goes.
    return null;
  }
}

export async function readEmbedHardware(now = Date.now()): Promise<EmbedHardware> {
  if (cached && now - cached.at < HARDWARE_TTL_MS) return cached.value;
  const jetson = existsSync(/* turbopackIgnore: true */ TEGRA_RELEASE);
  // A Jetson's nvidia-smi says nothing the gate could use; do not spend the call.
  const value: EmbedHardware = { arch: process.arch, jetson, gpu: jetson ? null : await readGpu() };
  cached = { at: now, value };
  return value;
}

/** For the tests. */
export function resetEmbedHardwareCache(): void {
  cached = null;
}

async function isFile(file: string): Promise<boolean> {
  return fs.stat(file).then((s) => s.isFile(), () => false);
}

/**
 * The copy of `id` on disk, if there is one.
 *
 * The 0.6B is the DEFAULT slot, so its file is whatever .env names (the
 * shipped Q8_0 on every box that never changed it). Any other model is one of
 * its catalog variants, best first; only a verified download is ever renamed
 * into place (embed-model-fetch.ts), so a file there is a whole one.
 */
export async function installedLocalEmbeddingVariant(
  id: LocalEmbeddingModelId,
): Promise<{ quant: LocalEmbeddingVariant["quant"]; file: string; bytes: number } | null> {
  if (id === DEFAULT_LOCAL_EMBEDDING_MODEL_ID) {
    const spec = getEmbedLaunchSpec();
    const stat = await fs.stat(spec.modelPath).catch(() => null);
    return stat?.isFile() ? { quant: "Q8_0", file: spec.hfFile, bytes: stat.size } : null;
  }
  for (const variant of localEmbeddingModelSpec(id).variants) {
    if (await isFile(path.join(getEmbedModelDir(), variant.file))) {
      return { quant: variant.quant, file: variant.file, bytes: variant.bytes };
    }
  }
  return null;
}

/** May this box switch onto `id` right now, and with which quant? */
export async function gateLocalModel(id: LocalEmbeddingModelId): Promise<LocalModelGate> {
  const [hardware, active] = await Promise.all([readEmbedHardware(), readActiveLocalEmbeddingModel()]);
  return gateLocalEmbeddingModel(id, hardware, { active: active.id === id });
}

/**
 * The selection a switch onto `id` records: the variant on disk when there is
 * one (any variant fits once the model is allowed at all), else null.
 */
export async function selectionForSwitch(id: LocalEmbeddingModelId): Promise<LocalEmbeddingSelection | null> {
  // The model the box already runs keeps the quant it runs: two quants of one
  // model share a name and a width, so a quant-only change is one no identity
  // would catch — it is never made here.
  const active = await readActiveLocalEmbeddingModel();
  if (active.id === id && id !== DEFAULT_LOCAL_EMBEDDING_MODEL_ID) {
    const file = path.join(getEmbedModelDir(), localEmbeddingVariant(id, active.quant).file);
    return (await isFile(file)) ? active : null;
  }
  const installed = await installedLocalEmbeddingVariant(id);
  return installed ? { id, quant: installed.quant } : null;
}

/** Every catalog model as the picker draws it. */
export async function localEmbeddingModelOptions(): Promise<LocalEmbeddingModelOption[]> {
  const [hardware, active] = await Promise.all([readEmbedHardware(), readActiveLocalEmbeddingModel()]);
  return Promise.all(
    LOCAL_EMBEDDING_MODELS.map(async (spec) => {
      const isActive = active.id === spec.id;
      const gate = gateLocalEmbeddingModel(spec.id, hardware, { active: isActive });
      const installed = await installedLocalEmbeddingVariant(spec.id);
      const downloadBytes = gate.quant ? spec.variants.find((v) => v.quant === gate.quant)?.bytes ?? null : null;
      return {
        id: spec.id,
        label: spec.label,
        dimensions: spec.dimensions,
        active: isActive,
        installed: installed !== null,
        bytes: installed?.bytes ?? downloadBytes,
        quant: installed?.quant ?? gate.quant,
        available: gate.available,
        reason: gate.reason,
        detail: gate.detail,
      };
    }),
  );
}
