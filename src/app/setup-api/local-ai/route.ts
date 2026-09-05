export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { promisify } from "util";
import { execFile as execFileCb } from "child_process";
import { get, setMany } from "@/lib/config-store";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import { readConfig as readOpenClawConfig, inferConfiguredLocalModel, findOpenclawBin, restartGateway, openclawIsAbsent } from "@/lib/openclaw-config";
import { getActiveHarness } from "@/lib/harness";
import { removeLocalAiFromHermes } from "@/lib/hermes-local-ai";

const execFile = promisify(execFileCb);
const OPENCLAW_BIN = findOpenclawBin();
const CLAWBOX_HOME_DIR = process.env.CLAWBOX_HOME_DIR || process.env.HOME || "/home/clawbox";

async function runCommand(cmd: string, args: string[]) {
  return await execFile(cmd, args, {
    cwd: CLAWBOX_HOME_DIR,
    env: { ...process.env, HOME: CLAWBOX_HOME_DIR },
    timeout: 30_000,
  });
}

export async function POST(request: Request) {
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action !== "disable") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }

  try {
    const config = await readOpenClawConfig();
    const inferredLocal = inferConfiguredLocalModel(config);

    // Which runtime is actually up. The OpenClaw config answers on an OpenClaw
    // box; on a Hermes one it is empty of models by definition, so this used to
    // resolve to nothing and "turn Local AI off" left the model RESIDENT — up
    // to 3.2 GB of an 8 GB box, and for Ollama a unit that also stays enabled
    // across reboots (the enable path persists it). Our own config store knows
    // what we started, so it is the fallback. Read before the clear below.
    const stored = await get("local_ai_provider");
    const runningProvider = inferredLocal?.provider
      ?? (stored === "llamacpp" || stored === "ollama" ? stored : null);

    if (runningProvider === "llamacpp" || runningProvider === "ollama") {
      await stopLocalAiProvider(runningProvider);
    }

    await setMany({
      local_ai_configured: false,
      local_ai_provider: undefined,
      local_ai_model: undefined,
      local_ai_configured_at: undefined,
    });

    // Clearing the OpenClaw fallback only applies where OpenClaw exists. On the
    // Hermes SKU there is no binary to spawn (it would ENOENT); the Hermes
    // unregister below is what actually takes effect there.
    //
    // A failure here is REPORTED, not swallowed: the model is stopped, so a
    // fallback list that still names it sends the next turn that falls back to
    // an endpoint with nothing behind it. It is a qualification rather than a
    // refusal, though — the stop and the flag clear above are the steps this
    // click is for, and they landed — so it rides the `warning` channel the
    // panel already paints amber, and a retry re-runs only what is left.
    let warning: string | null = null;
    if (!openclawIsAbsent()) {
      const cleared = await runCommand(OPENCLAW_BIN, [
        "config",
        "set",
        "agents.defaults.model.fallbacks",
        JSON.stringify([]),
        "--json",
      ]).then(
        () => true,
        (err) => {
          console.error("[local-ai] Failed to clear the OpenClaw fallback list:", err);
          return false;
        },
      );
      if (!cleared) {
        warning = "Local AI is stopped, but OpenClaw still lists it as a fallback model. Turn it off again to finish clearing it.";
      }
    }

    // Hermes keeps its own providers block, so disabling here has to unregister
    // there too — otherwise the picker keeps offering a model that is no longer
    // running, which fails only once the customer actually sends a message.
    if ((await getActiveHarness()) === "hermes") {
      // `wasDefault` is the round-trip half: when the local model was the
      // device's active provider, removeLocalAiFromHermes clears the selection
      // (leaving it set with the providers block gone 502s every chat turn with
      // "Unknown provider 'clawlocal'"), and we remember that it WAS the
      // selection so re-enabling puts the device back where it was rather than
      // on nothing.
      //
      // The failure is ANSWERED rather than logged. On this SKU the unregister
      // is the only step that reaches the customer: the OpenClaw clear above is
      // skipped (no binary) and the restart below returns immediately (no
      // gateway unit), so a swallowed failure left `providers.clawlocal` in
      // config.yaml and the route still said `{success:true}` — Settings showed
      // Local AI off while Hermes' own pickers went on offering the stopped
      // model, and the owner learned otherwise from a chat turn. The steps that
      // did run stand: a retry has only this one left to do.
      const removal = await removeLocalAiFromHermes().catch((err) => {
        console.error("[local-ai] Hermes local provider removal failed:", err);
        return null;
      });
      if (!removal) {
        return NextResponse.json(
          {
            error: "Local AI was stopped, but Hermes still lists it as a provider. Try turning Local AI off again.",
            code: "hermes_unregister_failed",
          },
          { status: 502 },
        );
      }
      if (removal.wasDefault) {
        await setMany({ local_ai_was_default: true });
      }
    }

    // No readiness wait: this answer is discarded, and the route answers
    // `{success:true}` for the config change either way — so the poll would only
    // add up to the whole budget to an owner's "Turn off Local AI" click.
    await restartGateway({ awaitReady: false }).catch(() => {});

    return NextResponse.json(warning ? { success: true, warning } : { success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to disable Local AI" },
      { status: 500 },
    );
  }
}
