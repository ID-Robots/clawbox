import { runHermesCli } from "@/lib/hermes-cli";
import { get } from "@/lib/config-store";
import { patchHermesConfig, readHermesConfigValue } from "@/lib/hermes-config-yaml";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { withProviderMcpRefresh } from "@/lib/provider-mcp-refresh";
import { getLocalAiToken } from "@/lib/local-ai-token";
import { getDefaultLlamaCppModel } from "@/lib/llamacpp";
import { getLocalAiOpenAiBaseUrl, getLocalAiProxyRootUrl } from "@/lib/local-ai-runtime";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";

/**
 * Register the on-device model with Hermes.
 *
 * Enabling Gemma 4 wrote the selection into ~/.openclaw/openclaw.json and
 * started llama.cpp — which is the whole story on an OpenClaw box, and half a
 * story on a Hermes one. Hermes keeps its own `providers:` block, so the local
 * model was running and configured while Hermes had never heard of it: Settings
 * said "configured", and the chat's provider picker listed only the cloud
 * providers. This closes that gap the same way ClawBox AI does — as a custom
 * OpenAI-compatible provider (see hermes-clawai.ts).
 *
 * The base_url is our own proxy, not llama.cpp directly, for two reasons:
 * the proxy is what implements on-demand standby (it wakes the model on the
 * first request and lets it sleep again to free RAM — "sleeping until needed"
 * in the Settings card), and it is the only endpoint that stays put when the
 * backend port or runtime changes. It authenticates with the local-AI bearer
 * token, which is exactly what the api_key slot is for.
 */

export const HERMES_LOCAL_PROVIDER = "clawlocal";

export type LocalAiProviderId = "llamacpp" | "ollama";

export class HermesLocalApplyError extends Error {}


/**
 * Point Hermes at the local model. `makeDefault` decides whether the device
 * also SWITCHES to it: turning on a private fallback should make it available,
 * not silently take over from the provider the customer chose.
 */
export async function applyLocalAiToHermes(options: {
  provider: LocalAiProviderId;
  model: string;
  makeDefault?: boolean;
}): Promise<{ provider: string; model: string }> {
  // Registering the local model adds a provider to the list the ClawBox MCP
  // server probed ONCE, at boot, and turned into `ai_set_provider`'s enum. The
  // wrapper samples that set either side of the write and asks the agent to
  // re-advertise only when it moved — see `provider-mcp-refresh.ts`.
  return withProviderMcpRefresh(() => applyLocalAi(options));
}

async function applyLocalAi(options: {
  provider: LocalAiProviderId;
  model: string;
  makeDefault?: boolean;
}): Promise<{ provider: string; model: string }> {
  const model = (options.model || getDefaultLlamaCppModel()).trim();
  // The id reaches argv. A leading dash would be read as a flag.
  if (!model || model.startsWith("-")) {
    throw new HermesLocalApplyError("Local model id is missing or malformed.");
  }

  const set: Record<string, string> = {
    // The OpenAI-compatible root, NOT the bare proxy root: Hermes appends
    // /chat/completions to base_url, and Ollama only serves that under /v1.
    // The bare root used to be written here, so every Ollama-backed chat turn
    // 404'd upstream and surfaced as a 502.
    [`providers.${HERMES_LOCAL_PROVIDER}.base_url`]: getLocalAiOpenAiBaseUrl(options.provider),
    [`providers.${HERMES_LOCAL_PROVIDER}.api_key`]: getLocalAiToken(),
    [`providers.${HERMES_LOCAL_PROVIDER}.api_mode`]: "openai",
    // What this endpoint serves, for the pickers Hermes builds ITSELF — the
    // Telegram/Discord `/model` keyboard and the Hermes dashboard's Models page,
    // both from `list_authenticated_providers` (hermes_cli/model_switch.py:2571).
    //
    // Those probe `<base_url>/models` for a live list, and standby is the point
    // of the local model: asleep, it answers nothing, so the row arrives with an
    // empty list and there is no model to select — the same hole
    // `normalizeRow` already patches for OUR chat header, on the surface we do
    // not serve. Declaring the id is what Hermes reads instead of the probe when
    // the probe comes back empty (model_switch.py:3423-3431), and a probe that
    // DOES answer still wins, so a woken box still shows whatever it is running.
    //
    // A plain scalar rather than a list: there is exactly one configured local
    // model, and a string is an allowlist shape as far as Hermes is concerned
    // (`_declared_model_ids` at model_switch.py:61, `_models_config_is_allowlist`
    // at :136) — which also keeps it inside what the comment-preserving YAML
    // writer can splice.
    [`providers.${HERMES_LOCAL_PROVIDER}.models`]: model,
  };
  if (options.makeDefault) {
    set["model.provider"] = HERMES_LOCAL_PROVIDER;
    set["model.default"] = model;
  }

  // One read-merge-write instead of three-to-five `hermes config set` calls.
  // Each of those re-serialised config.yaml and took every comment in it with
  // them — a customer who clicked "save local model" lost the file's Security
  // and Fallback Model documentation for good (b10).
  try {
    await patchHermesConfig({ set });
  } catch (err) {
    // Guarded here as well as at the source, because this catch is `catch
    // (err)` — it re-publishes the message of ANY throw from the write path,
    // not only the `HermesConfigWriteError` that path cleans. A wrapper whose
    // safety depends on every future thrower having remembered is the shape
    // this whole round is about.
    throw new HermesLocalApplyError(
      sanitizeErrorMessage(err instanceof Error ? err.message : "")
        || "Failed to register the local model with Hermes",
    );
  }

  invalidateModelOptions();
  return { provider: HERMES_LOCAL_PROVIDER, model };
}

let reconciled = false;

/**
 * True only when Hermes has NO model declared for our local provider.
 *
 * Three answers, not two: `hermes config get` exits non-zero both for a key
 * that is unset and for a config it could not read, and repairing off a failed
 * read would overwrite whatever is really in the file — so only the "not set"
 * wording counts as missing. A value of any shape is left alone; it may be
 * Hermes' own discovered catalogue, which is richer than the one id we know.
 */
async function localCatalogueMissing(): Promise<boolean> {
  const declared = await runHermesCli(
    ["config", "get", `providers.${HERMES_LOCAL_PROVIDER}.models`],
    { timeoutMs: 15_000 },
  );
  if (declared.code === 0) return false;
  return /config key not set/i.test(`${declared.stdout ?? ""}\n${declared.stderr ?? ""}`);
}

/**
 * Register the local model if it was configured BEFORE this code existed.
 *
 * The write above only happens when the customer enables local AI. Every device
 * that already had Gemma 4 on would otherwise keep the symptom — configured,
 * running, absent from the picker — until someone thought to toggle it off and
 * on again. So the picker's own read repairs it, once per process, and only
 * when there is genuinely something to repair.
 */
export async function reconcileLocalAiWithHermes(): Promise<void> {
  if (reconciled) return;
  reconciled = true;
  try {
    const configured = await get("local_ai_configured");
    if (configured !== true) return;
    const provider = await get("local_ai_provider");
    if (provider !== "llamacpp" && provider !== "ollama") return;
    // Already registered? Then this is a normal device and we are done —
    // unless the registered value is one THIS code wrote and would no longer
    // write (the bare pre-/v1 Ollama proxy root every Ollama-configured Hermes
    // box got, 404ing every chat turn). "Ours" is anything under our own proxy
    // root; a value pointing anywhere else is somebody's deliberate
    // configuration and stays untouched. Written this way — rather than
    // pinning the one bad literal — so any future stale self-written URL heals
    // on the next reconcile instead of needing its own clause.
    const existing = await runHermesCli(
      ["config", "get", `providers.${HERMES_LOCAL_PROVIDER}.base_url`],
      { timeoutMs: 15_000 },
    );
    const registered = existing.code === 0 ? existing.stdout.trim() : "";
    const ourStaleUrl =
      registered.startsWith(`${getLocalAiProxyRootUrl()}/setup-api/local-ai/`)
      && registered !== getLocalAiOpenAiBaseUrl(provider);
    if (registered && !ourStaleUrl && !(await localCatalogueMissing())) return;

    const stored = await get("local_ai_model");
    // Stored as "llamacpp/gemma4-e2b-it-q4_0"; Hermes wants the bare id.
    const model = typeof stored === "string" ? stored.split("/").pop() || "" : "";
    // The INNER write, deliberately — this one repair must not ask for an MCP
    // reload. It hangs off `GET /setup-api/hermes/models`, and that route is
    // what the agent's own `ai_list_models` reads: a `reload.mcp` from in here
    // would shut down the very MCP child that is mid-tool-call. The enum
    // catches up at the owner's next provider action or the next restart, which
    // is what a box in this state has been doing all along.
    await applyLocalAi({ provider, model });
  } catch (err) {
    // Never let a repair break the read it is attached to.
    console.error("[hermes-local-ai] reconcile failed:", err);
    reconciled = false;
  }
}

/** Test seam. */
export function _resetLocalAiReconcileForTests(): void {
  reconciled = false;
}

/**
 * Remove the provider when local AI is turned off, so the picker stops offering
 * a model that is no longer running.
 *
 * It also clears `model.provider` when that still points at us. The previous
 * behaviour — documented at the time as deliberate, "an entry that errors once
 * is a smaller surprise than a silent reassignment" — turned out to be neither
 * small nor once: with the providers block gone and `model.provider: clawlocal`
 * left behind, EVERY chat turn 502s with
 * `Unknown provider 'clawlocal'. Check 'hermes model' …` and the picker keeps
 * offering the dead model, because a stored current provider is unshifted into
 * the list whether or not it exists. That is the state a fresh Hermes box lands
 * in the moment its owner toggles Local AI off, since the local model was its
 * only provider. No provider selected is a state the product already renders
 * ("Choose a provider"); a provider that cannot answer is not.
 *
 * The caller gets `wasDefault` back so a later enable can restore the selection
 * rather than leaving the device on nothing — off → on round-trips.
 */
export async function removeLocalAiFromHermes(): Promise<{ wasDefault: boolean; model: string | null }> {
  // The same bug pointing the other way: an enum still offering a provider the
  // device no longer serves, which /setup-api/hermes/models answers with
  // "Unknown provider".
  return withProviderMcpRefresh(() => removeLocalAi());
}

async function removeLocalAi(): Promise<{ wasDefault: boolean; model: string | null }> {
  const activeProvider = await readHermesConfigValue("model.provider").catch(() => null);
  const wasDefault = activeProvider === HERMES_LOCAL_PROVIDER;
  const model = wasDefault ? await readHermesConfigValue("model.default").catch(() => null) : null;

  // `models` rides with the endpoint it describes. Left behind, it is a
  // `providers.clawlocal` block naming a model with nowhere to send it — and
  // Hermes renders a row for any entry that has models, so the picker would go
  // on offering the stopped model, which is the exact state this function
  // exists to end.
  const unset = ["base_url", "api_key", "api_mode", "models"].map(
    (key) => `providers.${HERMES_LOCAL_PROVIDER}.${key}`,
  );
  if (wasDefault) {
    unset.push("model.provider", "model.default");
  }
  await patchHermesConfig({ unset });

  invalidateModelOptions();
  return { wasDefault, model };
}
