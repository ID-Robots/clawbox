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
 * does not, or names an older endpoint — a dual box that switched to Hermes
 * after the engine was saved on OpenClaw. Registers the provider only; the
 * selection stays the owner's.
 *
 * Latched once the block is in place (registered here or found), like
 * `reconcileLocalAiWithHermes`; not latched when there is no record yet or
 * config.yaml could not be read, so a later save or read tries again. Remove
 * forgets the latch. `force` skips it and writes the block from the record:
 * the wizard's selection must know the block is there, and current, before it
 * names the provider. Answers whether it is.
 */
let hermesReconciled = false;
let underFloorWarned = false;
export async function reconcileExternalEngineWithHermes(opts: { force?: boolean } = {}): Promise<boolean> {
  if (hermesReconciled && !opts.force) return true;
  try {
    const record = externalEngineFromState(await getAll());
    if (!record) return false;
    // Hermes refuses a session under its window floor: a provider it cannot
    // run is not registered; Settings tells the owner to save it again here.
    // Not latched: a later save with a window Hermes can run, on OpenClaw in
    // this same process, must still be registered. Only the warning is once.
    if (record.contextWindow < HERMES_MIN_CONTEXT_WINDOW) {
      if (!underFloorWarned) {
        console.warn(`[external-engine] not registered with Hermes: its ${record.contextWindow}-token window is under Hermes' ${HERMES_MIN_CONTEXT_WINDOW} floor`);
        underFloorWarned = true;
      }
      return false;
    }
    const declared = await resolveHermesConfigValue("providers.clawext.base_url");
    if (declared.state === "unreadable") return false;
    // A block that names another endpoint is an older save's (a dual box that
    // saved again on OpenClaw): rewritten from the record. The selection
    // rewrites it in any case, so it never names a stale endpoint or key.
    const inPlace = declared.state === "present"
      || (declared.state === "value" && declared.value === record.baseUrl);
    if (inPlace && !opts.force) {
      hermesReconciled = true;
      return true;
    }
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
    hermesReconciled = true;
    invalidateModelOptions();
    return true;
  } catch (err) {
    console.error("[external-engine] Hermes reconcile failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** The engine was removed: the next save may need registering again. */
export function forgetExternalEngineHermesReconcile(): void {
  hermesReconciled = false;
  underFloorWarned = false;
}

/** For tests: forget the once-per-process latch. */
export const resetExternalEngineReconcileForTests = forgetExternalEngineHermesReconcile;
