import { EMBED_MODEL_DOWNLOAD_KIND } from "./background-task-kinds";

/**
 * What a restarted web server does with a background task whose work was
 * cut off, by kind (src/lib/background-tasks.ts).
 *
 * The work's own closure died with the old process, and the route module
 * that defined it may never be loaded in the new one — so what a kind needs
 * done at its ending, whoever sees it, is named here, and the runner imports
 * this module only when it adopts or closes such a task (dynamically: the
 * hooks reach the embedder and the local-AI runtime, which nothing else in
 * the runner needs).
 *
 *  - `finish(unitEndedWell)`: an ADOPTED task's root step has ended. Answer
 *    how the task really ended — `{ok: true, result?}` or `{ok: false,
 *    error?}` — doing what the work would have done after the unit. Called
 *    with `false` too (the unit failed, or its run was lost), for cleanup;
 *    the answer is then not read.
 *  - `cleanup()`: a task closed `interrupted` without adoption. Undo what the
 *    work had left half-done.
 *
 * A kind with no entry closes on the runner's own rules (`finishes`).
 *
 * SERVER ONLY.
 */

export interface BackgroundTaskHooks {
  finish?: (unitEndedWell: boolean) => Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
  cleanup?: () => Promise<void>;
}

export async function hooksFor(kind: string): Promise<BackgroundTaskHooks> {
  if (kind === EMBED_MODEL_DOWNLOAD_KIND) {
    const embed = await import("./embed-model-download");
    return {
      async finish(unitEndedWell) {
        const outcome = await embed.finishEmbedModelDownload(unitEndedWell);
        return outcome.ok ? { ok: true, result: { status: embed.EMBED_MODEL_DONE_STATUS } } : outcome;
      },
      async cleanup() {
        await embed.settleEmbedModelAside();
      },
    };
  }
  return {};
}
