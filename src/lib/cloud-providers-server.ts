/**
 * "Hide cloud AI providers" (src/lib/cloud-providers.ts says what it hides),
 * read and written on the server.
 */

import { getKnownMany, set } from "@/lib/config-store";
import {
  HIDE_CLOUD_PROVIDERS_KEY,
  autoHideCloudProviders,
  cloudProvidersHidden,
  hideCloudSettingFrom,
  type CloudProvidersView,
} from "@/lib/cloud-providers";
import { externalEngineFromState } from "@/lib/external-engine";
import { EXTERNAL_ENGINE_STORE_KEY, externalEngineDisplayName, externalEngineModelRef } from "@/lib/external-engine-shared";
import { ORG_MODE_KEY, orgModeFrom } from "@/lib/org-mode";

/** Every key the view is made of, read together so they cannot disagree. */
const VIEW_KEYS = [
  HIDE_CLOUD_PROVIDERS_KEY,
  ORG_MODE_KEY,
  EXTERNAL_ENGINE_STORE_KEY,
  "local_only_mode",
  "local_ai_model",
] as const;

/** The switch and what it resolves to, from one store snapshot. */
export function cloudProvidersViewFrom(state: Record<string, unknown> | null | undefined): CloudProvidersView {
  const engine = externalEngineFromState(state);
  const orgMode = orgModeFrom(state?.[ORG_MODE_KEY]);
  const setting = hideCloudSettingFrom(state?.[HIDE_CLOUD_PROVIDERS_KEY]);
  const externalEngineSelected = engine !== null;
  const localModel = state?.local_ai_model;
  return {
    hidden: cloudProvidersHidden({ setting, orgMode, externalEngineSelected }),
    setting,
    autoHidden: autoHideCloudProviders({ orgMode, externalEngineSelected }),
    orgMode,
    localOnly: state?.local_only_mode === true,
    externalEngine: engine
      ? { displayName: externalEngineDisplayName(engine.modelId), modelRef: externalEngineModelRef(engine.modelId) }
      : null,
    localModel: typeof localModel === "string" && localModel ? localModel : null,
  };
}

/**
 * The view as stored now, or null when the store could not be read at all:
 * "we could not read the file" is not evidence that the owner never chose
 * (src/lib/config-store.ts, getKnownMany), so nothing is guessed here.
 */
export async function readCloudProvidersView(): Promise<CloudProvidersView | null> {
  const { values, known } = await getKnownMany(VIEW_KEYS);
  return known ? cloudProvidersViewFrom(values) : null;
}

/**
 * Are the cloud providers hidden? For the surfaces a conversation can be sent
 * from (the chat's model picker), a store that cannot be read counts as
 * HIDDEN: failing open would offer, for as long as the file is unreadable, the
 * very providers the owner may have hidden. Settings does not guess at all
 * (the route answers 503 and the page keeps its old screen).
 */
export async function readCloudProvidersHidden(): Promise<boolean> {
  const view = await readCloudProvidersView();
  return view === null ? true : view.hidden;
}

export async function writeHideCloudProviders(hide: boolean): Promise<void> {
  await set(HIDE_CLOUD_PROVIDERS_KEY, hide);
}
