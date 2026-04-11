export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { promisify } from "util";
import { execFile as execFileCb } from "child_process";
import { setMany } from "@/lib/config-store";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import { readConfig as readOpenClawConfig, inferConfiguredLocalModel, findOpenclawBin, restartGateway } from "@/lib/openclaw-config";

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

    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "agents.defaults.model.fallbacks",
      JSON.stringify([]),
      "--json",
    ]).catch(() => {});

    await restartGateway().catch(() => {});

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to disable Local AI" },
      { status: 500 },
    );
  }
}
