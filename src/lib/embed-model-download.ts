import fs from "fs/promises";
import path from "./runtime-path";
import { getEmbedLaunchSpec, getEmbedProvisioningStatus } from "./embed-server";

/**
 * The memory-search model download's bookkeeping, shared by the route that
 * starts it (src/app/setup-api/embed/install/route.ts) and by what a restarted
 * web server does with a download it adopted or found cut off
 * (src/lib/background-task-finishers.ts). Route files may export only
 * handlers, so it lives here.
 *
 * "Download again" moves the copy that is on the box ASIDE before the root
 * step runs — install.sh's step answers "already cached" for any file at the
 * model's path, a truncated one included — and the aside copy has to be
 * settled whatever ends the download: put back when no new model arrived,
 * dropped (and the embedder that still holds it open stopped) when one did.
 * The process that moved it may not be the one that sees the end.
 *
 * SERVER ONLY.
 */

export const EMBED_MODEL_DONE_STATUS = "The memory-search model is on this box.";
export const EMBED_MODEL_MISSING_ERROR = "The download finished but the memory-search model is not on this box.";

/**
 * Where "Download again" keeps the copy it replaces until the new one is
 * whole: beside the models directory, never in it — the models directory's
 * size is the download's bar, and the old copy would count as downloaded.
 */
export function embedModelAsidePath(modelPath: string = getEmbedLaunchSpec().modelPath): string {
  return path.join(path.dirname(path.dirname(modelPath)), `${path.basename(modelPath)}.previous`);
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

/**
 * Settle a copy set aside by a download that has ended (or never will):
 * back in place when there is no model, gone when there is one. Answers
 * whether an aside copy was dropped — the embedder may still hold it open.
 */
export async function settleEmbedModelAside(modelPath: string = getEmbedLaunchSpec().modelPath): Promise<{ dropped: boolean }> {
  const aside = embedModelAsidePath(modelPath);
  if (!(await exists(aside))) return { dropped: false };
  if (await exists(modelPath)) {
    await fs.rm(aside, { force: true }).catch(() => {});
    return { dropped: true };
  }
  await fs.rename(aside, modelPath).catch(() => {});
  return { dropped: false };
}

/**
 * How a download that ended in another process really ended: the model must
 * be on the box (a step can exit 0 without one: no Hugging Face CLI), and an
 * aside copy is then dropped and the embedder holding it stopped, so the next
 * search loads the new one. A download that did not end well puts the old
 * copy back.
 */
export async function finishEmbedModelDownload(unitEndedWell: boolean): Promise<{ ok: boolean; error?: string }> {
  const modelPath = getEmbedLaunchSpec().modelPath;
  if (!unitEndedWell) {
    await settleEmbedModelAside(modelPath);
    return { ok: false };
  }
  const after = await getEmbedProvisioningStatus().catch(() => null);
  if (!after?.modelAvailable) {
    await settleEmbedModelAside(modelPath);
    return { ok: false, error: EMBED_MODEL_MISSING_ERROR };
  }
  const { dropped } = await settleEmbedModelAside(modelPath);
  if (dropped) {
    const { stopLocalAiProvider } = await import("./local-ai-runtime");
    await stopLocalAiProvider("embed").catch(() => {});
  }
  return { ok: true };
}
