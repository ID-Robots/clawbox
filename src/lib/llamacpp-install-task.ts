import { execFile as execFileCb, spawn } from "child_process";
import fs from "fs/promises";
import { promisify } from "util";
import { POST as configureAiModel } from "@/app/setup-api/ai-models/configure/route";
import {
  BackgroundTaskFailure,
  type BackgroundTaskContext,
  type StartBackgroundTaskSpec,
} from "@/lib/background-tasks";
import { LLAMACPP_INSTALL_KIND } from "@/lib/background-task-kinds";
import { getActiveHarness } from "@/lib/harness";
import { isJournalNoise } from "@/lib/journal-noise";
import { LOCAL_AI_SYSTEM_LANE, llamacppInstallNeeds } from "@/lib/local-ai-install-queue";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
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
import { startRootStep } from "@/lib/root-step-runner";
import { waitForGatewayBack } from "@/lib/gateway-hot-apply";
import { rootStepJournalArgs, rootStepUnit } from "@/lib/root-step-journal";

/**
 * Gemma 4 through llama.cpp — install, start, configure — as a background
 * task: what POST /setup-api/llamacpp/install starts (Settings → Local AI's
 * Install, Enable and "Make primary" on the Gemma row, and the setup wizard),
 * and what a restarted server rebuilds when it finds the install still queued
 * (src/lib/background-task-starters.ts). It lived in the route; a route file
 * may export only its handlers.
 *
 * SERVER ONLY.
 */

export const LLAMACPP_MODEL_ID_RE = /^[a-zA-Z0-9._:-]+$/;

export type ConfigureScope = "primary" | "local";

/** What one install was asked for: the same three values are the same install. */
export interface LlamaCppInstallRequest {
  alias: string;
  scope: ConfigureScope;
  /** Only an explicit "switch to it" click sets this. */
  activate: boolean;
}

/**
 * One install per request shape. A second press asking for the SAME thing
 * follows the install running (or queued); one asking for something else — a
 * "make primary" pressed while a plain enable runs — is an install of its
 * own, which waits its turn in the queue (LOCAL_AI_SYSTEM_LANE: one runtime,
 * one gateway config) instead of being refused or folded into the first.
 */
export function llamacppInstallGroup({ alias, scope, activate }: LlamaCppInstallRequest): string {
  return `llamacpp-install:${alias}:${scope}:${activate ? "activate" : "keep"}`;
}

/** The request a task's `meta` holds, or null for one this build cannot run. */
export function llamacppInstallRequest(meta: Record<string, unknown>): LlamaCppInstallRequest | null {
  const alias = typeof meta.alias === "string" ? meta.alias : "";
  if (!LLAMACPP_MODEL_ID_RE.test(alias)) return null;
  const scope = meta.scope === "local" ? "local" : meta.scope === "primary" ? "primary" : null;
  if (scope === null) return null;
  return { alias, scope, activate: meta.activate === true };
}

const execFile = promisify(execFileCb);
const CLAWBOX_HOME_DIR = process.env.CLAWBOX_HOME_DIR || process.env.HOME || "/home/clawbox";
const LLAMACPP_INSTALL_STEP = "llamacpp_install";
const LLAMACPP_INSTALL_SERVICE = rootStepUnit(LLAMACPP_INSTALL_STEP);
// Must stay >= TimeoutStartSec in config/clawbox-root-update@.service so
// systemd, not us, owns the kill. A cold box builds llama.cpp from source with
// CUDA and downloads a multi-GB GGUF; 30 min was not enough and the install
// died mid-build.
const LLAMACPP_INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
// How often we ask systemd how the install unit is doing while it runs.
const LLAMACPP_INSTALL_POLL_MS = 3000;
// `systemctl start --no-block` returns before the unit leaves "inactive".
// Re-check a couple of times at this interval before concluding it finished,
// so we don't mistake "hasn't started yet" for "already done".
const LLAMACPP_INSTALL_START_GRACE_MS = 1000;
const LLAMACPP_INSTALL_START_GRACE_POLLS = 2;
const SYSTEMCTL_QUERY_TIMEOUT_MS = 15_000;
// Phase-stable prefix: getLlamaCppOverlayProgress keys the "Provisioning
// offline Gemma 4" step off "installing gemma 4", and the raw journal lines
// (cmake, hf download, apt) match nothing — without this the wizard would jump
// back to step 1 on every log line. Everything after the separator is shown to
// the user as live detail.
const INSTALL_STATUS_PREFIX = "Installing Gemma 4 for offline use";
const INSTALL_STATUS_SEPARATOR = " — ";

function getLastLogLine(logText: string): string | null {
  // Never su's or PAM's own lines: they are the root step's plumbing, and the
  // last line is what the row shows as the install's status (journal-noise.ts).
  const lines = logText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isJournalNoise(line));
  return lines.length > 0 ? lines[lines.length - 1] : null;
}


function shouldRepairLlamaCppRuntime(logLine: string | null): boolean {
  if (!logLine) return false;
  const normalized = logLine.toLowerCase();
  return normalized.includes("[llamacpp] missing hugging face cli")
    || normalized.includes("[llamacpp] missing llama-server")
    || normalized.includes("[llamacpp] missing local model");
}

/**
 * What THIS install run has written.
 *
 * Bounded by `sinceMs`, the moment this call started the unit: the journal is
 * persistent and this is polled from the first second — before the unit has
 * said anything — so an unbounded read answers with the LAST attempt's last
 * line, which the loop below shows as live progress and then reports as this
 * run's failure reason. root-step-journal.ts has the rest of the reasoning.
 */
async function readLlamaCppInstallLog(sinceMs: number, lines: number): Promise<string> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/journalctl",
      rootStepJournalArgs(LLAMACPP_INSTALL_STEP, { sinceMs, lines }),
      { timeout: 10_000 },
    );
    return stdout;
  } catch {
    return "";
  }
}

async function readLlamaCppInstallFailure(sinceMs: number): Promise<string | null> {
  return getLastLogLine(await readLlamaCppInstallLog(sinceMs, 40));
}

/**
 * ActiveState/Result for the install unit. Empty strings mean "couldn't ask" —
 * callers treat that the same as "not running" and fall back to the on-disk
 * provisioning check, which is the real gate.
 */
async function readInstallUnitState(): Promise<{ active: string; result: string }> {
  try {
    const { stdout } = await execFile(
      "/usr/bin/systemctl",
      ["show", LLAMACPP_INSTALL_SERVICE, "-p", "ActiveState", "-p", "Result"],
      { timeout: SYSTEMCTL_QUERY_TIMEOUT_MS },
    );
    return {
      active: /^ActiveState=(.*)$/m.exec(stdout)?.[1]?.trim() || "",
      result: /^Result=(.*)$/m.exec(stdout)?.[1]?.trim() || "",
    };
  } catch {
    return { active: "", result: "" };
  }
}

function isUnitRunning(active: string): boolean {
  return active === "activating" || active === "active" || active === "reloading";
}

/**
 * Run the root install step, streaming its journal output.
 *
 * Previously this was a single blocking `systemctl start`, which emitted
 * nothing for up to 30 minutes — a cold Jetson build looked identical to a
 * hang, and there was no way to tell whether it was progressing. Now we start
 * the unit detached and poll systemd, so the wizard shows live build/download
 * lines and a genuine failure surfaces the moment the unit fails.
 */
async function repairLlamaCppRuntime(
  onStatus: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  // Before the start, so nothing this run writes falls outside the window the
  // journal reads are bounded by.
  const startedAt = Date.now();
  try {
    await startRootStep(
      LLAMACPP_INSTALL_STEP,
      { noBlock: true, timeoutMs: SYSTEMCTL_QUERY_TIMEOUT_MS },
    );
  } catch (err) {
    const failureLine = await readLlamaCppInstallFailure(startedAt);
    return {
      ok: false,
      error: failureLine || (err instanceof Error ? err.message : "Failed to repair llama.cpp runtime"),
    };
  }

  const deadline = Date.now() + LLAMACPP_INSTALL_TIMEOUT_MS;
  let lastLine: string | null = null;
  let sawRunning = false;
  let gracePolls = 0;

  while (Date.now() < deadline) {
    const { active, result } = await readInstallUnitState();
    if (isUnitRunning(active)) sawRunning = true;

    const line = getLastLogLine(await readLlamaCppInstallLog(startedAt, 5));
    if (line && line !== lastLine) {
      lastLine = line;
      onStatus(line);
    }

    if (active === "failed") {
      return { ok: false, error: lastLine || `llama.cpp install failed (${result || "unknown"})` };
    }

    if (!isUnitRunning(active)) {
      // Either it finished, or `--no-block` returned before it started. Give it
      // a couple of short re-checks before believing the former.
      if (sawRunning || gracePolls >= LLAMACPP_INSTALL_START_GRACE_POLLS) {
        if (result && result !== "success") {
          return { ok: false, error: lastLine || `llama.cpp install failed (${result})` };
        }
        return { ok: true };
      }
      gracePolls += 1;
      await new Promise((resolve) => setTimeout(resolve, LLAMACPP_INSTALL_START_GRACE_MS));
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, LLAMACPP_INSTALL_POLL_MS));
  }

  return { ok: false, error: lastLine || "Timed out installing the local Gemma 4 runtime." };
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
      cwd: CLAWBOX_HOME_DIR,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: CLAWBOX_HOME_DIR },
    }
  );
}

// How long the stream follows a gateway restart the configure route answered
// before it was over. A restart is stop + pre-start + core start-up, 50-60 s on
// a board; three times that before the stream stops waiting and calls the
// install done anyway (the gateway comes back on its own — it is not a failure).
const GATEWAY_BACK_WAIT_MS = 180_000;
const GATEWAY_BACK_HEARTBEAT_MS = 10_000;
// Keeps "applying configuration" in it, so the overlay holds the step it is on
// (`getLlamaCppOverlayProgress`) and shows the rest as detail.
const GATEWAY_RESTARTING_STATUS = `Applying configuration${INSTALL_STATUS_SEPARATOR}the assistant is restarting to load it...`;

async function configureLlamaCpp(
  alias: string,
  scope: ConfigureScope,
  activate: boolean,
  onStatus: (status: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const req = new Request("http://localhost/setup-api/ai-models/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "llamacpp",
      apiKey: alias,
      authMode: "local",
      scope,
      activate,
    }),
  });
  const res = await configureAiModel(req);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.success) {
    return { ok: false, error: body?.error || "Failed to configure llama.cpp" };
  }
  // The configure route applies a llama.cpp save without restarting the
  // gateway; when it did have to restart, it answered before the gateway was
  // back (TASK-1535). This stream is already open and painting progress, so it
  // follows the restart itself: "configured" should mean the assistant can use
  // the model, and a heartbeat line keeps the step visibly alive meanwhile.
  if (body?.gatewayRestarting === true) {
    // From a timer, so a stream the reader has already closed must not throw
    // out of it: an exception there is an uncaught one for the whole server.
    const say = () => {
      try {
        onStatus(GATEWAY_RESTARTING_STATUS);
      } catch {
        /* the page went away; the wait below still bounds this */
      }
    };
    say();
    const heartbeat = setInterval(say, GATEWAY_BACK_HEARTBEAT_MS);
    try {
      if (!(await waitForGatewayBack(GATEWAY_BACK_WAIT_MS))) {
        console.warn("[llamacpp/install] the gateway was not back from its restart in time; it finishes on its own");
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
  return { ok: true };
}

/** The task for `request`, sized for the harness the box runs (`harness`). */
export function llamacppInstallTask(
  request: LlamaCppInstallRequest,
  harness: Awaited<ReturnType<typeof getActiveHarness>>,
): StartBackgroundTaskSpec {
  const { alias, scope, activate } = request;
  const spec = getLlamaCppLaunchSpec(alias, harness);
  return {
    kind: LLAMACPP_INSTALL_KIND,
    group: llamacppInstallGroup(request),
    title: "Installing Gemma 4 (local AI)",
    label: "Gemma 4",
    meta: { alias, scope, activate },
    status: "Checking local Gemma 4 runtime...",
    steps: [
      { id: "check", label: "Check the local runtime", weight: 0 },
      { id: "install", label: "Install llama.cpp and download Gemma 4", weight: 6 },
      { id: "start", label: "Start Gemma 4", weight: 2 },
      { id: "configure", label: "Apply the configuration", weight: 1 },
    ],
    lanes: [LOCAL_AI_SYSTEM_LANE],
    needs: llamacppInstallNeeds(spec.modelDir),
    run: (task) => installLlamaCpp(task, alias, scope, activate, spec),
  };
}

/** {@link llamacppInstallTask} with the harness read now — a restart's rebuild. */
export async function llamacppInstallTaskNow(request: LlamaCppInstallRequest): Promise<StartBackgroundTaskSpec> {
  return llamacppInstallTask(request, await getActiveHarness());
}

/**
 * The install itself, as a background task (src/lib/background-tasks.ts): its
 * `{status}` lines are the ones this route always streamed — the setup
 * wizard's overlay keys its steps off their wording — and it ends by
 * resolving the closing payload or throwing the error line.
 *
 * It used to run inside the response stream, whose `enqueue` throws once the
 * client is gone: a reload or a dropped tunnel mid-install threw out of the
 * next status line, and everything after it — starting the runtime, the
 * configuration — never happened, over a root step that finished on its own.
 */
async function installLlamaCpp(
  task: BackgroundTaskContext,
  alias: string,
  scope: ConfigureScope,
  activate: boolean,
  spec: ReturnType<typeof getLlamaCppLaunchSpec>,
): Promise<Record<string, unknown>> {
  task.step("check");
  await ensureLlamaCppRuntimeDir();

  const existingModels = await queryLlamaCppModels(spec.baseUrl);
  // Any model, not only this alias. `getLlamaCppLaunchSpec()` resolves
  // `modelPath` from getDefaultLlamaCppFile() whatever the alias is, and
  // start-llamacpp.sh passes that as `--model` while the alias is only
  // `--alias` — so every alias on a box is the SAME GGUF and a non-empty
  // /v1/models means THE runtime is up, whatever it calls itself.
  //
  // waitForLlamaCppReady() and isLlamaCppUp() (src/lib/local-ai-runtime.ts)
  // already read it that way on every proxied inference request. This
  // route was the one that did not, and it is the one with a 20-minute
  // budget: a warm runtime under a label from an earlier install left the
  // live pid blocking a restart, the alias never appeared, and the wizard
  // polled for the full startupTimeoutMs before reporting a timeout for a
  // runtime that was answering the whole time.
  if (existingModels.length > 0) {
    task.step("configure", "llama.cpp is already running. Applying configuration...");
    const configured = await configureLlamaCpp(alias, scope, activate, (status) => task.status(status));
    if (!configured.ok) throw new BackgroundTaskFailure(configured.error || "Failed to configure llama.cpp");
    return { model: alias, status: "llama.cpp is ready and configured." };
  }

  let provisioning = await getLlamaCppProvisioningStatus(alias);
  if (!provisioning.installed) {
    task.step(
      "install",
      provisioning.binaryAvailable
        ? "Installing Gemma 4 for offline use..."
        : "Installing llama.cpp and Gemma 4 for offline use...",
    );
    const repaired = await repairLlamaCppRuntime((line) => {
      task.status(`${INSTALL_STATUS_PREFIX}${INSTALL_STATUS_SEPARATOR}${line}`);
    });
    if (!repaired.ok) throw new BackgroundTaskFailure(repaired.error || "Failed to provision the local Gemma 4 runtime");
    provisioning = await getLlamaCppProvisioningStatus(alias);
    if (!provisioning.installed) {
      throw new BackgroundTaskFailure("llama.cpp install finished, but the local Gemma 4 runtime is still incomplete.");
    }
  }

  task.step("start");
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
      task.status(
        attemptedRuntimeRepair
          ? `Restarting llama.cpp after repairing the local runtime...`
          : provisioning.installed
            ? `Starting preinstalled Gemma 4...`
            : `Starting llama.cpp and downloading ${alias}...`,
      );
      await fs.writeFile(spec.logPath, "", "utf-8").catch(() => {});
      const child = startLlamaCpp(spec, alias);

      if (!child.pid) throw new BackgroundTaskFailure("Failed to start llama.cpp");

      child.unref();
      await writeLlamaCppPid(child.pid, spec.pidPath);
      pid = child.pid;
      waitingForExistingStart = false;
      startedRuntimeHere = true;
      lastLogLine = "";
    } else if (waitingForExistingStart) {
      task.status("llama.cpp is already starting. Waiting for it to become ready...");
      waitingForExistingStart = false;
    }

    const models = await queryLlamaCppModels(spec.baseUrl);
    // Same rule as the pre-check above: the runtime answering at all is
    // the readiness signal, because one GGUF backs every alias.
    if (models.length > 0) {
      task.step("configure", "llama.cpp is ready. Applying ClawBox configuration...");
      const configured = await configureLlamaCpp(alias, scope, activate, (status) => task.status(status));
      if (!configured.ok) throw new BackgroundTaskFailure(configured.error || "Failed to configure llama.cpp");
      if (startedRuntimeHere) {
        task.status("Gemma 4 is configured. Returning it to standby to free RAM...");
        await stopLocalAiProvider("llamacpp").catch(() => {});
        return {
          model: alias,
          status: `${alias} is installed and configured. It will wake automatically when OpenClaw needs it.`,
        };
      }
      return { model: alias, status: `${alias} is installed, running, and configured.` };
    }

    const currentPid = await readLlamaCppPid(spec.pidPath);
    if (currentPid && !isLlamaCppPidRunning(currentPid)) {
      await clearLlamaCppPid(spec.pidPath);
      pid = null;
      const logText = await tailLlamaCppLog(spec.logPath);
      const logLine = getLastLogLine(logText);
      if (!attemptedRuntimeRepair && shouldRepairLlamaCppRuntime(logLine)) {
        task.status("Repairing the llama.cpp runtime so Gemma can start...");
        attemptedRuntimeRepair = true;
        const repaired = await repairLlamaCppRuntime((repairLine) => {
          task.status(`${INSTALL_STATUS_PREFIX}${INSTALL_STATUS_SEPARATOR}${repairLine}`);
        });
        if (!repaired.ok) throw new BackgroundTaskFailure(repaired.error || "Failed to repair llama.cpp runtime");
        task.status("llama.cpp runtime repaired. Restarting Gemma...");
        continue;
      }

      throw new BackgroundTaskFailure(logLine || "llama.cpp exited before becoming ready.");
    }

    const logText = await tailLlamaCppLog(spec.logPath);
    const logLine = getLastLogLine(logText);
    if (logLine && logLine !== lastLogLine) {
      lastLogLine = logLine;
      task.status(logLine);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new BackgroundTaskFailure("Timed out waiting for llama.cpp to become ready.");
}
