import type { StartBackgroundTaskSpec } from "./background-tasks";
import {
  EMBED_MODEL_DOWNLOAD_KIND,
  KOKORO_INSTALL_KIND,
  LLAMACPP_INSTALL_KIND,
  WHISPER_ENGINE_INSTALL_KIND,
  WHISPER_SIZE_DOWNLOAD_KIND,
} from "./background-task-kinds";
import { safeWhisperSize } from "./local-install";

/**
 * The work of a QUEUED task, rebuilt after a restart (src/lib/background-
 * tasks.ts).
 *
 * A task accepted into the queue keeps its work as a closure of the process
 * that accepted it. A restart loses the closure but not the record: the task
 * is still queued, under the kind and `meta` it was started with — which is
 * everything its starting route used to build it. So each kind that can wait
 * in the queue names here how its work is built again, and the runner imports
 * this only when such a task's turn comes (dynamically: it reaches every
 * engine's install, which nothing else in the runner needs).
 *
 * A kind with no entry, or a `meta` this build cannot read, answers null and
 * the task ends `interrupted` with a sentence that says to start it again.
 *
 * SERVER ONLY.
 */
export async function startSpecFor(kind: string, meta: Record<string, unknown>): Promise<StartBackgroundTaskSpec | null> {
  switch (kind) {
    case KOKORO_INSTALL_KIND:
      return (await import("./kokoro-install")).kokoroInstallTask();
    case WHISPER_ENGINE_INSTALL_KIND:
      return (await import("./whisper-install-tasks")).whisperEngineInstallTask();
    case WHISPER_SIZE_DOWNLOAD_KIND: {
      const size = safeWhisperSize(meta.size);
      if (size === null) return null;
      return (await import("./whisper-install-tasks")).whisperSizeDownloadTaskNow(size);
    }
    case EMBED_MODEL_DOWNLOAD_KIND:
      return (await import("./embed-install-task")).embedModelDownloadTask({ force: meta.force === true });
    case LLAMACPP_INSTALL_KIND: {
      const llamacpp = await import("./llamacpp-install-task");
      const request = llamacpp.llamacppInstallRequest(meta);
      return request ? llamacpp.llamacppInstallTaskNow(request) : null;
    }
    default:
      return null;
  }
}
