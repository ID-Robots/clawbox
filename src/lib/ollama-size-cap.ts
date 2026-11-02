import fs from "fs";
import os from "os";
import { OLLAMA_MAX_MODEL_PARAM_B } from "./resource-limits";

/**
 * The largest Ollama model, in billions of parameters, the model search offers
 * on THIS host.
 *
 * OLLAMA_MAX_MODEL_PARAM_B (4) is the answer under the cgroup cap install.sh
 * puts on ollama.service on a Jetson — the drop-in below, MemoryMax 5632M — and
 * stays the answer wherever that drop-in is. A PC installed by install-x64.sh
 * has no such cap: Ollama may use the machine. There the figure follows the
 * memory, at about 0.6 GB per billion parameters for a 4-bit model with up to
 * 60% of the memory for its weights; the rest is the desktop, the KV cache and
 * everything else the machine runs. A 128 GB DGX Spark gets 120B-class models,
 * a 16 GB laptop 16B. Never below the Jetson's figure.
 */
export const OLLAMA_MEMORY_DROPIN = "/etc/systemd/system/ollama.service.d/50-clawbox-memory.conf";

const WEIGHT_SHARE = 0.6;
const BYTES_PER_BILLION_PARAMS_Q4 = 0.6e9;

/** The marker install.sh and install-x64.sh use for "this is a Jetson". */
export const TEGRA_RELEASE = "/etc/nv_tegra_release";

export function ollamaMaxModelParamB(
  dropin: string = OLLAMA_MEMORY_DROPIN,
  totalBytes: number = os.totalmem(),
  tegraRelease: string = TEGRA_RELEASE,
): number {
  // A Jetson keeps its figure even when the drop-in is missing (a skipped or
  // failed resource-limits step): its memory is shared with the local model.
  if (fs.existsSync(dropin) || fs.existsSync(tegraRelease)) return OLLAMA_MAX_MODEL_PARAM_B;
  const derived = Math.floor((totalBytes * WEIGHT_SHARE) / BYTES_PER_BILLION_PARAMS_Q4);
  return Math.max(OLLAMA_MAX_MODEL_PARAM_B, derived);
}
