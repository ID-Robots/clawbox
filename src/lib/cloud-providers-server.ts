/**
 * "Hide cloud AI providers" (src/lib/cloud-providers.ts says what it hides),
 * read and written on the server.
 */

import { getAll, set } from "@/lib/config-store";
import {
  HIDE_CLOUD_PROVIDERS_KEY,
  autoHideCloudProviders,
  cloudProvidersHidden,
  hideCloudSettingFrom,
  type CloudProvidersView,
} from "@/lib/cloud-providers";
import { externalEngineFromState } from "@/lib/external-engine";
import { externalEngineDisplayName, externalEngineModelRef } from "@/lib/external-engine-shared";
import { ORG_MODE_KEY, orgModeFrom } from "@/lib/org-mode";

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

/** Are the cloud providers hidden in this store snapshot? */
export function cloudProvidersHiddenIn(state: Record<string, unknown> | null | undefined): boolean {
  return cloudProvidersViewFrom(state).hidden;
}

/** The view as stored now. A store that cannot be read hides nothing — the appliance default. */
export async function readCloudProvidersView(): Promise<CloudProvidersView> {
  let state: Record<string, unknown> = {};
  try {
    state = await getAll();
  } catch {
    state = {};
  }
  return cloudProvidersViewFrom(state);
}

export async function readCloudProvidersHidden(): Promise<boolean> {
  return (await readCloudProvidersView()).hidden;
}

export async function writeHideCloudProviders(hide: boolean): Promise<void> {
  await set(HIDE_CLOUD_PROVIDERS_KEY, hide);
}
