import { getAll, setMany } from "@/lib/config-store";
import { getActiveHarness, type Harness } from "@/lib/harness";
import {
  openclawIsAbsent,
  readConfig,
  runOpenclawConfigSetBatch,
  runOpenclawConfigUnset,
  type OpenClawConfig,
} from "@/lib/openclaw-config";
import { readGatewayConfigBaseline, restartGatewayAnsweringEarly, settleConfigWrite } from "@/lib/gateway-hot-apply";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import { patchHermesConfig, resolveHermesConfigValue } from "@/lib/hermes-config-yaml";
import { applyLocalAiToHermes, HermesLocalRemovalError, removeLocalAiFromHermes } from "@/lib/hermes-local-ai";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { withProviderMcpRefresh } from "@/lib/provider-mcp-refresh";
import { forgetProviderVerified } from "@/lib/provider-verified";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";
import { hermesProviderSet } from "@/lib/external-engine-hermes";
import {
  EXTERNAL_ENGINE_PROVIDER,
  EXTERNAL_ENGINE_STORE_KEY,
  HERMES_MIN_CONTEXT_WINDOW,
  externalEngineModelRef,
  isExternalEngineRef,
  type ExternalEngineSettings,
} from "@/lib/external-engine-shared";
import {
  LOCAL_AI_STORE_KEYS,
  NO_KEY_PLACEHOLDER,
  deleteExternalEngineKey,
  externalEngineFromState,
  openclawExternalProviderDefinition,
  probeExternalEngine,
  readExternalEngineKey,
  writeExternalEngineKey,
  type ExternalEngineRecord,
  type PreviousLocalAiState,
} from "@/lib/external-engine";

/**
 * Saving and removing the external AI engine (TASK-2376): the writes into the
 * ACTIVE harness, through the same doors the rest of the box uses — OpenClaw's
 * config writers and chat/model's own POST for the primary (so the session
 * sweep, Tool Search and the compaction model follow it as on any pick);
 * Hermes' config.yaml patcher for its providers block and selection.
 *
 * While an engine is selected the Local AI store keys name it
 * (`local_ai_provider: clawext`), which is what the chat picker, Settings and
 * the provider list already read; what they said before is kept in the record
 * and put back on removal. llama.cpp and Ollama are stopped on save and the
 * Local AI proxy refuses to start them again until the engine is removed
 * (local-ai-proxy.ts, instrumentation-node.ts).
 */

export class ExternalEngineRefusal extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
  }
}

const HOME_ENV = () => {
  const home = process.env.CLAWBOX_HOME_DIR || process.env.HOME || "/home/clawbox";
  return { cwd: home, env: { ...process.env, HOME: home } };
};

/** A llama.cpp or Ollama reference — the on-device refs an engine replaces. */
function isOnDeviceRef(ref: unknown): ref is string {
  if (typeof ref !== "string") return false;
  const provider = ref.split("/")[0].trim().toLowerCase();
  return provider.startsWith("llamacpp") || provider.startsWith("ollama");
}

const HERMES_PROVIDER_KEYS = ["base_url", "api_key", "api_mode", "models", "models_discovered", "name", "context_length"];

/**
 * An error's text for a log line or a response, with the engine's key taken
 * out whatever echoed it (a CLI repeating its argv, a library quoting a
 * header) on top of `sanitizeErrorMessage`'s generic credential shapes.
 */
function scrub(err: unknown, key: string | null): string {
  let text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const stored = readExternalEngineKey();
  for (const secret of [key, stored]) {
    if (secret && secret !== NO_KEY_PLACEHOLDER && secret.length >= 4) text = text.split(secret).join("<redacted>");
  }
  return sanitizeErrorMessage(text) ?? "";
}

/** Register the on-device model with Hermes again, as the box had it before the engine. */
async function reRegisterOnDevice(previous: PreviousLocalAiState, makeDefault: boolean): Promise<boolean> {
  const provider = previous.store.local_ai_provider === "ollama" ? "ollama" : "llamacpp";
  const stored = previous.store.local_ai_model;
  const model = typeof stored === "string" ? stored.slice(stored.indexOf("/") + 1) : "";
  try {
    await applyLocalAiToHermes({ provider, model, makeDefault });
    return true;
  } catch (err) {
    console.error("[external-engine] re-registering the on-device model with Hermes failed:", scrub(err, null));
    return false;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Which key the probe and the harness get. A key typed now wins; "clear"
 * drops it; otherwise the one on file — but ONLY for the same origin, so
 * changing the address can never send the stored key to a host it was not
 * given for.
 */
function resolveKey(
  input: { apiKey?: string | null; clearApiKey?: boolean },
  existing: ExternalEngineRecord | null,
  baseUrl: string,
): string | null {
  if (input.apiKey) return input.apiKey;
  if (input.clearApiKey) return null;
  if (!existing || originOf(existing.baseUrl) !== originOf(baseUrl)) return null;
  const stored = readExternalEngineKey();
  return stored && stored !== NO_KEY_PLACEHOLDER ? stored : null;
}

async function chatModelPost(model: string, automatic: boolean): Promise<boolean> {
  try {
    const { POST } = await import("@/app/setup-api/chat/model/route");
    const res = await POST(new Request("http://localhost/setup-api/chat/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, ...(automatic ? { automatic: true } : {}) }),
    }));
    if (res.ok) return true;
    const data = (await res.json().catch(() => ({}))) as { warning?: unknown; error?: unknown };
    if (res.status === 502 && typeof data.warning === "string" && data.warning) return true;
    console.error(`[external-engine] chat/model refused ${model}: HTTP ${res.status}`, typeof data.error === "string" ? data.error : "");
    return false;
  } catch (err) {
    console.error("[external-engine] chat/model switch failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function settleOpenclaw(before: OpenClawConfig, baseline: Awaited<ReturnType<typeof readGatewayConfigBaseline>>): Promise<void> {
  const settlement = await settleConfigWrite({ before, after: await readConfig(), baseline, label: "external-engine" });
  if (settlement === "restart-required") {
    await restartGatewayAnsweringEarly().catch((err) => {
      console.error("[external-engine] gateway restart after the provider write failed:", err instanceof Error ? err.message : err);
    });
  }
}

function previousStoreOf(state: Record<string, unknown>): PreviousLocalAiState["store"] {
  const store = {} as PreviousLocalAiState["store"];
  for (const key of LOCAL_AI_STORE_KEYS) store[key] = state[key] === undefined ? null : state[key];
  return store;
}

/** The store keys as they were, for `setMany` (null → absent). */
function restoreStoreEntries(previous: PreviousLocalAiState): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const key of LOCAL_AI_STORE_KEYS) {
    const value = previous.store?.[key];
    entries[key] = value === null ? undefined : value;
  }
  return entries;
}

function selectedStoreEntries(record: ExternalEngineRecord): Record<string, unknown> {
  return {
    [EXTERNAL_ENGINE_STORE_KEY]: record,
    local_ai_configured: true,
    local_ai_provider: EXTERNAL_ENGINE_PROVIDER,
    local_ai_model: externalEngineModelRef(record.modelId),
    local_ai_configured_at: record.savedAt,
    local_ai_was_default: undefined,
  };
}

// ── OpenClaw ────────────────────────────────────────────────────────────────

async function applyToOpenclaw(
  settings: ExternalEngineSettings,
  key: string | null,
  previous: PreviousLocalAiState,
  firstSave: boolean,
): Promise<PreviousLocalAiState["openclaw"]> {
  const config = await readConfig();
  const ref = externalEngineModelRef(settings.modelId);
  const listed = config.agents?.defaults?.model?.fallbacks;
  const fallbacks = Array.isArray(listed) ? listed.filter((f): f is string => typeof f === "string") : [];
  // The on-device fallbacks leave: a turn that fell back to one would wake the
  // very server the engine replaces. So does an older engine ref after a
  // change of model.
  const removed = fallbacks.filter((f) => isOnDeviceRef(f) || (isExternalEngineRef(f) && f !== ref));
  const kept = fallbacks.filter((f) => !removed.includes(f));
  const baseline = await readGatewayConfigBaseline();
  const ops: string[][] = [[
    `models.providers.${EXTERNAL_ENGINE_PROVIDER}`,
    JSON.stringify(openclawExternalProviderDefinition(settings, key)),
    "--json",
  ]];
  if (removed.length > 0) ops.push(["agents.defaults.model.fallbacks", JSON.stringify(kept), "--json"]);
  await runOpenclawConfigSetBatch(ops, HOME_ENV());
  await settleOpenclaw(config, baseline);
  const prior = previous.openclaw;
  return {
    primary: firstSave ? (config.agents?.defaults?.model?.primary ?? null) : (prior?.primary ?? null),
    removedFallbacks: [...new Set([...(prior?.removedFallbacks ?? []), ...removed.filter(isOnDeviceRef)])],
  };
}

async function removeFromOpenclaw(record: ExternalEngineRecord, harness: Harness): Promise<string | undefined> {
  const config = await readConfig();
  const primary = config.agents?.defaults?.model?.primary;
  const previous = record.previous.openclaw;
  if (isExternalEngineRef(primary)) {
    // The store already names the previous Local AI again (the caller restored
    // it), so chat/model offers the old on-device row when that is where the
    // chat was. Failing that, the cloud model the picker would go "back" to.
    const candidates: string[] = [];
    if (previous?.primary && !isExternalEngineRef(previous.primary)) candidates.push(previous.primary);
    try {
      const { readChatModelStateUnfiltered } = await import("@/app/setup-api/chat/model/route");
      const cloud = (await readChatModelStateUnfiltered()).primary?.model;
      if (typeof cloud === "string" && cloud && !isExternalEngineRef(cloud) && !candidates.includes(cloud)) candidates.push(cloud);
    } catch {
      // No cloud row to offer: only the previous primary is tried.
    }
    let moved = false;
    if (harness === "openclaw") {
      for (const candidate of candidates) {
        if (await chatModelPost(candidate, true)) {
          moved = true;
          break;
        }
      }
    } else if (candidates.length > 0) {
      // A dual box running Hermes: chat/model answers 409 WRONG_STORE there,
      // and no OpenClaw session is live to sweep. The file is all there is.
      try {
        await runOpenclawConfigSetBatch([["agents.defaults.model.primary", candidates[0]]], HOME_ENV());
        moved = true;
      } catch (err) {
        console.error("[external-engine] could not put OpenClaw's primary back:", scrub(err, null));
      }
    }
    if (!moved) {
      throw new ExternalEngineRefusal(
        "primary_stuck",
        "The chat could not be moved off the external engine, so it was left in place. Pick another model in the chat header, then remove the engine again.",
        502,
      );
    }
  }
  const after = await readConfig();
  const baseline = await readGatewayConfigBaseline();
  const listed = after.agents?.defaults?.model?.fallbacks;
  const fallbacks = Array.isArray(listed) ? listed.filter((f): f is string => typeof f === "string") : [];
  const restored = fallbacks.filter((f) => !isExternalEngineRef(f));
  for (const f of previous?.removedFallbacks ?? []) if (!restored.includes(f)) restored.push(f);
  if (JSON.stringify(restored) !== JSON.stringify(fallbacks)) {
    await runOpenclawConfigSetBatch([["agents.defaults.model.fallbacks", JSON.stringify(restored), "--json"]], HOME_ENV());
  }
  let warning: string | undefined;
  if (after.models?.providers?.[EXTERNAL_ENGINE_PROVIDER]) {
    try {
      await runOpenclawConfigUnset(`models.providers.${EXTERNAL_ENGINE_PROVIDER}`, HOME_ENV());
    } catch (err) {
      console.error("[external-engine] could not remove the OpenClaw provider:", scrub(err, null));
      warning = "The engine was removed from Local AI, but its OpenClaw provider entry could not be deleted. It is unused; remove it again to finish.";
    }
  }
  await settleOpenclaw(after, baseline);
  return warning;
}

// ── Hermes ──────────────────────────────────────────────────────────────────


async function hermesValue(key: string): Promise<string | null> {
  const read = await resolveHermesConfigValue(key);
  if (read.state === "unreadable") {
    throw new ExternalEngineRefusal("hermes_unreadable", "Hermes' config.yaml could not be read, so nothing was changed.", 502);
  }
  return read.state === "value" ? read.value : null;
}

async function applyToHermes(
  settings: ExternalEngineSettings,
  key: string | null,
  previous: PreviousLocalAiState,
  firstSave: boolean,
): Promise<PreviousLocalAiState["hermes"]> {
  return withProviderMcpRefresh(async () => {
    let snapshot = previous.hermes;
    if (firstSave) {
      const provider = await hermesValue("model.provider");
      const model = await hermesValue("model.default");
      const storedLocal = previous.store.local_ai_provider;
      const localRegistered = previous.store.local_ai_configured === true
        && (storedLocal === "llamacpp" || storedLocal === "ollama");
      snapshot = { provider, model, localRegistered };
      // The on-device model leaves Hermes' pickers while the engine is the
      // Local AI: offered, it would be a row whose every turn the proxy refuses.
      if (localRegistered) {
        try {
          await removeLocalAiFromHermes();
        } catch (err) {
          throw new ExternalEngineRefusal(
            "hermes_local_removal_failed",
            err instanceof HermesLocalRemovalError || err instanceof Error
              ? `The on-device model could not be taken out of Hermes first: ${scrub(err, key) || "unknown error"}`
              : "The on-device model could not be taken out of Hermes first.",
            502,
          );
        }
      }
    }
    try {
      // ONE write, re-save included: every key of the block is a scalar that
      // the set replaces, so the provider is never left half there. A
      // catalogue Hermes persisted for an older model (`models_discovered`)
      // goes in the same patch.
      await patchHermesConfig({
        set: {
          ...hermesProviderSet(settings, key),
          "model.provider": EXTERNAL_ENGINE_PROVIDER,
          "model.default": settings.modelId,
        },
        ...(firstSave ? {} : { unset: [`providers.${EXTERNAL_ENGINE_PROVIDER}.models_discovered`] }),
      });
    } catch (err) {
      // The on-device model was taken out above for an engine that did not
      // land: put it back where it was, so Hermes is never left with neither.
      if (firstSave && snapshot?.localRegistered) await reRegisterOnDevice(previous, snapshot.provider === "clawlocal");
      throw new ExternalEngineRefusal(
        "hermes_write_failed",
        scrub(err, key) || "The engine could not be written into Hermes' config.",
        502,
      );
    } finally {
      invalidateModelOptions();
    }
    await forgetProviderVerified(EXTERNAL_ENGINE_PROVIDER).catch(() => {});
    return snapshot;
  });
}

async function removeFromHermes(record: ExternalEngineRecord): Promise<string | undefined> {
  return withProviderMcpRefresh(async () => {
    const selection = await hermesValue("model.provider");
    const previous = record.previous.hermes;
    const unset = HERMES_PROVIDER_KEYS.map((k) => `providers.${EXTERNAL_ENGINE_PROVIDER}.${k}`);
    const set: Record<string, string> = {};
    const reRegisterLocal = previous?.localRegistered === true;
    if (selection === EXTERNAL_ENGINE_PROVIDER) {
      if (previous?.provider && previous.provider !== EXTERNAL_ENGINE_PROVIDER && previous.provider !== "clawlocal" && previous.model) {
        set["model.provider"] = previous.provider;
        set["model.default"] = previous.model;
      } else {
        // Never left naming a block that is gone (every turn would 502 with
        // "Unknown provider"); the on-device model, when it was the
        // selection, is made the default again just below.
        unset.push("model.provider", "model.default");
      }
    }
    try {
      await patchHermesConfig({ set, unset });
    } catch (err) {
      throw new ExternalEngineRefusal(
        "hermes_write_failed",
        scrub(err, null) || "The engine could not be removed from Hermes' config.",
        502,
      );
    } finally {
      invalidateModelOptions();
    }
    await forgetProviderVerified(EXTERNAL_ENGINE_PROVIDER).catch(() => {});
    if (!reRegisterLocal) return undefined;
    const back = await reRegisterOnDevice(record.previous, previous?.provider === "clawlocal" && selection === EXTERNAL_ENGINE_PROVIDER);
    return back
      ? undefined
      : "The engine was removed, but the on-device model could not be registered with Hermes again. Turn it on in Settings → Local AI.";
  });
}

// ── Save / remove ───────────────────────────────────────────────────────────

export interface SaveInput {
  settings: ExternalEngineSettings;
  /** A key typed now; undefined/null keeps the stored one (same origin only). */
  apiKey?: string | null;
  clearApiKey?: boolean;
}

export interface SaveOutcome {
  record: ExternalEngineRecord;
  harness: Harness;
  models: string[];
  warning?: string;
}

/** Validate against the live endpoint, then make it the box's Local AI and the chat's model. */
export async function saveExternalEngine(input: SaveInput): Promise<SaveOutcome> {
  const state = await getAll();
  if (state.local_only_mode) {
    throw new ExternalEngineRefusal(
      "local_only_mode",
      "Local-only mode is on. It keeps every conversation on this box, so turn it off before you point Local AI at an external engine.",
    );
  }
  const harness = await getActiveHarness();
  const { settings } = input;
  if (harness === "hermes" && settings.contextWindow < HERMES_MIN_CONTEXT_WINDOW) {
    throw new ExternalEngineRefusal(
      "context_too_small_for_hermes",
      `Hermes needs a model with a context window of at least ${HERMES_MIN_CONTEXT_WINDOW.toLocaleString("en-US")} tokens.`,
      400,
    );
  }
  const existing = externalEngineFromState(state);
  const key = resolveKey(input, existing, settings.baseUrl);
  const probe = await probeExternalEngine({ baseUrl: settings.baseUrl, apiKey: key, modelId: settings.modelId });
  if (!probe.ok) throw new ExternalEngineRefusal(probe.code, probe.error, 422);

  const firstSave = existing === null;
  const previous: PreviousLocalAiState = firstSave ? { store: previousStoreOf(state) } : existing.previous;
  const keyBefore = readExternalEngineKey();
  writeExternalEngineKey(key || NO_KEY_PLACEHOLDER);

  const record: ExternalEngineRecord = {
    ...settings,
    providerId: EXTERNAL_ENGINE_PROVIDER,
    harness,
    savedAt: new Date().toISOString(),
    previous,
  };

  try {
    if (harness === "hermes") {
      record.previous = { ...previous, hermes: await applyToHermes(settings, key, previous, firstSave || !previous.hermes) };
    } else {
      if (openclawIsAbsent()) throw new ExternalEngineRefusal("no_harness", "OpenClaw is not installed on this box.", 501);
      record.previous = { ...previous, openclaw: await applyToOpenclaw(settings, key, previous, firstSave || !previous.openclaw) };
    }
  } catch (err) {
    // The key on file goes back to what the harness still holds.
    if (firstSave || keyBefore === null) deleteExternalEngineKey();
    else writeExternalEngineKey(keyBefore);
    if (err instanceof ExternalEngineRefusal) throw err;
    throw new ExternalEngineRefusal(
      "write_failed",
      scrub(err, key) || "The engine could not be written into the assistant's config.",
      502,
    );
  }

  // From here the store names the engine — which is also what turns the
  // llama.cpp / Ollama start gates on — and the on-device runtime goes down.
  await setMany(selectedStoreEntries(record));
  await stopLocalAiProvider("llamacpp").catch((err) => {
    console.error("[external-engine] stopping llama.cpp failed:", err instanceof Error ? err.message : err);
  });
  if (previous.store.local_ai_provider === "ollama") {
    await stopLocalAiProvider("ollama").catch((err) => {
      console.error("[external-engine] stopping Ollama failed:", err instanceof Error ? err.message : err);
    });
  }

  let warning: string | undefined;
  if (harness === "openclaw" && !(await chatModelPost(externalEngineModelRef(settings.modelId), false))) {
    warning = "The engine is saved, but the chat could not be switched to it. Pick it in the chat header.";
  }
  return { record, harness, models: probe.models, ...(warning ? { warning } : {}) };
}

/** Take the engine out of the harness and put the previous Local AI back. */
export async function removeExternalEngine(): Promise<{ removed: boolean; warning?: string }> {
  const state = await getAll();
  const record = externalEngineFromState(state);
  if (!record) return { removed: false };
  const harness = await getActiveHarness();
  const restore = restoreStoreEntries(record.previous);
  // The previous Local AI first: chat/model reads it to offer the on-device
  // row the chat goes back to.
  await setMany(restore);
  const warnings: string[] = [];
  try {
    if (!openclawIsAbsent() && (harness === "openclaw" || (await readConfig()).models?.providers?.[EXTERNAL_ENGINE_PROVIDER])) {
      const w = await removeFromOpenclaw(record, harness);
      if (w) warnings.push(w);
    }
    const hermesDeclared = harness === "hermes"
      || (await resolveHermesConfigValue(`providers.${EXTERNAL_ENGINE_PROVIDER}.base_url`)).state === "value";
    if (hermesDeclared) {
      const w = await removeFromHermes(record);
      if (w) warnings.push(w);
    }
  } catch (err) {
    // Back to "selected": the harness still names the engine, so the store must too.
    await setMany(selectedStoreEntries(record));
    if (err instanceof ExternalEngineRefusal) throw err;
    throw new ExternalEngineRefusal(
      "write_failed",
      scrub(err, null) || "The engine could not be removed from the assistant's config.",
      502,
    );
  }
  await setMany({ [EXTERNAL_ENGINE_STORE_KEY]: undefined });
  deleteExternalEngineKey();
  return { removed: true, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
}
