/**
 * WHICH ACCOUNT, WHICH MODEL, AND HOW HARD IT THINKS, FOR EACH ROLE OF A CODING TEAM.
 *
 * A team's planner reads the folder and answers a JSON plan; its reviewers
 * read a diff and answer a verdict; only its workers write the code. Every one
 * of them used to run on the owner's model at the owner's effort — `ultracode`
 * on the most capable model, by default — so a three-task team paid top price
 * for six or seven runs of which three wrote anything.
 *
 * So a planner (and the lead, which is the planner back for a moment) and a
 * reviewer default to the provider's CHEAPER model (`ECONOMY_MODELS`:
 * `claude-sonnet-5` on Anthropic, the plan's flash tier on ClawBox AI) and to
 * at most `xhigh` effort — never MORE than the owner's own. Workers keep the
 * owner's model and effort.
 *
 * The owner may override any of three halves per role in the Coding Agent
 * settings (`coding_agent_role_models`): the PROVIDER that pays for the role's
 * runs, the MODEL — a tier (`standard`, `economy`) or one model that provider
 * offers (`roleModelOptions`) — and the EFFORT. A box that never opens that
 * section, or that stored the older `{ model: standard|economy }` shape, runs
 * exactly as it did before: the role on the team's own provider.
 *
 * PURE ON PURPOSE, like coding-provider.ts: the settings panel imports it to
 * draw the choices and the route to validate them, and neither may pull the
 * runner in. The effort levels are restated here rather than imported from
 * coding-agent.ts for the same reason; `coding-role-models.test.ts` pins the
 * two lists equal.
 */
import {
  ANTHROPIC_MODELS,
  CODING_PROVIDERS,
  OPENAI_MODELS,
  defaultModelForProvider,
  economyModelForProvider,
  isCodingProvider,
  type CodingProvider,
} from "./coding-provider";

/** The owner's per-role choices, in data/config.json. Absent on every box that never chose. */
export const CODING_AGENT_ROLE_MODELS_CONFIG_KEY = "coding_agent_role_models";

/**
 * The roles a choice is made for. The lead is the planner's: same run, back
 * for a moment. (A fourth, `bulk` — a worker on a task the plan marked
 * token-heavy — was deleted on 2026-10-30: no board ever marked a task bulk,
 * and a stored `bulk` choice is dropped by `roleModelsFrom` like any unknown
 * role.)
 */
export const MODEL_ROLES = ["planner", "worker", "reviewer"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** `standard`: the owner's own model for the provider. `economy`: the provider's cheaper one. */
export const ROLE_MODEL_TIERS = ["standard", "economy"] as const;
export type RoleModelTier = (typeof ROLE_MODEL_TIERS)[number];

/** Where a resolved run's model came from: a tier, or a model the owner named for the role. */
export type ResolvedRoleTier = RoleModelTier | "chosen";

/** Claude Code's effort levels, weakest first — the same list as coding-agent.ts's EFFORT_LEVELS. */
export const ROLE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export type RoleEffort = (typeof ROLE_EFFORT_LEVELS)[number];

/** What the panel and the route call "the role's default": no override stored. */
export const ROLE_AUTO = "auto";

/** The halves of one role's choice — the only fields a patch may carry. */
const CHOICE_FIELDS = ["provider", "model", "effort"] as const;

export interface RoleModelChoice {
  /** The account that pays for this role's runs. Absent: the team's own. */
  provider?: CodingProvider;
  /**
   * A tier (`standard` | `economy`), or a model id from
   * `roleModelOptions(provider)` — an id is only ever stored beside the
   * provider it belongs to. Absent: the role's default tier, or, where a
   * provider is stored, that provider's default model (`standard`).
   */
  model?: string;
  effort?: RoleEffort;
}

export type RoleModels = Partial<Record<ModelRole, RoleModelChoice>>;

/**
 * What a role gets with nothing stored: its tier, the effort it never goes
 * above and the steps it never gets more of (null: the owner's).
 *
 * The two caps hold even against a stored per-role effort: a planner or a
 * reviewer reads and answers, and ultracode's fan-out (coding-agent.ts,
 * WORKFLOW_TOOL) has nothing to orchestrate for a run that writes nothing —
 * measured on the owner's box, a planner stored on ultracode spent 5.7M tokens
 * reading one folder. The step cap is the same thought: a reader's answer is
 * a page, not a project, and the owner's ceiling (up to 2,000) is sized for
 * the worker that writes one.
 */
export const ROLE_DEFAULTS: Readonly<Record<ModelRole, { model: RoleModelTier; effortCap: RoleEffort | null; turnsCap: number | null }>> = {
  planner: { model: "economy", effortCap: "xhigh", turnsCap: 100 },
  worker: { model: "standard", effortCap: null, turnsCap: null },
  reviewer: { model: "economy", effortCap: "xhigh", turnsCap: 100 },
};

/** The steps a role's run gets: the owner's ceiling, or the role's cap where it has one. */
export function roleMaxTurns(role: ModelRole, ownerMaxTurns: number): number {
  const cap = ROLE_DEFAULTS[role].turnsCap;
  return cap === null ? ownerMaxTurns : Math.min(ownerMaxTurns, cap);
}

/**
 * The models a role may be pinned to on each provider.
 *
 * Anthropic and OpenAI: the coding fence itself (`ANTHROPIC_MODELS`,
 * `OPENAI_MODELS`), so a role can name nothing a run could not. ClawBox AI: its flash tier alone — the one model
 * every plan may use and the one a `clawbox-ai` record may carry
 * (`isRecordableModel`). Never the pro tier: it is Max-plan only, and a role
 * pinned to it would fail every run on any other plan.
 */
const ROLE_MODEL_OPTIONS: Readonly<Record<CodingProvider, readonly string[]>> = {
  "clawbox-ai": [economyModelForProvider("clawbox-ai")],
  anthropic: ANTHROPIC_MODELS,
  openai: OPENAI_MODELS,
};

/** The models a role may name on this provider. */
export function roleModelOptions(provider: CodingProvider): readonly string[] {
  return ROLE_MODEL_OPTIONS[provider];
}

/** Is this a model a role may name on this provider? */
export function isRoleModelId(provider: CodingProvider, value: unknown): value is string {
  return typeof value === "string" && roleModelOptions(provider).includes(value);
}

/**
 * Roughly what a token costs on each model, the plan's flash tier = 1.
 *
 * COARSE ON PURPOSE: rounded ratios of public list prices, input and output
 * blended, for a planner to weigh which role a task goes to and for the
 * settings to say "about 20×". Never a bill — what a run spent is its own
 * token count. Every model a role may name is here (pinned by the tests), so
 * the map a planner reads never has a hole in it.
 */
export const RELATIVE_MODEL_COST: Readonly<Record<string, number>> = {
  "deepseek-v4-flash": 1,
  "claude-sonnet-5": 10,
  "claude-opus-5": 20,
  "claude-opus-5-5": 20,
  "claude-fable-5-1": 40,
  // OpenAI's: TIER ESTIMATES, not list prices — read off the Codex CLI's own
  // catalogue descriptions (flagship, balanced everyday, fast and affordable)
  // and set level with the Anthropic tier each one stands beside. OpenAI's
  // prices for this generation were not checked from the box; correct these
  // to rounded price ratios once they are.
  "gpt-6-astra": 20,
  "gpt-5.6-sol": 20,
  "gpt-5.6-terra": 10,
  "gpt-5.6-luna": 3,
  "gpt-5.5": 10,
  "gpt-5.2": 10,
};

/**
 * What a run of this provider on this model costs, relative to the flash
 * tier — or null where nobody can say: a model the provider does not offer, or
 * no model at all on a provider whose plan decides (ClawBox AI's own default).
 *
 * @param model the run's model; null for the provider's default
 */
export function relativeModelCost(provider: CodingProvider, model: string | null): number | null {
  const id = model ?? defaultModelForProvider(provider);
  if (id === null || !isRoleModelId(provider, id)) return null;
  return Object.prototype.hasOwnProperty.call(RELATIVE_MODEL_COST, id) ? RELATIVE_MODEL_COST[id] : null;
}

/** A team run's role, as the choice is made for it: the lead's is the planner's. */
export function modelRoleOf(teamRole: "planner" | "worker" | "reviewer" | "lead"): ModelRole {
  return teamRole === "lead" ? "planner" : teamRole;
}

function isTier(value: unknown): value is RoleModelTier {
  return typeof value === "string" && (ROLE_MODEL_TIERS as readonly string[]).includes(value);
}

export function isRoleEffort(value: unknown): value is RoleEffort {
  return typeof value === "string" && (ROLE_EFFORT_LEVELS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEmptyChoice(choice: RoleModelChoice): boolean {
  return choice.provider === undefined && choice.model === undefined && choice.effort === undefined;
}

/** The weaker of two levels. */
export function weakerEffort(a: RoleEffort, b: RoleEffort): RoleEffort {
  return ROLE_EFFORT_LEVELS.indexOf(a) <= ROLE_EFFORT_LEVELS.indexOf(b) ? a : b;
}

/**
 * The stored choices, read back: only the fields this module could have
 * written survive; anything else on a hand-edited config — a role this build
 * no longer has (`bulk`) included — is no choice at all (the role's default),
 * never an error that stops a team. A model id without
 * its provider, or one its provider no longer offers, is dropped on its own —
 * the provider the owner chose stays, on its default model.
 */
export function roleModelsFrom(raw: unknown): RoleModels {
  const out: RoleModels = {};
  if (!isPlainObject(raw)) return out;
  for (const role of MODEL_ROLES) {
    const entry = raw[role];
    if (!isPlainObject(entry)) continue;
    const { provider, model, effort } = entry;
    const choice: RoleModelChoice = {};
    if (isCodingProvider(provider)) choice.provider = provider;
    if (isTier(model) || (choice.provider && isRoleModelId(choice.provider, model))) choice.model = model as string;
    if (isRoleEffort(effort)) choice.effort = effort;
    if (!isEmptyChoice(choice)) out[role] = choice;
  }
  return out;
}

/** The one sentence for a model value that is neither a tier nor a model any provider offers. */
function unknownModel(role: string): string {
  const offered = CODING_PROVIDERS.map((p) => `${p}: ${roleModelOptions(p).join(", ")}`).join("; ");
  return `roleModels.${role}.model must be one of: ${ROLE_AUTO}, ${ROLE_MODEL_TIERS.join(", ")} — or a model its provider offers (${offered}).`;
}

/**
 * The owner's edit — `{ planner?: { provider?, model?, effort? }, … }`, where
 * `"auto"` (or null) puts that half back to the role's default — applied to
 * what is stored. Refused WHOLE, with the reason, on anything it does not
 * know: an unknown role or field, a value off its list, or a model id its
 * provider does not offer. A settings write that saved half of what was asked
 * is the kind of surprise a per-role price knob must not have.
 *
 * A model id belongs to its provider. One named without a provider takes the
 * role's stored provider and is refused where there is none; a provider
 * changed (or reset) WITHOUT naming the model drops a stored id the new
 * provider does not offer, so the role lands on that provider's default
 * rather than on a pair no run could start. A tier survives either change.
 */
export function applyRoleModelsPatch(current: RoleModels, patch: unknown): { ok: true; value: RoleModels } | { ok: false; error: string } {
  if (!isPlainObject(patch)) {
    return { ok: false, error: `roleModels must be an object keyed by role (${MODEL_ROLES.join(", ")}).` };
  }
  const next: RoleModels = JSON.parse(JSON.stringify(roleModelsFrom(current))) as RoleModels;
  for (const [role, entry] of Object.entries(patch)) {
    if (!(MODEL_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: `Unknown role "${role}". Use one of: ${MODEL_ROLES.join(", ")}.` };
    }
    if (!isPlainObject(entry)) {
      return { ok: false, error: `roleModels.${role} must be an object: { provider?, model?, effort? }.` };
    }
    if (Object.keys(entry).some((field) => !(CHOICE_FIELDS as readonly string[]).includes(field))) {
      return { ok: false, error: `roleModels.${role} takes provider, model and effort only.` };
    }
    const choice: RoleModelChoice = { ...(next[role as ModelRole] ?? {}) };
    const reset = (value: unknown) => value === null || value === ROLE_AUTO;

    // The provider first, whatever order the body spelled them in: the model
    // half is checked against the provider this edit leaves the role on.
    if ("provider" in entry) {
      const value = entry.provider;
      if (reset(value)) delete choice.provider;
      else if (isCodingProvider(value)) choice.provider = value;
      else return { ok: false, error: `roleModels.${role}.provider must be one of: ${ROLE_AUTO}, ${CODING_PROVIDERS.join(", ")}.` };
      if (!("model" in entry) && choice.model !== undefined && !isTier(choice.model)
        && !(choice.provider && isRoleModelId(choice.provider, choice.model))) {
        delete choice.model;
      }
    }
    if ("model" in entry) {
      const value = entry.model;
      if (reset(value)) delete choice.model;
      else if (isTier(value)) choice.model = value;
      else if (choice.provider && isRoleModelId(choice.provider, value)) choice.model = value;
      else if (choice.provider && typeof value === "string" && CODING_PROVIDERS.some((p) => isRoleModelId(p, value))) {
        return { ok: false, error: `roleModels.${role}.model is not offered on ${choice.provider}. Use one of: ${ROLE_AUTO}, ${ROLE_MODEL_TIERS.join(", ")}, ${roleModelOptions(choice.provider).join(", ")}.` };
      } else if (!choice.provider && typeof value === "string" && CODING_PROVIDERS.some((p) => isRoleModelId(p, value))) {
        return { ok: false, error: `roleModels.${role}.model names a model, so roleModels.${role}.provider must name the account it runs on.` };
      } else {
        return { ok: false, error: unknownModel(role) };
      }
    }
    if ("effort" in entry) {
      const value = entry.effort;
      if (reset(value)) delete choice.effort;
      else if (isRoleEffort(value)) choice.effort = value;
      else return { ok: false, error: `roleModels.${role}.effort must be one of: ${ROLE_AUTO}, ${ROLE_EFFORT_LEVELS.join(", ")}.` };
    }
    if (isEmptyChoice(choice)) delete next[role as ModelRole];
    else next[role as ModelRole] = choice;
  }
  return { ok: true, value: next };
}

/** What one role's run starts with. */
export interface RoleRun {
  /** The account that pays for it — the team's own unless the role names one. */
  provider: CodingProvider;
  /** The model on that provider, or null where the provider's plan decides. */
  model: string | null;
  effort: RoleEffort;
  /** `standard`/`economy` for a tier, `chosen` for a model the owner named. */
  tier: ResolvedRoleTier;
  /**
   * True when nothing stored chose the provider or the model: the role's
   * default tier on the team's own provider. The effort half says nothing here.
   */
  auto: boolean;
}

/**
 * What one role's run starts with: its provider, its model there, its effort.
 *
 * With nothing stored — or the older `{ model: standard|economy }` — the
 * answer is the team's own provider, exactly as before this module knew about
 * providers. A provider stored without a model is that provider's default
 * model (the `standard` tier there); `standard` on the team's own provider is
 * `ownerModel`, the model the team's runs would carry anyway.
 *
 * @param ownerProvider the provider the team's runs are on (the owner's
 *   default, or the one the start named)
 * @param ownerModel the model a run of that provider gets when nobody named
 *   one for the role (`defaultModelForProvider`: null where the plan decides)
 * @param ownerEffort the owner's own effort setting
 */
export function resolveRoleRun(
  role: ModelRole,
  ownerProvider: CodingProvider,
  ownerModel: string | null,
  ownerEffort: RoleEffort,
  stored: RoleModels,
): RoleRun {
  const own = stored[role] ?? {};
  const auto = own.provider === undefined && own.model === undefined;
  const provider = own.provider ?? ownerProvider;
  const value = own.model ?? (own.provider ? "standard" : ROLE_DEFAULTS[role].model);
  let model: string | null;
  let tier: ResolvedRoleTier;
  if (value === "economy") {
    model = economyModelForProvider(provider);
    tier = "economy";
  } else if (value !== "standard" && isRoleModelId(provider, value)) {
    model = value;
    tier = "chosen";
  } else {
    // `standard` — and, defensively, an id its provider does not offer, which
    // `roleModelsFrom` never lets through: the provider's default, not a run
    // that fails minutes in on a model its account cannot reach.
    model = provider === ownerProvider ? ownerModel : defaultModelForProvider(provider);
    tier = "standard";
  }

  // The cap holds against a stored effort too (see ROLE_DEFAULTS): the
  // owner's choice can lower a planner or a reviewer, never lift it past xhigh.
  const cap = ROLE_DEFAULTS[role].effortCap;
  const chosen = own.effort ?? ownerEffort;
  const effort = cap ? weakerEffort(chosen, cap) : chosen;
  return { provider, model, effort, tier, auto };
}

/** One role as the panel draws it: every half, `"auto"` where nothing is stored. */
export interface RoleModelsViewEntry {
  provider: CodingProvider | typeof ROLE_AUTO;
  /** `"auto"`, a tier, or a model id of `provider`. */
  model: string;
  effort: RoleEffort | typeof ROLE_AUTO;
}

/**
 * The choices as the panel draws them: every role, every half, `"auto"` where
 * nothing is stored — so a client never has to know which roles exist to read
 * an answer.
 */
export function roleModelsView(stored: RoleModels): Record<ModelRole, RoleModelsViewEntry> {
  const view = {} as Record<ModelRole, RoleModelsViewEntry>;
  for (const role of MODEL_ROLES) {
    view[role] = {
      provider: stored[role]?.provider ?? ROLE_AUTO,
      model: stored[role]?.model ?? ROLE_AUTO,
      effort: stored[role]?.effort ?? ROLE_AUTO,
    };
  }
  return view;
}
