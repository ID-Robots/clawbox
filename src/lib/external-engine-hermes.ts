import { getAll } from "@/lib/config-store";
import { patchHermesConfig, resolveHermesConfigValue } from "@/lib/hermes-config-yaml";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { HERMES_MIN_CONTEXT_WINDOW, externalEngineDisplayName, type ExternalEngineSettings } from "@/lib/external-engine-shared";
import { NO_KEY_PLACEHOLDER, externalEngineFromState, readExternalEngineKey } from "@/lib/external-engine";

/**
 * The Hermes provider block of the external AI engine (TASK-2376), and the
 * read-path repair that puts it back. Kept apart from external-engine-ops.ts
 * so the Hermes model list route — which runs the repair on every read — does
 * not pull in the save path's chat, gateway and runtime modules.
 */

/**
 * The values of `providers.clawext.*` as Hermes reads a custom
 * OpenAI-compatible provider. The KEYS are written as literals at each call
 * site, so the harness contract (scripts/harness-contract) checks every one
 * against the pinned Hermes.
 */
export function hermesProviderValues(settings: ExternalEngineSettings, key: string | null) {
  return {
    baseUrl: settings.baseUrl,
    apiKey: key || NO_KEY_PLACEHOLDER,
    apiMode: "openai",
    models: settings.modelId,
    name: externalEngineDisplayName(settings.modelId),
    // Entry-level `context_length` backs every model the entry serves
    // (hermes_cli/config_providers.py); `model.context_length` would be global
    // and outlive a switch to a cloud model.
    contextLength: String(settings.contextWindow),
  };
}

/**
 * Register the engine with Hermes when the store names it and config.yaml
 * does not — a dual box that switched to Hermes after the engine was saved on
 * OpenClaw. Registers the provider only; the selection stays the owner's.
 * Once per process, like `reconcileLocalAiWithHermes`.
 */
let hermesReconciled = false;
export async function reconcileExternalEngineWithHermes(): Promise<void> {
  if (hermesReconciled) return;
  hermesReconciled = true;
  try {
    const record = externalEngineFromState(await getAll());
    if (!record) return;
    // Hermes refuses a session under its window floor: a provider it cannot
    // run is not registered; Settings tells the owner to save it again here.
    if (record.contextWindow < HERMES_MIN_CONTEXT_WINDOW) {
      console.warn(`[external-engine] not registered with Hermes: its ${record.contextWindow}-token window is under Hermes' ${HERMES_MIN_CONTEXT_WINDOW} floor`);
      return;
    }
    const declared = await resolveHermesConfigValue("providers.clawext.base_url");
    if (declared.state !== "absent") return;
    const key = readExternalEngineKey();
    const v = hermesProviderValues(record, key === NO_KEY_PLACEHOLDER ? null : key);
    await patchHermesConfig({
      set: {
        "providers.clawext.base_url": v.baseUrl,
        "providers.clawext.api_key": v.apiKey,
        "providers.clawext.api_mode": v.apiMode,
        "providers.clawext.models": v.models,
        "providers.clawext.name": v.name,
        "providers.clawext.context_length": v.contextLength,
      },
    });
    invalidateModelOptions();
  } catch (err) {
    hermesReconciled = false;
    console.error("[external-engine] Hermes reconcile failed:", err instanceof Error ? err.message : err);
  }
}

/** For tests: forget the once-per-process latch. */
export function resetExternalEngineReconcileForTests(): void {
  hermesReconciled = false;
}
