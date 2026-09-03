import type { OpenclawConfigSetArgs, OpenClawConfig } from "@/lib/openclaw-config";

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

/**
 * WHICH provider those ops actually switch on, given the config as it was
 * BEFORE the batch — or `null` when they switch nothing on.
 *
 * The ON half of the gate, answered the way `setProviderPlugins` answers the
 * OFF half: with the id it flipped, or `null`. Both halves change what
 * `openclaw models list --provider <p>` returns — a plugin that is off
 * enumerates nothing — so both are provider-set changes the catalogue has to
 * count, and the ON half is the one no caller could see. The enable rides in
 * the batch (it has to, for the core to validate the reference), so by the
 * time `setProviderPlugins` re-reads the config the flag is already true and
 * it correctly reports no flip.
 *
 * The ops themselves are emitted whenever a reference names the gated
 * provider, whether or not the flag is already on, so their presence is NOT a
 * state change: announcing one on every Claude pick would spend a ~3-minute
 * `openclaw models list` per click on a Jetson.
 *
 * Pure, and deliberately reads only the flag. An absent one IS enabled (the
 * plugin declares `enabledByDefault: true`), and a config that could not be
 * read reaches this as `{}` or `null` and so reads as already-on: this stays
 * silent rather than announcing a change that may not have happened.
 */
export function providerPluginSwitchedOnBy(
  modelRefs: readonly (string | null | undefined)[],
  configBeforeWrite: OpenClawConfig | null | undefined,
): string | null {
  if (enableProviderPluginOps(modelRefs).length === 0) return null;
  const wasOn = (configBeforeWrite?.plugins as
    { entries?: Record<string, { enabled?: boolean }> } | undefined)
    ?.entries?.anthropic?.enabled ?? true;
  return wasOn ? null : "anthropic";
}
