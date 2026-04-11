export const dynamic = "force-dynamic";

import { execFile as execFileCb, spawn } from "child_process";
import fs from "fs/promises";
import { NextResponse } from "next/server";
import { promisify } from "util";
import { POST as configureAiModel } from "@/app/setup-api/ai-models/configure/route";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import { getDefaultLlamaCppModel } from "@/lib/llamacpp";
import {
  clearLlamaCppPid,
  ensureLlamaCppRuntimeDir,
  getLlamaCppProvisioningStatus,
  getLlamaCppLaunchSpec,
  isLlamaCppPidRunning,
  queryLlamaCppModels,
  readLlamaCppPid,
  tailLlamaCppLog,
  writeLlamaCppPid,
} from "@/lib/llamacpp-server";

const MODEL_ID_RE = /^[a-zA-Z0-9._:-]+$/;
const encoder = new TextEncoder();
const execFile = promisify(execFileCb);
const LLAMACPP_INSTALL_SERVICE = "clawbox-root-update@llamacpp_install.service";
const LLAMACPP_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

function emit(controller: ReadableStreamDefaultController<Uint8Array>, payload: Record<string, unknown>) {
  controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
}

function getLastLogLine(logText: string): string | null {
  const lines = logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

type ConfigureScope = "primary" | "local";

function shouldRepairLlamaCppRuntime(logLine: string | null): boolean {
  if (!logLine) return false;
  const normalized = logLine.toLowerCase();
  return normalized.includes("[llamacpp] missing hugging face cli")
    || normalized.includes("[llamacpp] missing llama-server")
    || normalized.includes("[llamacpp] missing local model");
}

async function readLlamaCppInstallFailure(): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/journalctl",
      ["-u", LLAMACPP_INSTALL_SERVICE, "-n", "40", "--no-pager", "-o", "cat"],
      { timeout: 10_000 },
    );
    return getLastLogLine(stdout);
  } catch {
    return null;
  }
}

async function repairLlamaCppRuntime(): Promise<{ ok: boolean; error?: string }> {
  await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "reset-failed", LLAMACPP_INSTALL_SERVICE], {
    timeout: 10_000,
  }).catch(() => {});

  try {
    await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "start", LLAMACPP_INSTALL_SERVICE], {
      timeout: LLAMACPP_INSTALL_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    const failureLine = await readLlamaCppInstallFailure();
    return {
      ok: false,
      error: failureLine || (err instanceof Error ? err.message : "Failed to repair llama.cpp runtime"),
    };
  }
}

function startLlamaCpp(spec: ReturnType<typeof getLlamaCppLaunchSpec>, alias: string) {
  return spawn(
    "bash",
    [
      spec.scriptPath,
      spec.modelDir,
      spec.hfRepo,
      spec.hfFile,
      alias,
      spec.host,
      `${spec.port}`,
      spec.logPath,
      spec.binPath,
      spec.hfBinPath,
      `${spec.contextWindow}`,
    ],
    {
      cwd: "/home/clawbox",
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: "/home/clawbox" },
    }
  );
}

async function configureLlamaCpp(alias: string, scope: ConfigureScope): Promise<{ ok: boolean; error?: string }> {
  const req = new Request("http://localhost/setup-api/ai-models/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "llamacpp",
      apiKey: alias,
      authMode: "local",
      scope,
    }),
  });
  const res = await configureAiModel(req);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.success) {
    return { ok: false, error: body?.error || "Failed to configure llama.cpp" };
  }
  return { ok: true };
}

export async function POST(request: Request) {
  let body: { model?: string; scope?: ConfigureScope };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const alias = body.model?.trim() || getDefaultLlamaCppModel();
  const scope = body.scope === "local" ? "local" : "primary";
  if (!MODEL_ID_RE.test(alias)) {
    return NextResponse.json({ error: "Invalid llama.cpp model ID" }, { status: 400 });
  }

  const spec = getLlamaCppLaunchSpec(alias);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await ensureLlamaCppRuntimeDir();
        emit(controller, { status: "Checking local Gemma 4 runtime..." });

        const existingModels = await queryLlamaCppModels(spec.baseUrl);
        if (existingModels.includes(alias)) {
          emit(controller, { status: "llama.cpp is already running. Applying configuration..." });
          const configured = await configureLlamaCpp(alias, scope);
          if (!configured.ok) {
            emit(controller, { error: configured.error });
            controller.close();
            return;
          }
          emit(controller, { success: true, model: alias, status: "llama.cpp is ready and configured." });
          controller.close();
          return;
        }

        let provisioning = await getLlamaCppProvisioningStatus(alias);
        if (!provisioning.installed) {
          emit(controller, {
            status: provisioning.binaryAvailable
              ? "Installing Gemma 4 for offline use..."
              : "Installing llama.cpp and Gemma 4 for offline use...",
          });
          const repaired = await repairLlamaCppRuntime();
          if (!repaired.ok) {
            emit(controller, { error: repaired.error || "Failed to provision the local Gemma 4 runtime" });
            controller.close();
            return;
          }
          provisioning = await getLlamaCppProvisioningStatus(alias);
          if (!provisioning.installed) {
            emit(controller, { error: "llama.cpp install finished, but the local Gemma 4 runtime is still incomplete." });
            controller.close();
            return;
          }
        }

        let pid = await readLlamaCppPid(spec.pidPath);
        if (pid && !isLlamaCppPidRunning(pid)) {
          await clearLlamaCppPid(spec.pidPath);
          pid = null;
        }
        let attemptedRuntimeRepair = false;
        let waitingForExistingStart = !!pid;
        let startedRuntimeHere = false;

        const deadline = Date.now() + spec.startupTimeoutMs;
        let lastLogLine = "";

        while (Date.now() < deadline) {
          if (!pid) {
            emit(controller, {
              status: attemptedRuntimeRepair
                ? `Restarting llama.cpp after repairing the local runtime...`
                : provisioning.installed
                  ? `Starting preinstalled Gemma 4...`
                  : `Starting llama.cpp and downloading ${alias}...`,
            });
            await fs.writeFile(spec.logPath, "", "utf-8").catch(() => {});
            const child = startLlamaCpp(spec, alias);

            if (!child.pid) {
              emit(controller, { error: "Failed to start llama.cpp" });
              controller.close();
              return;
            }

            child.unref();
            await writeLlamaCppPid(child.pid, spec.pidPath);
            pid = child.pid;
            waitingForExistingStart = false;
            startedRuntimeHere = true;
            lastLogLine = "";
          } else if (waitingForExistingStart) {
            emit(controller, { status: "llama.cpp is already starting. Waiting for it to become ready..." });
            waitingForExistingStart = false;
          }

          const models = await queryLlamaCppModels(spec.baseUrl);
          if (models.includes(alias)) {
            emit(controller, { status: "llama.cpp is ready. Applying ClawBox configuration..." });
            const configured = await configureLlamaCpp(alias, scope);
            if (!configured.ok) {
              emit(controller, { error: configured.error });
              controller.close();
              return;
            }
            if (startedRuntimeHere) {
              emit(controller, { status: "Gemma 4 is configured. Returning it to standby to free RAM..." });
              await stopLocalAiProvider("llamacpp").catch(() => {});
              emit(controller, {
                success: true,
                model: alias,
                status: `${alias} is installed and configured. It will wake automatically when OpenClaw needs it.`,
              });
            } else {
              emit(controller, { success: true, model: alias, status: `${alias} is installed, running, and configured.` });
            }
            controller.close();
            return;
          }

          const currentPid = await readLlamaCppPid(spec.pidPath);
          if (currentPid && !isLlamaCppPidRunning(currentPid)) {
            await clearLlamaCppPid(spec.pidPath);
            pid = null;
            const logText = await tailLlamaCppLog(spec.logPath);
            const logLine = getLastLogLine(logText);
            if (!attemptedRuntimeRepair && shouldRepairLlamaCppRuntime(logLine)) {
              emit(controller, { status: "Repairing the llama.cpp runtime so Gemma can start..." });
              attemptedRuntimeRepair = true;
              const repaired = await repairLlamaCppRuntime();
              if (!repaired.ok) {
                emit(controller, { error: repaired.error || "Failed to repair llama.cpp runtime" });
                controller.close();
                return;
              }
              emit(controller, { status: "llama.cpp runtime repaired. Restarting Gemma..." });
              continue;
            }

            emit(controller, { error: logLine || "llama.cpp exited before becoming ready." });
            controller.close();
            return;
          }

          const logText = await tailLlamaCppLog(spec.logPath);
          const logLine = getLastLogLine(logText);
          if (logLine && logLine !== lastLogLine) {
            lastLogLine = logLine;
            emit(controller, { status: logLine });
          }

          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        emit(controller, { error: "Timed out waiting for llama.cpp to become ready." });
        controller.close();
      } catch (err) {
        emit(controller, {
          error: err instanceof Error ? err.message : "Failed to install llama.cpp model",
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  });
}
