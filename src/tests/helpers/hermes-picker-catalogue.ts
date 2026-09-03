/**
 * Hermes' own picker reader, mirrored — the contract every ClawBox writer of a
 * `providers.<slug>` block has to satisfy.
 *
 * Hermes builds the Telegram/Discord `/model` keyboard AND its own dashboard's
 * Models page from one substrate, `list_authenticated_providers`
 * (hermes_cli/model_switch.py:2571, Hermes 0.20.5 as installed on a
 * Hermes-edition box). For a custom OpenAI-compatible provider — which is what
 * both ClawBox AI and the on-device model are — section 3 of that function
 * builds the row's models from `default_model`/`model` plus the declared
 * `models:`, then probes `<base_url>/models` and lets the probe REPLACE the
 * declared list unless the declaration is allowlist-shaped and the probe came
 * back empty.
 *
 * Kept small and in one place on purpose. It lives here rather than beside one
 * writer because the clawai path declares a LIST through the CLI and the local
 * path declares a STRING through the YAML splice, and the only thing that makes
 * those two the same fix is that Hermes reads both — so both are judged by this
 * one mirror. A mirror can only ever agree with the writer if the writer is
 * what defines it; these three functions are transcribed from the Python, with
 * the line numbers to check them against, and the shapes were confirmed against
 * the installed interpreter on the box (`_declared_model_ids('qwen2.5:3b')` →
 * `['qwen2.5:3b']`, allowlist `True`).
 */

/** `_declared_model_ids` — hermes_cli/model_switch.py:61. */
export function declaredModelIds(value: unknown): string[] {
  const ids: string[] = [];
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const id = candidate.trim();
    if (!id || ids.some((seen) => seen.toLowerCase() === id.toLowerCase())) return;
    ids.push(id);
  };
  if (typeof value === "string") add(value);
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") add(item);
      else if (item && typeof item === "object") {
        const row = item as { id?: unknown; name?: unknown };
        add(typeof row.id === "string" && row.id.trim() ? row.id : row.name);
      }
    }
  } else if (value && typeof value === "object") {
    // Hermes' own sentinels inside a mapping-shaped `models:` are not ids.
    for (const key of Object.keys(value)) {
      if (key === "__explicit_model_allowlist__" || key === "__discovered_model_catalog__") continue;
      add(key);
    }
  }
  return ids;
}

/**
 * `_models_config_is_allowlist` — hermes_cli/model_switch.py:136.
 *
 * A mapping is per-model METADATA that Hermes itself wrote, never a user pin;
 * a list or a bare string is an intentional narrow. That last clause is what
 * the on-device model's single-scalar declaration rests on.
 */
export function modelsConfigIsAllowlist(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return declaredModelIds(value).length > 0;
  return false;
}

/**
 * The model ids Hermes' `/model` picker offers for one `providers:` entry.
 *
 * `liveProbe` is what `<base_url>/models` yielded: `[]` when the endpoint
 * answered in a shape Hermes could not read (the ClawBox AI proxy) or had
 * nothing to say (the local model asleep), `null` when it did not answer at
 * all. Merge rule: model_switch.py:3423-3431.
 */
export function hermesPickerModels(
  entry: Record<string, unknown>,
  liveProbe: string[] | null,
): string[] {
  const declared = declaredModelIds(entry.models);
  const fallbackDefault = entry.default_model ?? entry.model;
  const models = typeof fallbackDefault === "string" && fallbackDefault.trim()
    ? [fallbackDefault.trim(), ...declared.filter((id) => id !== fallbackDefault.trim())]
    : declared;
  const hasExplicitModels = modelsConfigIsAllowlist(entry.models);
  if (liveProbe !== null && (liveProbe.length > 0 || !hasExplicitModels)) return liveProbe;
  return models;
}
