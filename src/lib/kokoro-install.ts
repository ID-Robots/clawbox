import { BackgroundTaskFailure, type StartBackgroundTaskSpec } from "./background-tasks";
import { KOKORO_INSTALL_KIND } from "./background-task-kinds";
import { KOKORO_INSTALL_NEEDS, LOCAL_AI_SYSTEM_LANE } from "./local-ai-install-queue";

/**
 * The box's own voice (Kokoro) as a background task: what POST
 * /setup-api/tts/install starts, and what a restarted server rebuilds when it
 * finds the install still queued (src/lib/background-task-starters.ts). Here
 * rather than in the route because a route file may export only its handlers.
 *
 * The work is install.sh's `voice_kokoro_install` root step — the CUDA Kokoro
 * stack, its on-demand server unit, the workspace scripts and the
 * `tts-local-cli` provider entry — followed through systemd so the row shows
 * what the installer is doing, and adopted by a server that restarts while it
 * runs.
 *
 * SERVER ONLY.
 */

/** The install and the removal never run together: they write the same stamp, cache and unit. */
export const KOKORO_GROUP = "voice-kokoro";

/**
 * Not below config/clawbox-root-update@.service's TimeoutStartSec (2 h), so
 * systemd, not this follow, owns the kill: a follow that gave up first would
 * show a red error over an install that was still running and about to
 * finish. Same rule the llama.cpp install keeps.
 */
const INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const KOKORO_INSTALLED_STATUS = "The voice on this box is installed.";

export function kokoroInstallTask(): StartBackgroundTaskSpec {
  return {
    kind: KOKORO_INSTALL_KIND,
    group: KOKORO_GROUP,
    title: "Installing the voice (Kokoro)",
    label: "Kokoro",
    status: "Installing the voice on this box (Kokoro)…",
    steps: [{ id: "install", label: "Install Kokoro and register the voice" }],
    lanes: [LOCAL_AI_SYSTEM_LANE],
    needs: KOKORO_INSTALL_NEEDS,
    async run(task) {
      task.step("install");
      // Through the task, so a web server that restarts mid-install follows
      // the same unit again; the unit is the whole install.
      const result = await task.rootStep("voice_kokoro_install", {
        timeoutMs: INSTALL_TIMEOUT_MS,
        label: "the voice install",
        finishes: { status: KOKORO_INSTALLED_STATUS },
      });
      if (!result.ok) throw new BackgroundTaskFailure(result.error || "The voice install did not finish.");
      return { status: KOKORO_INSTALLED_STATUS };
    },
  };
}
