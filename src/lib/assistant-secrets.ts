/**
 * "Import from assistant": keys the main assistant already holds, offered to
 * the owner BY NAME and copied into the owner's secret store on their click, so
 * a coding run can be given one without the owner typing it in again.
 *
 * WHERE THE KEYS COME FROM — the harness's own place, read the way ClawBox
 * already reads it:
 *
 *  - HERMES keeps a box's API keys in `~/.hermes/.env`: the ones the owner
 *    pasted into a skill's settings (src/lib/hermes-skill-secrets.ts), the ones
 *    `hermes config set` routed there, and the ones the owner added by hand.
 *    The pinned Hermes has no grant or export mechanism of its own, so the
 *    file is read through src/lib/hermes-env.ts, the box's one reader of it.
 *  - OPENCLAW offers nothing to copy, by design. The pinned gateway keeps
 *    credentials in its shared secret store as `secret`-kind entries, whose
 *    values are write-only: `secrets store get` refuses them and
 *    `secrets.store.list` has no reveal. The only env-backed reference ClawBox
 *    writes is the Discord bot token, which is on the denylist below. So on a
 *    box without Hermes the list is empty and the card offers no import.
 *
 * WHAT IS NEVER OFFERED, whatever the file holds — the assistant's and the
 * box's OWN wiring (`isImportableSecretName`): the session secret, ClawBox's
 * gateway, MCP, portal and local-AI tokens, every chat-channel and mail
 * credential, the model-provider keys the assistant answers with, and a secret
 * manager's master token (Bitwarden, 1Password). Those
 * are how the box itself works; a coding run that needs one of them is the
 * owner's to give by typing it, not something a button should make easy. On
 * top of this the store's own reserved names (`isReservedSecretName`) still
 * apply, so nothing here can name `PATH`, `LD_PRELOAD` or a `CLAUDE_` variable.
 *
 * WHAT THIS FILE NEVER DOES: return a value to a caller. `listAssistantSecrets`
 * answers names; `importAssistantSecret` reads the one value it was asked for
 * and hands it straight to the store's `importSecret`, which seals it, files it
 * UN-TICKED and writes the audit line. The value is in no answer, no refusal
 * and no log line.
 *
 * A COPY, NOT A LINK. Rotating the assistant's key does not change the copy,
 * and deleting the copy does not touch the assistant's: revocation stays where
 * the owner can see it, in the secrets list.
 */

import { get as configGet } from "@/lib/config-store";
import { hasHermesHarness } from "@/lib/edition-source";
import { readHermesEnv } from "@/lib/hermes-env";
import {
  importSecret,
  isReservedSecretName,
  isStorableSecretValue,
  requireSecretName,
  requireSecretScope,
  SECRET_NAME_RE,
  SecretStoreError,
  type SecretView,
} from "@/lib/project-secrets";
import type { SecretImportSource } from "@/lib/secrets-audit";

/**
 * The feature's switch. ON when absent — the owner's import is a click they
 * make, and every copy still lands un-ticked — and `false` turns the list, the
 * copy and the card's button off together, without a rebuild.
 */
export const SECRET_IMPORT_CONFIG_KEY = "coding_agent_secret_import";

export async function getSecretImportEnabled(): Promise<boolean> {
  return (await configGet(SECRET_IMPORT_CONFIG_KEY)) !== false;
}

/** One name the picker may offer. Never a value — see the header. */
export interface AssistantSecretName {
  name: string;
  source: SecretImportSource;
}

/** The box's own names, beyond the store's reserved ones. */
const BOX_OWN_NAMES: ReadonlySet<string> = new Set([
  "SESSION_SECRET", "MCP_TOKEN", "LOCAL_AI_TOKEN", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
  "SUDO_PASSWORD", "RAFT_PROFILE",
  // The assistant's custom OpenAI-compatible endpoint, when it has one.
  "OPENAI_API_KEY", "OPENAI_BASE_URL",
]);

/**
 * Prefixes of the assistant's and the box's own wiring: the harnesses
 * themselves, ClawBox's portal and AI plan, and every chat channel and mail
 * account Hermes can be connected to (its `messaging` variables).
 */
const BOX_OWN_PREFIXES: readonly string[] = [
  "HERMES_", "OPENCLAW_", "CLAWAI_", "PORTAL_", "API_SERVER_", "GATEWAY_", "TOOL_GATEWAY_",
  // A secret MANAGER's own credential — Bitwarden's access token, which
  // `hermes secrets bitwarden` keeps in this file, and the 1Password CLI's —
  // opens every key in the vault behind it, not one.
  "BWS_", "OP_",
  "TELEGRAM_", "DISCORD_", "SLACK_", "WHATSAPP_", "SIGNAL_", "MATRIX_", "TEAMS_", "MATTERMOST_",
  "GOOGLE_CHAT_", "EMAIL_", "SMS_", "TWILIO_", "LINE_", "WECOM_", "FEISHU_", "DINGTALK_", "QQ_", "QQBOT_",
  "IRC_", "NTFY_", "BLUEBUBBLES_", "SIMPLEX_", "PHOTON_", "BUZZ_", "A2A_", "WEBHOOK_",
];

/**
 * The model-provider variables the assistant answers with: the pinned Hermes'
 * own `provider` catalogue, less the ones the store's `ANTHROPIC_` / `CLAUDE_`
 * reservation already refuses.
 */
const MODEL_PROVIDER_NAMES: ReadonlySet<string> = new Set([
  "ACTUAL_API_KEY", "AI_GATEWAY_API_KEY", "ALIBABA_CODING_PLAN_API_KEY", "ALIBABA_CODING_PLAN_BASE_URL",
  "ALIBABA_CODING_PLAN_CN_API_KEY", "ALIBABA_CODING_PLAN_CN_BASE_URL", "ALIBABA_TOKEN_PLAN_API_KEY",
  "ALIBABA_TOKEN_PLAN_BASE_URL", "ALIBABA_TOKEN_PLAN_CN_API_KEY", "ALIBABA_TOKEN_PLAN_CN_BASE_URL",
  "ARCEEAI_API_KEY", "ARCEE_BASE_URL", "AWS_PROFILE", "AWS_REGION", "AZURE_FOUNDRY_API_KEY",
  "AZURE_FOUNDRY_BASE_URL", "COMMANDCODE_ANTHROPIC_BASE_URL", "COMMANDCODE_API_KEY", "COMMANDCODE_BASE_URL",
  "DASHSCOPE_API_KEY", "DASHSCOPE_BASE_URL", "DASHSCOPE_CN_BASE_URL", "DEEPINFRA_API_KEY", "DEEPINFRA_BASE_URL",
  "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GEMINI_BASE_URL",
  "GLM_API_KEY", "GLM_BASE_URL", "GMI_API_KEY", "GMI_BASE_URL", "GOOGLE_API_KEY", "HF_BASE_URL", "HF_TOKEN",
  "KILOCODE_API_KEY", "KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_CN_API_KEY", "KIMI_CODING_API_KEY",
  "LM_API_KEY", "LM_BASE_URL", "META_API_KEY", "META_BASE_URL", "META_MODEL_API_KEY", "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL", "MINIMAX_CN_API_KEY", "MINIMAX_CN_BASE_URL", "MODEL_API_KEY", "NEBIUS_API_KEY",
  "NEBIUS_BASE_URL", "NEBIUS_TOKEN_FACTORY_API_KEY", "NOUS_BASE_URL", "NOVITA_API_KEY", "NOVITA_BASE_URL",
  "NVIDIA_API_KEY", "NVIDIA_BASE_URL", "OLLAMA_API_KEY", "OLLAMA_BASE_URL", "OPENCODE_GO_API_KEY",
  "OPENCODE_GO_BASE_URL", "OPENCODE_ZEN_API_KEY", "OPENCODE_ZEN_BASE_URL", "OPENROUTER_API_KEY",
  "RAMP_ROUTER_API_KEY", "RAMP_ROUTER_BASE_URL", "ROUTER_API_KEY", "STEPFUN_API_KEY", "STEPFUN_BASE_URL",
  "TOKENHUB_API_KEY", "TOKENHUB_BASE_URL", "UPSTAGE_API_KEY", "UPSTAGE_BASE_URL", "VERTEX_CREDENTIALS_PATH",
  "XAI_API_KEY", "XAI_BASE_URL", "XIAOMI_API_KEY", "XIAOMI_BASE_URL", "Z_AI_API_KEY", "ZAI_API_KEY",
]);

/**
 * True when a name may be offered and copied: a valid secret name, not one the
 * store reserves, and not the assistant's or the box's own wiring.
 */
export function isImportableSecretName(name: string): boolean {
  if (!SECRET_NAME_RE.test(name) || isReservedSecretName(name)) return false;
  if (BOX_OWN_NAMES.has(name) || MODEL_PROVIDER_NAMES.has(name)) return false;
  return !BOX_OWN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The assistant's keys as name → value, for this module's own use only.
 *
 * Empty on a box without Hermes, and for a missing file. A file that is there
 * and cannot be read is a refusal, not an empty list: "your assistant holds no
 * keys" would be the wrong thing to tell an owner whose `.env` is broken.
 */
async function readAssistantEnv(): Promise<Map<string, { value: string; source: SecretImportSource }>> {
  const out = new Map<string, { value: string; source: SecretImportSource }>();
  if (!hasHermesHarness()) return out;
  let env: Record<string, string>;
  try {
    env = await readHermesEnv();
  } catch (err) {
    // The reason, never the file's contents.
    console.error("[secrets] could not read the assistant's key file for an import:", err instanceof Error ? err.message : err);
    throw new SecretStoreError("source_unreadable", "This ClawBox could not read the assistant's key file.");
  }
  for (const [name, value] of Object.entries(env)) {
    // An empty assignment is a key the assistant does not hold, and a value the
    // store would refuse (too short to redact, too long, control characters)
    // is one no copy could keep: offering it would only lead to a refusal.
    if (!isStorableSecretValue(value) || !isImportableSecretName(name)) continue;
    out.set(name, { value, source: "hermes" });
  }
  return out;
}

/** The names the picker may offer, sorted. Names and sources ONLY. */
export async function listAssistantSecrets(): Promise<AssistantSecretName[]> {
  const env = await readAssistantEnv();
  return [...env.entries()]
    .map(([name, { source }]) => ({ name, source }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The sources this box can copy from at all — what decides whether the card offers the button. */
export function assistantSecretSources(): SecretImportSource[] {
  return hasHermesHarness() ? ["hermes"] : [];
}

/**
 * Copy ONE of the assistant's keys into the owner's store, un-ticked.
 *
 * The name and the scope are checked BEFORE the assistant's file is read, so a
 * request that could never succeed costs nothing and learns nothing. The name
 * must then be one the list above would offer: a denylisted name is refused even
 * when the file holds it. Answers the stored entry's view — never the value.
 */
export async function importAssistantSecret(input: { name: unknown; scope?: unknown }): Promise<SecretView & { source: SecretImportSource }> {
  const name = requireSecretName(input.name);
  const scope = requireSecretScope(input.scope);
  if (!isImportableSecretName(name)) {
    throw new SecretStoreError(
      "not_importable",
      `${name} is part of how the assistant or this ClawBox itself works, so it is not offered for copying. Type it in yourself if a run really needs it.`,
    );
  }
  const env = await readAssistantEnv();
  const held = env.get(name);
  if (!held) {
    // Its own code, not the store's `not_found`: that one means the OWNER's list
    // changed, and the card words the two differently.
    throw new SecretStoreError("not_held", `The assistant holds no key called ${name} that this ClawBox can copy.`);
  }
  const view = await importSecret({ name, value: held.value, scope, source: held.source });
  return { ...view, source: held.source };
}
