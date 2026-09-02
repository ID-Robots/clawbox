import type { OpenclawConfigSetArgs } from "@/lib/openclaw-config";

/**
 * The `config set` operations that switch ON the provider plugins a set of
 * model references resolve through — meant to ride in the SAME
 * `config set --batch-json` as the writes of those references, ahead of them.
 *
 * OpenClaw 2 validates every model reference a batch touches
 * (`agents.defaults.model.primary`, each `agents.defaults.model.fallbacks.N`)
 * against the captured catalogs of the ENABLED plugins — after applying every
 * operation of the batch to one cloned snapshot (the core's
 * `runConfigOperations`, read on 2026.8.1). So an enable placed before the
 * reference in the same batch validates it with the plugin on, in one spawn,
 * and a refused batch leaves the flag exactly as it was: nothing to restore.
 * Two spawns with the enable first used to be the shape, and left the plugin
 * switched on for a switch that then failed.
 *
 * Only the anthropic plugin is gated (see `setProviderPlugins` in
 * openclaw-config.ts for the OFF half and why); a reference to any other
 * provider needs no operation. Pure: no read, no spawn.
 */
export const ANTHROPIC_PLUGIN_ENABLED_KEY = "plugins.entries.anthropic.enabled";

export function enableProviderPluginOps(
  modelRefs: readonly (string | null | undefined)[],
): OpenclawConfigSetArgs[] {
  const providers = new Set(
    modelRefs
      .filter((ref): ref is string => typeof ref === "string" && ref.includes("/"))
      .map((ref) => ref.split("/", 1)[0].trim().toLowerCase()),
  );
  return providers.has("anthropic") ? [[ANTHROPIC_PLUGIN_ENABLED_KEY, "true", "--json"]] : [];
}
