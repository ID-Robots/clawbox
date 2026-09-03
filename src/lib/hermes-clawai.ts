import { setMany } from "@/lib/config-store";
import { refreshCodingAgentToolsIfReadinessChanged } from "@/lib/coding-agent-mcp-refresh";
import { hermesAgentDrawsImages } from "@/lib/harness/hermes-features";
import { runHermesCli } from "@/lib/hermes-cli";
import { hermesCliAnswered } from "@/lib/hermes-cli-answered";
import { redactKey, safeHermesFailureMessage } from "@/lib/hermes-cli-message";
import { refreshHermesImageTools } from "@/lib/hermes-image-refresh";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { readUsableProviderIds, refreshProviderToolsIfSetChanged } from "@/lib/provider-mcp-refresh";
import { setHermesEnvValues } from "@/lib/hermes-env";
import {
  HERMES_IMAGE_PLUGIN_NAME,
  HERMES_IMAGE_TOKEN_ENV,
  installHermesImagePlugin,
  mergePluginsEnabled,
} from "@/lib/hermes-image-plugin";
import {
  CLAWBOX_AI_CHAT_MODEL_IDS,
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_IMAGE_MODEL_ID,
  CLAWBOX_AI_PRO_MODEL_ID,
  CLAWBOX_AI_VISION_MODEL_ID,
  type ClawboxAiTier,
} from "@/lib/clawbox-ai-models";
import { isClawboxAiVisionId, resolveVisionModelId } from "@/lib/clawbox-ai-vision";

// Applying ClawBox AI to a HERMES device, in one place.
//
// ClawBox AI is an OpenAI-compatible proxy, so it becomes a Hermes CUSTOM
// provider ("clawai") pointed at the proxy with the device token. Only the
// device-login that mints the token is ClawBox-specific; inference is
// Hermes-native (same base_url mechanism as any other provider). Verified
// on-device: this config yields a real ClawBox AI (deepseek) response.
//
// Shared by /setup-api/hermes/clawai (apply a stored token) and the device-login
// finaliser in /setup-api/ai-models/clawai/poll, so the two can't drift — before
// this, poll finalised exclusively through the OPENCLAW configure route, which
// writes ~/.openclaw/openclaw.json and restarts the OpenClaw gateway. On a
// Hermes SKU that runtime isn't installed, so the step threw BEFORE the token
// was persisted and the device-login CTA was a dead end.

export const CLAWAI_PROVIDER = "clawai";

// Trailing slashes are stripped because every consumer appends its own path
// segment (`/images/generations`, `/audio/transcriptions`, `/anthropic`); an
// override written as ".../api/ai/" would otherwise produce a double slash the
// proxy answers with a 404, which reads on the device as "images unavailable"
// rather than as a malformed base URL.
export const CLAWBOX_AI_PROXY_URL = (
  process.env.CLAWBOX_AI_PROXY_URL?.trim() || "https://clawbox.com/api/ai"
).replace(/\/+$/, "");

/** BARE model id (no `deepseek/` vendor prefix) — the proxy returns
 *  "HTTP 400: Model not allowed" for a prefixed slug. */
export function clawaiModelForTier(tier: ClawboxAiTier): string {
  return tier === "pro" ? CLAWBOX_AI_PRO_MODEL_ID : CLAWBOX_AI_FLASH_MODEL_ID;
}

export class ClawaiApplyError extends Error {}

/**
 * `getCodingAgentStatus().ready`, or null when the question could not be
 * answered.
 *
 * NULL IS LOAD-BEARING. Linking is not allowed to fail because a readiness probe
 * did — it stats a wrapper, looks for two binaries on PATH and lists the project
 * folders, and any of those can throw on a box with a half-installed harness or
 * an unreadable folder. This is a best-effort courtesy to the RUNNING agent laid
 * on top of writes that have already happened (or are about to), so an
 * unanswerable question means "do nothing", never "abandon the link".
 *
 * IMPORTED HERE, not at the top of the file. `coding-agent` owns the runs store
 * and reaches DATA_DIR while it is still being evaluated, and this module is
 * re-exported by `harness/credentials`, which every edition-agnostic credential
 * lookup pulls in. A static import would put that whole machinery in the graph
 * of routes that never link a box, for one boolean.
 */
async function codingAgentReady(): Promise<boolean | null> {
  return await import("@/lib/coding-agent")
    .then((mod) => mod.getCodingAgentStatus())
    .then((status) => status.ready)
    .catch(() => null);
}

/** @see applyClawaiToHermes */
export interface ApplyClawaiOptions {
  /**
   * What `getCodingAgentStatus().ready` said before the caller touched
   * anything, for a caller that wrote `clawai_token` ITSELF before calling.
   *
   * `ready` is `enabled` AND the harness installed AND ClawBox AI connected,
   * and that third fact IS the stored token — so a snapshot taken in here, after
   * such a caller has already written it, reads true no matter what the box
   * looked like a moment earlier. The guard then sees before === after and the
   * reload silently never happens. `/setup-api/hermes/clawai` persists a PASTED
   * token before it applies it and is the one caller that needs this; the two
   * others (the configure route and the device-code finaliser) write nothing
   * first, so they leave it unset and the snapshot below is honest.
   */
  codingAgentReadyBefore?: boolean;
}

/**
 * Point Hermes at ClawBox AI and persist the device state.
 *
 * @param token device token minted by the portal (never logged, never echoed)
 * @param tier  device tier — decides which bare deepseek id becomes model.default
 * @param options see `ApplyClawaiOptions`
 */
export async function applyClawaiToHermes(
  token: string,
  tier: ClawboxAiTier,
  options: ApplyClawaiOptions = {},
): Promise<{ provider: string; model: string; tier: ClawboxAiTier }> {
  const trimmed = token.trim();
  // A token that starts with "-" would be read by hermes as a flag. runHermesCli
  // never uses a shell, but argv position is still meaningful.
  if (!trimmed || trimmed.startsWith("-")) {
    throw new ClawaiApplyError("Sign in to ClawBox AI first to get a device token.");
  }
  const model = clawaiModelForTier(tier);

  // Read BEFORE anything is written, because the refresh at the bottom needs to
  // know whether this call is what turned drawing on. `hermesConfigGet` is keyed
  // on config.yaml's mtime, so on a box that has been asked this recently — the
  // chat asks it on every open — this costs nothing.
  const couldDrawBefore = await hermesAgentDrawsImages();
  // The SECOND family this call can move, and for the same reason: the ClawBox
  // MCP server decides whether `coding_agent_run`/`_status`/`_stop` exist at all
  // from one probe taken while it booted, and `ready` is `enabled` AND the
  // harness installed AND ClawBox AI connected. #514 taught the enable route to
  // notice when the SWITCH moved that verdict; connecting is the sibling write,
  // and it is the order the readiness text itself asks for ("ClawBox AI is not
  // connected. Open Settings → AI Models and sign in to ClawBox AI first.").
  const codingReadyBefore = options.codingAgentReadyBefore ?? (await codingAgentReady());
  // And the THIRD, which is the same fact from the picker's side: connecting
  // credentials the `clawai` provider, and the ClawBox MCP server turned the
  // provider list into `ai_set_provider`'s enum from one read taken while it
  // booted. Sampled here, ahead of every write below, for the same reason as
  // its two neighbours.
  const providersBefore = await readUsableProviderIds();

  const vision = await resolveVisionModelId({ token: trimmed });
  let visionModelId: string | null = vision.id;
  if (vision.reason === "probe-failed") {
    // The QUESTION failed — not a refusal. If the box already runs one of
    // OUR vision ids, keep it: a bad network moment must not downgrade a
    // box the proxy already upgraded. And when the current value cannot even
    // be READ (as opposed to being unset), write nothing at all — an
    // unreadable config is not an empty one.
    const current = await runHermesCli(["config", "get", "auxiliary.vision.model"], { timeoutMs: 15_000 });
    const listing = `${current.stdout ?? ""}\n${current.stderr ?? ""}`;
    if (current.code === 0) {
      const currentId = (current.stdout ?? "").trim();
      if (currentId && isClawboxAiVisionId(currentId)) visionModelId = currentId;
    } else if (!/config key not set/i.test(listing)) {
      visionModelId = null;
    }
  }
  console.log(`[Hermes ClawAI] Vision model ${visionModelId === null ? "left untouched (probe and read both failed)" : `resolved to ${visionModelId} (${vision.reason})`}`);

  const steps: string[][] = [
    ["config", "set", `providers.${CLAWAI_PROVIDER}.base_url`, CLAWBOX_AI_PROXY_URL],
    ["config", "set", `providers.${CLAWAI_PROVIDER}.api_key`, trimmed],
    ["config", "set", `providers.${CLAWAI_PROVIDER}.api_mode`, "openai"],
    // ── Telling Hermes what this provider serves ────────────────────────────
    //
    // Without this line the box's OWN pickers offer nothing: the Telegram /
    // Discord `/model` keyboard and the Hermes dashboard's Models page are both
    // built by `list_authenticated_providers` (hermes_cli/model_switch.py:2571,
    // Hermes 0.20.5), which reads a custom provider's model set out of THIS
    // block and then probes `<base_url>/models` for a live one.
    //
    // The probe cannot help us. `probe_api_models` (hermes_cli/models.py:5668)
    // reads the OpenAI envelope, `data[].id`; the ClawBox AI proxy answers
    // `200 {"status":"ok","service":"ClawBox AI Proxy","models":[…]}`. So Hermes
    // parses an EMPTY list, and an empty probe with nothing declared beside it
    // is what rendered as "clawai (0)" on the owner's phone while our own chat
    // header showed two models — the same box, two answers.
    //
    // A LIST, not the singular `model`/`default_model` key: only a list (or a
    // string) counts as an allowlist (`_models_config_is_allowlist`,
    // model_switch.py:136), and only an allowlist stops that empty probe from
    // replacing the declared ids (model_switch.py:3423-3431). It is a floor and
    // never a ceiling — a probe that DOES answer still wins, so the day the
    // proxy speaks the OpenAI envelope this stops mattering on its own.
    //
    // JSON is how `hermes config set` is told to store a list rather than a
    // string (hermes_cli/config.py:5515), the same way `plugins.enabled` is
    // written below.
    ["config", "set", `providers.${CLAWAI_PROVIDER}.models`, JSON.stringify(CLAWBOX_AI_CHAT_MODEL_IDS)],
    ["config", "set", "model.provider", CLAWAI_PROVIDER],
    ["config", "set", "model.default", model],
    // Clear any global custom-endpoint override a prior provider may have left,
    // so it doesn't shadow the clawai provider block.
    ["config", "unset", "model.base_url"],
    ["config", "unset", "model.api_key"],
    // ── Looking at a picture ────────────────────────────────────────────────
    //
    // Without these two, an attached image is quietly degraded to a text
    // description of itself. `agent/image_routing.py` runs in `auto` mode: it
    // attaches the image natively when the ACTIVE model reports
    // `supports_vision`, and otherwise routes it through `vision_analyze` using
    // whatever `auxiliary.vision` names. The chat model here is a bare DeepSeek
    // id, which is not vision-capable — so with `auxiliary.vision` unset there
    // is no second model to fall back to and the user gets an answer about an
    // image nobody looked at.
    //
    // Verified on the live box (2026-08-22): `hermes config get auxiliary`
    // reports the block exists with `vision: { provider: auto, model: '',
    // base_url: '', api_key: '', … }` — i.e. present in the schema and unset,
    // which is exactly the state that degrades a picture to a description.
    //
    // Only provider and model are written. `base_url` and `api_key` are left
    // empty ON PURPOSE so they inherit from the `providers.clawai` block set
    // above, for the same reason the two `unset` lines above exist: a spelled-out
    // endpoint shadows the provider block, and this one would shadow it with no
    // credential beside it. Naming the provider is what carries the URL and the
    // token together.
    //
    // This is the Hermes spelling of what `agents.defaults.imageModel` does on
    // the OpenClaw side — one capability, two harnesses, no second provider to
    // credential.
    // Resolved, not assumed: the DeepSeek vision model when the proxy serves
    // it, the previous one until then (src/lib/clawbox-ai-vision.ts) — and
    // written not at all when neither the proxy nor the config would answer.
    ...(visionModelId === null ? [] : [
      ["config", "set", "auxiliary.vision.provider", CLAWAI_PROVIDER],
      ["config", "set", "auxiliary.vision.model", visionModelId],
    ]),
    // ── Naming the session titler, for the same reason ──────────────────────
    //
    // `auxiliary.title_generation` ships as `provider: auto`, and auto is not a
    // guess about the configured provider — it is a SEARCH. Captured from a
    // box's own error log before it was linked:
    //
    //   Auxiliary title_generation: connection error on auto and no fallback
    //   available (tried: openrouter, nous, local/custom, api-key)
    //
    // Four credential-less providers tried in turn, each its own connection
    // attempt, on a box that had a perfectly good endpoint configured all along.
    // Naming clawai here is the same move as naming it for vision above: it
    // stops auto from wandering off to services this device has no account with.
    //
    // Measured honestly, this buys nothing on a HEALTHY box — the titler runs
    // on its own thread, concurrently with the turn's own request, and finishes
    // well inside it. What it removes is the unhealthy case, where that search
    // is four timeouts long and the retry ladder is the thing the customer is
    // waiting behind.
    //
    // The model is the chat model rather than a cheaper one for the same reason
    // `base_url` is left alone: the proxy serves a short allowlist, and naming
    // anything outside it turns every title into an HTTP 400.
    ["config", "set", "auxiliary.title_generation.provider", CLAWAI_PROVIDER],
    ["config", "set", "auxiliary.title_generation.model", model],
  ];

  for (const args of steps) {
    const r = await runHermesCli(args, { timeoutMs: 15_000 });
    // `unset` of an absent key is a no-op; only a failing `set` is fatal.
    if (r.code !== 0 && args[1] === "set") {
      // This message is rendered verbatim in the Settings save banner (the
      // configure route returns it as `{ error }`, and the clawai poll route
      // re-throws it unchanged), so the raw stream stops here: `hermes config
      // set` is a Python CLI and a crash prints /home/clawbox/.hermes at the
      // customer.
      //
      // The journal gets the diagnosis but NOT the credential, and that needs
      // saying twice because the token appears in two places at once. One of
      // these steps is `config set providers.clawai.api_key <device token>`, so
      // the KEY is logged and the value is not; and an argparse usage error
      // prints the argv it choked on, so the stream is redacted before either
      // the log or the parser sees it — the same order the `hermes auth add`
      // callers use.
      // Passed as ARGUMENTS rather than interpolated into the message: a
      // template built from argv is a tainted format string, and CodeQL is
      // right that a value flowing into the shape of a log line is a different
      // risk from one flowing into its data.
      console.error("[hermes/clawai] config write failed", args[1], args[2], r.code, redactKey(r.stderr, trimmed));
      throw new ClawaiApplyError(
        safeHermesFailureMessage(redactKey(r.stdout, trimmed), redactKey(r.stderr, trimmed))
          || "Failed to configure ClawBox AI",
      );
    }
  }

  // ── Making a picture ───────────────────────────────────────────────────────
  //
  // FAIL-SOFT, and it is the one part of this function that is. Everything
  // above decides whether the box can hold a conversation at all, so a failure
  // there has to stop the link and say so. Drawing is an extra: a box whose
  // image backend could not be installed still chats, still sees, still
  // transcribes — and `hermesAgentDrawsImages` reads the config this writes, so
  // the capability reports the failure honestly instead of the customer finding
  // it by asking for a picture.
  try {
    await enableHermesImageGeneration(trimmed);
  } catch (err) {
    // Name the failure, never the token that was being written with it.
    console.warn(
      "[hermes/clawai] could not enable image generation:",
      err instanceof Error ? err.message : "unknown error",
    );
  }

  // Keep the wizard's own status route consistent: without ai_model_configured
  // the setup flow can't advance past the AI step on a Hermes device.
  await setMany({
    clawai_token: trimmed,
    clawai_tier: tier,
    ai_model_configured: true,
    ai_model_provider: CLAWAI_PROVIDER,
    ai_model_configured_at: new Date().toISOString(),
  });

  // The device's provider/model just changed — don't serve the old selection.
  invalidateModelOptions();

  // Everything above wrote to DISK. The agent that will serve the next turn is
  // a process that has been running since long before any of it, and two of the
  // things just written — the credential in `~/.hermes/.env` and the backend in
  // `~/.hermes/plugins/` — are read once, at ITS startup. Without this the
  // owner links, the chat reports `canGenerateImages: true` off the config, and
  // the agent still has no `image_generate` to reach for. See
  // hermes-image-refresh.ts for the measurement that found it.
  //
  // AWAITED rather than left floating: this call can restart the very dashboard
  // the caller may talk to next, so it wants to be ordered rather than racing —
  // and a floating promise here would outlive the response with nothing
  // watching it. It cannot fail the link: the helper swallows everything and
  // returns void.
  //
  // The AFTER value is re-READ rather than assumed from the try/catch above, so
  // the refresh follows exactly the fact `/setup-api/chat/capabilities` serves
  // — including the case where a customer had already selected a backend of
  // their own by hand and our write failing changes nothing about what the box
  // can do. `hermesConfigGet` is keyed on config.yaml's mtime, which the writes
  // above just moved, so this sees the new value rather than a memo of the old.
  const respawnedMcpChildren = await refreshHermesImageTools(couldDrawBefore, await hermesAgentDrawsImages());

  // And the providers the agent may switch to, which the credential just written
  // added to the catalogue. ONE respawn across all three families: `reload.mcp`
  // kills and respawns every MCP child and invalidates the model's prompt cache,
  // and a link that moves three families is still one fact about one box — so if
  // the image reconcile above already reloaded (or bounced, which respawns the
  // children with the dashboard), this one reports rather than pays for a
  // second. Whichever family asks first pays; the rest report.
  const respawnedForProviders = await refreshProviderToolsIfSetChanged(
    providersBefore,
    await readUsableProviderIds(),
    { alreadyReloaded: respawnedMcpChildren },
  );

  // And the coding-agent family, which the token just written may have made
  // runnable — last in the chain, so it sees whether either neighbour already
  // paid for the respawn it needs.
  const codingReadyAfter = await codingAgentReady();
  if (codingReadyBefore !== null && codingReadyAfter !== null) {
    await refreshCodingAgentToolsIfReadinessChanged(
      codingReadyBefore,
      codingReadyAfter,
      { alreadyReloaded: respawnedMcpChildren || respawnedForProviders },
    );
  }

  return { provider: CLAWAI_PROVIDER, model, tier };
}

let clawaiModelsReconciled = false;

/**
 * Declare the ClawBox AI catalogue on a box that was linked before this code
 * existed — once per process, and a no-op on every other device.
 *
 * Every box already in the field has `providers.clawai` with a URL, a key and a
 * mode, and no `models:` at all, and nothing re-links it: the owner would keep
 * seeing "clawai (0)" in their bot for as long as the box stayed paired. Same
 * shape of repair, and the same reasoning, as `reconcileLocalAiWithHermes`.
 *
 * Deliberately narrower than a re-link: it writes ONE key and needs no token.
 *
 * THREE ANSWERS, NOT TWO. `hermes config get` exits non-zero both for a key
 * that is unset and for a config it could not read, and only the first is ours
 * to fill in — an unreadable config is not an empty one, so anything but the
 * "not set" wording leaves the file alone. And an existing value of ANY shape
 * is left alone too: it may be Hermes' own discovered catalogue, which is
 * richer than ours.
 *
 * THE LATCH IS FOR ANSWERS ONLY, and that is the whole difference between a
 * repair and a coin toss. `hermes` on the box is a shim over a venv Python, and
 * `step_hermes_install` moves the checkout aside and rebuilds it for about 90 s
 * with NO web-server restart afterwards (install.sh) — so during the very
 * update that ships this fix the shim runs and exits 127 without reaching
 * argparse. Latching on that would mean the box never declares its catalogue
 * for the life of the process and the owner's `/model` keeps saying
 * "clawai (0)" on the release that was meant to fix it. Every exit that is a
 * failed QUESTION or a failed WRITE unlatches, so the next request retries;
 * only the two real answers ("already declared", "written") stay latched.
 */
export async function reconcileClawaiModelsWithHermes(): Promise<void> {
  if (clawaiModelsReconciled) return;
  clawaiModelsReconciled = true;
  try {
    // The catalogue first, because on a settled box it is the answer: one
    // `hermes config get` (~0.6 s of process spawn) and we are done, rather than
    // two on every cold process for a repair that will never be needed again.
    const declared = await runHermesCli(
      ["config", "get", `providers.${CLAWAI_PROVIDER}.models`],
      { timeoutMs: 15_000 },
    );
    if (!hermesCliAnswered(declared)) return unlatch();
    if (declared.code === 0) return;
    const listing = `${declared.stdout ?? ""}\n${declared.stderr ?? ""}`;
    // A non-zero exit that is not "not set" is a config we could not read.
    // Nothing to unlatch for: the CLI answered, and its answer was "no".
    if (!/config key not set/i.test(listing)) return;

    // Only now ask whether there is a provider to describe. Not "is a token
    // stored" — the question is whether HERMES has the block, which is what its
    // pickers read. Without this a box that has never been linked would get a
    // `providers.clawai.models` with no endpoint beside it, which Hermes renders
    // as a picker row offering two models with nowhere to send them — the same
    // orphan the local provider's removal exists to avoid.
    const linked = await runHermesCli(
      ["config", "get", `providers.${CLAWAI_PROVIDER}.base_url`],
      { timeoutMs: 15_000 },
    );
    if (!hermesCliAnswered(linked)) return unlatch();
    if (linked.code !== 0 || !linked.stdout.trim()) return;

    const written = await runHermesCli(
      ["config", "set", `providers.${CLAWAI_PROVIDER}.models`, JSON.stringify(CLAWBOX_AI_CHAT_MODEL_IDS)],
      { timeoutMs: 15_000 },
    );
    if (written.code !== 0) {
      // A repair that could not be made is reported, never claimed: the picker
      // keeps showing what the box actually has, and the next request tries
      // again. No credential is in this argv — the value is a constant model
      // list — so the stream can be logged whole.
      console.warn(
        "[hermes/clawai] could not declare the ClawBox AI catalogue",
        written.code,
        written.stderr?.trim() || written.stdout?.trim() || "",
      );
      return unlatch();
    }
    // The catalogue this device serves just changed — don't serve the old one.
    //
    // NO MCP RELOAD HERE, deliberately, and the same reason `reconcileLocalAiWithHermes`
    // uses its INNER write: this hangs off `GET /setup-api/hermes/models`, which
    // is the route the agent's own `ai_list_models` reads, so a `reload.mcp`
    // would shut down the MCP child that is mid-tool-call. Nor does it move the
    // provider SET the enum is built from — the provider already existed; only
    // the models it lists changed — so there is nothing for
    // `refreshProviderToolsIfSetChanged` to notice. See provider-write-paths.test.ts.
    invalidateModelOptions();
  } catch (err) {
    console.error("[hermes/clawai] catalogue reconcile failed:", err);
    unlatch();
  }
}

/** Let the next request try the repair again. @see reconcileClawaiModelsWithHermes */
function unlatch(): void {
  clawaiModelsReconciled = false;
}

/** Test seam. */
export function _resetClawaiModelsReconcileForTests(): void {
  clawaiModelsReconciled = false;
}

/**
 * Point Hermes' own `image_generate` tool at ClawBox AI.
 *
 * Four writes, in the order a reader needs them:
 *
 *   1. the backend itself, copied into `~/.hermes/plugins/image_gen/clawai/`;
 *   2. its credential, under a name nothing else in Hermes reads — see
 *      `HERMES_IMAGE_TOKEN_ENV` for why that matters;
 *   3. `plugins.enabled`, MERGED with whatever is already there, because that
 *      list gates every user plugin on the box and not just ours;
 *   4. the model and the base URL, then LAST the selection — the key
 *      `image_gen_registry` resolves at tool time, and the one the capability
 *      probe reads, so it is only written once everything it depends on is.
 *
 * `base_url` is written explicitly rather than left to the plugin's default so
 * a staging box pointed at another proxy through `CLAWBOX_AI_PROXY_URL` gets
 * pictures from the same place it gets its answers.
 *
 * The MODEL is `gpt-image-1-mini` — the id the proxy serves on EVERY plan.
 * `gpt-image-2` is Max-only (`modelTiers` on the live endpoint), and this
 * function runs at link time, before anything here knows what the customer's
 * plan is, so naming it would turn every Free and Pro box's first drawing
 * request into a model-gate rejection.
 */
async function enableHermesImageGeneration(token: string): Promise<void> {
  await installHermesImagePlugin();
  await setHermesEnvValues({ [HERMES_IMAGE_TOKEN_ENV]: token });

  // Read-modify-write, and the read has to be the RAW list: `hermes config set`
  // replaces the value whole.
  //
  // AN UNSET KEY IS NOT A FAILED READ. `hermes config get` exits non-zero for
  // both, and the two want opposite answers: a box that has never enabled a
  // plugin wants the list initialised with ours, while a read that failed for
  // any other reason (a locked config, a timeout) knows NOTHING about what is
  // in that list — treating it as empty would write `["clawai"]` over the
  // customer's own enabled plugins and silently unload every one of them. So
  // only the "not set" wording proceeds; anything else stops here, and the
  // capability probe reports a box that cannot draw through its agent, which
  // is the truth.
  const current = await runHermesCli(["config", "get", "plugins.enabled"], { timeoutMs: 15_000 });
  const listing = `${current.stdout ?? ""}\n${current.stderr ?? ""}`;
  if (current.code !== 0 && !/config key not set/i.test(listing)) {
    throw new Error(current.stderr?.trim() || "hermes config get plugins.enabled failed");
  }
  const merged = mergePluginsEnabled(current.code === 0 ? current.stdout : "");
  // `image_gen.provider` LAST, because it is the key `hermesAgentDrawsImages`
  // reads and therefore the key that turns the agent's picture ability on. A
  // provider written first and then a failed `base_url` would leave a box
  // claiming it can draw through a backend that has nowhere to send the
  // request; written last, a failure anywhere above means the claim was never
  // made and the composer button stays.
  const steps: string[][] = [
    ...(merged ? [["config", "set", "plugins.enabled", JSON.stringify(merged)]] : []),
    ["config", "set", "image_gen.model", CLAWBOX_AI_IMAGE_MODEL_ID],
    ["config", "set", `image_gen.${HERMES_IMAGE_PLUGIN_NAME}.model`, CLAWBOX_AI_IMAGE_MODEL_ID],
    ["config", "set", `image_gen.${HERMES_IMAGE_PLUGIN_NAME}.base_url`, CLAWBOX_AI_PROXY_URL],
    ["config", "set", "image_gen.provider", HERMES_IMAGE_PLUGIN_NAME],
  ];
  for (const args of steps) {
    const r = await runHermesCli(args, { timeoutMs: 15_000 });
    if (r.code !== 0) {
      // Thrown, not swallowed: the caller logs it and the link still succeeds.
      // Half-written image config is exactly what the capability probe is for.
      throw new Error(r.stderr?.trim() || `hermes ${args.join(" ")} failed`);
    }
  }
}
