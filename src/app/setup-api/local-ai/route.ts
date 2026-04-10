export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { promisify } from "util";
import { execFile as execFileCb } from "child_process";
import { setMany } from "@/lib/config-store";
import { clearLlamaCppPid, getLlamaCppLaunchSpec, readLlamaCppPid } from "@/lib/llamacpp-server";
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

async function disableLlamaCpp(alias?: string) {
  const spec = getLlamaCppLaunchSpec(alias);
  const pid = await readLlamaCppPid(spec.pidPath);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Process is already gone.
      }
    } catch {}
    await clearLlamaCppPid(spec.pidPath);
  }
}

async function disableOllama() {
  try {
    await execFile("systemctl", ["stop", "ollama"], { timeout: 30_000 });
  } catch {
    // Non-fatal: if systemd stop fails, fall back to process termination attempt.
    const pgrep = await execFile("pgrep", ["-f", "ollama serve"], { timeout: 5_000 }).catch(() => null);
    const pids = pgrep?.stdout?.trim().split("\n").filter(Boolean) ?? [];
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {}
    }
  }
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

    if (inferredLocal?.provider === "llamacpp") {
      await disableLlamaCpp(inferredLocal.model.replace(/^llamacpp\//, ""));
    } else if (inferredLocal?.provider === "ollama") {
      await disableOllama();
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
