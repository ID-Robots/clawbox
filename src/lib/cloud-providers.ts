// "Hide cloud AI providers" (TASK-2497): the owner's switch that takes the
// cloud AI providers (ClawBox AI, OpenAI, Anthropic, Google, OpenRouter, xAI
// and the rest) off every screen — Settings → AI providers, the setup
// wizard's AI step, the chat's model picker and its "AI Provider - Set up in
// Settings" row — for a box whose AI is meant to stay on the box or the
// owner's own network.
//
// Stored as `hide_cloud_providers` in data/config.json: a literal `true` is
// on, a literal `false` is off, anything else (absent, hand-edited) is AUTO:
// on exactly when organisation mode is on AND an external engine (provider
// `clawext`, TASK-2376) is the box's Local AI, off otherwise. So a normal box
// keeps every screen it had, an organisation box that runs a local engine
// hides the cloud without anyone asking, and the owner can still turn it off
// (or on) by hand.
//
// Pure (no `fs`, no Next): the desktop and the routes judge the same rule.
// The store read is src/lib/cloud-providers-server.ts.

/** The switch in data/config.json. */
export const HIDE_CLOUD_PROVIDERS_KEY = "hide_cloud_providers";

/** What the owner chose: on, off, or left to the automatic rule. */
export type HideCloudSetting = "on" | "off" | "auto";

export function hideCloudSettingFrom(value: unknown): HideCloudSetting {
  if (value === true) return "on";
  if (value === false) return "off";
  return "auto";
}

/** The automatic rule: an organisation box whose AI is an external engine. */
export function autoHideCloudProviders(input: { orgMode: boolean; externalEngineSelected: boolean }): boolean {
  return input.orgMode && input.externalEngineSelected;
}

/** Are the cloud providers hidden, given the setting and the box's state? */
export function cloudProvidersHidden(input: {
  setting: HideCloudSetting;
  orgMode: boolean;
  externalEngineSelected: boolean;
}): boolean {
  if (input.setting === "on") return true;
  if (input.setting === "off") return false;
  return autoHideCloudProviders(input);
}

/**
 * Providers that answer on the box or the owner's own network, never a cloud
 * service: the external engine (both harnesses), Hermes' on-device row, and
 * the on-device engines. Everything else is a cloud provider.
 */
const LOCAL_AI_PROVIDER_IDS: ReadonlySet<string> = new Set(["clawext", "clawlocal", "llamacpp", "ollama"]);

export function isLocalAiProviderId(id: unknown): boolean {
  return typeof id === "string" && LOCAL_AI_PROVIDER_IDS.has(id);
}

/** GET /setup-api/settings/cloud-providers (owner only). */
export interface CloudProvidersView {
  /** The cloud providers are off every screen right now. */
  hidden: boolean;
  setting: HideCloudSetting;
  /** What AUTO resolves to on this box now. */
  autoHidden: boolean;
  orgMode: boolean;
  localOnly: boolean;
  /** The external engine, when one is the box's Local AI. */
  externalEngine: { displayName: string; modelRef: string } | null;
  /** The Local AI model ref the box names (local_ai_model), or null. */
  localModel: string | null;
}

/**
 * Should Settings lead with the local choice and fold the cloud providers
 * away? When an external engine is the AI, or Local-only mode is on — then a
 * cloud provider is never the recommended choice.
 */
export function localAiFirst(view: Pick<CloudProvidersView, "externalEngine" | "localOnly"> | null | undefined): boolean {
  return !!view && (view.externalEngine !== null || view.localOnly);
}
