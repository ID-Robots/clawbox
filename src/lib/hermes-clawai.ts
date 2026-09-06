import { setMany } from "@/lib/config-store";
import { refreshCodingAgentToolsIfReadinessChanged } from "@/lib/coding-agent-mcp-refresh";
import { hermesAgentDrawsImages } from "@/lib/harness/hermes-features";
import { runHermesCli, type HermesCliResult } from "@/lib/hermes-cli";
import { hermesCliAnswered, hermesStoredValueAsText } from "@/lib/hermes-cli-answered";
import { redactKey, safeHermesFailureMessage } from "@/lib/hermes-cli-message";
import { refreshHermesImageTools } from "@/lib/hermes-image-refresh";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { readUsableProviderIds, refreshProviderToolsIfSetChanged } from "@/lib/provider-mcp-refresh";
import { setHermesEnvValues } from "@/lib/hermes-env";
import {
  HERMES_IMAGE_PLUGIN_KEY,
  HERMES_IMAGE_PLUGIN_NAME,
  HERMES_IMAGE_TOKEN_ENV,
  installHermesImagePlugin,
  mergePluginsEnabled,
  decodePluginsEnabledJson,
  decodePluginsEnabledPlain,
  type PluginsEnabledState,
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
import { forgetProviderVerified } from "@/lib/provider-verified";
import { forgetClawaiCredentialRefusal } from "@/lib/harness/credentials";

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
  // BEFORE the first write. The token is about to change — an account switch, a
  // re-pair, a rotated device token — and the step loop below can throw after
  // `providers.clawai.api_key` has already landed, which would leave the new
  // token on disk beside a mark asserting the old one worked. A mark lost to a
  // failed apply is always safe. See src/lib/provider-verified.ts.
  await forgetProviderVerified(CLAWAI_PROVIDER);
  // And the other mark ABOUT this credential, for the same reason and at the
  // same moment: a refusal the proxy gave the OLD token says nothing about the
  // new one, and leaving it would make the picture button and the microphone
  // stay away from a device that was just re-linked to fix exactly that.
  forgetClawaiCredentialRefusal();

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
    // The probe cannot help us. `probe_api_models` (hermes_cli/models.py:5592)
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
  // One of those steps was `providers.clawai.models`, and an exit 0 does not
  // say it landed as a LIST — the same silent stored-as-text this file's repair
  // exists for, reached through the path EVERY fresh box takes.
  //
  // Not verified here, and never thrown over: a box whose catalogue went in as
  // text still chats, still sees, still draws, so failing the link over it
  // would be a false failure on a working device. The repair does that job, and
  // this hands it back — with no backoff, because nothing failed here — so the
  // very next models read re-examines the key. That hand-back is load-bearing
  // on its own: an unlinked box has usually already run the repair and latched
  // its silent "no providers.clawai", so without it the value the link just
  // wrote is not looked at again until the web server restarts.
  handClawaiRepairBack();

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

  // A box with no on-device engine now has a voice, so give it one.
  //
  // install.sh registers `tts.providers.clawbox-local` on every Hermes box and
  // SELECTS it whatever the engine did — deliberately, because to Hermes an
  // unset `tts.provider` is its factory Edge cloud rather than silence
  // (`tools/tts_tool.py`, measured on the box), so a board that declines Kokoro
  // is kept on a command provider that fails loudly instead of being handed to
  // Microsoft. The cloud voice is the other half of that decision and it could
  // not be made there: it needs this credential, and the link happens after the
  // install. So it is made here, where the token is.
  //
  // Never over an owner's own pick — only where nothing has been chosen, where
  // Hermes' factory `edge` cloud is still selected, or where the on-device
  // provider is selected with no engine behind it, which is the state the
  // measured box was left in.
  await selectHermesCloudVoiceIfUnvoiced(trimmed, tier);

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
let clawaiRetryAfter = 0;
let clawaiUnverifiedWrites = 0;

/**
 * How long a repair whose QUESTION failed waits before another request retries.
 *
 * Unlatching on a failure is right — an update must not be able to skip the
 * repair for the life of the process — but on its own it removes the only
 * bound on what that failure costs. `GET /setup-api/hermes/models` awaits both
 * repairs BEFORE it serves anything, each CLI read carries a 15 s timeout, and
 * that route is what the chat header, the Settings panel and the agent's own
 * `ai_list_models` all read: a box whose `hermes` is wedged — a filelock held
 * by an interactive CLI, a half-built venv — would pay it on every request
 * instead of once per process. Same number and the same reasoning as
 * `FAILED_READ_TTL_MS` in hermes-config-cache.ts, which exists so that a
 * hanging `hermes` cannot become one Python start per request.
 *
 * IT BOUNDS THE RATE, NOT THE TOTAL — see `REPAIR_MAX_UNVERIFIED_WRITES`.
 */
const REPAIR_RETRY_MS = 60_000;

/**
 * How many writes this process may issue that it cannot read back.
 *
 * A RATE IS NOT A BOUND WHEN THE FAULT IS PERMANENT. `hermes config set` exits
 * 0 for reasons that have nothing to do with the key landing — a config.yaml
 * the web-server user cannot write, a full partition, a `save_config` that
 * loses a filelock race, a refusal that still exits 0 — and a key that never
 * landed reads back exactly like one that was never written: measured on the
 * box, `hermes config get providers.clawai.models --json` exits 1 with
 * `Config key not set: providers.clawai.models`. So the deciding read answers
 * "write" again, and with only `REPAIR_RETRY_MS` in the way that is one
 * customer config.yaml rewrite plus three Python starts every 60 s for the life
 * of the web server — on `GET /setup-api/hermes/models`, which AWAITS this
 * repair before it serves the chat header, the Settings panel or the agent's
 * own `ai_list_models`.
 *
 * Three, because a repair that has issued three writes nobody could read back
 * has proved as much as one whose literal came back as text.
 *
 * IT COUNTS WRITES, NOT FAILED QUESTIONS, which is what keeps it away from the
 * case the unlatch exists for: a `step_hermes_install` rebuild exits 127 before
 * reaching argparse, the deciding read answers "retry", NO write is issued and
 * no attempt is spent — so a 90 s rebuild still costs nothing but the rate
 * bound, however many requests arrive during it.
 *
 * The counter clears on a write that LANDS, and otherwise only on a restart:
 * the journal says once that this box stopped trying, and the next process
 * start tries again because the deciding read still finds the key missing.
 */
const REPAIR_MAX_UNVERIFIED_WRITES = 3;

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
 * THE LATCH IS FOR ANSWERS ONLY, and that is the whole difference between a
 * repair and a coin toss. `hermes` on the box is a shim over a venv Python, and
 * `step_hermes_install` moves the checkout aside and rebuilds it for about 90 s
 * with NO web-server restart afterwards (install.sh) — so during the very
 * update that ships this fix the shim runs and exits 127 without reaching
 * argparse. Latching on that would mean the box never declares its catalogue
 * for the life of the process and the owner's `/model` keeps saying
 * "clawai (0)" on the release that was meant to fix it.
 *
 * So a failed QUESTION unlatches and is asked again on a later request, no
 * sooner than `REPAIR_RETRY_MS`: no write was issued, and a rebuild that exits
 * 127 costs one Python start a minute until it finishes.
 *
 * A WRITE THIS PROCESS COULD NOT READ BACK unlatches too — and carries a SECOND
 * bound, because a rate alone bounds nothing that is permanent. `config set`
 * exits 0 for reasons that have nothing to do with the key landing, and a key
 * that never landed reads back exactly like an absent one, so the deciding read
 * answers "write" again on every pass. `REPAIR_MAX_UNVERIFIED_WRITES` is what
 * makes that end: three writes nobody could read back, and then this process
 * stops rewriting the customer's config.yaml and says so once.
 *
 * The two real answers ("nothing to do", "written") stay latched, and so does
 * the one failed write this module can PROVE is final: a literal handed back as
 * text will be handed back as text every 60 s for the life of the process.
 *
 * EVERY EXIT SAYS SOMETHING. A silent `return` on the one path the field will
 * actually reach is how a box ends up wrong with nothing in its journal, so
 * each verdict that is not "this box is already correct" carries a line.
 */
export async function reconcileClawaiModelsWithHermes(): Promise<void> {
  if (clawaiModelsReconciled || Date.now() < clawaiRetryAfter) return;
  clawaiModelsReconciled = true;
  try {
    const verdict = await clawaiCatalogueVerdict();
    if (verdict.action === "retry") {
      console.warn(`[hermes/clawai] catalogue repair deferred — ${verdict.reason}`);
      return unlatch();
    }
    if (verdict.action === "leave") {
      if (verdict.reason) console.log(`[hermes/clawai] catalogue left alone — ${verdict.reason}`);
      return;
    }
    if (verdict.overwriting) {
      // Logged where the write happens, not where the shape was read: a line
      // claiming an overwrite that never ran is the false-success shape this
      // module keeps being audited for. These are the states in which the file
      // and the symptom disagree — a populated `models:` and "clawai (0)" or one
      // bogus entry on the owner's phone — so each is worth naming.
      console.warn(
        `[hermes/clawai] providers.${CLAWAI_PROVIDER}.models holds ${verdict.overwriting}`
        + " — declaring the ClawBox AI catalogue over it",
      );
    }
    const written = await runHermesCli(
      ["config", "set", `providers.${CLAWAI_PROVIDER}.models`, JSON.stringify(CLAWBOX_AI_CHAT_MODEL_IDS)],
      { timeoutMs: 15_000 },
    );
    // AN EXIT CODE IS NOT AN OUTCOME. `hermes config set k '["a","b"]'` exits 0
    // even when its structured parse did not yield a list: it prints
    // "…storing as string." to stderr and saves the literal text
    // (hermes_cli/config.py:5518-5530). Hermes then reads that string as a
    // ONE-ID allowlist, so the keyboard would offer a single bogus model and
    // this repair would have latched "done" over it. Not reachable on the build
    // `HERMES_PIN_COMMIT` installs — the coercion chain there yields a real
    // list — which is exactly why it is worth a guard rather than a comment.
    const storedAsText = hermesStoredValueAsText(written);
    // AND NEITHER IS A CLEAN STDERR. That warning only exists on a CLI whose
    // coercion block prints it, so it cannot speak for one old enough to lack
    // the block — where the same literal is stored as text with an EMPTY stderr
    // and exit 0. The narrow band where that happens is a box moved off
    // `HERMES_PIN_COMMIT` by a hand-run `hermes update` onto a CLI that still
    // takes `--json` on `config get` (or the verdict read would have answered
    // "retry") and no longer coerces on `config set`. The guard is worth having
    // for a wider reason than that band, though: an exit code is not an outcome
    // for ANY reason a write may fail to land, and this repair runs unattended
    // on every field box.
    const outcome: ClawaiWriteOutcome = written.code !== 0
      ? { kind: "unverified", why: `the write exited ${written.code}` }
      : storedAsText
        ? { kind: "stored-as-text" }
        : await verifyClawaiCatalogue();
    if (outcome.kind !== "landed") {
      // A repair that could not be made is reported, never claimed: the picker
      // keeps showing what the box actually has. No credential is in this argv
      // — the value is a constant model list — so the stream can be logged
      // whole.
      console.warn(
        "[hermes/clawai] could not declare the ClawBox AI catalogue",
        outcome.kind === "stored-as-text"
          ? "(this hermes stores a list as text — the same write cannot land, so it is not retried before the next restart)"
          : `(${outcome.why})`,
        written.stderr?.trim() || written.stdout?.trim() || "",
      );
      // A FAILURE WE HAVE PROVED IS FINAL DOES NOT GET A RETRY. `unlatch()` is
      // for a repair that might work on a later request — a locked config, a
      // wedged CLI. A CLI that parsed our constant literal and did not get a
      // list will parse it the same way every 60 s for the life of this
      // process, and each attempt re-serialises the customer's config.yaml
      // through `save_config` for nothing. So that one answer stays latched:
      // the journal says why, the next process start tries once more (the
      // residue is still in the file, and the verdict read finds it), and a
      // hand-run `hermes update` to a CLI that can store a list is picked up on
      // the restart that follows it.
      if (outcome.kind !== "unverified") return;
      // A WRITE THAT NEVER REACHED ARGPARSE IS NOT AN ATTEMPT. 126 and 127 are
      // the SHELL's codes (see `hermesCliAnswered`): the `hermes` shim ran
      // while `step_hermes_install` was rebuilding the venv under it, so
      // nothing was parsed, nothing was written and no config.yaml was
      // re-serialised. That is a failed QUESTION wearing a write's clothes, and
      // spending one of three attempts on it would burn the budget on exactly
      // the transient the unlatch exists for.
      if (!hermesCliAnswered(written)) return unlatch();
      // AND A FAILURE WE CANNOT PROVE EITHER WAY GETS A FEW, NOT AN ENDLESS
      // SUPPLY. `unverified` is the honest verdict for a question that did not
      // answer — but it is also what a `config set` that exits 0 without
      // landing produces on EVERY pass, and that fault is a property of the
      // box, not a moment. Counting those writes is what turns "retry, rate
      // limited" into a repair that ends: three attempts, then this process
      // stops rewriting config.yaml and says so once.
      clawaiUnverifiedWrites += 1;
      if (clawaiUnverifiedWrites < REPAIR_MAX_UNVERIFIED_WRITES) return unlatch();
      console.warn(
        `[hermes/clawai] giving up on the ClawBox AI catalogue after ${clawaiUnverifiedWrites}`
        + " writes that could not be read back — not retried before the next restart",
      );
      return;
    }
    // The write landed, so nothing is owed to the bound above any more: a later
    // hand-back (a re-link) starts from a clean count.
    clawaiUnverifiedWrites = 0;
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

/**
 * What a write to `providers.clawai.models` turned out to be.
 *
 *   landed         — the key reads back as exactly the ids we sent.
 *   stored-as-text — the CLI handed our own literal back as a STRING. Proof
 *                    that this build cannot store a list, and therefore that
 *                    re-issuing the identical write is futile.
 *   unverified     — the question failed, or answered something else. Says
 *                    nothing about the write either way, so the caller retries
 *                    — on the ordinary cadence, and only until
 *                    `REPAIR_MAX_UNVERIFIED_WRITES` of them have gone by.
 *
 * `why` IS THE HALF THE JOURNAL USED TO LOSE. "It did not read back as the list
 * we wrote" is a DEFINITE claim, and this outcome is the one that knows least:
 * a 15 s timeout, a SIGKILL, a decorated stdout and a genuine "key absent" all
 * arrive here. So each carries the read's own exit code and first stderr line —
 * and NEVER the value, which is why the leaf is read rather than the block.
 */
type ClawaiWriteOutcome =
  | { kind: "landed" }
  | { kind: "stored-as-text" }
  | { kind: "unverified"; why: string };

/**
 * Did the catalogue we just wrote actually land as a LIST?
 *
 * `hermes config set` has no typed mode — `set_config_value(key, value: str,
 * force=False)` (hermes_cli/config.py:5383) is the only entry point, and a JSON
 * literal through its `_looks_structured_value` coercion is the harness's own
 * way of storing a list. What the harness offers for the other half is
 * `hermes config get <key> --json` (config.py:5769), which prints
 * `json.dumps(value)`; that is the whole verification, so nothing here reaches
 * into Hermes' store. (The OpenClaw half of this repo gets a typed
 * `config set … --json` instead — see the PR body; the asymmetry is Hermes',
 * not ours.)
 *
 * `force` IS NOT PASSED, DELIBERATELY. What that parameter gates has not been
 * read on the build `HERMES_PIN_COMMIT` installs, and nothing here depends on
 * knowing: if it does gate replacing an existing node, a refusal that still
 * exits 0 is precisely the false success this read-back catches — reported with
 * its cause and bounded by `REPAIR_MAX_UNVERIFIED_WRITES` rather than retried
 * forever. Sending a flag whose effect we have not read on the build we ship
 * would be the guess this function exists to remove.
 *
 * THE LEAF, NOT THE BLOCK, and not only for the smaller parse: the entry this
 * repair read to decide carries `api_key`, and this key cannot. A verification
 * that need never hold a credential should not be given one — which is also
 * what makes the read's stderr safe to put in the journal.
 *
 * IT NEVER THROWS. `runHermesCli` rejects on a spawn failure or a timeout, and
 * an unanswerable verification is not the repair failing — letting it reach the
 * caller's `catch` would log "catalogue reconcile failed" over a write that
 * landed.
 */
async function verifyClawaiCatalogue(): Promise<ClawaiWriteOutcome> {
  const declared = JSON.stringify(CLAWBOX_AI_CHAT_MODEL_IDS);
  let read: HermesCliResult;
  try {
    read = await runHermesCli(
      ["config", "get", `providers.${CLAWAI_PROVIDER}.models`, "--json"],
      { timeoutMs: 15_000 },
    );
  } catch (err) {
    // Every rejection `runHermesCli` produces is one of its own fixed sentences
    // — "hermes timed out", a `spawnFailureMessage` — so none of them can carry
    // a value out of the store.
    return unverified(err instanceof Error ? err.message : "the read-back could not be run");
  }
  // 126, 127 and a signal's `null` are all covered by this one test, so
  // `hermesCliAnswered` would add nothing here: what separates them is the
  // number in the journal line, not a second branch.
  if (read.code !== 0) return unverified(`read exit ${read.code}${stderrCause(read.stderr)}`);
  let value: unknown;
  try {
    value = JSON.parse(read.stdout);
  } catch {
    // Our own words, never the `SyntaxError` — it quotes a prefix of its input.
    return unverified("the read-back was not JSON");
  }
  if (
    Array.isArray(value)
    && value.length === CLAWBOX_AI_CHAT_MODEL_IDS.length
    && value.every((id, i) => id === CLAWBOX_AI_CHAT_MODEL_IDS[i])
  ) {
    return { kind: "landed" };
  }
  return value === declared ? { kind: "stored-as-text" } : unverified("the key holds something else");
}

/** An outcome that says nothing about the write, and why it could not say more. */
function unverified(why: string): ClawaiWriteOutcome {
  return { kind: "unverified", why: `could not be verified — ${why}` };
}

/** The CLI's first stderr line, for the journal: capped, and never a value —
 *  the key this read names holds model ids, and the block that holds `api_key`
 *  is deliberately not the one read here. */
function stderrCause(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/, 1)[0]?.slice(0, 200);
  return line ? `: ${line}` : "";
}

/** Let a later request try the repair again, no sooner than `REPAIR_RETRY_MS`
 *  and no more often in total than `REPAIR_MAX_UNVERIFIED_WRITES`.
 *  @see reconcileClawaiModelsWithHermes */
function unlatch(): void {
  clawaiModelsReconciled = false;
  clawaiRetryAfter = Date.now() + REPAIR_RETRY_MS;
}

/** Something OTHER than the repair may have moved `providers.clawai.models`:
 *  let the very next read look at it, with no backoff. Nothing failed, so there
 *  is nothing to back off from — and this runs on an explicit customer action
 *  (a link) rather than on every request, so it cannot become a spawn per
 *  request the way an unbounded retry could. Same lever, and the same
 *  reasoning, as `handRepairBack` in hermes-local-ai.ts. */
function handClawaiRepairBack(): void {
  clawaiModelsReconciled = false;
  clawaiRetryAfter = 0;
}

/**
 * What to do about `providers.clawai.models`, decided from the WHOLE entry.
 *
 *   "write"  — declare our catalogue. `overwriting` names what was already
 *              there, when something was, because a repair that replaces a
 *              populated key is worth a line in the journal saying which fault
 *              it found.
 *   "leave"  — this box is not ours to change. A `reason` is logged; the two
 *              ordinary cases (already declared, never linked) carry none,
 *              because every box on the fleet would print them once a boot.
 *   "retry"  — the question failed. Never an answer, always logged, and the
 *              caller unlatches so a later request asks again.
 *
 * THE WHOLE ENTRY, NOT THE `models` LEAF, and that is the difference between a
 * repair and vandalism. Hermes decides what `models:` MEANS from two of its
 * siblings:
 *
 *   - `discover_models: false` is its documented way to pin a catalogue of any
 *     shape — "discover_models: false is the documented way to pin, and it is
 *     honored above" (model_switch.py:3777), read on the installed build. With
 *     discovery off no probe runs, so even a mapping is exactly what the
 *     keyboard shows: that owner has NO symptom, and overwriting their pin with
 *     our flat two-id list would destroy per-model metadata to fix nothing.
 *   - `models_discovered: true` marks a catalogue Hermes persisted for itself,
 *     which `_models_config_is_allowlist` refuses WHATEVER the shape (:136). Our
 *     list would be refused with it, so writing there would latch "repaired"
 *     over a keyboard still saying "clawai (0)" — a false success. That refusal
 *     only bites where a probe can replace what it refused, so the flag is read
 *     TOGETHER with `discover_models`: with discovery off nothing replaces
 *     anything and the box is repairable after all.
 *
 * One read answers all of that, and carries the `base_url` the orphan guard
 * needs, so it also replaces the second CLI spawn this repair used to make.
 *
 * `--json` IS LOAD-BEARING. Plain `hermes config get` renders a block through
 * `yaml.safe_dump` (`_format_config_get_value`, hermes_cli/config.py:1203) and a
 * bare string through `str()`, so the shapes this function exists to tell apart
 * arrive as text only a YAML reader could separate. `--json` is the CLI's own
 * machine-readable mode for exactly this (`hermes config get <key> [--json]`,
 * config.py:5769) and prints `json.dumps(value)`; verified against the build
 * `HERMES_PIN_COMMIT` installs, which `step_hermes_install` brings every box to.
 * A box moved off that pin by a hand-run `hermes update` could meet a CLI that
 * rejects the flag: that answers "retry", which is logged and rate-limited by
 * `REPAIR_RETRY_MS` rather than repeated per request.
 *
 * THE STDOUT OF THIS READ IS A CREDENTIAL. The entry carries `api_key`, so no
 * branch below logs `stdout` — only exit codes and our own words.
 */
type ClawaiVerdict =
  | { action: "write"; overwriting?: string }
  | { action: "leave"; reason: string }
  | { action: "retry"; reason: string };

async function clawaiCatalogueVerdict(): Promise<ClawaiVerdict> {
  const read = await runHermesCli(
    ["config", "get", `providers.${CLAWAI_PROVIDER}`, "--json"],
    { timeoutMs: 15_000 },
  );
  if (!hermesCliAnswered(read)) {
    return { action: "retry", reason: `the CLI never answered (exit ${read.code})` };
  }
  if (read.code !== 0) {
    // No `providers.clawai` at all: a box that has never been linked. A real
    // answer, and there is nothing to describe — writing `models` beside no
    // endpoint would give Hermes a picker row offering two models with nowhere
    // to send them, the same orphan the local provider's removal exists to
    // avoid. Anything else is a config we could not read.
    if (/config key not set/i.test(`${read.stdout ?? ""}\n${read.stderr ?? ""}`)) {
      return { action: "leave", reason: "" };
    }
    return { action: "retry", reason: `the provider block could not be read (exit ${read.code})` };
  }

  let entry: unknown;
  try {
    // THIS CATCH IS LOAD-BEARING FOR A SECOND REASON. `JSON.parse` throws a
    // `SyntaxError` whose message QUOTES A PREFIX OF ITS INPUT, and this input
    // is the whole `providers.clawai` block — `api_key` and all. Letting it
    // reach the caller's `catch (err)` would print that prefix through
    // `console.error("[hermes/clawai] catalogue reconcile failed:", err)`. The
    // reason below is our own words; nothing derived from the error is logged.
    entry = JSON.parse(read.stdout);
  } catch {
    return { action: "retry", reason: "the CLI printed a value this build could not parse" };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { action: "retry", reason: "providers.clawai is not a block" };
  }
  const row = entry as Record<string, unknown>;

  if (!(typeof row.base_url === "string" && row.base_url.trim())) {
    // `models:` beside no endpoint is a picker row offering models with nowhere
    // to send them — the orphan the local provider's removal exists to avoid —
    // so this is still "leave". But a block that exists with no `base_url` is
    // an INVALID state, not an ordinary one, and the two verdicts that stay
    // silent are silent because every box on the fleet is in them. The line
    // names the provider and nothing else: the block it came from carries
    // `api_key`.
    return { action: "leave", reason: `providers.${CLAWAI_PROVIDER} carries no endpoint` };
  }
  // FIRST, because it beats every other reading of `models:` — WHEREVER A PROBE
  // CAN ACT ON IT. `models_discovered: true` makes `_models_config_is_allowlist`
  // return False whatever the shape (:136), so with discovery on the empty probe
  // replaces our list and a write here would latch "repaired" over a keyboard
  // still saying "clawai (0)".
  //
  // With `discover_models: false` beside it that reading means nothing:
  // `_discovery_allowed` gates the probe (:3788) and `grp["models"] =
  // live_models` never runs (:3823), so nothing replaces anything and the row is
  // exactly what `_declared_model_ids` finds. An entry carrying both flags and
  // no readable `models:` is EMPTY — the same "clawai (0)" — and the ids we
  // declare there are permanent, because no probe can come back to undo them.
  // Declining it would strand a box one write fixes for good.
  //
  // THE FLAG IS DECLARED BESIDE, NOT CLEARED, and that is a known limit rather
  // than an oversight: an owner who later turns discovery back on puts that box
  // into the state above, where the empty probe wins and this branch declines
  // it. Clearing the flag would mean a second write to verify on a state only a
  // contradictory pair of hand-edits produces — Hermes writes neither key into
  // `providers:` (it persists its own catalogues under `custom_providers`).
  if (hermesOwnsCatalogue(row) && hermesDiscoversModels(row)) {
    return { action: "leave", reason: "Hermes persisted this catalogue itself (models_discovered)" };
  }
  // A LIST STORED AS TEXT IS NOT A CATALOGUE — and it is the one broken shape
  // Hermes reads as a perfectly good one. Ran on the installed 0.20.5 over the
  // string `["deepseek-v4-flash","deepseek-v4-pro"]`: `_declared_model_ids`
  // (:61) yields ONE id, the whole literal, and `_models_config_is_allowlist`
  // (:136) says True. So the keyboard offers a single unusable entry and BOTH
  // "already declared" branches below walk away from it.
  //
  // This is the residue of the failed write the guard in
  // `reconcileClawaiModelsWithHermes` catches: `hermes config set` saves the
  // literal text and exits 0, so the value is in the file before that guard
  // ever sees the warning, and on a CLI old enough to lack the coercion block
  // there is no warning to see. Unlatching without this check re-reads the
  // string we just wrote and calls it declared — the guard would defeat itself.
  if (typeof row.models === "string" && looksLikeStructuredText(row.models)) {
    return { action: "write", overwriting: "a list Hermes stored as text" };
  }
  // A PIN THAT PINS NOTHING IS NOT A PIN. `discover_models: false` only protects
  // something if there is something to protect: with discovery off Hermes runs
  // no probe (`_discovery_allowed`, model_switch.py:3788) and shows exactly the
  // ids `_declared_model_ids` finds, so the flag beside an absent or empty
  // `models:` leaves the row EMPTY — the "clawai (0)" this repair exists to
  // fix, reached down the one path that used to walk away calling it a pin.
  // `_declared_model_ids` is the right question here rather than the allowlist
  // one, because with discovery off even a mapping's keys are shown.
  if (!hermesDiscoversModels(row) && hermesDeclaresAnyId(row.models)) {
    return { action: "leave", reason: "the catalogue is pinned with discover_models: false" };
  }
  if (row.models === undefined) return { action: "write" };
  return isHermesAllowlist(row.models)
    ? { action: "leave", reason: "" }
    : { action: "write", overwriting: "a value Hermes does not read as an allowlist" };
}

/**
 * Does this text plausibly encode a YAML/JSON list or mapping?
 * `_looks_structured_value`, hermes_cli/config.py:5322 — the CLI's OWN test for
 * "this argument is a structure, not a scalar", and the one that decides
 * whether `config set` attempts a `yaml.safe_load` at all. Borrowing it here
 * rather than inventing a rule keeps the two ends of the same write agreeing:
 * every value the CLI meant to store as a list, and failed to, answers true.
 *
 * ONLY THE FLOW-STYLE TRIGGER IS MODELLED, deliberately. The Python also fires
 * on multi-line block style (`- item` / `key: value` lines), which cannot be
 * residue here: this module writes `JSON.stringify(ids)` and nothing else, and a
 * hand-edited block in config.yaml is loaded by PyYAML as a real list long
 * before any of this runs. The conservatism is the point either way — a model
 * id is a scalar, so `deepseek-v4-flash` and even `-5` stay pins.
 */
function looksLikeStructuredText(value: string): boolean {
  const stripped = value.replace(/^\s+/, "");
  return stripped.startsWith("[") || stripped.startsWith("{");
}

/**
 * Will Hermes probe `<base_url>/models` for this entry? `discover_models`,
 * model_switch.py:3371 — absent means yes, and the string spellings "false",
 * "no" and "0" mean no, exactly as the Python coerces them.
 */
function hermesDiscoversModels(row: Record<string, unknown>): boolean {
  const flag = row.discover_models;
  if (flag === undefined) return true;
  // `discover.lower() not in {"false","no","0"}` — NO trim, deliberately. A
  // quoted " false " is discovery ON to Hermes, so the empty probe wipes the
  // block and the repair IS needed; trimming here would have ClawBox decline to
  // touch a box Hermes is about to empty.
  if (typeof flag === "string") return !["false", "no", "0"].includes(flag.toLowerCase());
  return Boolean(flag);
}

/**
 * Does this `models:` yield any id at all? `_declared_model_ids`,
 * model_switch.py:61 — a non-empty string, any list entry that resolves to an
 * id, or a mapping's keys, skipping the two sentinel keys Hermes writes for
 * itself.
 *
 * Deliberately WIDER than `isHermesAllowlist`: a mapping is not an allowlist,
 * but its keys are still what a pinned (discovery-off) row displays, and the
 * only question here is whether anything would be shown.
 */
function hermesDeclaresAnyId(value: unknown): boolean {
  if (isHermesAllowlist(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).some(
    (key) => key !== "__explicit_model_allowlist__" && key !== "__discovered_model_catalog__",
  );
}

/**
 * `_entry_models_discovered` — model_switch.py:116. The current entry-level
 * `models_discovered: true`, or the in-mapping sentinel older builds wrote and
 * this one still accepts on read.
 */
function hermesOwnsCatalogue(row: Record<string, unknown>): boolean {
  if (row.models_discovered === true) return true;
  const models = row.models;
  return Boolean(
    models
    && typeof models === "object"
    && !Array.isArray(models)
    && (models as Record<string, unknown>).__discovered_model_catalog__ === true,
  );
}

/**
 * Would Hermes read this value as an allowlist? `_models_config_is_allowlist`
 * (model_switch.py:136): a non-empty string, or a list yielding at least one id
 * through `_declared_model_ids` (:61). Never a mapping — that is metadata
 * Hermes wrote for itself, not a pin. The `discovered` argument the Python
 * takes is the caller's `hermesOwnsCatalogue` gate above, which is a different
 * verdict here (leave alone) rather than a different shape.
 *
 * Transcribed rather than imported from `src/tests/helpers/
 * hermes-picker-catalogue.ts` ON PURPOSE: that mirror is what judges this
 * module's writes, and a guard sharing its code could only ever agree with it.
 */
function isHermesAllowlist(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    if (typeof entry === "string") return Boolean(entry.trim());
    if (!entry || typeof entry !== "object") return false;
    const nested = entry as { id?: unknown; name?: unknown };
    return [nested.id, nested.name].some((field) => typeof field === "string" && field.trim());
  });
}

/** Test seam. The counter is NOT part of the hand-back — a re-link is worth one
 *  more attempt, not a fresh three — so it is cleared here explicitly. */
export function _resetClawaiModelsReconcileForTests(): void {
  clawaiUnverifiedWrites = 0;
  handClawaiRepairBack();
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
  // only the "not set" wording proceeds; anything else stops here, with what
  // the box already holds left exactly as it is.
  //
  // `--json` IS LOAD-BEARING. In the plain rendering a stored LIST and a stored
  // STRING that spells one are the same characters, and `hermes config set`
  // stores the literal as TEXT whenever its coercion misses
  // (hermes_cli/config.py:5514-5527, exit 0 either way). Hermes then loads NO
  // user plugin at all — `_get_enabled_set` answers `set(enabled) if
  // isinstance(enabled, list) else set()` — while ClawBox read the residue back
  // as a real list and concluded there was nothing to do. TASK-701.
  //
  // WITHDRAW THE CLAIM ON AN ANSWER, NEVER ON A FAILED QUESTION. Every box
  // that can be in the residue state has been linked once already, so
  // `image_gen.provider` is on disk naming us — and that single key is what
  // `hermesAgentDrawsImages` reads — so an answer that PROVES the plugin
  // cannot load has to take it back down; declining to re-make the claim would
  // leave the composer button and the capability both saying yes over a plugin
  // Hermes does not load.
  //
  // But only such an answer. This function runs on every AI-Models save and
  // every re-link and has no periodic caller, and the only unattended writer of
  // `image_gen.provider` is the boot repair in `scripts/register-mcp.sh`, which
  // puts it back solely where it has just repaired the plugin list that made it
  // unloadable — so a withdrawal made over a
  // held config lock, a timeout, a shim exiting 127 or a rendering that is not
  // machine-readable is not caution: it is image generation gone from a
  // working box until the owner happens to save Settings again. Those failures
  // establish NOTHING about what is on disk; they are reported, and what the
  // box holds is left exactly as it was (which is what beta did).
  let loadable: boolean;
  try {
    const { state, typed } = await readPluginsEnabledFromCli();
    if (state.kind === "unreadable") {
      // Not a proof of anything, and the two reasons are said apart: a build
      // that takes `--json` without honouring it renders the same ambiguous
      // text here as a healthy list would, while a command that printed nothing
      // read no value at all and must not be reported as if it had.
      throw new Error(
        state.reason === "silent"
          ? "hermes answered nothing for plugins.enabled — left alone, image generation not re-armed"
          : "plugins.enabled holds a value this build cannot read — left alone, image generation not re-armed",
      );
    }
    if (state.kind === "residue" && !state.names.length) {
      // The one place "MERGED, NEVER REPLACED" gives way: a residue no name
      // could be recovered from is overwritten, because leaving it would leave
      // the box loading no plugin at all. Said out loud before it happens, and
      // said HERE rather than in the decoder, which also runs as the prover —
      // where nothing is replaced and the same line would be a false report.
      console.warn(
        `[hermes/clawai] plugins.enabled holds ${state.shape}, which names no plugin;`
        + " replacing it rather than merging into it",
      );
    }
    const merged = mergePluginsEnabled(state);
    // NULL IS "NOTHING TO WRITE", NEVER "NOTHING TO ASK". The key already names
    // us in a real list — the state of every healthy linked box — so the write
    // is skipped; but the allow-list is not the only thing Hermes gates on, and
    // deriving "loadable" from it here would be the same inference this whole
    // path exists to stop making. `plugins.disabled` names us and every type
    // check on `plugins.enabled` still says yes. So the prover runs on both
    // paths: the write path asks it after the write, this one asks it directly.
    loadable = merged
      ? await writePluginsEnabled(merged, typed)
      : await hermesConfirmsPluginLoadable(typed);
  } catch (err) {
    if (err instanceof PluginsEnabledDisproved) await withdrawImageProviderClaim();
    throw err;
  }
  // WHAT OUR BACKEND IS, before the proof — it turns nothing on. These name the
  // model and the address this device's own plugin posts to, and
  // `image_gen.clawai.base_url` is the key a re-link exists to repair when
  // `CLAWBOX_AI_PROXY_URL` moves in a release. Written ahead of the proof
  // because held behind it they were skipped whenever the listing could not be
  // asked, leaving a box that still claims `clawai` posting to the address of
  // the release before. (They are still skipped whenever the read OR the proof
  // throws — nothing below the block above runs then — which is the honest
  // limit of the hoist.)
  const describes: string[][] = [
    ["config", "set", `image_gen.${HERMES_IMAGE_PLUGIN_NAME}.model`, CLAWBOX_AI_IMAGE_MODEL_ID],
    ["config", "set", `image_gen.${HERMES_IMAGE_PLUGIN_NAME}.base_url`, CLAWBOX_AI_PROXY_URL],
  ];
  for (const args of describes) await runOrThrow(args);
  if (!loadable) {
    // Hermes never answered the question that would prove it loads the plugin.
    // Not a failure worth throwing over, and not proof either — so no new claim
    // is made, no old one is taken away, and the next link asks again.
    console.warn(
      "[hermes/clawai] hermes did not confirm the plugin is loadable — image generation left as it was",
    );
    return;
  }
  // `image_gen.provider` LAST, because it is the key `hermesAgentDrawsImages`
  // reads and therefore the key that turns the agent's picture ability on. A
  // provider written first and then a failed `base_url` would leave a box
  // claiming it can draw through a backend that has nowhere to send the
  // request; written last, a failure anywhere above means the claim was never
  // made and the composer button stays.
  // The GLOBAL `image_gen.model` belongs with the provider, not with the
  // describing writes above: whichever backend is SELECTED reads it (our own
  // plugin reads `image_gen.clawai.model`), so it is ours to name only when we
  // are about to become that backend. Written unconditionally it replaced a
  // customer's chosen model on every AI-Models save — including on the paths
  // that then make no claim at all — which is the mirror of the care
  // `withdrawImageProviderClaim` takes not to remove somebody else's provider.
  // Before `image_gen.provider`, so the ordering rule below still holds.
  await runOrThrow(["config", "set", "image_gen.model", CLAWBOX_AI_IMAGE_MODEL_ID]);
  await runOrThrow(["config", "set", "image_gen.provider", HERMES_IMAGE_PLUGIN_NAME]);
}

/**
 * One `hermes config set` that has to land.
 *
 * Thrown, not swallowed: the caller logs it and the link still succeeds.
 * Half-written image config is exactly what the capability probe is for.
 */
async function runOrThrow(args: string[]): Promise<void> {
  const r = await runHermesCli(args, { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(r.stderr?.trim() || `hermes ${args.join(" ")} failed`);
}

/**
 * Read `plugins.enabled` as Hermes would, and say whether the TYPE could be
 * asked about at all.
 *
 * `typed` is the second half of the answer: false means this build cannot
 * render the key machine-readably, so a list and a string that spells one are
 * indistinguishable here and no proof is possible on this box — a permanent
 * property, not a moment, which is why the caller keeps its claim there.
 */
async function readPluginsEnabledFromCli(): Promise<{ state: PluginsEnabledState; typed: boolean }> {
  const typedRead = await runHermesCli(
    ["config", "get", "plugins.enabled", "--json"],
    { timeoutMs: 15_000 },
  );
  if (typedRead.code === 0) return { state: decodePluginsEnabledJson(typedRead.stdout), typed: true };
  if (/config key not set/i.test(`${typedRead.stdout ?? ""}\n${typedRead.stderr ?? ""}`)) {
    return { state: { kind: "list", names: [] }, typed: true };
  }
  // A CLI whose `config get` does not take the flag answers argparse's
  // "unrecognized arguments: --json". Ask again PLAINLY rather than refusing
  // the feature: `--json` is only what lets the type be PROVED, and a build
  // that cannot answer that question has told us nothing about whether the
  // stored value is residue. Losing image generation there would be a false
  // failure, not a conservative one — these boxes draw today.
  //
  // ONLY for that answer, though. Any other failure — a held config lock, a
  // timeout, a wedged shim — must propagate: falling back to the ambiguous
  // rendering there is how a stored `["clawai"]` string gets read as a list
  // again, which is the whole defect this function exists to remove.
  if (!UNSUPPORTED_OPTION_RE.test(`${typedRead.stdout ?? ""}\n${typedRead.stderr ?? ""}`)) {
    throw new Error(
      typedRead.stderr?.trim() || `hermes config get plugins.enabled --json failed (exit ${typedRead.code})`,
    );
  }
  const plainRead = await runHermesCli(["config", "get", "plugins.enabled"], { timeoutMs: 15_000 });
  const listing = `${plainRead.stdout ?? ""}\n${plainRead.stderr ?? ""}`;
  if (plainRead.code !== 0 && !/config key not set/i.test(listing)) {
    throw new Error(plainRead.stderr?.trim() || "hermes config get plugins.enabled failed");
  }
  console.warn(
    "[hermes/clawai] this hermes does not answer `config get --json`;"
    + " plugins.enabled is merged from the plain rendering and its type is not proved",
  );
  // The SIBLING of the silence rule in `decodePluginsEnabledJson`, and it
  // matters just as much here: this build cannot be asked the typed question,
  // so `writePluginsEnabled` arms the backend without a listing to prove it,
  // and the merge that runs first would write `["clawai"]` over whatever the
  // key really holds. An exit 0 that printed NOTHING is not "the list is
  // empty"; the unset key arrives on the branch above, as a non-zero exit
  // saying "Config key not set" (or those words in the rendering), and only
  // that is read as an empty list.
  if (plainRead.code === 0 && !plainRead.stdout?.trim()) {
    return { state: { kind: "unreadable", reason: "silent" }, typed: false };
  }
  return {
    state: decodePluginsEnabledPlain(plainRead.code === 0 ? plainRead.stdout : ""),
    typed: false,
  };
}

/**
 * Stop claiming the agent can draw.
 *
 * `hermesAgentDrawsImages` reads `image_gen.provider` and nothing else, and
 * nothing else on the device writes it while the owner is away except the
 * boot repair in `scripts/register-mcp.sh`, which puts the claim back only
 * where it has just made the plugin loadable again — so on a box linked once
 * before, declining to re-write the key leaves the old claim standing. Only
 * OUR selection is withdrawn: a customer who chose FAL by hand keeps it (the "known and accepted
 * false positive" hermes-features.ts documents is their choice, not ours).
 *
 * Best effort, and never throws: it runs on the way out of a failure that is
 * already being reported, and a second error here would replace the first.
 */
async function withdrawImageProviderClaim(): Promise<void> {
  try {
    const read = await runHermesCli(["config", "get", "image_gen.provider"], { timeoutMs: 15_000 });
    if (read.code !== 0 || read.stdout.trim() !== HERMES_IMAGE_PLUGIN_NAME) return;
    await runHermesCli(["config", "unset", "image_gen.provider"], { timeoutMs: 15_000 });
    console.warn(
      "[hermes/clawai] withdrew image_gen.provider — the ClawBox AI backend is not loadable here",
    );
  } catch {
    // Nothing to add: the caller is already reporting why we got here.
  }
}

/**
 * Argparse's (and Click's) answers for an option a build does not have.
 * Matched on the WORDING because the exit code (2) is shared with every other
 * usage error. Both spellings of "unrecognised" are listed: the population this
 * fallback exists for is boxes moved off `HERMES_PIN_COMMIT` by a hand-run
 * `hermes update`, which is precisely where the wording can differ. A miss only
 * costs the plain fallback — the type is then simply not proved, and nothing is
 * withdrawn over it.
 */
const UNSUPPORTED_OPTION_RE =
  /unrecogni[sz]ed arguments?:|no such option|unknown option|invalid choice|got unexpected extra argument/i;

/**
 * Hermes was ASKED AND ANSWERED, and the answer establishes that it will not
 * load our plugin: the CLI's own "storing as string" on the write, or
 * `hermes plugins list` reporting the plugin as anything but enabled.
 *
 * The one error that withdraws `image_gen.provider`. Everything else that can
 * go wrong around this key — a held config lock, a timeout, 126/127 from the
 * shim, a listing that is not JSON, a write that never landed — leaves the box
 * holding whatever it held, because none of it says the plugin is absent and
 * nothing on the device would put the claim back (see the caller).
 */
class PluginsEnabledDisproved extends Error {}

/**
 * Write `plugins.enabled` and PROVE Hermes will load us from it.
 *
 * AN EXIT CODE IS NOT AN OUTCOME — the same rule `reconcileClawaiModelsWithHermes`
 * follows for `providers.clawai.models`, and it matters more here. That key
 * degrades one picker; this one is the opt-in allow-list for every user plugin
 * on the box, and a value Hermes cannot read as a list disables all of them.
 *
 * The caller's ordering is what turns the answer into behaviour:
 * `image_gen.provider` — the key `hermesAgentDrawsImages` reads, and therefore
 * the key that turns the agent's picture ability on — is written after this. So
 * anything short of proof means the box does not claim it can draw. A wrong
 * `false` only hides an ability; a wrong `true` is an apology.
 *
 * There is no retry loop: this runs once, at link time, and the caller logs
 * while the link itself still succeeds.
 *
 * @returns true when the plugin is loadable as far as this build can be asked —
 *          false when the write exited 0 and the question that would prove it
 *          could not be put. Throws when the write could not be made (a plain
 *          Error: nothing was established, and the box is no worse off than
 *          before the save) and `PluginsEnabledDisproved` when the CLI's answer
 *          establishes that no plugin can load from what is stored.
 */
async function writePluginsEnabled(names: string[], typed: boolean): Promise<boolean> {
  const written = await runHermesCli(
    ["config", "set", "plugins.enabled", JSON.stringify(names)],
    { timeoutMs: 15_000 },
  );
  if (written.code !== 0) {
    throw new Error(written.stderr?.trim() || "hermes config set plugins.enabled failed");
  }
  // The CLI's own warning when its coercion did not yield a structure. Cheap,
  // and it names the cause; the read-back below is what covers a build too old
  // to print it, where the same literal is stored as text with a clean stderr.
  if (hermesStoredValueAsText(written)) {
    throw new PluginsEnabledDisproved(
      "hermes stored plugins.enabled as text, so no plugin would load — image generation left off",
    );
  }
  return hermesConfirmsPluginLoadable(typed);
}

/**
 * Will Hermes LOAD our plugin? The one prover, for both paths.
 *
 * ASK HERMES, do not re-derive its answer. `hermes plugins list --json` runs
 * `_get_enabled_set()` itself — the very function the loader uses — so its
 * verdict cannot disagree with what will actually load, the way a type
 * inference over `config get` can. And it is the ONLY thing that catches
 * `plugins.disabled`, a deny-list that wins over `plugins.enabled` and leaves
 * every reading of the allow-list saying "loadable" over a plugin Hermes
 * refuses. That is why the caller asks this even when it wrote nothing: an
 * allow-list that already names us is a reason to skip the WRITE, never a
 * reason to skip the QUESTION.
 *
 * @param typed whether this build answered `config get --json` at all.
 * @returns true when Hermes reports the plugin enabled — false when the
 *          question could not be put on a build that can otherwise be asked
 *          machine-readable questions. Throws `PluginsEnabledDisproved` when
 *          Hermes answers that it will not load it.
 */
async function hermesConfirmsPluginLoadable(typed: boolean): Promise<boolean> {
  const verdict = await hermesReportsPluginEnabled(HERMES_IMAGE_PLUGIN_NAME);
  if (verdict === "enabled") return true;
  if (verdict === "not-enabled") {
    // ANSWERED, and the answer is no: the value stored is not a list Hermes
    // can load us from, or `plugins.disabled` names us. This is the proof.
    throw new PluginsEnabledDisproved(
      "hermes does not report the plugin as enabled",
    );
  }
  if (verdict === "no-such-question" && typed) {
    // This build HAS no listing to ask, so no link of it will ever get THAT
    // proof, and refusing the feature over it would take image generation away
    // from a first link for good. But it is not a build that can be asked
    // NOTHING: it answers `config get --json`, so the two keys Hermes actually
    // gates on can still be read machine-readably. Ask those instead of arming
    // on an exit code — a build without the listing is not a licence to make
    // the claim TASK-701 exists to stop making.
    console.warn(
      "[hermes/clawai] this hermes does not answer `plugins list --json`;"
      + " proving the plugin from plugins.enabled and plugins.disabled instead",
    );
    return hermesKeysConfirmPluginLoadable();
  }
  // A QUESTION THAT COULD NOT BE ASKED IS NOT A WRITE THAT FAILED. 126, 127 and
  // a signalled `null` are the shell's codes for the `hermes` shim while
  // `step_hermes_install` rebuilds the venv under it — nothing was parsed, and
  // any write above still exited 0 with no coercion warning. Suppressing image
  // generation for the whole link over that is the false-failure shape; the
  // sibling repair answers `unverified` and tries again for the same reason.
  console.warn(
    "[hermes/clawai] hermes could not be asked whether the plugin is enabled;"
    + " what is on disk is left exactly as it is, unproved",
  );
  // A build that answers NEITHER machine-readable question cannot be asked at
  // all — a permanent property rather than a moment — and refusing the feature
  // on those boxes would take away something that works today. Where the build
  // does answer `config get --json` (so the ambiguity this whole path exists
  // for was resolvable) a silent listing is a moment, and no claim is made.
  return !typed;
}

/**
 * What Hermes itself says about a plugin, or why it could not be asked.
 *
 * `cannot-ask` and `no-such-question` are kept apart because they are a moment
 * and a permanent property of the build: a shim exiting 127 will answer at the
 * next link, a subcommand flag that does not exist never will.
 */
type HermesPluginVerdict = "enabled" | "not-enabled" | "cannot-ask" | "no-such-question";

/**
 * Would Hermes load this plugin? ASKED, not inferred.
 *
 * HARNESS-FIRST, READ ON THE BOX (0.20.5 = 2026.8.19, the pinned build,
 * read-only, 2026-09-04). `hermes plugins list --json` prints one row per
 * discovered plugin as `{name, status, version, description, source}`
 * (`hermes_cli/plugins_cmd.py:1969-1980`), and `status` comes from
 * `_plugin_status(name, enabled, disabled, key)` (`:1930-1936`) over
 * `_get_enabled_set()` (`:1309-1324`) — the SAME function the loader gates on,
 * `set(enabled) if isinstance(enabled, list) else set()`. So a residue stored
 * as text reads back "not enabled" from Hermes' own mouth, and a name in
 * `plugins.disabled` reads "disabled" — a state a type check on
 * `plugins.enabled` calls loadable and Hermes never loads. Measured: the
 * command answers in ~1 s and reports our plugin `{"status": "enabled",
 * "source": "user"}` on a linked box.
 *
 * A MISSING ROW IS NOT A NO. The rows come from `_discover_all_plugins()`, so
 * an absent one means discovery did not see the directory — which says nothing
 * about the allow-list this function was asked about. Reported as "cannot ask"
 * so it makes no claim and withdraws none.
 */
async function hermesReportsPluginEnabled(name: string): Promise<HermesPluginVerdict> {
  const listed = await runHermesCli(["plugins", "list", "--json"], { timeoutMs: 15_000 });
  if (!hermesCliAnswered(listed) || listed.code !== 0) {
    // A build without this flag can never answer, however often it is asked —
    // the same permanent property `config get --json` is exempted for, matched
    // on the same wording. Told apart from a transient failure because the
    // caller owes those two different things.
    return hermesCliAnswered(listed)
      && UNSUPPORTED_OPTION_RE.test(`${listed.stdout ?? ""}\n${listed.stderr ?? ""}`)
      ? "no-such-question"
      : "cannot-ask";
  }
  let rows: unknown;
  try {
    rows = JSON.parse(listed.stdout);
  } catch {
    return "cannot-ask";
  }
  if (!Array.isArray(rows)) return "cannot-ask";
  const row = rows.find(
    (r): r is { name: string; status?: unknown } =>
      !!r && typeof r === "object" && (r as { name?: unknown }).name === name,
  );
  if (!row) return "cannot-ask";
  if (row.status === "enabled") return "enabled";
  // THE NEGATIVE IS A CLOSED LIST, not "anything that is not `enabled`".
  // `not-enabled` is the one verdict that WITHDRAWS a working box's claim, and
  // this file already argues (see UNSUPPORTED_OPTION_RE) that CLI wording
  // differs on builds moved off the pin by a hand-run `hermes update`. An
  // unrecognised status — a renamed field, an "enabled (user)" — would then
  // take image generation away from a box where Hermes was loading the plugin
  // all along, on every Save, with nothing to put it back. A wrong
  // `cannot-ask` hides nothing; a wrong `not-enabled` is an apology.
  //
  // The list is what `_plugin_status` can return, read on the pinned 0.20.5
  // build (`hermes_cli/plugins_cmd.py:1931-1937`): exactly `disabled`,
  // `enabled` and `not enabled`.
  return typeof row.status === "string" && HERMES_NOT_LOADED_STATUSES.has(row.status.toLowerCase())
    ? "not-enabled"
    : "cannot-ask";
}

/** The statuses that PROVE Hermes will not load the plugin. See above. */
const HERMES_NOT_LOADED_STATUSES = new Set(["disabled", "not enabled", "not-enabled"]);

/**
 * The proof a build WITHOUT `plugins list --json` can still give.
 *
 * Hermes gates a user plugin on exactly two keys, and this reads both the way
 * the loader does rather than inferring either:
 *   `plugins.enabled`  — `_get_enabled_set()` is
 *      `set(enabled) if isinstance(enabled, list) else set()`, so anything that
 *      is not a LIST naming us means no load. That is a fact about what is
 *      stored, so it PROVES the negative.
 *   `plugins.disabled` — `_plugin_status` gives it precedence, in either
 *      spelling (`clawai` and the resolved `image_gen/clawai`).
 *
 * A question that could not be PUT — an unreadable rendering, a read that
 * failed — establishes nothing and answers false: no claim made, none taken
 * away, and the next Save asks again. Only an ANSWER that names the negative
 * throws, exactly as the listing's does.
 */
async function hermesKeysConfirmPluginLoadable(): Promise<boolean> {
  const { state, typed } = await readPluginsEnabledFromCli();
  if (!typed || state.kind === "unreadable") return false;
  if (state.kind === "residue" || !state.names.includes(HERMES_IMAGE_PLUGIN_NAME)) {
    throw new PluginsEnabledDisproved(
      "plugins.enabled does not read back as a list naming the plugin",
    );
  }
  const denied = await readPluginsDisabledFromCli();
  if (!denied) return false;
  if (denied.has(HERMES_IMAGE_PLUGIN_NAME) || denied.has(HERMES_IMAGE_PLUGIN_KEY)) {
    throw new PluginsEnabledDisproved("plugins.disabled names the plugin");
  }
  return true;
}

/**
 * `plugins.disabled` as a set of names, or null when it could not be read.
 *
 * Null rather than an empty set for every DOUBT — a read that failed, a
 * rendering that could not be parsed — because an empty set here reads as
 * "nothing is denied" and that is not a claim to invent. Two things ARE an
 * honest empty, because both are ANSWERS: the CLI's own "Config key not set",
 * and a value that is not a LIST — `_get_disabled_set()` reads that as denying
 * nothing, so it denies nothing here too.
 */
async function readPluginsDisabledFromCli(): Promise<Set<string> | null> {
  const read = await runHermesCli(
    ["config", "get", "plugins.disabled", "--json"],
    { timeoutMs: 15_000 },
  );
  const listing = `${read.stdout ?? ""}\n${read.stderr ?? ""}`;
  if (read.code !== 0) {
    return /config key not set/i.test(listing) ? new Set() : null;
  }
  const state = decodePluginsEnabledJson(read.stdout);
  // The same decoder, and the same reading of silence: a command that printed
  // nothing has not said the deny-list is empty.
  if (state.kind === "unreadable") return null;
  // A RESIDUE DENIES NOTHING, so its recovered names are not a deny-list.
  // `_get_disabled_set()` gates on the same type as the allow-list —
  // `set(disabled) if isinstance(disabled, list) else set()`
  // (hermes_cli/plugins_cmd.py:1257-1269, read on the pinned 0.20.5 build) —
  // so a `plugins.disabled` stored as a STRING is a value Hermes loads the
  // plugin over. Returning the names recovered out of it would withdraw
  // `image_gen.provider` from a box that is drawing today; the honest empty is
  // the only reading that matches what Hermes does.
  return state.kind === "residue" ? new Set() : new Set(state.names);
}

/**
 * Point Hermes at the ClawBox cloud voice when nothing else can speak.
 *
 * Two questions before it writes anything, and each has a writer on the other
 * edition that already asks it.
 *
 * ENTITLEMENT. Cloud speech is served only to the device tier
 * `CLAWBOX_AI_SPEECH_TIER`; the proxy answers 403 to anything below it. The
 * Voice route refuses the pick on an unentitled box, and
 * `gateway-pre-start.sh` says why in as many words: pointing an unentitled box
 * at it "would be worse than leaving it alone — the panel would call the cloud
 * voice configured … and every spoken reply would pay a failed round trip". A
 * box that is honestly mute is better than one aimed at a route it may not
 * call, and nothing would ever move it back: install.sh then sees `openai` and
 * preserves it as an owner's choice.
 *
 * A READ THAT FAILED IS NOT AN ANSWER — of EVERY key this decides on, not just
 * of `tts.provider`. `hermes config get` exits the same way for an unset key
 * and for one that never completed (an OOM-killed Python start on a loaded
 * Jetson), and `readHermesVoice` therefore reports which of its own reads did
 * not answer (`HermesVoiceProbe.unread`). The shell half of this same change
 * refuses to make that mistake at length (install.sh, "AN UNSET KEY IS NOT A
 * FAILED READ"); each of the three flags closes a door that does not reopen:
 * an unread SELECTION would replace a choice we could not read, an unread
 * CLOUD SLOT would read an owner's own speech server as "unset, so ours", and
 * an unread on-device DEFINITION would read a working box as voiceless. The
 * engine probe answers the same way (`probeLocalTtsEngine` → `null`).
 *
 * Then it writes only in the three states that are not an owner's choice:
 *
 *   unset            — which to Hermes means its factory Edge cloud, not
 *                      silence: measured read-only on the pinned 0.20.5
 *                      package, `tools/tts_tool.py:211` `DEFAULT_PROVIDER =
 *                      "edge"` and `:661` `(tts_config.get("provider") or
 *                      DEFAULT_PROVIDER)`.
 *   `edge`           — the same cloud said out loud, which a ClawBox must
 *                      never speak through by default (hermes-tts.ts).
 *   `clawbox-local`  — selected, with no Kokoro behind it.
 *
 * ...and in each of them it asks THIS BOX what it has before it reaches for
 * the cloud. An unset key is not evidence of a missing engine — install.sh
 * leaves it unset when a `hermes config set` hiccups, and a box provisioned
 * before the Hermes arm existed has never had one written — so a working
 * Kokoro is selected instead, and only a box that really cannot speak for
 * itself is sent off-device. Getting that backwards is permanent: the next
 * `step_openclaw_tts` sees `openai`, falls into its "already set" arm and
 * preserves it as the owner's choice for good.
 *
 * Anything else — elevenlabs, piper, one an owner added by hand — is left
 * alone.
 *
 * The cloud ENDPOINT AND CREDENTIAL are refreshed for the provider that speaks
 * through them — a box already on `openai` over our own route, and a box this
 * call is about to point there. `writeHermesCloudTarget` is the only writer of
 * `tts.openai.*` on this edition, so returning early on a box already speaking
 * through the cloud left `tts.openai.api_key` holding the token the portal
 * has just rotated: every utterance 401s while `hermesSpeaksReplies`, which
 * asks only that the two keys are non-empty, calls the voice configured. The
 * OpenClaw sibling does not have that hole — `gateway-pre-start.sh` rewrites
 * the speech apiKey on every gateway start. A box speaking through anything
 * else is not refreshed at all: three `hermes config set` spawns inside the
 * link for a route it will never use, leaving our proxy and the device token
 * in a slot nobody asked us to fill.
 *
 * Never throws: a link that worked must not report failure because the voice
 * could not be pointed. The Voice panel remains the place to set it by hand.
 */
async function selectHermesCloudVoiceIfUnvoiced(token: string, tier: ClawboxAiTier): Promise<void> {
  try {
    const [
      {
        readHermesVoice,
        selectHermesProvider,
        writeHermesCloudTarget,
        HERMES_LOCAL_TTS_PROVIDER,
        HERMES_CLOUD_TTS_PROVIDER,
        HERMES_FACTORY_TTS_PROVIDER,
        CLAWBOX_AI_SPEECH_TIER,
        hermesCloudRouteIsOurs,
      },
      { probeLocalTtsEngine, localTtsCommandRunnable },
    ] = await Promise.all([
      import("@/lib/hermes-tts"),
      import("@/lib/local-models"),
    ]);
    // The tier just linked, not a re-read: `setMany` wrote `clawai_tier` a
    // moment ago, but the argument is the same fact without a second round trip
    // and without a window where the store has not settled. It is already the
    // DEVICE tier — the same value `speechEntitledTier()` reads back — so it is
    // compared with the constant directly.
    if (tier !== CLAWBOX_AI_SPEECH_TIER) {
      console.log(
        `[hermes-clawai] this plan does not include the cloud voice — leaving tts.provider alone`,
      );
      return;
    }
    const voice = await readHermesVoice();
    // A READ THAT FAILED IS NOT AN ANSWER, asked of every key this decides on
    // rather than only of `tts.provider`. `hermes config get` exits the same
    // way for an unset key and for one that never answered, and each of these
    // three decides something that cannot be taken back — see
    // `HermesVoiceProbe.unread`. Costs nothing: the flags come off the memo the
    // read above has just filled.
    if (voice.unread.provider) {
      console.warn(
        "[hermes-clawai] could not read this box's voice selection — leaving it alone rather than"
        + " replacing a choice we could not read",
      );
      return;
    }
    // Is the OpenAI-compatible slot OURS to write?
    //
    // On Hermes `openai` is the generic slot, not ClawBox's: an owner may have
    // pointed it at a self-hosted speech server with their own key, and
    // install.sh lists `openai` among the values it preserves untouched as the
    // owner's choice. Writing there would redirect their speech to our proxy
    // with our token while the selection, and every panel, stayed exactly the
    // same. `gateway-pre-start.sh` — the sibling this refresh is modelled on —
    // refuses for exactly this reason: it computes whether the speech route is
    // already taken and prints "already names its own speech route" rather
    // than writing. Fail closed in this direction: not refreshing a token costs
    // a 401 the owner can fix from the Voice panel; overwriting the endpoint,
    // key and model of a speech server they run is silent and cannot be undone
    // from here.
    //
    // WHAT counts as ours lives in `hermesCloudRouteIsOurs` and is not restated
    // here, because the Voice panel asks the same question before calling this
    // box's voice ClawBox cloud — and two copies of that rule is how the panel
    // and the writer come to disagree about whose key is in the slot.
    const ownRoute = hermesCloudRouteIsOurs(voice, CLAWBOX_AI_PROXY_URL);
    const current = voice.provider;
    const unchosen = current === null
      || current === HERMES_FACTORY_TTS_PROVIDER
      || current === HERMES_LOCAL_TTS_PROVIDER;
    if (!unchosen) {
      // An owner's own provider — elevenlabs, piper, one they added by hand.
      // The SELECTION is theirs and is never touched. The endpoint and
      // credential are refreshed only for the one provider that speaks through
      // them, because this is the only writer of `tts.openai.*` on this edition
      // and the portal rotates the token on a re-link: an unrefreshed key means
      // every utterance 401s while `hermesSpeaksReplies`, which asks only that
      // the two keys are non-empty, calls the voice configured. On a box
      // speaking through anything else those three writes would be 45 s of
      // `hermes config set` inside the link for a route it will never use, and
      // would park our proxy and the device token in a slot nobody asked us to
      // fill.
      if (current === HERMES_CLOUD_TTS_PROVIDER && ownRoute) {
        await writeHermesCloudTarget(token);
        console.log("[hermes-clawai] refreshed the ClawBox AI speech credential");
      } else if (current === HERMES_CLOUD_TTS_PROVIDER) {
        console.log(
          "[hermes-clawai] tts.openai already names its own speech route — leaving it alone",
        );
      }
      return;
    }
    // What this box HAS, asked in every unchosen state rather than only over a
    // `clawbox-local` selection. A working on-device engine is the answer
    // wherever there is one — an owner on it is not moved off it by linking a
    // box, and an unset key on a box that can speak for itself is not a reason
    // to send its owner's words off the device.
    //
    // THREE conjuncts, the same three every other surface asks for: Hermes has
    // a `type: command` definition for it, the engine is installed, and the
    // script is runnable. `local-models.ts` documents the third — "the file can
    // lose the bit long after the config was written" — and `hermesSpeaksReplies`
    // and the Voice route both demand it.
    //
    // Only the first two can say "I could not ask"; the third answers a plain
    // boolean, and that asymmetry is deliberate. `localTtsCommandRunnable` is a
    // stat and an access on a local path — no spawn, no bus, no Python start —
    // so the failure modes the other two guard against do not reach it, and a
    // three-valued answer would buy a state that never occurs at the cost of a
    // third "leave it alone" branch on the decision that matters most.
    const engine = await probeLocalTtsEngine();
    // MOVING A BOX OFF ITS OWN VOICE IS PERMANENT — the next
    // `step_openclaw_tts` sees `openai`, falls into its "already set" arm and
    // preserves it as the owner's choice for good — so it is done only on a
    // POSITIVE "this box cannot speak for itself". A definition we could not
    // read and a systemd bus that did not answer are both "we could not tell",
    // and on a box already selected on `clawbox-local` they leave it alone.
    //
    // Only there: an unset key or Hermes' `edge` is not a working on-device
    // selection to protect, and leaving one alone leaves the box on Microsoft's
    // cloud — strictly worse than our own proxy, which is what the fall-through
    // below reaches.
    if (current === HERMES_LOCAL_TTS_PROVIDER && (voice.unread.localProvider || engine === null)) {
      console.log(
        "[hermes-clawai] could not tell whether this box still speaks for itself — leaving the"
        + " on-device selection alone",
      );
      return;
    }
    if (voice.localRegistered
      && voice.localCommand !== null
      && engine === true
      && await localTtsCommandRunnable(voice.localCommand)) {
      if (current === HERMES_LOCAL_TTS_PROVIDER) return;
      await selectHermesProvider("local");
      console.log("[hermes-clawai] this box has its own voice — selecting the on-device engine");
      return;
    }
    if (!ownRoute) {
      // Nothing to select it onto: the cloud slot is the owner's, or its read
      // did not answer, so pointing `tts.provider` at it would speak through an
      // endpoint that is not ours to arrange.
      console.log("[hermes-clawai] no on-device voice, and tts.openai is not ours — leaving the selection alone");
      return;
    }
    // DEFINITION BEFORE SELECTION, immediately before it and only on this path:
    // the endpoint and credential land first, so a failure here leaves
    // `tts.provider` untouched rather than selecting a provider that cannot
    // answer. Written here rather than above the engine question so a cloud
    // credential that would not write can never abandon the decision that
    // needed no cloud at all — that would leave a box with a working Kokoro on
    // an unset key, which to Hermes is Microsoft's Edge cloud.
    await writeHermesCloudTarget(token);
    await selectHermesProvider("cloud");
    console.log("[hermes-clawai] no on-device voice on this box — speaking through ClawBox AI");
  } catch (err) {
    console.warn(
      "[hermes-clawai] could not point the cloud voice:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
