export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { promisify } from "util";
import { execFile as execFileCb } from "child_process";
import { setMany } from "@/lib/config-store";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import { readConfig as readOpenClawConfig, inferConfiguredLocalModel, findOpenclawBin, restartGateway, openclawIsAbsent } from "@/lib/openclaw-config";
import { getActiveHarness } from "@/lib/harness";
import { removeLocalAiFromHermes } from "@/lib/hermes-local-ai";

const execFile = promisify(execFileCb);
const OPENCLAW_BIN = findOpenclawBin();

async function runCommand(cmd: string, args: string[]) {
  return await execFile(cmd, args, {
    cwd: "/home/clawbox",
    env: { ...process.env, HOME: "/home/clawbox" },
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

    if (inferredLocal?.provider === "llamacpp" || inferredLocal?.provider === "ollama") {
      await stopLocalAiProvider(inferredLocal.provider);
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
    if (!openclawIsAbsent()) {
      await runCommand(OPENCLAW_BIN, [
        "config",
        "set",
        "agents.defaults.model.fallbacks",
        JSON.stringify([]),
        "--json",
      ]).catch(() => {});
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
      const removal = await removeLocalAiFromHermes().catch((err) => {
        console.error("[local-ai] Hermes local provider removal failed:", err);
        return null;
      });
      if (removal?.wasDefault) {
        await setMany({ local_ai_was_default: true });
      }
    }

    await restartGateway().catch(() => {});

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to disable Local AI" },
      { status: 500 },
    );
  }
}
