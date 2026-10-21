import { execFile } from "child_process";
import fs from "fs";
import { promisify } from "util";

import posture from "../../config/agent-sandbox.json";
import { harnessesHere } from "@/lib/clawbox-mcp-registration";
import { getKnown } from "@/lib/config-store";
import { isPlainObject, readConfigStrict, restartGateway } from "@/lib/openclaw-config";
import { rootStepUnit } from "@/lib/root-step-journal";
import { startRootStep } from "@/lib/root-step-runner";

const execFileAsync = promisify(execFile);

/**
 * The owner's switch for the agent tool sandbox (Settings -> Harness).
 *
 * OpenClaw can run an agent's tool calls inside a container
 * (`agents.defaults.sandbox`), which limits what a bad command or a
 * prompt-injected page can reach. ClawBox runs it as ROOTLESS Podman, as the
 * clawbox user — no daemon and no `docker` group, which would be root in all
 * but name — for every session except the agent's main chat. The posture is
 * config/agent-sandbox.json, which scripts/agent-sandbox-config.mjs turns into
 * openclaw.json for install.sh and gateway-pre-start.sh.
 *
 * OFF UNLESS THE STORE HOLDS EXACTLY `true`, the same rule as the boot side:
 * the default stays off until its cost is measured on a Nano. Settings never
 * writes openclaw.json itself. The switch is the one input; the gateway's
 * pre-start applies it on the restart below, so a fresh install, an update and
 * this page cannot disagree about what "on" means.
 *
 * OpenClaw only: a Hermes edition has no `agents.defaults.sandbox`, and its
 * terminal backend stays local.
 */
export const AGENT_SANDBOX_ENABLED_KEY: string = posture.storeKey;
export const AGENT_SANDBOX_MODE_ON: string = posture.modeWhenOn;
export const AGENT_SANDBOX_MODE_OFF: string = posture.modeWhenOff;
export const AGENT_SANDBOX_IMAGE: string = posture.sandbox.docker.image;
export const AGENT_SANDBOX_BUDGET: { memoryBytes: number; diskBytes: number } = {
  memoryBytes: posture.budget.memoryBytes,
  diskBytes: posture.budget.diskBytes,
};
/**
 * The root step that installs the runtime (Podman, the clawbox user's
 * subordinate IDs, the image): step_openclaw_config, which provisions it when
 * the switch reads on. Already a web root step, so the switch adds no new
 * root entrypoint.
 */
export const AGENT_SANDBOX_PROVISION_STEP = "openclaw_config";

export function isAgentSandboxEnabledValue(value: unknown): boolean {
  return value === true;
}

/** The switch as stored; `known: false` when the store could not be read (and `enabled` is then a guess of off). */
export async function readAgentSandboxSwitch(): Promise<{ enabled: boolean; known: boolean }> {
  const { value, known } = await getKnown(AGENT_SANDBOX_ENABLED_KEY);
  return { enabled: known && isAgentSandboxEnabledValue(value), known };
}

/** Is there an OpenClaw on this box for the switch to act on? */
export function agentSandboxAvailable(): boolean {
  return harnessesHere().openclaw;
}

/**
 * `agents.defaults.sandbox.mode` as OpenClaw's config holds it now: an absent
 * key is OpenClaw's own default, off. Null when this edition has no OpenClaw,
 * or the config could not be read.
 */
export async function readAgentSandboxMode(): Promise<string | null> {
  if (!agentSandboxAvailable()) return null;
  try {
    // Read as plain JSON: ClawBox's OpenClawConfig type does not model the
    // sandbox block, and this only needs its one string.
    const config: unknown = await readConfigStrict();
    const agents = isPlainObject(config) && isPlainObject(config.agents) ? config.agents : {};
    const defaults = isPlainObject(agents.defaults) ? agents.defaults : {};
    const sandbox = isPlainObject(defaults.sandbox) ? defaults.sandbox : {};
    return typeof sandbox.mode === "string" ? sandbox.mode : AGENT_SANDBOX_MODE_OFF;
  } catch {
    return null;
  }
}

export type AgentSandboxRuntime = "ready" | "missing" | "unknown";

/**
 * Can the gateway start a sandbox right now: is Podman installed, and is the
 * image in the clawbox user's own store? The same `podman image exists` the
 * image script asks, run as the same user. "unknown" when Podman is there but
 * did not answer (a timeout, a broken store).
 */
export async function readAgentSandboxRuntime(): Promise<AgentSandboxRuntime> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Rootless Podman keeps its runtime state under XDG_RUNTIME_DIR, which a
  // system service does not get; the lingering user manager has the directory.
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === "function") {
    const dir = `/run/user/${process.getuid()}`;
    if (fs.existsSync(dir)) env.XDG_RUNTIME_DIR = dir;
  }
  try {
    await execFileAsync("podman", ["image", "exists", AGENT_SANDBOX_IMAGE], { env, timeout: 15_000, cwd: "/" });
    return "ready";
  } catch (err) {
    const e = err as { code?: unknown; killed?: boolean };
    // ENOENT: no podman at all. Exit 1: podman answered, and the image is not there.
    if (e.code === "ENOENT" || (e.code === 1 && !e.killed)) return "missing";
    return "unknown";
  }
}

/**
 * Is the runtime being installed right now — the provisioning root step's unit
 * active? Tri-state: null when systemd could not be asked.
 */
export async function agentSandboxProvisioning(): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/systemctl",
      ["show", rootStepUnit(AGENT_SANDBOX_PROVISION_STEP), "-p", "ActiveState"],
      { timeout: 15_000, cwd: "/" },
    );
    const state = /^ActiveState=(.*)$/m.exec(stdout)?.[1]?.trim();
    if (!state) return null;
    return state === "activating" || state === "active" || state === "reloading";
  } catch {
    return null;
  }
}

export interface AgentSandboxApplyResult {
  /** null: no OpenClaw here, nothing to restart. */
  openclaw: { restarted: boolean } | null;
  /** True when this call started (or found running) the step that installs the runtime. */
  provisioning: boolean;
  error: string | null;
}

/**
 * Make the saved switch true now. The gateway restart IS the apply: its
 * pre-start writes `agents.defaults.sandbox.mode` from the switch (the
 * path-guard and MCP switch pattern), and the mode is read back to prove it.
 *
 * Switched on with the runtime missing, the root step that installs it is
 * started AFTER the restart, so its config writes never race the pre-start's.
 * Until it finishes, OpenClaw refuses the sandboxed sessions' tools rather
 * than run them on the box: on is never quietly off. Switching off leaves the
 * runtime installed, so on again is instant. Never throws.
 */
export async function applyAgentSandboxSwitch(enabled: boolean): Promise<AgentSandboxApplyResult> {
  const result: AgentSandboxApplyResult = { openclaw: null, provisioning: false, error: null };
  if (!agentSandboxAvailable()) return result;

  const wanted = enabled ? AGENT_SANDBOX_MODE_ON : AGENT_SANDBOX_MODE_OFF;
  try {
    await restartGateway();
    result.openclaw = { restarted: true };
    const mode = await readAgentSandboxMode();
    // An unreadable config proves nothing either way: not a success.
    if (mode === null) {
      result.error = "The switch is saved and the gateway restarted, but its config could not be read back to confirm the new mode. Check the ClawBox gateway log.";
    } else if (mode !== wanted) {
      result.error = "The switch is saved and the gateway restarted, but its config does not show the new mode yet. Check the ClawBox gateway log.";
    }
  } catch (err) {
    console.error("[agent-sandbox] gateway restart failed:", err instanceof Error ? err.message : err);
    result.openclaw = { restarted: false };
    result.error = "The switch is saved, but the assistant's gateway did not come back after the restart. The next gateway start applies it.";
  }

  if (!enabled) return result;
  if ((await readAgentSandboxRuntime()) === "ready") return result;
  if ((await agentSandboxProvisioning()) === true) {
    result.provisioning = true;
    return result;
  }
  try {
    await startRootStep(AGENT_SANDBOX_PROVISION_STEP, { noBlock: true });
    result.provisioning = true;
  } catch (err) {
    console.error("[agent-sandbox] the runtime install could not be started:", err instanceof Error ? err.message : err);
    result.error ??= err instanceof Error && (err as { rootStepUnavailable?: boolean }).rootStepUnavailable
      ? err.message
      : "The switch is saved, but the sandbox runtime install could not be started. Switch it off and on again to retry.";
  }
  return result;
}
