/**
 * THE SHAPE OF THE CODING TEAM'S AGENT-SETTABLE SETTINGS — pure, no Node
 * imports, so the MCP server (mcp/tools/coding-agent.ts) and the seam that
 * validates and applies them (src/lib/coding-settings-patch.ts, which pulls
 * the whole runner in) read one list and cannot drift apart. Same pattern as
 * project-secrets-shape.ts beside the secret store.
 *
 * What the set is and why each exclusion is one: coding-settings-patch.ts.
 */

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
 * The enable route's fields the settings door refuses BY NAME: the owner's
 * consent surfaces. Named, rather than left to "unknown field", so the
 * refusal can say where the owner changes it instead of implying a typo.
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

/** Where the owner changes what the door refuses — the sentence every such refusal ends with. */
export const SETTINGS_PAGE_SENTENCE = "The owner changes it on the Coding Agent app's Settings page.";

/** The refusal `kind` for a field the assistant may never change (400, beside `invalid` for a bad value). */
export const OWNER_SETTING_KIND = "owner_setting";

/**
 * The effort levels the settings door offers for the owner's own effort —
 * coding-agent.ts's OFFERED_EFFORT_LEVELS, restated here so the MCP schema
 * can name them without importing the runner; `coding-settings-shape.test.ts`
 * pins the two lists equal, the way coding-role-models.ts pins its copy.
 */
export const AGENT_EFFORT_LEVELS = ["low", "xhigh", "max", "ultracode"] as const;

/** coding-run-history.ts's HISTORY_RETENTION_MODES, restated for the same reason and pinned by the same test. */
export const AGENT_HISTORY_RETENTION_MODES = ["standard", "everything"] as const;

/** The MCP tool's way of saying "the role's default" for a half — either word maps to `ROLE_AUTO`. */
export const ROLE_RESET_WORDS = ["auto", "default"] as const;
