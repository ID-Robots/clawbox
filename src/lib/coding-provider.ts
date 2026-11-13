/**
 * WHICH ACCOUNT PAYS FOR A CODING RUN — and which models it may ask for.
 *
 * Until now there was exactly one answer: `claude-ds`, Claude Code pointed at
 * this box's ClawBox AI plan (see scripts/claude-ds). That is still the
 * default and still what a box with nothing else configured uses. The second
 * answer is the owner's OWN Anthropic access — either the native `claude`
 * login in their home, or an API key they saved on the box — which buys them
 * Claude's own models for a run when the ClawBox AI plan's DeepSeek tier is
 * not what the task needs. The third is the owner's OWN OpenAI access — a
 * ChatGPT sign-in or an API key — and it is the one provider that does not
 * run on Claude Code at all: an `openai` run is the Codex CLI (`codex exec`),
 * see src/lib/coding-codex.ts and src/lib/coding-openai.ts.
 *
 * PURE ON PURPOSE. No `fs`, no `child_process`, no config store: the MCP
 * server imports this to validate its own arguments before it ever reaches
 * the route, the same way it imports coding-agent-status.ts. Everything that
 * touches the box — the stored key, the readiness probe — lives in
 * src/lib/coding-anthropic.ts, and everything that spawns lives in
 * src/lib/coding-agent.ts.
 *
 * The fourth is the BOX'S OWN ENGINE — `local` (TASK-2501 PR-E): Claude Code
 * on the model in the Local AI slot (the owner's External engine, or Local
 * AI's llama.cpp / Ollama), through the box's own Messages-API route
 * (src/lib/local-anthropic-route.ts). Nobody pays and nothing leaves for a
 * cloud model. It is what a box under the local-only AI lock runs on, and the
 * only provider it offers then (`providersUnderLock`).
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
export const CODING_PROVIDERS = ["clawbox-ai", "anthropic", "openai", "local"] as const;

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
 * The providers the owner CONNECTED to the coding agent (Settings → Coding
 * agent → Connected providers, 2026-10-28): a team may run on several accounts
 * at once, one per role. A record from before the list reads as the default
 * provider alone (`CODING_AGENT_PROVIDER_CONFIG_KEY`), which is what every box
 * ran on until then.
 */
export const CODING_AGENT_CONNECTED_PROVIDERS_CONFIG_KEY = "coding_agent_providers";

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
 * ones the device names elsewhere rather than whatever the account can reach:
 * an unknown model id is a failed run several minutes in, and the picker's
 * job is to make that impossible from here.
 *
 * The Fable models are offered beside the default, never instead of it: a run
 * nobody named a model for lands on `DEFAULT_ANTHROPIC_MODEL`.
 * `claude-fable-5-2` (2026-11-09, the owner's ask) leads them — the newer
 * generation at a lower list price than `claude-fable-5-1`, which stays for a
 * role or a follow-up run that already names it. `claude-sonnet-5-5` and
 * `claude-haiku-5-5` joined the same day, for the cheaper halves of a team:
 * all three answered the box's own Claude sign-in when asked (2026-11-09).
 *
 * `claude-opus-5` stays on the list behind `claude-opus-5-5`
 * rather than retiring, because this list is the fence for what a
 * caller ASKS FOR: the MCP tool's `model` enum, the run route, and a
 * follow-up run that re-states the model of the run it continues all go
 * through it, and a model that had left would be refused there by name.
 *
 * It is NOT the fence for what a run CARRIES. A resume that names nothing
 * keeps the previous run's `requestedModel` without consulting this list at
 * all (`applyProviderChoice` in coding-agent.ts), and a stored id is read
 * back against a shape regex rather than against these entries
 * (`normalizeRequestedModel`). So dropping an id here does not stop one
 * already on a run record — it only stops the next caller naming it.
 */
export const ANTHROPIC_MODELS = [
  "claude-opus-5-5",
  "claude-fable-5-2",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
] as const;

export type AnthropicModel = (typeof ANTHROPIC_MODELS)[number];

/**
 * The model an `anthropic` run gets when the caller named none — the same one
 * a team's worker gets (`ROLE_DEFAULT_MODELS` in coding-role-models.ts), so a
 * one-task plan run as a single run is written by the model its tasks would
 * have been. Sonnet 5.5 since 2026-11-10: on this box it reached the same
 * hidden-test score as Opus 5.5 on both benchmark tasks for a quarter to a
 * half of the cost (docs/benchmarks/coding-anthropic-models-2026-11.md). A
 * caller that names a model still gets that model.
 */
export const DEFAULT_ANTHROPIC_MODEL: AnthropicModel = "claude-sonnet-5-5";

/**
 * The models offered for an `openai` run — the Codex CLI's own picker list.
 *
 * Read off the CLI rather than chosen here: `codex debug models` (codex-cli
 * 0.154.0) marks exactly these `visibility: list`, highest priority first. The
 * hidden ones beside them are a security research tier, retired ids the CLI
 * itself migrates away from (gpt-5.4, gpt-5.4-mini) and its own approval
 * reviewer — none of them a model a coding run should be started on.
 *
 * The same fence as ANTHROPIC_MODELS: what a caller may ASK for, never what a
 * stored record may carry.
 */
export const OPENAI_MODELS = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"] as const;

export type OpenAIModel = (typeof OPENAI_MODELS)[number];

/**
 * The model an `openai` run gets when the caller named none: the CLI's own
 * default, which is what `codex exec` reports in its header with nothing
 * configured (`model: gpt-6-astra`). Named explicitly rather than left to the
 * CLI so the record says which model ran and a resume re-enters on it.
 */
export const DEFAULT_OPENAI_MODEL: OpenAIModel = "gpt-6-astra";

/**
 * The owner's OpenAI API key, in the device secret store beside the Anthropic
 * account pool's credentials (src/lib/project-secrets.ts, device scope) —
 * never data/config.json, never a route's answer, never a log line. A run gets
 * it as `CODEX_API_KEY`, the variable `codex exec` authenticates with.
 */
export const OPENAI_SECRET_SCOPE = "@openai-coding";
export const OPENAI_API_KEY_SECRET_NAME = "OPENAI_API_KEY";

/**
 * What a `local` run's record says it was started on: the model the box's
 * engine serves, whichever that is when the run starts. Not a model id any
 * server knows — the wrapper puts the engine's own id in every slot
 * (scripts/claude-ds) and the route asks the engine for its model whatever a
 * request names — so a record keeps this label, and the run's init event
 * records the id that actually answered.
 */
export const LOCAL_ENGINE_MODEL = "local-engine";

/**
 * The CHEAPER model of each provider: what a coding team's role runs on when
 * the owner stored the `economy` tier for it (src/lib/coding-role-models.ts;
 * a role with nothing stored runs on `ROLE_DEFAULT_MODELS` there instead).
 *
 * On `clawbox-ai` it is the plan's flash tier, which EVERY plan may use (the
 * wrapper's own fallback and its small model — see scripts/claude-ds), and
 * every team role's default there too. It is the one model a `clawbox-ai` run's record may carry
 * (`isRecordableModel`); a CALLER still cannot name one for that provider.
 *
 * On `openai` it is the one the CLI's own catalogue describes as its fast and
 * affordable coding model, gpt-5.6-luna.
 */
export const ECONOMY_MODELS: Readonly<Record<CodingProvider, string>> = {
  "clawbox-ai": "deepseek-v4-flash",
  // The box's engine serves one model, whichever it is: every tier is it.
  local: LOCAL_ENGINE_MODEL,
  // Haiku 5.5 since 2026-11-10: Sonnet 5.5 became a worker's default, so the
  // cheaper tier is the model under it — it scored 111 of 111 on the same
  // hidden cases for a fraction of Sonnet's cost.
  anthropic: "claude-haiku-5-5",
  openai: "gpt-5.6-luna",
};

/** The cheaper model of this provider. */
export function economyModelForProvider(provider: CodingProvider): string {
  return ECONOMY_MODELS[provider];
}

/**
 * May a run of this provider carry this model on its record? Anything the
 * provider lets a caller name, and its economy model — which, on a provider
 * whose plan picks the model, only the box itself ever sets.
 */
export function isRecordableModel(provider: CodingProvider, model: unknown): model is string {
  if (typeof model !== "string" || !model) return false;
  return modelsForProvider(provider).includes(model) || model === ECONOMY_MODELS[provider];
}

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
  openai: "codingAgent.providerName.openai",
  local: "codingAgent.providerName.local",
};

export function isCodingProvider(value: unknown): value is CodingProvider {
  return typeof value === "string" && (CODING_PROVIDERS as readonly string[]).includes(value);
}

/** A stored or inherited value read as a provider; anything else is the default. */
export function codingProviderFrom(raw: unknown): CodingProvider {
  return isCodingProvider(raw) ? raw : DEFAULT_CODING_PROVIDER;
}

/** The connected providers off the record, in their stored order, unknown ids and repeats dropped; no usable list → the default provider alone. */
export function connectedProvidersFrom(raw: unknown, fallback: CodingProvider): CodingProvider[] {
  const out: CodingProvider[] = [];
  if (Array.isArray(raw)) for (const id of raw) if (isCodingProvider(id) && !out.includes(id)) out.push(id);
  return out.length > 0 ? out : [fallback];
}

/**
 * The models a caller may name for this provider.
 *
 * Empty for `clawbox-ai` — and that is a fact, not a gap: the ClawBox AI plan
 * decides which DeepSeek tier answers (see scripts/claude-ds), so a model
 * named here would either be ignored or 403'd upstream. The route refuses one
 * rather than pretending to honour it. Empty for `local` too: the box's
 * engine serves one model.
 */
export function modelsForProvider(provider: CodingProvider): readonly string[] {
  if (provider === "anthropic") return ANTHROPIC_MODELS;
  if (provider === "openai") return OPENAI_MODELS;
  return [];
}

/** The model an unnamed run gets, or null where the plan decides. */
export function defaultModelForProvider(provider: CodingProvider): string | null {
  if (provider === "anthropic") return DEFAULT_ANTHROPIC_MODEL;
  if (provider === "openai") return DEFAULT_OPENAI_MODEL;
  return null;
}

/** Does this provider's run answer from the box's own engine rather than a cloud account? */
export function runsOnLocalEngine(provider: CodingProvider): boolean {
  return provider === "local";
}

// ─── The local-only AI lock (TASK-2501) ──────────────────────────────────────

/**
 * The providers a box under the local-only AI lock may run on: its own engine
 * alone. ClawBox AI, Anthropic and OpenAI all send the run's code to a cloud
 * model, which is exactly what the lock forbids.
 */
export const LOCKED_CODING_PROVIDERS: readonly CodingProvider[] = Object.freeze(["local"]);

/** The providers a box may run on: all of them, or the box's engine alone under the lock. */
export function providersUnderLock(locked: boolean): readonly CodingProvider[] {
  return locked ? LOCKED_CODING_PROVIDERS : CODING_PROVIDERS;
}

/** The provider a run is on with nothing named: the owner's under no lock, the box's engine under it. */
export function lockedDefaultProvider(stored: CodingProvider, locked: boolean): CodingProvider {
  return locked && !LOCKED_CODING_PROVIDERS.includes(stored) ? "local" : stored;
}

/** The connected list as the box runs it: under the lock, the box's engine alone. */
export function lockedConnectedProviders(stored: readonly CodingProvider[], locked: boolean): CodingProvider[] {
  return locked ? [...LOCKED_CODING_PROVIDERS] : [...stored];
}

/**
 * Why Codex does not run under the lock. Checked against the pinned CLI
 * (config/codex-target.txt, 0.153.4): its provider config refuses
 * `wire_api = "chat"` ("no longer supported … set wire_api = \"responses\""),
 * so Codex reaches a model only through the Responses API (`/v1/responses`).
 * The box's engines serve Chat Completions, and the route that carries a
 * local run (src/lib/local-anthropic-route.ts) speaks Anthropic's Messages
 * API to Claude Code — so a Codex run pointed at the engine would fail on its
 * first request. Refused up front, in these words, instead.
 */
export const CODEX_LOCAL_REFUSAL =
  "Codex cannot run on the box's own engine: the Codex CLI this box runs (0.153.4) reaches a model only through the Responses API (/v1/responses), and the box's engine serves Chat Completions only. Coding runs under the local-only AI lock use Claude Code on the engine: provider \"local\".";

/** The words a refused cloud provider gets under the lock. */
export function lockedProviderRefusal(provider: CodingProvider): string {
  if (runsOnCodex(provider)) return `The local-only AI lock is on. ${CODEX_LOCAL_REFUSAL}`;
  return `The local-only AI lock is on: a coding run may not send its code to ${provider === "anthropic" ? "Anthropic" : "ClawBox AI"}'s cloud models. Use provider "local" (the box's own engine).`;
}

/** Does this provider's run go through the Codex CLI rather than Claude Code? */
export function runsOnCodex(provider: CodingProvider): boolean {
  return provider === "openai";
}

/**
 * The providers the settings panel OFFERS — its account rows, its per-role
 * selects and the OpenAI card, which all read `status.providers` — as against
 * CODING_PROVIDERS, what the box can run at all.
 *
 * Under the local-only AI lock the box's engine alone is offered. Otherwise
 * `local` is offered only where the owner already put it (connected or
 * default), and every other provider but `openai` is always offered. `openai` runs on the Codex
 * CLI (install.sh's `codex_cli` step, `isCodexInstalled` in coding-openai.ts),
 * and on a box without it the row and the card could only ever say "install
 * the CLI": noise on every box whose owner never asked for OpenAI (2026-10-30).
 * So it is offered when the CLI is there, OR when the owner already has it —
 * a saved credential, a place on the connected list, or the default — so an
 * account that was set up and then lost its CLI stays visible, with the
 * readiness check's reason beside it, rather than vanishing.
 *
 * Only what the panel shows. The run route and the MCP tool still accept the
 * id (CODING_PROVIDERS) and refuse an `openai` run for the missing CLI in words.
 */
export function offeredProviders(state: {
  codexInstalled: boolean;
  openaiConnected: boolean;
  connected: readonly CodingProvider[];
  defaultProvider: CodingProvider;
  /** The local-only AI lock: the box's engine is then the one provider offered. */
  locked?: boolean;
}): CodingProvider[] {
  if (state.locked === true) return [...LOCKED_CODING_PROVIDERS];
  return CODING_PROVIDERS.filter((id) => {
    // The box's engine is the locked box's provider. On any other box it is
    // offered only where the owner already put it — nothing changes for a
    // box that never asked for it.
    if (runsOnLocalEngine(id)) return state.connected.includes(id) || state.defaultProvider === id;
    return !runsOnCodex(id)
      || state.codexInstalled
      || state.openaiConnected
      || state.connected.includes(id)
      || state.defaultProvider === id;
  });
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
      error: resolved === "local"
        ? "A local run answers on the one model the box's engine serves, so a model cannot be named for it."
        : "ClawBox AI chooses the model from the box's plan, so a model cannot be named for it. Use provider \"anthropic\" or \"openai\" to choose a model.",
    };
  }
  if (!allowed.includes(model)) {
    return { ok: false, error: `Unknown model for ${resolved}. Use one of: ${allowed.join(", ")}.` };
  }
  return { ok: true, provider: resolved, model };
}
