export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  backgroundTaskResponse,
  liveBackgroundTask,
  startBackgroundTask,
} from "@/lib/background-tasks";
import { getDefaultLlamaCppModel } from "@/lib/llamacpp";
import { getActiveHarness } from "@/lib/harness";
import {
  LLAMACPP_MODEL_ID_RE,
  llamacppInstallGroup,
  llamacppInstallTask,
  type ConfigureScope,
} from "@/lib/llamacpp-install-task";

/**
 * POST /setup-api/llamacpp/install → install, start and configure Gemma 4
 * through llama.cpp, streamed (`{status}` lines, then ONE closing
 * `{success: true}` or `{error}`).
 *
 * Settings → Local AI's Install, Enable and "Make primary" on the Gemma row,
 * and the setup wizard. The work is a BACKGROUND TASK of the server
 * (src/lib/llamacpp-install-task.ts), which this response only follows: a
 * closed Settings, a reload or a dropped tunnel leaves it running and its
 * progress on the desktop's corner card.
 *
 * Pressed while another engine installs, it is accepted all the same and waits
 * its turn, queued (src/lib/local-ai-install-queue.ts) — one runtime and one
 * gateway config are not two installs' to write at once.
 */
export async function POST(request: Request) {
  let body: { model?: string; scope?: ConfigureScope; activate?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const alias = body.model?.trim() || getDefaultLlamaCppModel();
  const scope = body.scope === "local" ? "local" : "primary";
  // Only an explicit "switch to it" click sets this; a plain enable leaves the
  // customer's chosen provider in place.
  const activate = body.activate === true;
  if (!LLAMACPP_MODEL_ID_RE.test(alias)) {
    return NextResponse.json({ error: "Invalid llama.cpp model ID" }, { status: 400 });
  }
  // Sizes the window the server starts with (Hermes has a floor). Read here,
  // before the check below, so nothing awaits between that check and the
  // task it guards.
  const harness = await getActiveHarness();

  // Asked again while an install runs or waits — a reopened Settings, the
  // setup wizard retrying, a second browser: the SAME install is followed
  // rather than a second root step and a second llama-server started under the
  // first. Different settings for the same runtime are an install of their
  // own, queued behind this one, so a "make primary" is never silently folded
  // into a plain enable — and never refused either.
  const asked = { alias, scope, activate } as const;
  const live = liveBackgroundTask(llamacppInstallGroup(asked));
  if (live) return backgroundTaskResponse(live.id);

  const start = startBackgroundTask(llamacppInstallTask(asked, harness));
  return backgroundTaskResponse(start.started ? start.task.id : start.running.id);
}
