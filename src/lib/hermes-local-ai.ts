import { runHermesCli } from "@/lib/hermes-cli";
import { hermesCliAnswered } from "@/lib/hermes-cli-answered";
import { get } from "@/lib/config-store";
import {
  patchHermesConfig,
  readHermesConfigValue,
  resolveHermesConfigValue,
  type HermesConfigRead,
} from "@/lib/hermes-config-yaml";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { withProviderMcpRefresh } from "@/lib/provider-mcp-refresh";
import { getLocalAiToken } from "@/lib/local-ai-token";
import { getDefaultLlamaCppModel } from "@/lib/llamacpp";
import { getLocalAiOpenAiBaseUrl, getLocalAiProxyRootUrl } from "@/lib/local-ai-runtime";
import { sanitizeErrorMessage } from "@/lib/safe-error-text";
import { forgetProviderVerified } from "@/lib/provider-verified";

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
 * A removal that did not land, carrying the selection state read BEFORE it ran.
 *
 * `wasDefault` — "the local model was this device's active provider" — is read
 * at the top of `removeLocalAi`, and a partial unset can clear `model.provider`
 * and still leave a `providers.clawlocal` key behind. This refusal is the last
 * moment the fact exists: the retry reads a `model.provider` that is already
 * gone, answers `false`, and re-enabling Local AI would then put the device on
 * nothing instead of back on the model it was on. So it rides out with the
 * error, and the route stores it either way.
 *
 * A plain `Error` and NOT a `HermesConfigWriteError` subclass, deliberately:
 * nothing narrows on that class (the route catches whatever comes), and
 * extending it would evaluate an imported class at MODULE LOAD time — which
 * breaks every suite that mocks `hermes-config-yaml` without listing it, for a
 * lineage no caller reads.
 */
export class HermesLocalRemovalError extends Error {
  constructor(message: string, readonly wasDefault: boolean) {
    super(message);
  }
}


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
  const catalogue = await localCatalogueState();
  // A catalogue question that FAILED is not a reason to stop asking. Omitting
  // `models` below is right — an unreadable key is not an absent one — but the
  // picker's own repair latches once per process and may already have run, so
  // nothing would ever come back for it and the key would stay missing until
  // the web server restarted. Hand the repair back to the next read — with no
  // backoff, because the repair did not fail here, this enable did.
  if (catalogue === "unknown") handRepairBack();

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
    // at :136 — both verified against the installed Hermes) — which also keeps
    // it inside what the comment-preserving YAML writer can splice.
    //
    // WRITTEN ONLY WHEN THE KEY IS OURS. If Hermes has cached its own discovered
    // catalogue there it is a nested block, and `setYamlPath` refuses a leaf
    // that opens one — which aborts the WHOLE patch onto `hermes config set`
    // and takes every comment in config.yaml with it, the exact loss this
    // module exists to prevent. Leaving a richer catalogue alone is also just
    // right: a live probe beats our one id whenever the model is awake.
    ...(catalogue === "absent" || catalogue === "scalar"
      ? { [`providers.${HERMES_LOCAL_PROVIDER}.models`]: model }
      : {}),
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
let retryAfter = 0;

/**
 * How long a repair whose QUESTION failed waits before another request retries.
 *
 * Same number and the same reasoning as `REPAIR_RETRY_MS` in hermes-clawai.ts
 * and `FAILED_READ_TTL_MS` in hermes-config-cache.ts: unlatching on a failure
 * is what stops an update from skipping the repair for the life of the process,
 * and a bound is what stops that retry from becoming a Python start per request
 * on `GET /setup-api/hermes/models` — the route the chat header, the Settings
 * panel and the agent's own `ai_list_models` all read, which awaits BOTH
 * repairs before it serves anything.
 */
const REPAIR_RETRY_MS = 60_000;

/** A repair ATTEMPT failed: let a later request try again, but not for a
 *  minute. */
function retryLater(): void {
  reconciled = false;
  retryAfter = Date.now() + REPAIR_RETRY_MS;
}

/** Something OTHER than the repair noticed the key may be missing: let the very
 *  next read try, with no backoff. Nothing failed here, so there is nothing to
 *  back off from — and this runs on an explicit customer action rather than on
 *  every request, so it cannot become a spawn per request the way an unbounded
 *  `retryLater` could. */
function handRepairBack(): void {
  reconciled = false;
  retryAfter = 0;
}

/**
 * How `providers.clawlocal.models` is currently spelled in config.yaml.
 *
 *   "absent"  — not there. Ours to write, and the case every field box is in.
 *   "scalar"  — the one-id form THIS module writes. Ours to update, which is
 *               what makes a changed local model land.
 *   "foreign" — there, and not a scalar: Hermes' own discovered catalogue,
 *               which is a nested block. Never ours to touch — see the write
 *               site for what splicing over it would cost.
 *   "unknown" — the question failed. Not an answer, and never treated as one.
 *
 * Two reads because one cannot tell those four apart. `readHermesConfigValue`
 * parses the file and returns a value only for a scalar; it answers null for
 * absent, for a block AND for a file it could not read, so a non-null result is
 * the only thing it settles on its own. The CLI splits the remaining three:
 * exit 0 means the key is there in some other shape, "config key not set" means
 * it is not, and anything else — including the 126/127 a `step_hermes_install`
 * rebuild produces without ever reaching argparse — is the CLI failing to
 * answer rather than answering "no".
 */
type LocalCatalogueState = "absent" | "scalar" | "foreign" | "unknown";

/**
 * Is the key still in config.yaml, according to HERMES' OWN READER?
 *
 * `hermes config get <key>` loads the file with PyYAML, which is the same
 * loader the gateway uses, so it answers for the shapes our line reader has to
 * decline but PyYAML reads happily — a block at an indent we cannot index, a
 * duplicate key, a flow mapping with members. A document PyYAML itself refuses
 * is declined by both, and lands in `unknown` where it belongs. Exit 0 is
 * "there in some shape", "config key not set" is "not
 * there", and anything else — including the 126/127 a `step_hermes_install`
 * rebuild produces without ever reaching argparse — is the CLI failing to
 * answer rather than answering "no".
 */
type HermesKeyPresence = "present" | "absent" | "unknown";

type HermesCliRead =
  | { presence: "present"; value: string }
  | { presence: "absent" | "unknown" };

/**
 * The one spawn behind both readers below.
 *
 * It carries the value out, and the read-back loop points it at
 * `providers.<slug>.api_key` on every removal that reaches the CLI — so the
 * rule is not "never ask it about a credential", it is that the value never
 * leaves this function except through `selectionValue`, whose only two call
 * sites pass the literals `model.provider` and `model.default` (a provider slug
 * and a model id). `cliKeyPresence` is what every other key goes through and it
 * drops the value on the floor; nothing here logs one.
 */
async function cliKeyRead(key: string): Promise<HermesCliRead> {
  // `runHermesCli` REJECTS for a missing binary, a timeout and its own SIGKILL.
  // None of those is an answer either, and the callers here all treat "could
  // not ask" the same way, so it is folded in rather than thrown.
  const answer = await runHermesCli(["config", "get", key], { timeoutMs: 15_000 }).catch(() => null);
  if (!answer || !hermesCliAnswered(answer)) return { presence: "unknown" };
  if (answer.code === 0) return { presence: "present", value: (answer.stdout ?? "").trim() };
  return /config key not set/i.test(`${answer.stdout ?? ""}\n${answer.stderr ?? ""}`)
    ? { presence: "absent" }
    : { presence: "unknown" };
}

async function cliKeyPresence(key: string): Promise<HermesKeyPresence> {
  return (await cliKeyRead(key)).presence;
}

/**
 * What one key is SET TO, asking Hermes' own reader for the shapes ours has to
 * decline — with "nobody could say" kept apart from "nothing is set there".
 *
 * `readHermesConfigValue` collapses both into `null`, and the difference is the
 * whole of TASK-545's remaining half: on a config.yaml our line editor cannot
 * index, reading "could not be read" as "the local model is not the selection"
 * left `model.provider: clawlocal` in the file with its providers block removed
 * — the state this module's header describes, where every chat turn 502s with
 * `Unknown provider 'clawlocal'` — while the route answered `{success:true}`.
 */
async function selectionValue(key: string): Promise<{ known: boolean; value: string | null }> {
  const read = await resolveHermesConfigValue(key).catch(
    (): HermesConfigRead => ({ state: "unreadable" }),
  );
  if (read.state === "value") return { known: true, value: read.value };
  // `absent` is nothing there; `present` is a non-scalar under a key that is a
  // scalar wherever Hermes wrote it. Neither can be a provider slug, and both
  // are answers.
  if (read.state !== "unreadable") return { known: true, value: null };
  const cli = await cliKeyRead(key);
  if (cli.presence === "unknown") return { known: false, value: null };
  return { known: true, value: cli.presence === "present" ? cli.value : null };
}

async function localCatalogueState(): Promise<LocalCatalogueState> {
  const key = `providers.${HERMES_LOCAL_PROVIDER}.models`;
  if ((await readHermesConfigValue(key)) !== null) return "scalar";
  const declared = await cliKeyPresence(key);
  if (declared === "unknown") return "unknown";
  return declared === "present" ? "foreign" : "absent";
}

/**
 * Declare the local model where Hermes' own pickers read it, for a box
 * registered before this code existed.
 *
 * NARROW ON PURPOSE: one key, and never a re-registration. Re-running the full
 * apply would drag every field box down the repair path built for a stale
 * self-written URL — and that path substitutes `getDefaultLlamaCppModel()` for
 * an unreadable `local_ai_model`, which on an Ollama box would declare a
 * llama.cpp id as the Ollama endpoint's model and put it in Hermes' picker.
 * An id we do not have is a reason to write nothing, not to invent one.
 */
async function declareLocalCatalogue(model: string): Promise<boolean> {
  if (!model || model.startsWith("-")) return true;
  const key = `providers.${HERMES_LOCAL_PROVIDER}.models`;
  const state = await localCatalogueState();
  if (state === "unknown") return false;
  // "foreign" is Hermes' own block and never ours. "scalar" IS ours — it is the
  // one-id form this module writes — so a scalar that no longer names the
  // configured model is our own value gone stale, and leaving it would have the
  // picker go on offering a model this box no longer runs. The enable path has
  // always updated it; the repair used to write only when the key was missing,
  // so a box whose model changed while the CLI was unreadable kept the old id.
  if (state === "foreign") return true;
  if (state === "scalar" && (await readHermesConfigValue(key)) === model) return true;
  await patchHermesConfig({ set: { [key]: model } });
  invalidateModelOptions();
  return true;
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
  if (reconciled || Date.now() < retryAfter) return;
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
    if (!hermesCliAnswered(existing)) {
      // The CLI did not answer (a `step_hermes_install` rebuild exits 127
      // without reaching argparse). Not evidence about this box — try again on
      // a later request rather than latching a non-answer for the process.
      retryLater();
      return;
    }
    const registered = existing.code === 0 ? existing.stdout.trim() : "";
    const ourStaleUrl =
      registered.startsWith(`${getLocalAiProxyRootUrl()}/setup-api/local-ai/`)
      && registered !== getLocalAiOpenAiBaseUrl(provider);

    const stored = await get("local_ai_model");
    // Stored as "llamacpp/gemma4-e2b-it-q4_0"; Hermes wants the bare id.
    const model = typeof stored === "string" ? stored.split("/").pop() || "" : "";

    if (registered && !ourStaleUrl) {
      // The endpoint is right; only the catalogue Hermes' own pickers read can
      // still be missing. One key, no re-registration.
      if (!(await declareLocalCatalogue(model))) retryLater();
      return;
    }
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
    retryLater();
  }
}

/** Test seam. */
export function _resetLocalAiReconcileForTests(): void {
  reconciled = false;
  retryAfter = 0;
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
  // BEFORE the write, and three-state. There is no safe unset list to send
  // while this is unknown: putting `model.provider` on it blind would drop the
  // owner's cloud selection on a Local AI toggle-off, and leaving it off is the
  // 502-per-turn state above. Nothing has been written when we refuse, so Local
  // AI stays registered and the box goes on working, whereas the same doubt one
  // step later would leave the providers block half removed around a selection
  // nobody could read.
  //
  // It is NOT free, and a family of shapes pays for it: several anomalies
  // confined to the `model:` block while `providers:` stays ordinary — a flow
  // mapping, a block at any indent but two, a duplicate key inside it, an
  // alias, a sequence, or an inline comment on the `model:` line (which the
  // merge path deliberately preserves, so it persists) — leave our line reader
  // able to resolve the providers keys and unable to resolve the selection. With the
  // CLI also dead (a `step_hermes_install` rebuild, ~90 s), those removals used
  // to complete through the merge path with no CLI spawn at all and now answer
  // 502 with the block still in place. That success was luck rather than
  // knowledge — "not the default" was a guess, and the guess being wrong is
  // precisely the defect this read exists to end — so the conservative branch
  // is kept and the cost is stated instead of hidden.
  const selection = await selectionValue("model.provider");
  if (!selection.known) {
    console.error("[hermes-local-ai] the active provider could not be read; nothing was removed");
    throw new HermesLocalRemovalError(
      "The Hermes config could not be read, so the removal was not attempted.",
      false,
    );
  }
  const wasDefault = selection.value === HERMES_LOCAL_PROVIDER;
  // `known` is deliberately not checked for this one. It is reached only once
  // `wasDefault` is PROVED true, so whatever is there is a local model id and
  // goes on the unset list either way; the value is a courtesy for a later
  // enable, and nothing reads it today (`local-ai/route.ts` takes only
  // `wasDefault`). Refusing the whole removal because the id could not be
  // re-read would trade a completed removal for a 502 over a field with no
  // consumer.
  const model = wasDefault ? (await selectionValue("model.default")).value : null;

  // `models` rides with the endpoint it describes. Left behind, it is a
  // `providers.clawlocal` block naming a model with nowhere to send it — and
  // Hermes renders a row for any entry that has models, so the picker would go
  // on offering the stopped model, which is the exact state this function
  // exists to end.
  // The api_key goes with the endpoint, so an older turn's "this provider
  // answered" mark stops describing anything. Switching Local AI off and on
  // again re-registers the provider with a freshly read token; without this the
  // row would come back reporting a verification from before the teardown.
  // See src/lib/provider-verified.ts.
  await forgetProviderVerified(HERMES_LOCAL_PROVIDER);
  const unset = ["base_url", "api_key", "api_mode", "models"].map(
    (key) => `providers.${HERMES_LOCAL_PROVIDER}.${key}`,
  );
  if (wasDefault) {
    unset.push("model.provider", "model.default");
  }
  // `finally`, and BEFORE the proof. `withProviderMcpRefresh` samples the
  // provider set either side of this call and re-reads it in a `finally`
  // precisely because "the write threw" is not "nothing was written" — and that
  // re-read only sees the new catalogue if the memo has been dropped. Left at
  // the end, a partial removal that then refuses would leave `getModelOptions`
  // serving the pre-removal set, so no `reload.mcp` is asked for and
  // `ai_set_provider`'s enum goes on offering a provider whose endpoint is
  // already out of the file.
  //
  // The `finally` is for the same reason one call earlier: `applyViaCli` walks
  // the unsets one spawn at a time and does not catch, and `runHermesCli`
  // REJECTS on a timeout — so three keys can land and the fourth take the whole
  // call down. The file may have changed whatever happens after this line.
  try {
    await patchHermesConfig({ unset });
  } finally {
    invalidateModelOptions();
  }

  // PROVED, not inferred. `patchHermesConfig`'s merge path reads every key back
  // (patchText), but its CLI fallback does not: `applyViaCli`'s unset loop
  // discards the exit code, because `hermes config unset` on a key that was
  // never there is the no-op the loop relies on. So a config.yaml the line
  // editor refuses (a flow mapping, a duplicate key) sends the patch to a CLI
  // that a `step_hermes_install` rebuild has left exiting 127 before argparse,
  // and this function returned as if the provider were gone.
  //
  // That return is the ONE fact the disable route answers on for this SKU, so
  // it has to be a fact.
  //
  // EVERY key, not just the endpoint: `applyViaCli` walks the unsets one CLI
  // call at a time, so it can land some and drop others — and `models` left
  // behind on its own is a `providers.clawlocal` entry that Hermes still
  // renders as a picker row, which is the exact state this function exists to
  // end.
  //
  // Through `resolveHermesConfigValue`, because `readHermesConfigValue` answers
  // `null` for a file it could not read as well as for a key that is gone, and
  // the two are not interchangeable HERE: the CLI fallback runs precisely
  // because the line editor could not work with this file, so a read-back that
  // cannot resolve the path is the ordinary companion of that write, not the
  // exotic one.
  // Reading that as "removed" would rebuild the false success one layer down.
  //
  // "present" is a leftover as much as "value" is: `providers.clawlocal.models`
  // is a scalar only while WE own it, and Hermes' own discovery writes a nested
  // block there — which the scalar reader answered `null` for, exactly as it
  // does for a key that is gone.
  const leftovers: string[] = [];
  const unproven: string[] = [];
  const unresolved: string[] = [];
  for (const key of unset) {
    const read = await resolveHermesConfigValue(key);
    if (read.state === "value" || read.state === "present") leftovers.push(key);
    else if (read.state === "unreadable") unresolved.push(key);
  }
  // HARNESS FIRST, and it is what keeps this proof from inventing a failure.
  // Our line reader is not the only reader of config.yaml: `hermes config get`
  // is Hermes' own, loading the file with PyYAML exactly as the gateway does,
  // and `localCatalogueState` above already trusts it for the shape question.
  // Asking it is the difference between "this file is not line-editable" and
  // "nobody can say whether the removal landed" — and answering the first as
  // the second is a 502 the owner can never clear, because the retry the banner
  // asks for reads the same file.
  //
  // One at a time, and only until the CLI stops answering. This branch is an
  // ordinary outcome rather than an exotic one — the whole reason the write
  // took the CLI is that the reader could not work with this file, so it can be
  // all six keys — and six `hermes` python interpreters started at once on a
  // Jetson is precisely the case where they all time out and a removal that
  // landed answers 502. A CLI that failed to ANSWER once will not answer for
  // the next key either: that is a fact about the shim, not about the key.
  //
  // Not asked at all once a leftover is on the record: "still registered" is
  // already certain, and every question here is a serial 15-second budget in
  // front of a click the owner is holding open.
  let cliAnswering = leftovers.length === 0;
  for (const key of unresolved) {
    const presence = cliAnswering ? await cliKeyPresence(key) : "unknown";
    if (presence === "present") leftovers.push(key);
    else if (presence === "unknown") {
      cliAnswering = false;
      unproven.push(key);
    }
  }
  if (leftovers.length > 0) {
    console.error("[hermes-local-ai] keys survived the removal:", leftovers.join(", "));
    throw new HermesLocalRemovalError("The local model is still registered with Hermes.", wasDefault);
  }
  if (unproven.length > 0) {
    console.error("[hermes-local-ai] removal could not be verified for:", unproven.join(", "));
    throw new HermesLocalRemovalError(
      "The Hermes config could not be read back, so the removal is unproven.",
      wasDefault,
    );
  }

  return { wasDefault, model };
}
