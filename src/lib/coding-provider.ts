/**
 * WHICH ACCOUNT PAYS FOR A CODING RUN — and which models it may ask for.
 *
 * Until now there was exactly one answer: `claude-ds`, Claude Code pointed at
 * this box's ClawBox AI plan (see scripts/claude-ds). That is still the
 * default and still what a box with nothing else configured uses. The second
 * answer is the owner's OWN Anthropic access — either the native `claude`
 * login in their home, or an API key they saved on the box — which buys them
 * Claude's own models for a run when the ClawBox AI plan's DeepSeek tier is
 * not what the task needs.
 *
 * PURE ON PURPOSE. No `fs`, no `child_process`, no config store: the MCP
 * server imports this to validate its own arguments before it ever reaches
 * the route, the same way it imports coding-agent-status.ts. Everything that
 * touches the box — the stored key, the readiness probe — lives in
 * src/lib/coding-anthropic.ts, and everything that spawns lives in
 * src/lib/coding-agent.ts.
 *
 * THE TWO CREDENTIALS NEVER MEET. `clawbox-ai` runs must not see the owner's
 * Anthropic key, and `anthropic` runs must not inherit the proxy's base URL
 * or its portal token — an inherited ANTHROPIC_AUTH_TOKEN outranks an API key
 * and would silently send an "Anthropic" run back through the proxy under a
 * model name it does not serve. buildRunEnv() writes one side or the other
 * and the wrapper unsets the rest; `coding-agent-provider-env.test.ts` pins
 * the isolation in both directions.
 */

/** The providers a run may be started against, default first. */
export const CODING_PROVIDERS = ["clawbox-ai", "anthropic"] as const;

export type CodingProvider = (typeof CODING_PROVIDERS)[number];

/**
 * What a box uses when the owner has never chosen: the ClawBox AI plan it
 * already pays for. A box that has no Anthropic credential at all must not
 * have its runs refused because of a default nobody set.
 */
export const DEFAULT_CODING_PROVIDER: CodingProvider = "clawbox-ai";

/** The owner's default, in data/config.json. */
export const CODING_AGENT_PROVIDER_CONFIG_KEY = "coding_agent_provider";

/**
 * The owner's Anthropic API key, beside `clawai_token` in the same 0600
 * data/config.json — the existing pattern for a credential the box holds on
 * the owner's behalf. It is never answered by a route, never logged and never
 * put in a run's spawn environment: the wrapper reads it out of the config
 * itself, exactly as it already reads the ClawBox AI token.
 */
export const ANTHROPIC_API_KEY_CONFIG_KEY = "anthropic_api_key";

/**
 * The models offered for an `anthropic` run. Deliberately a short list of the
 * two the device names elsewhere rather than whatever the account can reach:
 * an unknown model id is a failed run several minutes in, and the picker's
 * job is to make that impossible from here.
 */
export const ANTHROPIC_MODELS = ["claude-opus-5", "claude-sonnet-5"] as const;

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];

/** The model an `anthropic` run gets when the caller named none. */
export const DEFAULT_ANTHROPIC_MODEL: AnthropicModel = "claude-opus-5";

/**
 * The catalogue key that names a provider in the owner's language.
 *
 * A TABLE, not `codingAgent.provider.${id}`. Two reasons, and the first is a
 * rule this repository enforces: translation keys are dot-notation camelCase
 * (`translations.test.ts`), and `clawbox-ai` has a hyphen in it — built by
 * interpolation the key was `codingAgent.provider.clawbox-ai`, which the
 * catalogue convention forbids and which only the whole-catalogue test caught.
 * The second is that a key assembled from a value cannot be grepped, so a
 * renamed provider would leave a dead lookup no search would find.
 */
export const CODING_PROVIDER_NAME_KEY: Readonly<Record<CodingProvider, string>> = {
  "clawbox-ai": "codingAgent.providerName.clawboxAi",
  anthropic: "codingAgent.providerName.anthropic",
};

export function isCodingProvider(value: unknown): value is CodingProvider {
  return typeof value === "string" && (CODING_PROVIDERS as readonly string[]).includes(value);
}

/** A stored or inherited value read as a provider; anything else is the default. */
export function codingProviderFrom(raw: unknown): CodingProvider {
  return isCodingProvider(raw) ? raw : DEFAULT_CODING_PROVIDER;
}

/**
 * The models a caller may name for this provider.
 *
 * Empty for `clawbox-ai` — and that is a fact, not a gap: the ClawBox AI plan
 * decides which DeepSeek tier answers (see scripts/claude-ds), so a model
 * named here would either be ignored or 403'd upstream. The route refuses one
 * rather than pretending to honour it.
 */
export function modelsForProvider(provider: CodingProvider): readonly string[] {
  return provider === "anthropic" ? ANTHROPIC_MODELS : [];
}

/** The model an unnamed run gets, or null where the plan decides. */
export function defaultModelForProvider(provider: CodingProvider): string | null {
  return provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : null;
}

/**
 * A caller's `{ provider, model }`, checked together.
 *
 * Answers either the pair a run may be started with or the one sentence the
 * caller needs. Both surfaces — the HTTP route and the MCP tool — go through
 * this, so a model the box would refuse is refused in the same words wherever
 * it arrives, and neither can drift into accepting a model the other does not.
 *
 * @param provider what the caller asked for, or null/undefined for the owner's default
 * @param model what the caller asked for, or null/undefined for the provider's default
 * @param fallback the owner's stored default provider
 */
export function resolveRunProvider(
  provider: unknown,
  model: unknown,
  fallback: CodingProvider,
): { ok: true; provider: CodingProvider; model: string | null } | { ok: false; error: string } {
  let resolved: CodingProvider;
  if (provider === undefined || provider === null || provider === "") {
    resolved = fallback;
  } else if (isCodingProvider(provider)) {
    resolved = provider;
  } else {
    return { ok: false, error: `Unknown provider. Use one of: ${CODING_PROVIDERS.join(", ")}.` };
  }

  if (model === undefined || model === null || model === "") {
    return { ok: true, provider: resolved, model: defaultModelForProvider(resolved) };
  }
  if (typeof model !== "string") {
    return { ok: false, error: "The model must be a string." };
  }
  const allowed = modelsForProvider(resolved);
  if (allowed.length === 0) {
    // Said plainly rather than ignored: a run that silently answered on a
    // different model than the one asked for is the failure this whole
    // selector exists to make visible.
    return {
      ok: false,
      error: "ClawBox AI chooses the model from the box's plan, so a model cannot be named for it. Use provider \"anthropic\" to choose a model.",
    };
  }
  if (!allowed.includes(model)) {
    return { ok: false, error: `Unknown model for ${resolved}. Use one of: ${allowed.join(", ")}.` };
  }
  return { ok: true, provider: resolved, model };
}
