import fs from "fs/promises";
import path from "./runtime-path";
import { BackgroundTaskFailure, type StartBackgroundTaskSpec } from "./background-tasks";
import { EMBED_MODEL_DOWNLOAD_KIND } from "./background-task-kinds";
import { getEmbedLaunchSpec, getEmbedProvisioningStatus } from "./embed-server";
import { EMBED_HF_FILE } from "./embed-runtime-ids";
import {
  EMBED_MODEL_DONE_STATUS,
  EMBED_MODEL_MISSING_ERROR,
  embedModelAsidePath,
  settleEmbedModelAside,
} from "./embed-model-download";
import { dirBytes } from "./install-disk";
import { embedModelNeeds } from "./local-ai-install-queue";
import { stopLocalAiProvider } from "./local-ai-runtime";

/**
 * The memory-search model's download as a background task: what POST
 * /setup-api/embed/install starts, and what a restarted server rebuilds when it
 * finds the download still queued (src/lib/background-task-starters.ts).
 *
 * SERVER ONLY.
 */

/** One download at a time: two would fight over the same file. */
export const EMBED_GROUP = "embed-model";

/**
 * Not below config/clawbox-root-update@.service's TimeoutStartSec (2 h), so
 * systemd, not this follow, owns the kill. Same rule the llama.cpp and voice
 * installs keep.
 */
const INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** How often the model directory is re-measured for the bar. */
const PROGRESS_POLL_MS = 1500;
/**
 * The default GGUF's size as the Hub lists it (639 MB), for the bar only: the
 * download's own size is not known before it starts, and an estimate a few
 * kilobytes off holds the bar at 100% for those last kilobytes, which the
 * percent caps. Another file (`EMBED_HF_FILE` in .env) has no known size and
 * gets a moving bar without a figure.
 */
const DEFAULT_MODEL_BYTES = 639 * 1000 * 1000;

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

/** `force`: "Download again" over a copy that is here. */
export function embedModelDownloadTask({ force }: { force: boolean }): StartBackgroundTaskSpec {
  const spec = getEmbedLaunchSpec();
  const modelDir = path.dirname(spec.modelPath);
  return {
    kind: EMBED_MODEL_DOWNLOAD_KIND,
    group: EMBED_GROUP,
    title: "Downloading the memory-search model",
    label: "Memory search",
    meta: { force },
    status: "Fetching the memory-search model (Qwen3-Embedding, about 640 MB)…",
    needs: embedModelNeeds(modelDir),
    async run(task) {
      const aside = embedModelAsidePath(spec.modelPath);
      // Inside the task, where the group lock serialises it: a request that
      // tidied this up beside a running "Download again" would put the copy it
      // had just moved aside back under it. (A server that restarts mid-way
      // settles it too: src/lib/background-task-finishers.ts.)
      await settleEmbedModelAside(spec.modelPath);
      // "Download again" over a copy that is here: the step answers "already
      // cached" for ANY file at that path, a truncated one included, so the
      // copy is moved aside first — and put back if the new one never arrives,
      // so a failed repair leaves the box no worse than it found it.
      const previousBytes = force ? await fs.stat(spec.modelPath).then((s) => s.size, () => null) : null;
      if (previousBytes !== null) await fs.rename(spec.modelPath, aside);
      const total = previousBytes ?? (path.basename(spec.modelPath) === EMBED_HF_FILE ? DEFAULT_MODEL_BYTES : null);
      const restore = async () => {
        if (previousBytes !== null && !(await exists(spec.modelPath))) await fs.rename(aside, spec.modelPath).catch(() => {});
      };

      // A partial download already there (an attempt that died) is resumed by
      // the Hub CLI, so it counts from the start rather than reading as zero.
      const timer = total === null ? null : setInterval(() => {
        void dirBytes(modelDir).then((bytes) => {
          if (bytes !== null) task.progress(Math.min(bytes, total), total);
        });
      }, PROGRESS_POLL_MS);
      if (total !== null) task.progress(0, total);
      let result;
      try {
        result = await task.rootStep("embed_model", {
          timeoutMs: INSTALL_TIMEOUT_MS,
          label: "the memory model download",
        });
      } finally {
        if (timer) clearInterval(timer);
      }
      if (!result.ok) {
        await restore();
        throw new BackgroundTaskFailure(result.error || "The memory model download did not finish.");
      }
      const after = await getEmbedProvisioningStatus().catch(() => null);
      if (!after?.modelAvailable) {
        await restore();
        throw new BackgroundTaskFailure(EMBED_MODEL_MISSING_ERROR);
      }
      if (previousBytes !== null) {
        await fs.rm(aside, { force: true }).catch(() => {});
        // The running embedder still holds the old copy open; stopped, it is
        // woken on the next search with the new one.
        await stopLocalAiProvider("embed").catch(() => {});
      }
      return { status: EMBED_MODEL_DONE_STATUS };
    },
  };
}
