import { runHermesCli } from "@/lib/hermes-cli";
import { redactKey, safeHermesFailureMessage } from "@/lib/hermes-cli-message";
import { setMany } from "@/lib/config-store";
import {
  getModelOptions,
  invalidateModelOptions,
  isAllowedProvider,
  scopeFromPayload,
} from "@/lib/hermes-model-options";

// Applying an API-key cloud provider to a HERMES device.
//
// On the Hermes SKU there is no `openclaw` binary, so the OpenClaw configure
// route cannot shell out to it to store a provider key — that is exactly what
// produced `spawn openclaw ENOENT` for an API-key provider (Anthropic) while the
// OAuth path succeeded. Hermes keeps its own credential store, so the key is
// written the same way `/setup-api/hermes/provider-key` does — `hermes auth add`
// — and the provider is then activated through Hermes' own model catalog, the
// same pairing-safe way `/setup-api/hermes/models` selects a provider.

export class HermesCloudApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesCloudApplyError";
  }
}

// OpenClaw provider id -> Hermes provider slug, for the API-key providers Hermes
// configures with `hermes auth add ... --type api-key`. Kept in step with the
// allowlist in `/setup-api/hermes/provider-key`. `openai` is intentionally
// absent: on Hermes it authenticates via OAuth (`openai-codex`), not a pasted
// key, so an OpenAI API key has no Hermes home and must not silently no-op.
const OPENCLAW_TO_HERMES_KEY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  google: "gemini",
  openrouter: "openrouter",
};

/** The Hermes slug an OpenClaw API-key provider maps to, or null when Hermes
 *  has no API-key home for it (e.g. openai, which is OAuth-only on Hermes). */
export function hermesKeyProviderFor(openclawProvider: string): string | null {
  return OPENCLAW_TO_HERMES_KEY_PROVIDER[openclawProvider] ?? null;
}

export interface HermesCloudApplyResult {
  provider: string;
  /** The model that was activated, or "" when the key was stored but no model
   *  could be resolved yet (the provider is left unchanged in that case). */
  model: string;
  /** True when the provider was made the active one; false when only the key
   *  was stored (no model available to pair with it yet). */
  activated: boolean;
}

/**
 * Store an API key for a cloud provider on Hermes and, when a model can be
 * resolved for it, make it the active provider.
 *
 * @throws HermesCloudApplyError carrying either ClawBox-authored text or a
 *   `hermes` message that has been through `safeHermesFailureMessage` — a raw
 *   stderr can carry the binary path, and the key must never be echoed back.
 *
 *   That sentence used to read "with only ClawBox-authored text", twenty-eight
 *   lines above a `throw` that handed back `add.stderr` verbatim. The docstring
 *   was right about the risk and wrong about the code; the code now matches it,
 *   and the promise is kept by a function rather than by a comment.
 */
export async function applyCloudProviderKeyToHermes(opts: {
  openclawProvider: string;
  apiKey: string;
}): Promise<HermesCloudApplyResult> {
  const slug = hermesKeyProviderFor(opts.openclawProvider);
  if (!slug) {
    throw new HermesCloudApplyError(
      "This provider is set up through the Hermes provider panel on this edition.",
    );
  }
  const key = opts.apiKey.trim();
  // A leading "-" would be read by hermes as a flag; runHermesCli never uses a
  // shell, but argv position still matters.
  if (!key || key.startsWith("-")) {
    throw new HermesCloudApplyError("An API key is required.");
  }

  // 1. Store the credential — this flips the provider's `authenticated` flag and
  //    unlocks its model list, so it must land before we try to pick a model.
  const add = await runHermesCli(
    ["auth", "add", slug, "--type", "api-key", "--api-key", key],
    { timeoutMs: 20_000 },
  );
  if (add.code !== 0) {
    // Two separate things must not reach the Settings banner, and the old
    // comment ("hermes stderr may name the provider but not the secret") was
    // only thinking about one of them — and was wrong about that one too.
    //
    // 1. The KEY. True of a clean refusal, false of an argparse usage error,
    //    which prints the offending argv and the key is IN the argv. Redacted
    //    rather than assumed absent, and redacted BEFORE the parser so the cap
    //    counts the text a person will actually see.
    // 2. The CRASH. `hermes auth add` is the first command a customer's saved
    //    key runs through, and a traceback here rendered verbatim in the save
    //    banner: CPython frames naming /home/clawbox/.hermes. That is the input
    //    PR #515 cleaned out of the chat bubble, on a screen its grep did not
    //    reach.
    //
    // The raw stream still goes to the journal, so nothing is lost for the
    // person diagnosing it — it just stops being published.
    console.error("[hermes cloud-provider] auth add exit", add.code, redactKey(add.stderr, key));
    throw new HermesCloudApplyError(
      safeHermesFailureMessage(redactKey(add.stdout, key), redactKey(add.stderr, key))
        || "Failed to save the API key.",
    );
  }
  invalidateModelOptions();

  // 2. Resolve a valid default model for the now-credentialed provider.
  let model = "";
  try {
    const payload = await getModelOptions({ refresh: true });
    if (isAllowedProvider(payload, slug)) {
      model = (await scopeFromPayload(payload, slug)).defaultModel || "";
    }
  } catch {
    // Catalog unreachable — treat as "no model yet" and leave the provider be.
  }

  // Writing model.provider without a model.default would strand the config on a
  // provider with no model (hermes config set can't clear model.default
  // atomically). So only activate when we actually have a model to pair; the key
  // is already stored either way, so the customer can finish in the Hermes panel.
  if (!model) {
    // The key is already stored in Hermes' own credential store; leave the
    // active provider untouched so the device isn't stranded on a model-less
    // provider. The customer finishes by picking a model in the Hermes panel.
    return { provider: slug, model: "", activated: false };
  }

  // The two ACTIVATION writes are the same call site three lines apart, and the
  // sibling-call-site shape is exactly what gets missed: a fix applied to the
  // `auth add` above and not to these would have left the leak live for every
  // customer whose key stored fine and whose config write did not.
  const setProvider = await runHermesCli(["config", "set", "model.provider", slug], { timeoutMs: 15_000 });
  if (setProvider.code !== 0) {
    console.error("[hermes cloud-provider] config set model.provider exit", setProvider.code, setProvider.stderr);
    throw new HermesCloudApplyError(
      safeHermesFailureMessage(setProvider.stdout, setProvider.stderr) || "Failed to select the provider.",
    );
  }
  const setModel = await runHermesCli(["config", "set", "model.default", model], { timeoutMs: 15_000 });
  if (setModel.code !== 0) {
    console.error("[hermes cloud-provider] config set model.default exit", setModel.code, setModel.stderr);
    throw new HermesCloudApplyError(
      safeHermesFailureMessage(setModel.stdout, setModel.stderr) || "Failed to set the model.",
    );
  }

  // Keep the wizard's own status route consistent: without ai_model_configured
  // the setup flow can't advance past the AI step on a Hermes device.
  await setMany({
    ai_model_configured: true,
    ai_model_provider: slug,
    ai_model_configured_at: new Date().toISOString(),
  });

  // The device's provider/model just changed — don't serve the old selection.
  invalidateModelOptions();
  return { provider: slug, model, activated: true };
}
