import { runHermesCli } from "@/lib/hermes-cli";
import { setMany } from "@/lib/config-store";
import {
  getModelOptions,
  invalidateModelOptions,
  isAllowedProvider,
  scopeFromPayload,
} from "@/lib/hermes-model-options";
import { withProviderMcpRefresh } from "@/lib/provider-mcp-refresh";

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
 * @throws HermesCloudApplyError with only ClawBox-authored text — a raw hermes
 *   stderr can carry the binary path, and the key must never be echoed back.
 */
export async function applyCloudProviderKeyToHermes(opts: {
  openclawProvider: string;
  apiKey: string;
}): Promise<HermesCloudApplyResult> {
  // Storing a key here credentials a provider the ClawBox MCP server has never
  // heard of: it read the provider list ONCE, while it booted, and turned it
  // into `ai_set_provider`'s enum. The wrapper samples that set either side of
  // the work below and asks the agent to re-advertise only when it actually
  // moved — see `provider-mcp-refresh.ts`.
  return withProviderMcpRefresh(() => applyCloudProviderKey(opts));
}

async function applyCloudProviderKey(opts: {
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
    // Never echo the key. hermes stderr may name the provider but not the secret.
    throw new HermesCloudApplyError(add.stderr || "Failed to save the API key.");
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

  const setProvider = await runHermesCli(["config", "set", "model.provider", slug], { timeoutMs: 15_000 });
  if (setProvider.code !== 0) {
    throw new HermesCloudApplyError(setProvider.stderr || "Failed to select the provider.");
  }
  const setModel = await runHermesCli(["config", "set", "model.default", model], { timeoutMs: 15_000 });
  if (setModel.code !== 0) {
    throw new HermesCloudApplyError(setModel.stderr || "Failed to set the model.");
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
