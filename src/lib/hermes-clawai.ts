import { setMany } from "@/lib/config-store";
import { runHermesCli } from "@/lib/hermes-cli";
import { invalidateModelOptions } from "@/lib/hermes-model-options";
import { setHermesEnvValues } from "@/lib/hermes-env";
import {
  HERMES_IMAGE_PLUGIN_NAME,
  HERMES_IMAGE_TOKEN_ENV,
  installHermesImagePlugin,
  mergePluginsEnabled,
} from "@/lib/hermes-image-plugin";
import {
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_IMAGE_MODEL_ID,
  CLAWBOX_AI_PRO_MODEL_ID,
  CLAWBOX_AI_VISION_MODEL_ID,
  type ClawboxAiTier,
} from "@/lib/clawbox-ai-models";

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

export const CLAWBOX_AI_PROXY_URL =
  process.env.CLAWBOX_AI_PROXY_URL?.trim() || "https://clawbox.com/api/ai";

/** BARE model id (no `deepseek/` vendor prefix) — the proxy returns
 *  "HTTP 400: Model not allowed" for a prefixed slug. */
export function clawaiModelForTier(tier: ClawboxAiTier): string {
  return tier === "pro" ? CLAWBOX_AI_PRO_MODEL_ID : CLAWBOX_AI_FLASH_MODEL_ID;
}

export class ClawaiApplyError extends Error {}

/**
 * Point Hermes at ClawBox AI and persist the device state.
 *
 * @param token device token minted by the portal (never logged, never echoed)
 * @param tier  device tier — decides which bare deepseek id becomes model.default
 */
export async function applyClawaiToHermes(
  token: string,
  tier: ClawboxAiTier,
): Promise<{ provider: string; model: string; tier: ClawboxAiTier }> {
  const trimmed = token.trim();
  // A token that starts with "-" would be read by hermes as a flag. runHermesCli
  // never uses a shell, but argv position is still meaningful.
  if (!trimmed || trimmed.startsWith("-")) {
    throw new ClawaiApplyError("Sign in to ClawBox AI first to get a device token.");
  }
  const model = clawaiModelForTier(tier);

  const steps: string[][] = [
    ["config", "set", `providers.${CLAWAI_PROVIDER}.base_url`, CLAWBOX_AI_PROXY_URL],
    ["config", "set", `providers.${CLAWAI_PROVIDER}.api_key`, trimmed],
    ["config", "set", `providers.${CLAWAI_PROVIDER}.api_mode`, "openai"],
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
    ["config", "set", "auxiliary.vision.provider", CLAWAI_PROVIDER],
    ["config", "set", "auxiliary.vision.model", CLAWBOX_AI_VISION_MODEL_ID],
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
      throw new ClawaiApplyError(r.stderr || "Failed to configure ClawBox AI");
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

  return { provider: CLAWAI_PROVIDER, model, tier };
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
 *   4. the selection and the model, which is what `image_gen_registry`
 *      resolves at tool time.
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
  const current = await runHermesCli(["config", "get", "plugins.enabled"], { timeoutMs: 15_000 });
  const merged = mergePluginsEnabled(current.code === 0 ? current.stdout : "");
  const steps: string[][] = [
    ...(merged ? [["config", "set", "plugins.enabled", JSON.stringify(merged)]] : []),
    ["config", "set", "image_gen.provider", HERMES_IMAGE_PLUGIN_NAME],
    ["config", "set", "image_gen.model", CLAWBOX_AI_IMAGE_MODEL_ID],
    ["config", "set", `image_gen.${HERMES_IMAGE_PLUGIN_NAME}.model`, CLAWBOX_AI_IMAGE_MODEL_ID],
    ["config", "set", `image_gen.${HERMES_IMAGE_PLUGIN_NAME}.base_url`, CLAWBOX_AI_PROXY_URL],
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
