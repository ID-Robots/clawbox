/**
 * WHICH MODEL, AND HOW HARD IT THINKS, FOR EACH ROLE OF A CODING TEAM.
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
 * owner's model and effort. The owner may override either half per role in
 * the Coding Agent settings (`coding_agent_role_models`); a box that never
 * opens that section runs on the defaults with no config change.
 *
 * PURE ON PURPOSE, like coding-provider.ts: the settings panel imports it to
 * draw the choices and the route to validate them, and neither may pull the
 * runner in. The effort levels are restated here rather than imported from
 * coding-agent.ts for the same reason; `coding-role-models.test.ts` pins the
 * two lists equal.
 */
import { economyModelForProvider, type CodingProvider } from "./coding-provider";

/** The owner's per-role choices, in data/config.json. Absent on every box that never chose. */
export const CODING_AGENT_ROLE_MODELS_CONFIG_KEY = "coding_agent_role_models";

/** The roles a choice is made for. The lead is the planner's: same run, back for a moment. */
export const MODEL_ROLES = ["planner", "worker", "reviewer"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** `standard`: the owner's own model for the provider. `economy`: the provider's cheaper one. */
export const ROLE_MODEL_TIERS = ["standard", "economy"] as const;
export type RoleModelTier = (typeof ROLE_MODEL_TIERS)[number];

/** Claude Code's effort levels, weakest first — the same list as coding-agent.ts's EFFORT_LEVELS. */
export const ROLE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export type RoleEffort = (typeof ROLE_EFFORT_LEVELS)[number];

/** What the panel and the route call "the role's default": no override stored. */
export const ROLE_AUTO = "auto";

export interface RoleModelChoice {
  model?: RoleModelTier;
  effort?: RoleEffort;
}

export type RoleModels = Partial<Record<ModelRole, RoleModelChoice>>;

/** What a role gets with nothing stored: its tier, and the effort it never goes above (null: the owner's). */
export const ROLE_DEFAULTS: Readonly<Record<ModelRole, { model: RoleModelTier; effortCap: RoleEffort | null }>> = {
  planner: { model: "economy", effortCap: "xhigh" },
  worker: { model: "standard", effortCap: null },
  reviewer: { model: "economy", effortCap: "xhigh" },
};

/** A team run's role, as the choice is made for it. */
export function modelRoleOf(teamRole: "planner" | "worker" | "reviewer" | "lead"): ModelRole {
  return teamRole === "lead" ? "planner" : teamRole;
}

function isTier(value: unknown): value is RoleModelTier {
  return typeof value === "string" && (ROLE_MODEL_TIERS as readonly string[]).includes(value);
}

export function isRoleEffort(value: unknown): value is RoleEffort {
  return typeof value === "string" && (ROLE_EFFORT_LEVELS as readonly string[]).includes(value);
}

/** The weaker of two levels. */
export function weakerEffort(a: RoleEffort, b: RoleEffort): RoleEffort {
  return ROLE_EFFORT_LEVELS.indexOf(a) <= ROLE_EFFORT_LEVELS.indexOf(b) ? a : b;
}

/**
 * The stored choices, read back: only the fields this module could have
 * written survive; anything else on a hand-edited config is no choice at all
 * (the role's default), never an error that stops a team.
 */
export function roleModelsFrom(raw: unknown): RoleModels {
  const out: RoleModels = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const role of MODEL_ROLES) {
    const entry = (raw as Record<string, unknown>)[role];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { model, effort } = entry as Record<string, unknown>;
    const choice: RoleModelChoice = {};
    if (isTier(model)) choice.model = model;
    if (isRoleEffort(effort)) choice.effort = effort;
    if (choice.model || choice.effort) out[role] = choice;
  }
  return out;
}

/**
 * The owner's edit — `{ planner?: { model?, effort? }, … }`, where `"auto"`
 * (or null) puts that half back to the role's default — applied to what is
 * stored. Refused WHOLE, with the reason, on anything it does not know: a
 * settings write that saved half of what was asked is the kind of surprise a
 * per-role price knob must not have.
 */
export function applyRoleModelsPatch(current: RoleModels, patch: unknown): { ok: true; value: RoleModels } | { ok: false; error: string } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { ok: false, error: "roleModels must be an object keyed by role (planner, worker, reviewer)." };
  }
  const next: RoleModels = JSON.parse(JSON.stringify(roleModelsFrom(current))) as RoleModels;
  for (const [role, entry] of Object.entries(patch as Record<string, unknown>)) {
    if (!(MODEL_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: `Unknown role "${role}". Use one of: ${MODEL_ROLES.join(", ")}.` };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `roleModels.${role} must be an object: { model?, effort? }.` };
    }
    const choice: RoleModelChoice = { ...(next[role as ModelRole] ?? {}) };
    for (const [field, value] of Object.entries(entry as Record<string, unknown>)) {
      const reset = value === null || value === ROLE_AUTO;
      if (field === "model") {
        if (reset) delete choice.model;
        else if (isTier(value)) choice.model = value;
        else return { ok: false, error: `roleModels.${role}.model must be one of: ${ROLE_AUTO}, ${ROLE_MODEL_TIERS.join(", ")}.` };
      } else if (field === "effort") {
        if (reset) delete choice.effort;
        else if (isRoleEffort(value)) choice.effort = value;
        else return { ok: false, error: `roleModels.${role}.effort must be one of: ${ROLE_AUTO}, ${ROLE_EFFORT_LEVELS.join(", ")}.` };
      } else {
        return { ok: false, error: `roleModels.${role} takes model and effort only.` };
      }
    }
    if (choice.model || choice.effort) next[role as ModelRole] = choice;
    else delete next[role as ModelRole];
  }
  return { ok: true, value: next };
}

/**
 * What one role's run starts with: its tier, the model that tier means on
 * this provider, and its effort.
 *
 * @param ownerModel the model a run of this provider gets when nobody named one
 *   (`defaultModelForProvider`: null where the plan decides)
 * @param ownerEffort the owner's own effort setting
 */
export function resolveRoleRun(
  role: ModelRole,
  provider: CodingProvider,
  ownerModel: string | null,
  ownerEffort: RoleEffort,
  stored: RoleModels,
): { tier: RoleModelTier; model: string | null; effort: RoleEffort } {
  const choice = stored[role] ?? {};
  const defaults = ROLE_DEFAULTS[role];
  const tier = choice.model ?? defaults.model;
  const effort = choice.effort ?? (defaults.effortCap ? weakerEffort(ownerEffort, defaults.effortCap) : ownerEffort);
  return { tier, model: tier === "economy" ? economyModelForProvider(provider) : ownerModel, effort };
}

/**
 * The choices as the panel draws them: every role, every half, `"auto"` where
 * nothing is stored — so a client never has to know which roles exist to read
 * an answer.
 */
export function roleModelsView(stored: RoleModels): Record<ModelRole, { model: RoleModelTier | typeof ROLE_AUTO; effort: RoleEffort | typeof ROLE_AUTO }> {
  const view = {} as Record<ModelRole, { model: RoleModelTier | typeof ROLE_AUTO; effort: RoleEffort | typeof ROLE_AUTO }>;
  for (const role of MODEL_ROLES) {
    view[role] = { model: stored[role]?.model ?? ROLE_AUTO, effort: stored[role]?.effort ?? ROLE_AUTO };
  }
  return view;
}
