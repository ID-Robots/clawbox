import type { BackgroundTaskNeeds } from "./background-task-queue";

/**
 * How the installs on Settings → Local AI share one Jetson Orin Nano (8 GB):
 * the lanes and needs each install's background task names, read by the queue
 * (src/lib/background-task-queue.ts).
 *
 * Every Install is accepted at once. What decides whether it starts at once:
 *
 *  - LOCAL_AI_SYSTEM_LANE — Kokoro, the Whisper engine and Gemma 4. Each is a
 *    root step that pip-installs into the clawbox user's own site-packages
 *    (Kokoro's PyTorch and faster-whisper's wheels share numpy and friends),
 *    builds with CUDA (CTranslate2, llama.cpp) and ends by writing the agent's
 *    config. Two of them at once is two pip runs in one site and two config
 *    writers: one at a time, in the order they were pressed.
 *  - WHISPER_CACHE_LANE — the Hugging Face cache and the unit speech-to-text
 *    reads: the engine install pre-downloads `base` into it, and every size
 *    download writes its own entry and repoints the unit.
 *  - The memory-search model's download writes one file of its own and holds
 *    no lane: it runs beside any of them when the box has the room.
 *
 * The needs are generous ceilings, the way src/lib/install-disk.ts sizes its
 * refusals: waiting costs minutes, a build killed by the OOM killer half-way
 * costs the install.
 *
 * Client-safe: data only.
 */

export const LOCAL_AI_SYSTEM_LANE = "local-ai-system";
export const WHISPER_CACHE_LANE = "whisper-cache";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * The installer's home as the ROOT STEP sees it — install.sh fixes it to this
 * literal — which is where the pip installs land.
 */
const INSTALLER_HOME = "/home/clawbox";

/** CUDA PyTorch (~300 MB of wheels, more unpacked), Kokoro and its weights. */
export const KOKORO_INSTALL_NEEDS: BackgroundTaskNeeds = {
  memoryBytes: 1536 * MIB,
  diskBytes: 2 * GIB,
  diskPath: INSTALLER_HOME,
};

/** The CTranslate2 CUDA build (the heaviest step on the board) and its 3 GiB of trees. */
export const WHISPER_ENGINE_INSTALL_NEEDS: BackgroundTaskNeeds = {
  memoryBytes: 2 * GIB,
  diskBytes: 3 * GIB,
  diskPath: INSTALLER_HOME,
};

/** Gemma 4 loading into llama-server (and a llama.cpp build when the runtime is missing). */
export function llamacppInstallNeeds(modelDir: string): BackgroundTaskNeeds {
  return { memoryBytes: 4 * GIB, diskBytes: 5 * GIB, diskPath: modelDir };
}

/** One 640 MB GGUF, fetched by the Hub CLI. */
export function embedModelNeeds(modelDir: string): BackgroundTaskNeeds {
  return { memoryBytes: 256 * MIB, diskBytes: 700 * 1000 * 1000, diskPath: modelDir };
}

/** One Whisper size's weights, fetched by a small Python process. */
export function whisperSizeNeeds(bytes: number, cacheDir: string): BackgroundTaskNeeds {
  return { memoryBytes: 512 * MIB, diskBytes: bytes, diskPath: cacheDir };
}
