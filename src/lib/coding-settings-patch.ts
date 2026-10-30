/**
 * THE CODING TEAM'S PREFERENCES THE ASSISTANT MAY CHANGE — and the ones it may not.
 *
 * Every coding-agent setting is written through POST /setup-api/coding-agent/enable,
 * which admits a PERSON's browser session alone: among its fields is the
 * owner's switch for a delegated shell, and the agent — which holds the MCP
 * bearer middleware admits everywhere else — must not be able to grant itself
 * that consent. The owner then asked (2026-10-30) for the assistant to be able
 * to tune the coding TEAM's parameters from the chat: "make the planner run on
 * Sonnet", "turn the review pass on", "allow three runs at once".
 *
 * This module is the seam between the two: the AGENT-SETTABLE set, its
 * validation and its application, built from exactly the validators and
 * setters the enable route uses (`src/lib/coding-agent.ts`,
 * `src/lib/coding-role-models.ts`) so the two doors refuse in one voice and
 * can never disagree about what a value means. `/setup-api/coding-agent/settings`
 * is its route, admitted to the owner's session OR the MCP bearer; the
 * `coding_settings_get` / `coding_settings_set` MCP tools call that route.
 *
 * EXCLUDED ON PURPOSE — the owner's consent surfaces, which stay on the fenced
 * enable route (or their own fenced routes) and are refused here by name with
 * a message that sends the caller to the Settings page:
 *
 *   - `enabled` — the switch for a delegated shell IS the consent.
 *   - `defaultDirectory` — where unattended runs work; the agent choosing
 *     the folder it is let loose in is the folder fence turned inside out.
 *   - `provider` / `providers` — connecting an account spends the owner's
 *     money or credentials; a role may only be PINNED to a provider the owner
 *     already connected (checked below).
 *   - `realBrowser` — putting a browser on the owner's screen is a consent,
 *     and a tool that could turn it back on makes the owner's "no" temporary
 *     (the same reason `browser_auto_open` has no tool).
 *   - `allowRules` (`coding-agent/permissions`), `injectSecrets` and the
 *     secret store (`coding-agent/secrets`) — what a run may do and what it is
 *     handed; both carry a same-origin fence on top of the cookie.
 *   - `setupComplete`, `clearHarnessFault` — the wizard's and the fault's
 *     state, the owner's to move.
 *
 * PURE VALIDATION FIRST, then the writes: a patch is checked WHOLE and refused
 * before any setter runs, the way the enable route checks its body, so a body
 * carrying a good effort and a bad parallel-run count moves nothing.
 */
import {
  checkRoleModelsPatch,
  getCodingAgentStatus,
  HISTORY_RETENTION_MODES,
  hostMaxParallelRuns,
  MIN_MAX_PARALLEL_RUNS,
  OFFERED_EFFORT_LEVELS,
  setAutoMerge,
  setAutoPr,
  setCodingGitAuthor,
  setEffort,
  setGenerateMedia,
  setHistoryRetention,
  setMaxParallelRuns,
  setPrBodyIncludesTask,
  setReviewPass,
  setRoleModels,
  setTeamDynamic,
  type CodingAgentStatus,
  type HistoryRetentionChange,
} from "./coding-agent";
import { CODING_GIT_EMAIL_REFUSAL, CODING_GIT_NAME_REFUSAL, normalizeCodingGitEmail, normalizeCodingGitName } from "./coding-git-identity";
import { PR_BODY_TASK_MODES } from "./coding-pr-body";
import { isCodingProvider, type CodingProvider } from "./coding-provider";
import { MODEL_ROLES, ROLE_AUTO, ROLE_EFFORT_LEVELS, ROLE_MODEL_TIERS, roleModelOptions } from "./coding-role-models";
import { logSafe } from "./log-safe";

/** The fields the assistant may change, in the order the enable route applies them. */
export const AGENT_SETTABLE_FIELDS = [
  "gitAuthorName",
  "gitAuthorEmail",
  "effort",
  "roleModels",
  "reviewPass",
  "autoPr",
  "prBodyIncludesTask",
  "autoMerge",
  "maxParallelRuns",
  "historyRetention",
  "generateMedia",
  "teamDynamic",
] as const;
export type AgentSettableField = (typeof AGENT_SETTABLE_FIELDS)[number];

/**
 * The enable route's fields this door refuses BY NAME — see the module
 * comment for why each one. Named, rather than left to "unknown field", so
 * the refusal can say where the owner changes it instead of implying a typo.
 */
export const OWNER_ONLY_FIELDS = [
  "enabled",
  "defaultDirectory",
  "provider",
  "providers",
  "realBrowser",
  "allowRules",
  "injectSecrets",
  "secrets",
  "setupComplete",
  "clearHarnessFault",
] as const;

/** Where the owner changes what this door refuses — the sentence every such refusal ends with. */
export const SETTINGS_PAGE_SENTENCE = "The owner changes it on the Coding Agent app's Settings page.";

/** The refusal `kind` for a field the assistant may never change (400, beside `invalid` for a bad value). */
export const OWNER_SETTING_KIND = "owner_setting";

/**
 * The current values of exactly the settable set, plus the choices a caller
 * needs to offer valid ones: what `getCodingAgentStatus` already knows, cut
 * down to what the assistant may touch.
 */
export interface CodingSettingsView {
  effort: CodingAgentStatus["effort"];
  /** The levels the panel offers — what `effort` may be set to. */
  effortLevels: readonly string[];
  /** Every role, every half, "auto" where nothing is stored. */
  roleModels: CodingAgentStatus["roleModels"];
  /** What each role resolves to right now, and whether its provider can run. */
  roleModelMap: CodingAgentStatus["roleModelMap"];
  /** `auto` resets a half; a role's `model` may also be one of these tiers or a model id of its provider. */
  roleModelTiers: readonly string[];
  /** The levels a role's own `effort` may be pinned to (a planner or reviewer never runs above xhigh). */
  roleEffortLevels: readonly string[];
  /** The accounts the owner connected — the only providers a role may be pinned to. */
  connectedProviders: CodingProvider[];
  /** The models a role may be pinned to on each connected provider. */
  providerModels: Record<string, readonly string[]>;
  reviewPass: boolean;
  autoPr: boolean;
  autoMerge: boolean;
  prBodyIncludesTask: CodingAgentStatus["prBodyIncludesTask"];
  prBodyTaskModes: readonly string[];
  teamDynamic: boolean;
  maxParallelRuns: number;
  minMaxParallelRuns: number;
  maxMaxParallelRuns: number;
  historyRetention: CodingAgentStatus["historyRetention"];
  historyRetentionModes: readonly string[];
  generateMedia: boolean;
  gitAuthorName: string | null;
  gitAuthorEmail: string | null;
  maxGitAuthorChars: number;
}

/** The settable set as it stands, off one status read. */
export async function readCodingSettings(): Promise<CodingSettingsView> {
  return settingsViewFrom(await getCodingAgentStatus());
}

/** The view cut out of a status the caller already holds (the route re-reads once after a write). */
export function settingsViewFrom(status: CodingAgentStatus): CodingSettingsView {
  return {
    effort: status.effort,
    effortLevels: status.effortLevels,
    roleModels: status.roleModels,
    roleModelMap: status.roleModelMap,
    roleModelTiers: ROLE_MODEL_TIERS,
    roleEffortLevels: ROLE_EFFORT_LEVELS,
    connectedProviders: status.connectedProviders,
    providerModels: Object.fromEntries(status.connectedProviders.map((p) => [p, roleModelOptions(p)])),
    reviewPass: status.reviewPass,
    autoPr: status.autoPr,
    autoMerge: status.autoMerge,
    prBodyIncludesTask: status.prBodyIncludesTask,
    prBodyTaskModes: PR_BODY_TASK_MODES,
    teamDynamic: status.teamDynamic,
    maxParallelRuns: status.maxParallelRuns,
    minMaxParallelRuns: status.minMaxParallelRuns,
    maxMaxParallelRuns: status.maxMaxParallelRuns,
    historyRetention: status.historyRetention,
    historyRetentionModes: HISTORY_RETENTION_MODES,
    generateMedia: status.generateMedia,
    gitAuthorName: status.gitAuthorName,
    gitAuthorEmail: status.gitAuthorEmail,
    maxGitAuthorChars: status.maxGitAuthorChars,
  };
}

/** A patch that passed `checkCodingSettingsPatch`: only settable fields, each of the right shape. */
export type CodingSettingsPatch = Partial<Record<AgentSettableField, unknown>>;

export type CodingSettingsCheck =
  | { ok: true; patch: CodingSettingsPatch; fields: AgentSettableField[] }
  | { ok: false; error: string; kind: typeof OWNER_SETTING_KIND | "invalid" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const refuse = (error: string, kind: typeof OWNER_SETTING_KIND | "invalid" = "invalid"): CodingSettingsCheck => ({ ok: false, error, kind });

/** The sentence a bad switch value gets — the setters' own wording, per switch. */
const SWITCH_REFUSAL: Readonly<Record<string, string>> = {
  reviewPass: "The review pass switch must be true or false.",
  autoPr: "The pull-request switch must be true or false.",
  autoMerge: "The merge switch must be true or false.",
  generateMedia: "The media switch must be true or false.",
  teamDynamic: "The team lead switch must be true or false.",
};

/**
 * Is this body a patch this door may apply? Refused WHOLE — before any setter
 * runs — on a field the assistant may never change (`owner_setting`, naming
 * the Settings page), a field nobody knows, an empty body, or any value the
 * enable route would refuse, with the enable route's own sentence.
 *
 * The role-model check reads what is stored (a model named alone runs on the
 * role's stored provider), which is why this is async. On top of
 * `checkRoleModelsPatch`, a role's PROVIDER must be one the owner connected:
 * the enable route lets the owner pick a provider before pasting its key, but
 * the assistant pinning a role to an account nobody connected is a team that
 * cannot start, and the choice of which accounts pay is the owner's.
 */
export async function checkCodingSettingsPatch(body: unknown, connectedProviders: readonly CodingProvider[]): Promise<CodingSettingsCheck> {
  if (!isPlainObject(body)) return refuse("Invalid request body: expected an object of settings to change.");
  const keys = Object.keys(body);
  for (const key of keys) {
    if ((OWNER_ONLY_FIELDS as readonly string[]).includes(key)) {
      return refuse(`"${key}" is not a setting the assistant may change. ${SETTINGS_PAGE_SENTENCE}`, OWNER_SETTING_KIND);
    }
    if (!(AGENT_SETTABLE_FIELDS as readonly string[]).includes(key)) {
      return refuse(`Unknown setting "${key}". The settings that can be changed here: ${AGENT_SETTABLE_FIELDS.join(", ")}.`);
    }
  }
  if (keys.length === 0) {
    return refuse(`Nothing to change. Name at least one of: ${AGENT_SETTABLE_FIELDS.join(", ")}.`);
  }
  const patch = body as CodingSettingsPatch;

  if ("effort" in patch && !(OFFERED_EFFORT_LEVELS as readonly unknown[]).includes(patch.effort)) {
    return refuse(`Effort must be one of: ${OFFERED_EFFORT_LEVELS.join(", ")}.`);
  }
  for (const field of Object.keys(SWITCH_REFUSAL)) {
    if (field in patch && typeof patch[field as AgentSettableField] !== "boolean") return refuse(SWITCH_REFUSAL[field]);
  }
  if ("prBodyIncludesTask" in patch && !(PR_BODY_TASK_MODES as readonly unknown[]).includes(patch.prBodyIncludesTask)) {
    return refuse(`What a pull request includes of the task must be one of: ${PR_BODY_TASK_MODES.join(", ")}.`);
  }
  if ("maxParallelRuns" in patch) {
    const runs = patch.maxParallelRuns;
    if (typeof runs !== "number" || !Number.isInteger(runs) || runs < MIN_MAX_PARALLEL_RUNS || runs > hostMaxParallelRuns()) {
      return refuse(`The number of runs at once must be a whole number between ${MIN_MAX_PARALLEL_RUNS} and ${hostMaxParallelRuns()}.`);
    }
  }
  if ("historyRetention" in patch && !(HISTORY_RETENTION_MODES as readonly unknown[]).includes(patch.historyRetention)) {
    return refuse(`The run history setting must be one of: ${HISTORY_RETENTION_MODES.join(", ")}.`);
  }
  // Both halves of the commit identity: a string, or null / "" to clear one.
  // Checked here with the resolver's own normaliser so a bad address refuses
  // the whole body before the name beside it is written (the setter checks
  // both before writing either, but the other fields would already be saved).
  if ("gitAuthorName" in patch) {
    const raw = patch.gitAuthorName;
    if (raw !== null && typeof raw !== "string") return refuse(CODING_GIT_NAME_REFUSAL);
    if (typeof raw === "string" && raw.trim() !== "" && !normalizeCodingGitName(raw)) return refuse(CODING_GIT_NAME_REFUSAL);
  }
  if ("gitAuthorEmail" in patch) {
    const raw = patch.gitAuthorEmail;
    if (raw !== null && typeof raw !== "string") return refuse(CODING_GIT_EMAIL_REFUSAL);
    if (typeof raw === "string" && raw.trim() !== "" && !normalizeCodingGitEmail(raw)) return refuse(CODING_GIT_EMAIL_REFUSAL);
  }
  if ("roleModels" in patch) {
    const connected = connectedProviders.length ? connectedProviders : [];
    if (isPlainObject(patch.roleModels)) {
      for (const role of MODEL_ROLES) {
        const entry = patch.roleModels[role];
        if (!isPlainObject(entry) || !("provider" in entry)) continue;
        const provider = entry.provider;
        if (provider === null || provider === ROLE_AUTO) continue;
        if (isCodingProvider(provider) && !connected.includes(provider)) {
          return refuse(
            `roleModels.${role}.provider must be one of the connected providers (${connected.join(", ")}), or ${ROLE_AUTO}. Connecting an account is the owner's: ${SETTINGS_PAGE_SENTENCE}`,
          );
        }
      }
    }
    // The shape, the roles, the fields, the provider/model pairs — the
    // library's own verdict, against what is stored.
    const refusal = await checkRoleModelsPatch(patch.roleModels);
    if (refusal) return refuse(refusal);
  }

  const fields = AGENT_SETTABLE_FIELDS.filter((f) => f in patch);
  return { ok: true, patch, fields };
}

export interface CodingSettingsApplied {
  /** The fields this call changed, in the order they were applied. */
  changed: AgentSettableField[];
  /** What happened to Claude Code's transcript period, when the history setting moved. */
  transcripts: HistoryRetentionChange["transcripts"];
  /** The settable set re-read after the writes. */
  settings: CodingSettingsView;
}

/**
 * Apply a CHECKED patch through the same setters the enable route uses, in
 * the same order, with the same journal lines (naming the actor, so the
 * owner's journal says who moved a knob). `checkCodingSettingsPatch` first,
 * always: the setters still throw `CodingAgentError("invalid")` on what they
 * refuse, but by then an earlier field in the body may be saved.
 */
export async function applyCodingSettingsPatch(patch: CodingSettingsPatch, actor: "owner" | "assistant"): Promise<CodingSettingsApplied> {
  const by = `by the ${actor}`;
  const changed: AgentSettableField[] = [];
  let transcripts: HistoryRetentionChange["transcripts"] = [];

  const hasName = "gitAuthorName" in patch;
  const hasEmail = "gitAuthorEmail" in patch;
  if (hasName || hasEmail) {
    // ONE call for both halves, for the reason the enable route gives: two
    // setters in a row could store the name and refuse the address.
    const saved = await setCodingGitAuthor({
      ...(hasName ? { name: patch.gitAuthorName as string | null } : {}),
      ...(hasEmail ? { email: patch.gitAuthorEmail as string | null } : {}),
    });
    // Never the values — they are the owner's own name and address.
    if (hasName) {
      console.error(`[coding-agent] commit author name ${saved.name ? "set" : "cleared"} ${by}`);
      changed.push("gitAuthorName");
    }
    if (hasEmail) {
      console.error(`[coding-agent] commit author e-mail ${saved.email ? "set" : "cleared"} ${by}`);
      changed.push("gitAuthorEmail");
    }
  }
  if ("effort" in patch) {
    const saved = await setEffort(patch.effort as string);
    console.error(`[coding-agent] effort set to ${saved} ${by}`);
    changed.push("effort");
  }
  if ("roleModels" in patch) {
    const saved = await setRoleModels(patch.roleModels);
    console.error(`[coding-agent] team role models set ${by}: ${JSON.stringify(saved)}`);
    changed.push("roleModels");
  }
  if ("reviewPass" in patch) {
    const saved = await setReviewPass(patch.reviewPass);
    console.error(`[coding-agent] review pass switched ${saved ? "on" : "off"} ${by}`);
    changed.push("reviewPass");
  }
  if ("autoPr" in patch) {
    const saved = await setAutoPr(patch.autoPr);
    console.error(`[coding-agent] auto pull requests switched ${saved ? "on" : "off"} ${by}`);
    changed.push("autoPr");
  }
  if ("prBodyIncludesTask" in patch) {
    const saved = await setPrBodyIncludesTask(patch.prBodyIncludesTask);
    console.error(`[coding-agent] pull requests will carry the task as ${logSafe(saved)}, ${by}'s choice`);
    changed.push("prBodyIncludesTask");
  }
  if ("autoMerge" in patch) {
    const saved = await setAutoMerge(patch.autoMerge);
    console.error(`[coding-agent] merging a cleared pull request switched ${saved ? "on" : "off"} ${by}`);
    changed.push("autoMerge");
  }
  if ("maxParallelRuns" in patch) {
    await setMaxParallelRuns(patch.maxParallelRuns);
    // The number is not in the line, for the reason the enable route gives
    // (js/log-injection); the answer carries it.
    console.error(`[coding-agent] the number of coding runs at once was changed ${by}`);
    changed.push("maxParallelRuns");
  }
  if ("historyRetention" in patch) {
    // The same hand-back the enable route does: "everything" pins Claude
    // Code's transcript period, "standard" releases it (setHistoryRetention).
    const change = await setHistoryRetention(patch.historyRetention);
    transcripts = change.transcripts;
    console.error(`[coding-agent] run history set to ${logSafe(change.policy.mode)} ${by}`);
    for (const t of transcripts) {
      if (t.state !== "already") console.error(`[coding-agent] Claude Code transcript period ${t.state}: ${logSafe(t.file)}`);
    }
    changed.push("historyRetention");
  }
  if ("generateMedia" in patch) {
    const saved = await setGenerateMedia(patch.generateMedia);
    console.error(`[coding-agent] generated pictures and audio switched ${saved ? "on" : "off"} ${by}`);
    changed.push("generateMedia");
  }
  if ("teamDynamic" in patch) {
    const saved = await setTeamDynamic(patch.teamDynamic);
    console.error(`[coding-agent] the coding team's lead switched ${saved ? "on" : "off"} ${by}`);
    changed.push("teamDynamic");
  }

  return { changed, transcripts, settings: await readCodingSettings() };
}
