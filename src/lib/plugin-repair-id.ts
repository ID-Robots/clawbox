// The plugin-id normalisation, on its own so a CLIENT component can import it.
//
// `plugin-repair.ts` reads the marker file and therefore imports `fs/promises`;
// `SettingsApp.tsx` is a client component, and importing the id helper from
// there pulled `fs` into the browser bundle and failed the build outright
// ("Module not found: Can't resolve 'fs'"). This half is pure string work and
// belongs to both sides.

/**
 * The bare name of a plugin, whatever spelling it arrived in.
 *
 * The registry keys one plugin under `discord`, `@openclaw/discord` and
 * `openclaw-discord` alike, and `ensureChannelPlugin` enables whichever one it
 * found — so a marker written under one spelling has to be found under any of
 * them, or the badge would be missing from exactly the row it describes.
 */
export function canonicalPluginId(id: string): string {
  let name = id;
  for (const prefix of ["@openclaw/", "openclaw-"]) {
    if (name.startsWith(prefix)) name = name.slice(prefix.length);
  }
  // `@openclaw/deepseek-provider` is the DeepSeek provider plugin; the boot
  // script marks it as `deepseek`, which is also what `plugins enable` takes.
  return name.endsWith("-provider") ? name.slice(0, -"-provider".length) : name;
}

/**
 * Which plugin a Settings row depends on.
 *
 * Not an identity map, because two rows are named after the thing the owner
 * sees rather than after the plugin behind it: ClawBox AI rides the DeepSeek
 * provider on every paired box, and the OpenAI GPT row is served by the Codex
 * harness plugin. A row with no entry here has no plugin that can fail this
 * way, and is never badged.
 */
export const ROW_PLUGIN_IDS: Readonly<Record<string, string>> = {
  clawai: "deepseek",
  deepseek: "deepseek",
  openai: "codex",
  discord: "discord",
  whatsapp: "whatsapp",
};

/**
 * Does a Settings row of its own already speak for this plugin?
 *
 * The map above answers "which plugin is behind this row"; this is the other
 * direction, and it exists because of the plugins that are behind NO row
 * (TASK-738). A core bump can leave an entry enabled for a plugin an older core
 * bundled — `byteplus`, `vydra`, `xiaomi` on the incident box — and the gateway
 * then refuses readiness over it. ClawBox switches such an entry off so the box
 * comes back, and the owner has to be able to see that and put it back; but
 * there is no Providers row and no Channels row for `vydra` to badge, so
 * without this the record would exist with nothing on screen drawn from it.
 *
 * Answered on the CANONICAL id on both sides, the same rule the badge lookup
 * uses: a row filed as `@openclaw/discord` is the `discord` row's plugin.
 */
export function pluginHasSettingsRow(pluginId: string): boolean {
  const wanted = canonicalPluginId(pluginId);
  return Object.values(ROW_PLUGIN_IDS).some((id) => canonicalPluginId(id) === wanted);
}
