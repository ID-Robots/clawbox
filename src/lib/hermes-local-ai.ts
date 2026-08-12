import { runHermesCli } from "@/lib/hermes-cli";
import { get } from "@/lib/config-store";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { getLocalAiToken } from "@/lib/local-ai-token";
import { getDefaultLlamaCppModel } from "@/lib/llamacpp";
import { getLocalAiProxyBaseUrl } from "@/lib/local-ai-runtime";

/**
 * Register the on-device model with Hermes.
 *
 * Enabling Gemma 4 wrote the selection into ~/.openclaw/openclaw.json and
 * started llama.cpp — which is the whole story on an OpenClaw box, and half a
 * story on a Hermes one. Hermes keeps its own `providers:` block, so the local
 * model was running and configured while Hermes had never heard of it: Settings
 * said "configured", and the chat's provider picker listed only the cloud
 * providers. This closes that gap the same way ClawBox AI does — as a custom
 * OpenAI-compatible provider (see hermes-clawai.ts).
 *
 * The base_url is our own proxy, not llama.cpp directly, for two reasons:
 * the proxy is what implements on-demand standby (it wakes the model on the
 * first request and lets it sleep again to free RAM — "sleeping until needed"
 * in the Settings card), and it is the only endpoint that stays put when the
 * backend port or runtime changes. It authenticates with the local-AI bearer
 * token, which is exactly what the api_key slot is for.
 */

export const HERMES_LOCAL_PROVIDER = "clawlocal";

export type LocalAiProviderId = "llamacpp" | "ollama";

export class HermesLocalApplyError extends Error {}


/**
 * Point Hermes at the local model. `makeDefault` decides whether the device
 * also SWITCHES to it: turning on a private fallback should make it available,
 * not silently take over from the provider the customer chose.
 */
export async function applyLocalAiToHermes(options: {
  provider: LocalAiProviderId;
  model: string;
  makeDefault?: boolean;
}): Promise<{ provider: string; model: string }> {
  const model = (options.model || getDefaultLlamaCppModel()).trim();
  // The id reaches argv. A leading dash would be read as a flag.
  if (!model || model.startsWith("-")) {
    throw new HermesLocalApplyError("Local model id is missing or malformed.");
  }

  const steps: string[][] = [
    ["config", "set", `providers.${HERMES_LOCAL_PROVIDER}.base_url`, getLocalAiProxyBaseUrl(options.provider)],
    ["config", "set", `providers.${HERMES_LOCAL_PROVIDER}.api_key`, getLocalAiToken()],
    ["config", "set", `providers.${HERMES_LOCAL_PROVIDER}.api_mode`, "openai"],
  ];
  if (options.makeDefault) {
    steps.push(["config", "set", "model.provider", HERMES_LOCAL_PROVIDER]);
    steps.push(["config", "set", "model.default", model]);
  }

  for (const args of steps) {
    const r = await runHermesCli(args, { timeoutMs: 15_000 });
    if (r.code !== 0) {
      throw new HermesLocalApplyError(r.stderr || "Failed to register the local model with Hermes");
    }
  }

  invalidateModelOptions();
  return { provider: HERMES_LOCAL_PROVIDER, model };
}

let reconciled = false;

/**
 * Register the local model if it was configured BEFORE this code existed.
 *
 * The write above only happens when the customer enables local AI. Every device
 * that already had Gemma 4 on would otherwise keep the symptom — configured,
 * running, absent from the picker — until someone thought to toggle it off and
 * on again. So the picker's own read repairs it, once per process, and only
 * when there is genuinely something to repair.
 */
export async function reconcileLocalAiWithHermes(): Promise<void> {
  if (reconciled) return;
  reconciled = true;
  try {
    const configured = await get("local_ai_configured");
    if (configured !== true) return;
    const provider = await get("local_ai_provider");
    if (provider !== "llamacpp" && provider !== "ollama") return;
    // Already registered? Then this is a normal device and we are done.
    const existing = await runHermesCli(
      ["config", "get", `providers.${HERMES_LOCAL_PROVIDER}.base_url`],
      { timeoutMs: 15_000 },
    );
    if (existing.code === 0 && existing.stdout.trim()) return;

    const stored = await get("local_ai_model");
    // Stored as "llamacpp/gemma4-e2b-it-q4_0"; Hermes wants the bare id.
    const model = typeof stored === "string" ? stored.split("/").pop() || "" : "";
    await applyLocalAiToHermes({ provider, model });
  } catch (err) {
    // Never let a repair break the read it is attached to.
    console.error("[hermes-local-ai] reconcile failed:", err);
    reconciled = false;
  }
}

/** Test seam. */
export function _resetLocalAiReconcileForTests(): void {
  reconciled = false;
}

/**
 * Remove the provider when local AI is turned off, so the picker stops offering
 * a model that is no longer running. If it was also the active provider, that
 * is left alone deliberately — silently reassigning the device to some other
 * provider on a "disable" is a bigger surprise than an entry that errors once.
 */
export async function removeLocalAiFromHermes(): Promise<void> {
  for (const key of ["base_url", "api_key", "api_mode"]) {
    // `unset` on an absent key is a no-op, so a partial registration cleans up
    // as happily as a complete one.
    await runHermesCli(["config", "unset", `providers.${HERMES_LOCAL_PROVIDER}.${key}`], {
      timeoutMs: 15_000,
    });
  }
  invalidateModelOptions();
}
