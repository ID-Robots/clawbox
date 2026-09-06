export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { getAll, setMany } from "@/lib/config-store";
import { readSetupGateFacts } from "@/lib/route-auth";
import { HANDOFF_TOKENS_PATH, HANDOFF_TTL_MS } from "@/lib/oauth-handoff";
import {
  restartGateway,
  runOpenclawDoctorFix,
  findOpenclawBin,
  runOpenclawConfigSet,
  runOpenclawConfigSetBatch,
  runOpenclawConfigUnset,
  type OpenclawConfigSetArgs,
  compactionReserveFloorForContext,
  inferConfiguredLocalModel,
  readConfig as readOpenClawConfig,
  spawnOpenclawCli,
  readConfigStrict as readOpenClawConfigStrict,
  setPrimaryModelWithoutCatalogValidation,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
  setProviderPlugins,
  openclawIsAbsent,
  OpenclawUnavailableError,
  type OpenClawConfig,
  GatewayNotReadyError,
} from "@/lib/openclaw-config";
import { enableProviderPluginOps } from "@/lib/provider-plugin-ops";
import { getActiveHarness } from "@/lib/harness";
import { refreshCodingAgentToolsIfReadinessChanged } from "@/lib/coding-agent-mcp-refresh";
import { applyLocalAiToHermes, HermesLocalApplyError } from "@/lib/hermes-local-ai";
import { applyClawaiToHermes, ClawaiApplyError } from "@/lib/hermes-clawai";
import { isClawboxAiVisionId, resolveVisionModelId } from "@/lib/clawbox-ai-vision";
import { applyCloudProviderKeyToHermes, HermesCloudApplyError } from "@/lib/hermes-cloud-provider";
import {
  getDefaultLlamaCppModel,
  getLlamaCppContextWindow,
  getLlamaCppMaxTokens,
  getLlamaCppProxyBaseUrl,
} from "@/lib/llamacpp";
import { activateLocalAiProvider, getLocalAiProxyBaseUrl } from "@/lib/local-ai-runtime";
import { HERMES_MINIMUM_CONTEXT_TOKENS, probeOllamaModel } from "@/lib/ollama-model-context";
import { unpairLocal as unpairClawKeep } from "@/lib/clawkeep";
import { getLocalAiToken, markLocalAiTokenMigrated } from "@/lib/local-ai-token";
import { getOrGenerateGatewayToken } from "@/lib/gateway-proxy";
import {
  CLAWBOX_AI_PROVIDER,
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_PRO_MODEL_ID,
  CLAWBOX_AI_MODEL_BY_TIER,
  CLAWBOX_AI_MODEL_ID_BY_TIER,
  CLAWBOX_AI_DEFAULT_TIER,
  CLAWBOX_AI_PROXY_URLS,
  CLAWBOX_AI_IMAGE_PROVIDER,
  CLAWBOX_AI_IMAGE_MODEL,
  CLAWBOX_AI_IMAGE_MODEL_ID,
  CLAWBOX_AI_IMAGE_MODEL_LABEL,
  isClawboxAiImageModelRef,
  CLAWBOX_AI_VISION_MODEL_ID,
  clawboxAiVisionModelRef,
  CLAWBOX_AI_VISION_MODEL_LABEL,
  CLAWBOX_AI_VISION_INPUT_MODALITIES,
  CLAWBOX_AI_VISION_MAX_TOKENS,
  normalizeClawboxAiTier,
  type ClawboxAiTier,
} from "@/lib/clawbox-ai-models";
import { OPENROUTER_CURATED_MODELS, OPENROUTER_DEFAULT_MODEL_ID } from "@/lib/openrouter-models";
import { resolveEntitledCodexModel } from "@/lib/codex-model-probe";
import {
  CHATGPT_AGENT_RUNTIME_ID,
  CHATGPT_DEFAULT_MODEL_ID,
  CHATGPT_PROFILE_KEY,
  CHATGPT_PROVIDER,
  chatgptModelRef,
  chatgptRuntimeArmOp,
  chatgptRuntimeEntryPath,
  isOauthProfile,
  openaiAuthOrder,
} from "@/lib/chatgpt-subscription";
import { fetchPortalTier } from "@/lib/clawbox-ai-portal-tier";
import { forgetClawaiCredentialRefusal } from "@/lib/harness/credentials";
import { clawaiCredentialRefusalOnRecord } from "@/lib/clawai-credential-refusal";
import {
  isValidModelId,
  GOOGLE_MODELS,
  ANTHROPIC_DEFAULT_MODEL_ID,
  GOOGLE_DEFAULT_MODEL_ID,
  OPENAI_DEFAULT_MODEL_ID,
  ANTHROPIC_MODELS,
  extractProviderModelId,
  routesSubscriptionNatively,
} from "@/lib/provider-models";
import { DISABLED_PROVIDERS_KEY, normalizeProviderId, parseDisabledProviders } from "@/lib/provider-status";
import { setProviderEnabled } from "@/lib/provider-enablement";
import { notifyProviderSetChanged } from "@/app/setup-api/ai-models/catalog/route";
import { forgetProviderEnumerations } from "@/lib/provider-runnable";
import {
  EXPLICIT_MODEL_PICKS_KEY,
  decideClawboxAiModelId,
  explicitPicksFrom,
} from "@/lib/explicit-model-pick";
import {
  isClaudeSubscriptionOnly,
  offSurfaceClaudeModelMessage,
  offSurfaceCodexModelMessage,
  readKnownModelIds,
} from "@/lib/subscription-surface";
// The model name on this route arrives in the request body. For a local
// provider it is the whole of `apiKey`, which nothing further constrains, and
// it reaches the lines below both directly and inside a subprocess error that
// quotes the command it ran. Bound every such field before logging it — see
// src/lib/log-safe.ts.
import { logSafe } from "@/lib/log-safe";
import { installDeepseekProviderPlugin } from "@/lib/openclaw-deepseek-plugin";
import { clawboxDisabledEntryId, clearPluginRepair } from "@/lib/plugin-repair";

const OPENCLAW_BIN = findOpenclawBin();
const OPENCLAW_HOME_DIR =
  process.env.CLAWBOX_OPENCLAW_HOME
  || process.env.OPENCLAW_HOME
  || path.join(process.env.HOME ?? "/home/clawbox", ".openclaw");
const CLAWBOX_HOME_DIR = process.env.HOME ?? "/home/clawbox";
/**
 * The agent whose LEGACY credential file ClawBox writes, pre-v2.
 *
 * `main` is the core's implicit agent (`LEGACY_IMPLICIT_AGENT_ID`) and the
 * directory it resolves for a config with no roster, which is every box that
 * still has a legacy `auth-profiles.json` to write. Deliberately NOT used for
 * the `models auth …` calls any more — see `pasteAuthApiKey`.
 */
const LEGACY_AGENT_ID = "main";
const AUTH_PROFILES_PATH = path.join(
  OPENCLAW_HOME_DIR,
  "agents",
  LEGACY_AGENT_ID,
  "agent",
  "auth-profiles.json",
);
const CLAWBOX_UID = process.getuid?.() ?? 1000;
const CLAWBOX_GID = process.getgid?.() ?? 1000;
const CLAWBOX_AI_PROXY_URL = process.env.CLAWBOX_AI_PROXY_URL?.trim() || "https://clawbox.com/api/ai";
/** Portal-token prefix — the entitlement marker both writers gate on. */
const CLAWBOX_AI_TOKEN_PREFIX = "claw_";
const CLAWBOX_AI_TOKEN_CONFIG_KEY = "clawai_token";
const CLAWBOX_AI_TIER_CONFIG_KEY = "clawai_tier";
const CLAWBOX_AI_PROFILE_KEY = "deepseek:default";
/**
 * Config-store marker: ClawBox has written an explicit OpenAI auth order that
 * a later save may need to clear. Without it the clear is a CLI cold start
 * spent against a store that has no order — see `applyOpenAiAuthOrder`.
 */
const OPENAI_AUTH_ORDER_KEY = "openai_auth_order_written";
const CLAWBOX_AI_MODEL = CLAWBOX_AI_MODEL_BY_TIER[CLAWBOX_AI_DEFAULT_TIER];

// Ollama pre-allocates KV cache for the full context window. The default 128K
// context would need ~12.5 GB, exceeding the Jetson's 8 GB RAM.
// 32K is the practical max — fits in RAM+swap without excessive thrashing.
// We define the model in openclaw.json with a capped contextWindow so the
// gateway generates models.json with the correct value on every restart.
const OLLAMA_CONTEXT_WINDOW = 32768;
const OLLAMA_MAX_TOKENS = 8192;

interface ProviderConfig {
  defaultModel: string;
  profileKey: string;
  /** Override config used when authMode is "subscription" (OAuth). */
  subscriptionOverride?: { defaultModel: string; profileKey?: string };
}

type ConfigureScope = "primary" | "local";

const PROVIDERS: Record<string, ProviderConfig> = {
  clawai: {
    defaultModel: CLAWBOX_AI_MODEL,
    profileKey: CLAWBOX_AI_PROFILE_KEY,
  },
  anthropic: {
    defaultModel: `anthropic/${ANTHROPIC_DEFAULT_MODEL_ID}`,
    profileKey: "anthropic:default",
  },
  openai: {
    defaultModel: `openai/${OPENAI_DEFAULT_MODEL_ID}`,
    profileKey: "openai:default",
    subscriptionOverride: {
      // The ChatGPT sign-in is an OAuth profile of the SAME provider, under a
      // key of its own so it coexists with the API-key one, and the model is
      // `openai/<id>` — OpenClaw 2 has no `codex/` namespace and never
      // consults a `codex:*` profile for an openai route. Evidence in
      // src/lib/chatgpt-subscription.ts. Newest model every ChatGPT tier can
      // run, Free included; entitled accounts are moved up to gpt-5.6 by the
      // sign-in probe below.
      defaultModel: chatgptModelRef(CHATGPT_DEFAULT_MODEL_ID),
      profileKey: CHATGPT_PROFILE_KEY,
    },
  },
  google: {
    defaultModel: `google/${GOOGLE_DEFAULT_MODEL_ID}`,
    profileKey: "google:default",
  },
  openrouter: {
    // Default pre-selection when user reaches the OpenRouter screen. The
    // user can override via `model` in the request body — see the picker
    // in AIModelsStep. Single source of truth: OPENROUTER_DEFAULT_MODEL_ID
    // in src/lib/openrouter-models.ts.
    defaultModel: `openrouter/${OPENROUTER_DEFAULT_MODEL_ID}`,
    profileKey: "openrouter:default",
  },
  ollama: {
    defaultModel: "ollama/llama3.2:3b",
    profileKey: "ollama:default",
  },
  llamacpp: {
    defaultModel: `llamacpp/${getDefaultLlamaCppModel()}`,
    profileKey: "llamacpp:default",
  },
};

const PROFILE_KEY_RE = /^[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)*$/;
const COMMAND_TIMEOUT_MS = 30_000;
const BATCH_COMMAND_TIMEOUT_MS = 60_000;

interface AuthProfilesFile {
  version: number;
  profiles: Record<string, unknown>;
}

function runCommand(cmd: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<void> {
  // Route `openclaw config set …` through the shared retry-aware helper in
  // openclaw-config.ts so callers automatically survive transient
  // `ConfigMutationConflictError` races (gateway touching the config during
  // reload, or two successive writes from this route landing in the same tick).
  // Non-openclaw invocations (e.g. `sudo optimize-ollama.sh`) keep the
  // one-shot spawn below unchanged — no retry semantics apply there.
  if (cmd === OPENCLAW_BIN && args[0] === "config" && args[1] === "set") {
    return runOpenclawConfigSet(args.slice(2), {
      timeoutMs,
      uid: CLAWBOX_UID,
      gid: CLAWBOX_GID,
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: CLAWBOX_HOME_DIR,
      uid: CLAWBOX_UID,
      gid: CLAWBOX_GID,
      env: { HOME: "/home/clawbox", ...process.env },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else
          reject(
            new Error(stderr.trim() || `${cmd} exited with code ${code}`)
          );
      }
    });
    child.stdin.end();
  });
}

/**
 * Apply `config set` assignments in as few `openclaw` invocations as possible
 * WITHOUT merging their error boundaries.
 *
 * Every invocation of the CLI costs ~8 s of Node startup on a Jetson (see
 * `runOpenclawConfigSetBatch`), which is where first-run setup's silent
 * two-and-a-half minutes came from (TASK-483). Batching is the fix, but this
 * route deliberately treats some writes as fatal and others as not — a chat
 * provider that works is worth more than an image tool, so a failure to
 * provision images must not fail "Connect ClawBox AI" — and one batch is
 * atomic, so a single combined call would make every failure fatal to
 * everything.
 *
 * So: try the combined call first, and only if it fails re-issue each group on
 * its own, which is exactly the old one-boundary-per-group behaviour. A batch
 * that fails wrote nothing, so re-applying the same values group by group is
 * safe. The slow path costs one extra invocation per group and is only reached
 * when something is already wrong.
 */
interface ConfigSetGroup {
  /** `config set` argvs, minus the leading `config set`. */
  ops: OpenclawConfigSetArgs[];
  /** Called instead of throwing when this group alone fails. Absent = fatal. */
  onError?: (err: unknown) => void;
  /** Called once this group's ops are known to have been applied. */
  onApplied?: () => void;
}

function runConfigSetBatch(ops: OpenclawConfigSetArgs[]): Promise<void> {
  return runOpenclawConfigSetBatch(ops, {
    // A batch is one CLI start-up regardless of size, so the per-attempt budget
    // stays in the same order as a single set; the extra headroom is because a
    // batch that times out costs every write in it, not one.
    timeoutMs: BATCH_COMMAND_TIMEOUT_MS,
    uid: CLAWBOX_UID,
    gid: CLAWBOX_GID,
  });
}

async function applyConfigSetGroups(groups: (ConfigSetGroup | null)[]): Promise<void> {
  const present = groups.filter((group): group is ConfigSetGroup => !!group && group.ops.length > 0);
  if (present.length === 0) return;

  if (present.length > 1) {
    try {
      await runConfigSetBatch(present.flatMap((group) => group.ops));
      for (const group of present) group.onApplied?.();
      return;
    } catch (err) {
      // Fall through: re-issue per group so each keeps its own fatal/non-fatal
      // boundary. Logged because the combined failure names the real cause,
      // while the per-group retry may only reproduce part of it.
      console.warn(
        "[AI Config] Combined config write failed; retrying one group at a time:",
        err instanceof Error ? logSafe(err.message) : err,
      );
    }
  }

  for (const group of present) {
    try {
      await runConfigSetBatch(group.ops);
      group.onApplied?.();
    } catch (err) {
      if (!group.onError) throw err;
      group.onError(err);
    }
  }
}

async function readAuthProfiles(): Promise<AuthProfilesFile> {
  try {
    const raw = await fs.readFile(AUTH_PROFILES_PATH, "utf-8");
    return JSON.parse(raw) as AuthProfilesFile;
  } catch (err) {
    // Only a genuinely absent file means "no profiles yet" (first run). Any
    // other failure — EACCES on a root-owned file, a partial/corrupt JSON, an
    // I/O error — must NOT be treated as empty: the caller does a
    // read-modify-write, so defaulting to {} here would overwrite the file with
    // a single profile and silently destroy every other provider's stored
    // credentials (there is no backup for this file). Fail closed instead.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, profiles: {} };
    }
    throw err;
  }
}

async function writeAuthProfiles(authProfiles: AuthProfilesFile) {
  await fs.mkdir(path.dirname(AUTH_PROFILES_PATH), { recursive: true });
  const tmpPath = AUTH_PROFILES_PATH + `.tmp.${Date.now()}.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(authProfiles, null, 2), {
    mode: 0o600,
  });
  await fs.rename(tmpPath, AUTH_PROFILES_PATH);
  await fs.chown(AUTH_PROFILES_PATH, CLAWBOX_UID, CLAWBOX_GID);
}

/**
 * Store an API-key credential the way the installed CLI does it.
 *
 * OpenClaw 2 keeps credentials in its sqlite auth store and refuses to hydrate
 * a recreated legacy auth-profiles.json (AuthProfileMigrationRequiredError
 * kills the gateway until a doctor migration). `models auth paste-api-key`
 * owns the store's schema on every generation — legacy json on v1, sqlite on
 * v2 — and updates the openclaw.json metadata itself. The key rides stdin,
 * never argv.
 */
/**
 * `models.mode` as openclaw.json carries it, or null when there is none to read.
 *
 * Null on the Hermes SKU (no OpenClaw config at all) and on an unreadable one,
 * which is why the caller compares two reads rather than testing a value: two
 * nulls are "nothing changed", the honest answer in both cases.
 */
async function readModelsMode(): Promise<string | null> {
  if (openclawIsAbsent()) return null;
  try {
    const mode = (await readOpenClawConfig())?.models?.mode;
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}

async function pasteAuthApiKey(provider: string, profileId: string, key: string): Promise<void> {
  // The sign-in guard is NOT here, deliberately: see `assertNoSignInAt`. By
  // the time this runs the request has already written its own
  // `auth.profiles.<key>` metadata, and on the ClawBox AI lane that metadata
  // says `oauth` — a guard reading the box at this point would refuse the very
  // save that wrote it. It is asked once, of the store as it was BEFORE this
  // request touched anything.
  await spawnOpenclawCli(
    [
      "models", "auth", "paste-api-key",
      // NO `--agent`. ClawBox used to pin `main` here — and in the sign-in
      // guard and the order write — on the argument that the CLI resolves a
      // READ and a WRITE differently, so an unpinned pair could address two
      // stores. Measured against the installed core (2026.8.1) with a sole
      // `pro-agent` roster and the flag omitted, that is not what happens:
      //
      //   models auth list --json     -> "agentId": "pro-agent"
      //   paste-api-key …             -> agents/pro-agent/agent/openclaw-agent.sqlite
      //
      // The two resolvers only diverge on a roster with SEVERAL agents, and
      // there `main` was never the right answer either. What the pin actually
      // did was write this device's ClawBox AI credential into an agent store
      // the gateway does not read — leaving whatever the real store held,
      // however stale, to keep serving turns, which is TASK-730 — or, when
      // `main` is not in the roster at all, fail the whole save outright:
      //
      //   $ openclaw models auth paste-api-key --agent main …
      //   Unknown agent id "main". Use "openclaw agents list" to see configured agents.
      //
      // So the target is the harness's to choose, and this asks it to.
      "--provider", provider,
      "--profile-id", profileId,
    ],
    { stdinData: key + "\n", timeoutMs: 60_000 },
  );
}

/** A pasted API key would have replaced a subscription sign-in. */
class SignInWouldBeLostError extends Error {
  constructor(readonly profileId: string) {
    super(`auth profile ${profileId} holds a sign-in`);
    this.name = "SignInWouldBeLostError";
  }
}

/**
 * Refuse a save whose API key would delete a subscription sign-in.
 *
 * `models auth paste-api-key` REPLACES whatever sits at `--profile-id`; there
 * is no merge and no refusal of its own. The CLI's default id is
 * `<provider>:manual`, chosen so a pasted key never lands on another
 * credential — ClawBox overrides it to `<provider>:default`, and that override
 * is what makes a collision possible at all. Measured with `openclaw models
 * auth list --json` on an OpenClaw box: `anthropic:default` is `oauth` there
 * TODAY, because this route's own subscription lane writes the OAuth bundle to
 * it (PROVIDERS has no `subscriptionOverride` for anthropic) and its API-key
 * lane pastes to the same id. The OpenAI shape needs a migration —
 * `doctor --fix` renames an OpenClaw 1 `openai-codex:*` profile to
 * `openai:<suffix>`, landing the ChatGPT sign-in where the key lane targets
 * (TASK-662, the #584 follow-up).
 *
 * ASKED OF THE STORE, not of openclaw.json's `auth.profiles` metadata. The
 * metadata is a false negative for the one credential most worth protecting:
 * `models auth login` — the Terminal sign-in — persists to the agent
 * credential store and never calls `applyAuthProfileConfig`, so a profile
 * created that way is invisible in the config. `models auth list --json` is
 * the store's own reader and is what `models auth logout` — the verb this
 * refusal names — acts on, so the guard and its remedy cannot disagree. It
 * costs one CLI cold start, which is why it is skipped for the providers that
 * have no sign-in lane at all.
 *
 * ASKED ONCE, BEFORE ANY WRITE. Later in the same request the save writes
 * `auth.profiles.<key>` itself — `{mode: "oauth"}` on the ClawBox AI lane —
 * so a guard consulted at paste time would refuse the save that wrote it.
 *
 * REFUSED rather than written under a second id. `applyAuthProfileConfig` does
 * record an order preferring a newly pasted peer, so a second profile is not
 * the false success it first looked like; the reason to refuse anyway is
 * narrower and worth stating plainly. A second id silently changes which
 * credential answers, on a box where ClawBox writes a STORE-level order for
 * openai (`applyOpenAiAuthOrder`) that outranks the config one and names only
 * the ids it knows about — so "both survive" would be true for anthropic and
 * argued for openai. One sentence the owner can act on beats a credential
 * shuffle he was not shown.
 *
 * Fails OPEN: a store that cannot be read does not refuse a save the owner
 * asked for. The failure is logged, and the paste that follows is the same one
 * beta performed unconditionally.
 */
async function assertNoSignInAt(profileId: string): Promise<void> {
  // Nothing to lose where there is no OpenClaw auth store: the Hermes SKU
  // keeps its credentials in the harness's own config and never reaches
  // `paste-api-key` at all.
  if (openclawIsAbsent()) return;
  let raw: string;
  try {
    // Unpinned, like the paste this guards and the auth order beside it: all
    // three let the core pick the agent, so all three address one store on
    // every box where a save can succeed (see `pasteAuthApiKey`). The response
    // names the agent it answered for (`agentId`, `agentDir`), so a box that
    // disagrees can still be told apart in a log.
    //
    // KNOWN LIMIT, measured: before an agent has a store of its own the core
    // answers from the shared one (`authStatePath` pointed at `agents/main/`
    // while `agentId` was `pro-agent`), so this can see an inherited profile
    // the paste would only have shadowed. It refuses in that case, which is
    // the safe direction — and strictly better than what it replaces, since
    // the same box previously failed the whole save with
    // `Unknown agent id "main"`.
    raw = await spawnOpenclawCli(
      ["models", "auth", "list", "--json"],
      { captureStdout: true, timeoutMs: 60_000 },
    );
  } catch (err) {
    console.warn(
      "[configure] could not read the auth profiles before pasting a key:",
      err instanceof Error ? logSafe(err.message) : err,
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[configure] `models auth list --json` was not JSON; the key paste is unguarded");
    return;
  }
  // `JSON.parse("null")` succeeds and `null.profiles` throws, which the
  // handler's own catch would turn into a 500 — the opposite of the fail-open
  // this guard promises, over a save that is perfectly good.
  if (!parsed || typeof parsed !== "object") return;
  const profiles = (parsed as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) return;
  // The store's own shape, measured on 2026.8.1:
  // `{profiles: [{id, provider, type, label, expiresAt}]}`, `type` being
  // `oauth` or `api_key`. Any OAuth row AT THIS ID counts, whatever provider it
  // names: the paste replaces the row, so what it would destroy is the
  // question, not who owns it.
  const holdsSignIn = profiles.some((row) => {
    if (!row || typeof row !== "object") return false;
    const entry = row as { id?: unknown; type?: unknown };
    return entry.id === profileId && isOauthProfile({ mode: String(entry.type ?? "") });
  });
  if (holdsSignIn) throw new SignInWouldBeLostError(profileId);
}

/**
 * Record the box's OpenAI auth preference with the core's own per-provider
 * order (`openclaw models auth order`, docs/cli/models.md) — or clear it.
 *
 * The order is only ever set when there is something to disambiguate: TWO
 * openai profiles, the ChatGPT sign-in and an API key. With one profile the
 * core already selects it (a usable profile outranks the
 * `models.providers.openai.apiKey` fallback), while a one-entry explicit order
 * is a trap — the core REPLACES the candidate list with it
 * (`baseOrder = explicitOrder ?? …`), so the next credential the owner adds is
 * invisible, and when the named profile is present but ineligible (an expired
 * OAuth credential) every openai turn is refused with "Explicit auth order for
 * openai has no usable profiles" over a working key in the same store.
 *
 * So: two profiles → name both, preferred first, and the preference is
 * revised by whichever save happened last. Fewer → clear, which also undoes a
 * one-entry order an earlier ClawBox left behind.
 *
 * Best effort, and the failure is NAMED in the answer rather than swallowed:
 * the credential is stored either way, and the chat route arms the Codex
 * runtime on the model, which only an OAuth profile satisfies.
 *
 * The `clear` is skipped entirely unless ClawBox itself has written an order
 * (a marker in the config store, set beside every `set`). On the ordinary
 * single-profile box — a ChatGPT sign-in only, or an API key only — the clear
 * would be a no-op against a store that has no order, and this codebase prices
 * a CLI cold start at about ten seconds on a Jetson, on the wizard's critical
 * path behind the sign-in overlay. It also leaves an order the OWNER set by
 * hand from the Terminal alone, which is the better default anyway.
 *
 * `preferred` is taken as present without looking for it — this save wrote it.
 * Only the OTHER openai profiles come from the config, and `readConfig`
 * answers `{}` rather than throwing for an unreadable or half-written file, so
 * a bad read looks like "one profile" and CLEARS. That is the deliberate
 * fail-safe direction: clearing hands selection back to the core, which still
 * has both credentials as candidates, while the alternative — writing the
 * one-entry order — is the trap described above.
 */
async function applyOpenAiAuthOrder(
  preferred: string,
  config: OpenClawConfig | null,
  clawboxWroteOrder: boolean,
): Promise<string | undefined> {
  const order = openaiAuthOrder(
    config?.auth?.profiles,
    preferred,
    (key) => PROFILE_KEY_RE.test(key),
  );
  const shouldSet = order.length > 1;
  if (!shouldSet && !clawboxWroteOrder) return undefined;
  const args = shouldSet
    ? ["models", "auth", "order", "set", "--provider", CHATGPT_PROVIDER, ...order]
    : ["models", "auth", "order", "clear", "--provider", CHATGPT_PROVIDER];
  try {
    await spawnOpenclawCli(args, { timeoutMs: 60_000 });
    // The marker follows the write that succeeded, so a later save knows
    // whether there is anything of ours to clear.
    await setMany({ [OPENAI_AUTH_ORDER_KEY]: shouldSet ? true : undefined });
    return undefined;
  } catch (orderErr) {
    console.warn(
      "[configure] models auth order failed for the OpenAI profiles:",
      orderErr instanceof Error ? JSON.stringify(logSafe(orderErr.message)) : orderErr,
    );
    return "Saved, but OpenClaw did not record which OpenAI credential to prefer; "
      + "if chat answers with an authentication error, run "
      + `'openclaw ${args.join(" ")}' from the Terminal.`;
  }
}

/**
 * Take the Codex runtime OFF `modelRef` when the save is the API-key lane, or
 * return the sentence that says it is still on.
 *
 * The arm used to be write-only — two routes added it, and the only remover is
 * `gateway-pre-start.sh`'s v1-gated cleanup, so on the pinned core nothing on
 * the box ever cleared it. Harmless while it could only sit on a `codex/<id>`
 * key no other lane could name; not harmless now that both OpenAI lanes write
 * `openai/<id>`. Without this, an owner who signs in with ChatGPT, later
 * switches OpenAI to API-key mode and saves the SAME model keeps every turn on
 * the ChatGPT account while Settings says "Configured" — and once the sign-in
 * is removed, the app-server has no credential and every turn dies on the
 * Cloudflare challenge with no ClawBox surface that can undo it.
 *
 * `config unset` rather than a `null` in the batch: batch entries carry only
 * `value`/`ref`/`provider` (no delete), and a null is refused by the schema —
 * `Invalid input: expected object, received null`, measured on 2026.8.1. Its
 * own spawn, and only when the entry is actually there, so the ordinary save
 * costs nothing.
 */
async function clearChatgptRuntimeArm(
  modelRef: string,
  config: OpenClawConfig | null,
): Promise<string | undefined> {
  const models = (config?.agents?.defaults as
    { models?: Record<string, { agentRuntime?: { id?: unknown } }> } | undefined)?.models;
  if (models?.[modelRef]?.agentRuntime?.id !== CHATGPT_AGENT_RUNTIME_ID) return undefined;
  const path = chatgptRuntimeEntryPath(modelRef);
  try {
    await runOpenclawConfigUnset(path, { uid: CLAWBOX_UID, gid: CLAWBOX_GID });
    return undefined;
  } catch (unsetErr) {
    console.error(
      "[configure] failed to clear the Codex runtime entry:",
      unsetErr instanceof Error ? JSON.stringify(logSafe(unsetErr.message)) : unsetErr,
    );
    return `Saved, but this box still routes ${modelRef} through your ChatGPT account: `
      + `clearing the Codex runtime setting failed. Run 'openclaw config unset ${path}' `
      + "from the Terminal, or chat may answer on the subscription instead of the API key.";
  }
}

/**
 * Whether the installed binary uses OpenClaw 2's SQLite credential store.
 * Ask the binary itself rather than the repository pin: a partially completed
 * update can leave those two versions different, and the installed process is
 * the one that must be able to consume the credential we just wrote.
 */
async function installedOpenclawUsesSqliteAuthStore(): Promise<boolean> {
  const output = await spawnOpenclawCli(["--version"], {
    captureStdout: true,
    timeoutMs: 30_000,
  });
  const match = /\b(20\d{2})\.(\d+)\.(\d+)\b/.exec(output);
  if (!match) throw new Error("Could not determine the installed OpenClaw version");
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year > 2026 || (year === 2026 && month >= 8);
}

/** The ClawBox AI token this box has on record, or "" — never a supplied one. */
async function storedClawboxAiToken(): Promise<string> {
  try {
    const config = await getAll();
    return typeof config[CLAWBOX_AI_TOKEN_CONFIG_KEY] === "string"
      ? config[CLAWBOX_AI_TOKEN_CONFIG_KEY].trim()
      : "";
  } catch {
    return "";
  }
}

/**
 * `getCodingAgentStatus().ready`, or `undefined` when the probe could not answer.
 *
 * IMPORTED LAZILY, the same move `hermes-clawai.ts` makes for the reason it
 * states: `coding-agent` owns the runs store and captures `DATA_DIR`,
 * `CODE_PROJECTS_DIR` and `RUNS_PATH` at module evaluation, and it drags
 * `child_process`, the app proxy, the git helpers and the browser-session
 * machinery in behind it. A static import here would put all of that in the
 * graph of every route that statically imports THIS one — `clawai/poll` and
 * `llamacpp/install` — and on the Hermes SKU it would be paid on a path that
 * returns long before this code can run.
 *
 * `undefined` on a throw, never `false`: "we could not find out" must not read
 * as "the coding agent is not ready", which would buy a reload on a save that
 * changed nothing.
 */
async function codingAgentReady(): Promise<boolean | undefined> {
  try {
    const { getCodingAgentStatus } = await import("@/lib/coding-agent");
    return (await getCodingAgentStatus()).ready;
  } catch {
    return undefined;
  }
}

async function getConfiguredClawboxAiToken(preferredToken?: string) {
  const trimmedPreferred = preferredToken?.trim();
  if (trimmedPreferred) {
    return trimmedPreferred;
  }

  return storedClawboxAiToken();
}

// Canonical DeepSeek V4 limits. Declared explicitly on every model entry
// rather than left to OpenClaw's bundled catalog: a configured provider in
// openclaw.json overrides the plugin catalog entirely, so an omitted
// contextWindow does NOT inherit the canonical spec — it falls through to the
// generic 200,000-token default. Verified on a real device running OpenClaw
// 2026.7.1 (2026-08-17): with these fields absent, `openclaw models list`
// resolved both V4 models to 200K; with them present it reports 1M.
const CLAWBOX_AI_CONTEXT_WINDOW = 1_000_000;
// 393,216 (384 x 1024) is the ceiling the upstream actually enforces, measured
// against the live proxy on 2026-08-18: max_tokens=393216 is accepted, 400000
// comes back 400 "the valid range of max_tokens is [1, 393216]". The previous
// 384,000 was a round number that left 9,216 tokens of output unusable for no
// reason.
const CLAWBOX_AI_MAX_TOKENS = 393_216;
// V4 is text-in/text-out upstream. Stated rather than inferred so the picker
// never offers image attachments the proxy would reject.
const CLAWBOX_AI_INPUT_MODALITIES = ["text"] as const;

function buildClawboxAiProviderDefinition(apiKey: string, visionModelId: string = CLAWBOX_AI_VISION_MODEL_ID) {
  // Emit the proxy URL, our auth, per-tier identity/branding/reasoning, and
  // the context/output/modality limits above.
  // `cost` stays zero to mark these as included-in-subscription so the
  // gateway doesn't surface DeepSeek's real per-token prices in the UI.
  return JSON.stringify({
    baseUrl: CLAWBOX_AI_PROXY_URL,
    api: "openai-completions",
    apiKey,
    // `reasoning: true` on both entries is what tells the OpenClaw
    // gateway to forward explicit thinking controls to DeepSeek. The
    // cloud proxy disables thinking by default, so `off` must remain
    // available in the model catalog; users opt into reasoning with
    // High/X-High from the chat header.
    //
    // `compat.supportedReasoningEfforts: ["off", "high", "xhigh"]` is what
    // tells the gateway's `catalogSupportsXHigh()` to append xhigh to
    // each model's allowed-level profile. Without it, sessions.patch
    // rejects xhigh ("use off|minimal|low|medium|high") and the chat
    // popup's "X-High" effort silently fails — even though the provider
    // stream layer maps OpenClaw xhigh → DeepSeek upstream
    // `reasoning_effort: "max"` perfectly. The plugin-extension JSON
    // does NOT cover this case because configured providers in
    // openclaw.json override the plugin's modelCatalog entirely; the
    // compat must live on the configured entry.
    models: [
      {
        id: CLAWBOX_AI_FLASH_MODEL_ID,
        name: "ClawBox AI Flash",
        reasoning: true,
        input: [...CLAWBOX_AI_INPUT_MODALITIES],
        contextWindow: CLAWBOX_AI_CONTEXT_WINDOW,
        maxTokens: CLAWBOX_AI_MAX_TOKENS,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["off", "high", "xhigh"],
        },
      },
      {
        id: CLAWBOX_AI_PRO_MODEL_ID,
        name: "ClawBox AI Pro",
        reasoning: true,
        input: [...CLAWBOX_AI_INPUT_MODALITIES],
        contextWindow: CLAWBOX_AI_CONTEXT_WINDOW,
        maxTokens: CLAWBOX_AI_MAX_TOKENS,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["off", "high", "xhigh"],
        },
      },
      // Image understanding. Not a chat tier and never selectable as one —
      // the device model picker reads CLAWAI_STATIC_MODELS, not this array —
      // it exists so `agents.defaults.imageModel` has something to resolve to
      // when the user attaches a picture and the text-only session model
      // cannot look at it. See the CLAWBOX_AI_VISION_* block in
      // src/lib/clawbox-ai-models.ts for why it lives under this provider.
      //
      // No `reasoning`/`compat`: the media-understanding path issues a
      // one-shot describe and never negotiates a thinking level.
      {
        id: visionModelId,
        name: CLAWBOX_AI_VISION_MODEL_LABEL,
        input: [...CLAWBOX_AI_VISION_INPUT_MODALITIES],
        maxTokens: CLAWBOX_AI_VISION_MAX_TOKENS,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}

/**
 * Model catalog entry that points OpenClaw's `openai` image provider at the
 * ClawBox AI proxy instead of api.openai.com.
 *
 * Why this exact shape — every field (and every omission) is load-bearing, all
 * verified against OpenClaw 2026.7.1-2, the version the device ships:
 *
 * - **Per-model `baseUrl`, never a provider-wide one.**
 *   `resolveConfiguredOpenAIImageBaseUrl(cfg, model)` in
 *   `dist/image-generation-provider-*.js` looks the requested image model up
 *   inside `models.providers.openai.models[]` and takes that entry's `baseUrl`,
 *   falling back to `models.providers.openai.baseUrl`, then to
 *   api.openai.com. Both hooks work, but the provider-wide one also retargets
 *   the OpenAI plugin's built-in *chat* catalog: `models.providers` merging
 *   keeps the implicit catalog when `models[]` is empty and each row resolves
 *   its endpoint as `model.baseUrl ?? providerBaseUrl`. Setting the provider
 *   baseUrl therefore points GPT-5.4/5.5/... at a proxy that only speaks
 *   DeepSeek chat and images, so every one of those picker entries would fail
 *   on its first turn. The per-model override touches exactly one model.
 *
 * - **No `api` field.** It narrows where the entry is offered as a chat model,
 *   but — measured on 2026.8.1 — it does NOT hide it everywhere, and the
 *   docblock in src/lib/clawbox-ai-models.ts says exactly where it fails: the
 *   configured-row gate is skipped under `models.mode: "replace"` (which the
 *   local-model branches of THIS route write), and `configuredKeys` exempts
 *   every configured row from the picker's hide rule. So OpenClaw's own
 *   pickers can still offer `openai/gpt-image-1-mini`; ClawBox's cannot, and
 *   all three writers of `agents.defaults.model.primary` refuse it. The field
 *   is still stripped from our row — it matches beta and it does close the
 *   common `models.mode: "merge"` case — but it is not the guarantee earlier
 *   revisions of this comment claimed. The image path is unaffected either
 *   way, because it reads raw config rather than the normalised catalog.
 *
 * - **`name` is mandatory.** OpenClaw's config schema rejects a models[] entry
 *   without one ("models.providers.openai.models.0.name: Invalid input") and an
 *   invalid config stops the gateway from starting.
 *
 * - **No `input` / `contextWindow` / `maxTokens` / `cost`.** Those describe a
 *   chat model's token accounting; an images endpoint has none, and the fields
 *   only exist on the DeepSeek entries because a configured provider overrides
 *   OpenClaw's bundled chat catalog. Nothing reads them here.
 */
type OpenAiProviderConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
>;
type OpenAiModelEntry = NonNullable<OpenAiProviderConfig["models"]>[number];

/**
 * Every host ClawBox has ever written as the ClawBox AI proxy.
 *
 * Seeded from the same source the boot migration uses — the LIVE
 * `models.providers.deepseek.baseUrl` this box was provisioned against — plus
 * the build-time `CLAWBOX_AI_PROXY_URL` and the shared historical list.
 *
 * Taking the live value matters: the two writers previously disagreed whenever
 * they disagreed about the env. A staging box whose web app was restarted
 * without `CLAWBOX_AI_PROXY_URL` stopped recognising its own staging image row
 * — `foreignOpenAiRoute` then called it foreign and backed the ENTIRE image
 * and token write off, with a single `console.warn` as the only signal.
 *
 * But the live value is only a ClawBox host when the deepseek entry is a
 * ClawBox AI one. `install.sh`'s `CLAWBOX_AI_API_KEY` branch provisions a RAW
 * DeepSeek key at `api.deepseek.com`, and on the first pairing the snapshot
 * still says that — admitting it would make a genuine third party "not
 * foreign" and write the portal token as the bearer for a route that leaves
 * for DeepSeek, which is the exact harm `foreignOpenAiRoute` exists to
 * prevent. So the live host is admitted only behind the same `claw_`
 * entitlement test the boot migration gates its whole block on.
 */
function clawboxProxyHosts(deepseekProvider: OpenAiProviderConfig | undefined): ReadonlySet<string> {
  const apiKey = deepseekProvider?.apiKey;
  const liveProxyUrl = typeof apiKey === "string" && apiKey.startsWith(CLAWBOX_AI_TOKEN_PREFIX)
    ? deepseekProvider?.baseUrl
    : undefined;
  return new Set(
    [CLAWBOX_AI_PROXY_URL, liveProxyUrl, ...CLAWBOX_AI_PROXY_URLS]
      .map((url) => (typeof url === "string" && url.trim() ? hostOfUrl(url.trim()) : null))
      .filter((host): host is string => host !== null),
  );
}

/**
 * Is this `models[]` row the one WE wrote?
 *
 * The id cannot answer it on its own. `gpt-image-1-mini` is a real OpenAI model
 * id, so an owner running their own image endpoint — Azure OpenAI, LiteLLM,
 * vLLM, any self-hosted OpenAI-compatible gateway — can have a row of exactly
 * that id. Claiming it repoints their route at our proxy, overwrites their
 * `api`, and puts the portal token on the provider block as the credential for
 * a route we do not own.
 *
 * So ownership is positive, not negative: the row's own `baseUrl` must name a
 * host ClawBox itself has written. "Not api.openai.com" is the wrong test —
 * api.openai.com is the LEAST likely place for a power user's private row.
 * The set includes the retired hosts, so the documented retarget of an entry
 * left on an old proxy still recognises it as ours.
 *
 * A row with no `baseUrl` of its own is not ours either: ClawBox has always
 * written one, and an inherited provider-level URL is the owner's choice.
 *
 * One question, asked identically by the four places that decide ownership:
 * `foreignOpenAiRoute`'s skip and this upsert here, and their two siblings in
 * scripts/gateway-pre-start.sh.
 */
function isOurImageRow(row: unknown, proxyHosts: ReadonlySet<string>): boolean {
  if (typeof row !== "object" || row === null) return false;
  const entry = row as OpenAiModelEntry;
  if (entry.id !== CLAWBOX_AI_IMAGE_MODEL_ID) return false;
  if (typeof entry.baseUrl !== "string" || !entry.baseUrl.trim()) return false;
  const host = hostOfUrl(entry.baseUrl.trim());
  return host !== null && proxyHosts.has(host);
}

/**
 * Merge our image-model entry into whatever `models[]` the box already carries.
 *
 * An upsert, not a replacement: `config set models.providers.openai.models`
 * writes the whole array, so building it from our entry alone would delete every
 * other model row the owner configured. The boot migration in
 * scripts/gateway-pre-start.sh has always upserted; this is the same operation
 * expressed against a JSON blob instead of a mutable dict, and the two must
 * agree — a box repaired at boot and a box configured through this route have to
 * end up with the same config.
 *
 * Repairs on an entry that is already ours, in the same order the migration
 * applies them: a missing/blank `name` (OpenClaw's schema rejects the config
 * without one and the gateway then refuses to start), a `baseUrl` left pointing
 * at a retired proxy, and a stray `api` — see
 * `buildClawboxAiImageProviderModels` for why `api` must not be there.
 */
function upsertClawboxAiImageModel(existing: unknown, proxyHosts: ReadonlySet<string>): OpenAiModelEntry[] {
  const rows: OpenAiModelEntry[] = Array.isArray(existing)
    ? existing.filter((row): row is OpenAiModelEntry => typeof row === "object" && row !== null)
    : [];
  if (!rows.some((row) => isOurImageRow(row, proxyHosts))) {
    return [
      ...rows,
      {
        id: CLAWBOX_AI_IMAGE_MODEL_ID,
        name: CLAWBOX_AI_IMAGE_MODEL_LABEL,
        baseUrl: CLAWBOX_AI_PROXY_URL,
      },
    ];
  }
  // Every duplicate of our row is repaired the same way — see the migration.
  return rows.map((row) => {
    if (!isOurImageRow(row, proxyHosts)) return row;
    const { api: _api, ...rest } = row;
    return {
      ...rest,
      name: typeof row.name === "string" && row.name.trim() ? row.name : CLAWBOX_AI_IMAGE_MODEL_LABEL,
      baseUrl: CLAWBOX_AI_PROXY_URL,
    };
  });
}

function buildClawboxAiImageProviderModels(existing: unknown, proxyHosts: ReadonlySet<string>) {
  return JSON.stringify(upsertClawboxAiImageModel(existing, proxyHosts));
}

/**
 * True when it is safe for us to own `models.providers.openai.apiKey`.
 *
 * We put the ClawBox AI token there because that is the only credential slot
 * the OpenAI image provider reads: on the image path it calls
 * `forceOpenAIImageApiKeyAuth(cfg)`, which injects `auth: "api-key"` into a
 * *copy* of the config, which in turn makes `shouldPreferExplicitConfigApiKeyAuth`
 * true and the configured key outrank any auth profile. Chat does not take that
 * branch — we deliberately never write `auth: "api-key"` into the real config —
 * so a user who also signs in to OpenAI keeps chatting on their own key from
 * `auth.profiles.openai:default` while images go out on the ClawBox token.
 *
 * The one case we refuse is a box that already has some *other* literal key
 * sitting in that slot. ClawBox has never written one (the openai branch of
 * this route configures a native auth profile and leaves `models.providers`
 * alone), so a value there was put there by hand, and overwriting a
 * hand-placed credential to enable a feature nobody asked for is not ours to
 * do. Those boxes get no image provider and a log line saying why.
 */
function canOwnOpenAiImageApiKey(existingKey: unknown): boolean {
  if (existingKey === undefined || existingKey === null) return true;
  if (typeof existingKey !== "string") return false;
  const trimmed = existingKey.trim();
  return trimmed === "" || trimmed.startsWith(CLAWBOX_AI_TOKEN_PREFIX);
}

/**
 * Where OpenClaw sends a request for an `openai` model that names no host of
 * its own. `resolveConfiguredOpenAIBaseUrl` in
 * `dist/shared-BdJp-xt6.js:11` (2026.7.1-2).
 */
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The baseUrl an already-configured `openai` route would send our token to, or
 * `null` when every configured route stays on the ClawBox AI proxy.
 *
 * `models.providers.openai.apiKey` is a *provider-wide* credential — the image
 * path is the only reason we write it, but nothing scopes it to the image
 * model. OpenClaw resolves a model's key by walking per-entry bindings, then
 * auth profiles, then the environment, and finally
 * `models.providers.<p>.apiKey` (`getApiKeyForModel`,
 * `dist/model-auth-CJEm9SNp.js:753` on 2026.7.1-2). On a ClawBox there is no
 * openai auth profile and no `OPENAI_API_KEY`, so that last step is where every
 * `openai/*` request lands: writing the portal token there makes it the bearer
 * for whatever else the box has configured under `openai`.
 *
 * Two configured shapes send it off-proxy, and both are the owner's own work
 * (ClawBox writes neither):
 *   - a `models[]` row other than ours. Its endpoint is
 *     `row.baseUrl ?? provider.baseUrl ?? api.openai.com` — so a row like
 *     `{id: "gpt-5", api: "openai-completions"}` with no baseUrl resolves
 *     straight to api.openai.com and would go out bearing `claw_…`.
 *   - a provider-level `baseUrl`, which is the fallback for every row that
 *     sets none.
 * Either one means the box has an `openai` setup we did not build and cannot
 * reason about, so the caller backs the whole migration off rather than
 * half-configure it: an image tool is not worth mailing the subscription token
 * to a third party.
 *
 * A malformed URL counts as foreign. We cannot show where it points, and
 * guessing in the permissive direction is the wrong way to be wrong here.
 *
 * Not covered — deliberately, and it is not something this function could fix:
 * OpenClaw's bundled openai *plugin* catalog (gpt-5.x, o1, o3, …) exists on
 * every box whether or not anything is configured, and those rows resolve to
 * api.openai.com too. Verified on 2026.7.1-2: with `models.providers.openai
 * .apiKey` set to a `claw_` token, `openclaw models list --provider openai`
 * flips all 17 of them from `Auth: no` to `Auth: yes`, so picking one in the
 * chat model picker would send the portal token to OpenAI. The only credential
 * slot the image provider reads is this provider-wide one (there is no
 * per-model `apiKey`), so the two cannot be separated in this version — see
 * the note on the PR.
 */
function foreignOpenAiRoute(provider: OpenAiProviderConfig | undefined, proxyHosts: ReadonlySet<string>): string | null {
  if (!provider) return null;
  // The SAME set `isOurImageRow` uses, not the build-time `CLAWBOX_AI_PROXY_URL`
  // alone. The boot migration asks this question with its own
  // `_clawbox_proxy_hosts`, built from the same three sources, and its
  // `_is_foreign` tests membership of that set exactly as this does — so the
  // two writers cannot disagree about a host, and neither can the two
  // questions asked here.
  //
  // With the build-time value alone, a staging box whose web app restarted
  // without the env var called its own staging host foreign while the
  // migration called it ours — and a foreign route backs the ENTIRE image and
  // token write off with one `console.warn`. Both were single-host once; both
  // now carry the retired hosts too, so a row left on an old proxy is not
  // mistaken for a third party's.
  const isForeign = (baseUrl: string) => {
    const host = hostOfUrl(baseUrl);
    return host === null || !proxyHosts.has(host);
  };

  const providerBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  if (providerBaseUrl && isForeign(providerBaseUrl)) return providerBaseUrl;

  const rows = Array.isArray(provider.models) ? provider.models : [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    // OUR row is skipped — not every row that happens to share its id. See
    // `isOurImageRow`: a `gpt-image-1-mini` row on a host we have never
    // written is the owner's, and skipping it by id here was what let the
    // upsert downstream claim it and repoint it at our proxy.
    if (isOurImageRow(row, proxyHosts)) continue;
    const rowBaseUrl = typeof row.baseUrl === "string" && row.baseUrl.trim()
      ? row.baseUrl.trim()
      : providerBaseUrl || OPENAI_DEFAULT_BASE_URL;
    if (isForeign(rowBaseUrl)) return rowBaseUrl;
  }
  return null;
}

/**
 * True when an `agents.defaults.<tool>Model` slot already names a model.
 *
 * Byte-for-byte the same test OpenClaw applies in `hasToolModelConfig`
 * (`dist/model-config.helpers-BS3FWcoO.js:25` on 2026.7.1-2):
 * `primary?.trim() || (fallbacks ?? []).some(entry => entry.trim().length > 0)`.
 * Fallbacks count. A box carrying only
 * `{ fallbacks: ["replicate/flux-pro"] }` has a working image setup its owner
 * chose, and since the write below replaces the whole object, testing
 * `primary` alone would delete those fallbacks.
 *
 * Connecting ClawBox AI is not by itself a request to change where images come
 * from — `configureClawboxAi` also runs from `ensureFallbackModel`, i.e. when
 * the user is configuring some *other* provider entirely and ClawBox AI is
 * only the fallback. Claiming an occupied slot there would silently overrule a
 * choice the user made elsewhere, so we claim only what is empty. Mirrors the
 * same guard in the boot migration in scripts/gateway-pre-start.sh.
 *
 * Shared by `imageGenerationModel` (where images come from) and `imageModel`
 * (what looks at an image the user sent). Different slots, identical
 * don't-clobber rule, and OpenClaw reads both through the same helper.
 */
function hasToolModelConfig(existing: unknown): boolean {
  if (typeof existing !== "object" || existing === null) return false;
  const cfg = existing as { primary?: unknown; fallbacks?: unknown };
  if (typeof cfg.primary === "string" && cfg.primary.trim()) return true;
  return Array.isArray(cfg.fallbacks)
    && cfg.fallbacks.some((ref) => typeof ref === "string" && ref.trim().length > 0);
}

/**
 * Point OpenClaw's `image_generate` tool at the ClawBox AI image proxy.
 *
 * Without this a provisioned ClawBox cannot generate images at all, even
 * though the subscription pays for 5/50/200 of them a month: OpenClaw only
 * registers `image_generate` when an image-generation provider is configured,
 * and ClawBox provisioning configured none.
 *
 * Registration is gated twice and the gates are asymmetric, which is why the
 * `agents.defaults.imageGenerationModel` write below is not optional:
 *   - Gate 1 (`resolveOptionalMediaToolFactoryPlan`) plans the tool only if
 *     `agents.defaults.imageGenerationModel` has a non-empty primary/fallback
 *     OR a plugin capability snapshot reports an available provider — and for
 *     `openai` that snapshot only accepts an `openai` *auth profile* or an
 *     `OPENAI_API_KEY` in the gateway's environment. It never reads
 *     `models.providers.openai.apiKey`.
 *   - Gate 2 (inside `createImageGenerateTool`) does accept the config key.
 * So a box with only the provider block would satisfy gate 2, fail gate 1, and
 * never see the tool. Naming a model in `imageGenerationModel` is the
 * deterministic path — hence the write below on every box that does not
 * already name one (see `hasToolModelConfig` for why "already" includes
 * fallbacks).
 *
 * Note the key name: `imageGenerationModel`, *not* `imageModel`. They are two
 * independent config keys with no aliasing between them — `imageModel` selects
 * the image *understanding* (vision) model and is what `openclaw models
 * set-image` writes, which is why that CLI command is not used here.
 */
function buildClawboxAiImageOps(
  clawboxAiToken: string,
  snapshot: OpenClawConfig | null,
): OpenclawConfigSetArgs[] {
  let existingOpenAiProvider: OpenAiProviderConfig | undefined =
    snapshot?.models?.providers?.[CLAWBOX_AI_IMAGE_PROVIDER];
  // OpenClaw 2 home first (agents.defaults.mediaModels.image); the legacy
  // key is still honoured as "already configured" so a box the loader has
  // not migrated yet is not double-claimed.
  const defaults = snapshot?.agents?.defaults as
    | { imageGenerationModel?: unknown; mediaModels?: { image?: unknown } }
    | undefined;
  const existingImageModel: unknown = defaults?.mediaModels?.image ?? defaults?.imageGenerationModel;
  if (typeof existingOpenAiProvider !== "object" || existingOpenAiProvider === null) {
    existingOpenAiProvider = undefined;
  }
  // Same seed the boot migration uses: the proxy this box was actually
  // provisioned against, off the deepseek entry the configure route wrote.
  const proxyHosts = clawboxProxyHosts(snapshot?.models?.providers?.[CLAWBOX_AI_PROVIDER]);

  if (!canOwnOpenAiImageApiKey(existingOpenAiProvider?.apiKey)) {
    console.warn(
      "[AI Config] Skipped ClawBox AI image provider: models.providers.openai.apiKey holds a non-ClawBox key we will not overwrite",
    );
    return [];
  }

  const foreignRoute = foreignOpenAiRoute(existingOpenAiProvider, proxyHosts);
  if (foreignRoute) {
    console.warn(
      // The host only: an owner-configured URL can carry user-info or query
      // credentials, and the journal keeps what is logged.
      `[AI Config] Skipped ClawBox AI image provider: models.providers.openai already routes to ${logSafe(hostOfUrl(foreignRoute) ?? "an unparseable URL")}, and the apiKey we would write there is the credential for that route too`,
    );
    return [];
  }

  // Leaf-path writes, not a whole-provider `config set models.providers.openai`:
  // replacing the object would drop any other openai settings the box carries.
  const ops: OpenclawConfigSetArgs[] = [
    [`models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}.apiKey`, clawboxAiToken],
    [
      `models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}.models`,
      buildClawboxAiImageProviderModels(existingOpenAiProvider?.models, proxyHosts),
      "--json",
    ],
  ];
  if (hasToolModelConfig(existingImageModel)) {
    console.log(
      "[AI Config] Left the image-generation model alone: it already names one (mediaModels.image or the legacy imageGenerationModel)",
    );
    return ops;
  }
  ops.push([
    // OpenClaw 2's home for the image-generation model. gateway-pre-start.sh
    // writes the same key under the same version gate; the two must stay in
    // step.
    "agents.defaults.mediaModels.image",
    JSON.stringify({ primary: CLAWBOX_AI_IMAGE_MODEL }),
    "--json",
  ]);
  return ops;
}

/**
 * Provision ClawBox AI: the auth profile, the provider definition, image
 * understanding, image generation, and optionally the fallback slot.
 *
 * All of it lands in ONE `openclaw config set --batch-json` on the happy path.
 * It used to be six to seven separate invocations at ~8 s of CLI startup each,
 * and on the ClawBox AI wizard path this function ran TWICE — see the caller
 * (TASK-483).
 *
 * The three groups below exist because their failures mean different things,
 * and `applyConfigSetGroups` is what keeps them apart while still writing them
 * together. Every conditional here reads `snapshot`, one config read taken
 * before any of this request's writes, because each of those decisions is about
 * what the owner had BEFORE we started — nothing we write in this pass changes
 * the answer.
 */
async function configureClawboxAi(
  setFallback: boolean,
  preferredToken?: string,
  extra?: {
    /** Ops to write in the same must-succeed group. */
    requiredOps?: OpenclawConfigSetArgs[];
    /** Extra groups to write in the same batch, with their own boundaries. */
    groups?: ConfigSetGroup[];
    /**
     * Did the SAVE that led here actually change this box's ClawBox AI
     * credential?
     *
     * THE CALLER'S QUESTION, and it cannot be answered here. By the time this
     * function runs, the handler has already written the new token into
     * `data/config.json` — so a read taken here answers with the value it is
     * being asked about, and every re-link would look like a re-paste. The
     * handler holds the only honest answer: `previousClawaiToken`, captured
     * before its own `setMany`. (The same trap `/setup-api/hermes/clawai`
     * documents for `codingAgentReadyBefore`, one file over.)
     *
     * Defaults to false, which is right for the path that does not pass it:
     * `ensureFallbackModel` calls this with no token whenever a box with no
     * local model saves ANY provider, and there the paste re-writes the bytes
     * the box already held.
     */
    credentialChanged?: boolean;
  },
) {
  const clawboxAiToken = await getConfiguredClawboxAiToken(preferredToken);
  if (!clawboxAiToken) {
    return false;
  }

  const credentialChanged = extra?.credentialChanged === true;

  // ClawBox AI uses the portal token generated by the user; stored through
  // the CLI so the credential lands in the auth store of the running
  // generation (see pasteAuthApiKey).
  await pasteAuthApiKey(CLAWBOX_AI_PROVIDER, CLAWBOX_AI_PROFILE_KEY, clawboxAiToken);
  // The credential is now on disk, so any memory that the PROXY refused the
  // previous one is about a token this box no longer holds. AFTER the write,
  // not before it: a paste that threw would otherwise have re-enabled requests
  // against the very token that was refused. This is what makes "re-link the
  // device" — the instruction every refusal prints — take effect on the next
  // call rather than after a timer. See src/lib/harness/credentials.ts.
  //
  // ONLY when the credential changed. Re-pasting the same refused bytes is not
  // a re-link, and clearing on one would let any other provider's save undo the
  // boot script's stand-down and start the storm again — the mark is about the
  // CREDENTIAL, so only a different credential retires it.
  if (credentialChanged) await forgetClawaiCredentialRefusal();

  let snapshot: OpenClawConfig | null = null;
  try {
    snapshot = await readOpenClawConfig();
  } catch {
    // No readable config yet (fresh box) — nothing to preserve.
    snapshot = null;
  }

  // Which vision id may this box name? The DeepSeek model when the proxy
  // serves it, the previous one until then — asked live, never assumed. When
  // the QUESTION failed (timeout, 5xx — not a refusal), keep whichever of
  // OUR ids the box already runs: a bad network moment must not downgrade a
  // box the proxy already upgraded.
  const vision = await resolveVisionModelId({ token: clawboxAiToken });
  const currentImageModel = snapshot?.agents?.defaults?.imageModel as { primary?: unknown; fallbacks?: unknown } | undefined;
  const currentPrimary = typeof currentImageModel?.primary === "string" ? currentImageModel.primary.trim() : "";
  const currentBareId = currentPrimary.startsWith(`${CLAWBOX_AI_PROVIDER}/`)
    ? currentPrimary.slice(CLAWBOX_AI_PROVIDER.length + 1)
    : currentPrimary;
  const visionId = vision.reason === "probe-failed" && currentPrimary && isClawboxAiVisionId(currentPrimary)
    ? currentBareId
    : vision.id;
  const visionRef = clawboxAiVisionModelRef(visionId);
  console.log(`[AI Config] Vision model resolved to ${visionId} (${vision.reason})`);

  const requiredOps: OpenclawConfigSetArgs[] = [
    [
      `auth.profiles.${CLAWBOX_AI_PROFILE_KEY}`,
      JSON.stringify({ provider: CLAWBOX_AI_PROVIDER, mode: "api_key" }),
      "--json",
    ],
    [
      `models.providers.${CLAWBOX_AI_PROVIDER}`,
      buildClawboxAiProviderDefinition(clawboxAiToken, visionId),
      "--json",
    ],
    ...(extra?.requiredOps ?? []),
  ];

  // Point image *understanding* at the vision entry the provider definition
  // above just wrote. Without this the device accepts an attached picture and
  // then cannot look at it: the ClawBox AI chat models are `input: ["text"]`,
  // so OpenClaw hands the turn a media path instead of inline image parts, and
  // the `image` tool that would read that path resolves its model through
  // `agents.defaults.imageModel` — which ClawBox provisioning never set, making
  // `runWithImageModelFallback` throw "No image model configured"
  // (`dist/model-fallback-CvSRhgYr.js` on 2026.7.1). Reproduced on a real box
  // on 2026-08-21; see TASK-417.
  //
  // Same don't-clobber rule as image generation, for the same reason: this
  // function also runs when ClawBox AI is merely being added as a *fallback*
  // for some other provider, and a slot the owner filled is their choice.
  // Non-fatal for the same reason too.
  const visionOps: OpenclawConfigSetArgs[] = [];
  if (!hasToolModelConfig(snapshot?.agents?.defaults?.imageModel)) {
    visionOps.push([
      "agents.defaults.imageModel",
      JSON.stringify({ primary: visionRef }),
      "--json",
    ]);
  } else if (currentPrimary && isClawboxAiVisionId(currentPrimary) && currentPrimary !== visionRef) {
    // The slot names one of OUR vision ids — the previous default is ours to
    // move to the resolved one (both directions: the DeepSeek upgrade when
    // the proxy starts serving it, and the fall-back if it stops). A value
    // the owner set themselves never matches and is never touched — and the
    // move changes ONLY `primary`: fallbacks the owner added ride along.
    console.log(`[AI Config] Moving agents.defaults.imageModel ${currentPrimary} -> ${visionRef}`);
    visionOps.push([
      "agents.defaults.imageModel",
      JSON.stringify({ ...(currentImageModel as object), primary: visionRef }),
      "--json",
    ]);
  } else {
    console.log(
      "[AI Config] Left agents.defaults.imageModel alone: it already names a vision model",
    );
  }

  // Images ride on the same token and the same proxy, so they are provisioned
  // here rather than behind a separate opt-in — a box that has ClawBox AI has
  // image generation whether or not ClawBox AI is also the chat provider.
  // Non-fatal: a chat provider that works is worth more than an image tool, so
  // a failure here must not fail the whole "Connect ClawBox AI" flow.
  let imageOps: OpenclawConfigSetArgs[] = [];
  // The other half of the boot script's stand-down, and the reason it needs one
  // here at all: `buildClawboxAiImageOps` writes the SAME row and the SAME slot
  // that `scripts/gateway-pre-start.sh` takes back when the proxy has refused
  // this box's credential, and this function runs on saves that have nothing to
  // do with ClawBox AI. Without this gate, configuring any other provider on a
  // refused box re-armed the image path and restarted the gateway on top of it.
  // Read AFTER the clear above, so a genuine re-link arms as it always did.
  if (await clawaiCredentialRefusalOnRecord()) {
    console.log(
      "[AI Config] Left the ClawBox AI image model alone: the proxy has refused this box's credential",
    );
  } else {
    try {
      imageOps = buildClawboxAiImageOps(clawboxAiToken, snapshot);
    } catch (err) {
      console.warn(
        "[AI Config] Failed to configure ClawBox AI image provider:",
        err instanceof Error ? logSafe(err.message) : err,
      );
    }
  }

  await applyConfigSetGroups([
    { ops: requiredOps },
    {
      ops: visionOps,
      onApplied: () =>
        console.log(
          `[AI Config] Set ClawBox AI vision model ${visionRef} via proxy ${CLAWBOX_AI_PROXY_URL}`,
        ),
      onError: (err) =>
        console.warn(
          "[AI Config] Failed to configure ClawBox AI vision model:",
          err instanceof Error ? logSafe(err.message) : err,
        ),
    },
    {
      ops: imageOps,
      onApplied: () =>
        console.log(
          `[AI Config] Set ClawBox AI image provider ${CLAWBOX_AI_IMAGE_MODEL} via proxy ${CLAWBOX_AI_PROXY_URL}`,
        ),
      // `logSafe`, not the raw message: this one is built from a subprocess
      // failure, so it carries whatever `openclaw` wrote to stderr — a value
      // that reached the CLI from this route's request body, control characters
      // and all. Unbounded and un-escaped, it would be the caller deciding how
      // many journal records one API call produces. The command line itself is
      // already safe: the batch label names the config paths and elides every
      // value, which here includes the portal token (see
      // `configSetBatchLabelArgs`).
      onError: (err) =>
        console.warn(
          "[AI Config] Failed to configure ClawBox AI image provider:",
          err instanceof Error ? logSafe(err.message) : err,
        ),
    },
    ...(extra?.groups ?? []),
    setFallback
      ? {
          ops: [[
            "agents.defaults.model.fallbacks",
            JSON.stringify([CLAWBOX_AI_MODEL]),
            "--json",
          ]],
        }
      : null,
  ]);

  return true;
}

async function setFallbackModels(models: string[]) {
  await runCommand(OPENCLAW_BIN, [
    "config",
    "set",
    "agents.defaults.model.fallbacks",
    JSON.stringify(models),
    "--json",
  ]);
}

async function getStoredLocalFallbackModel(): Promise<string | null> {
  try {
    const config = await getAll();
    if (Object.prototype.hasOwnProperty.call(config, "local_ai_configured") && config.local_ai_configured === false) {
      return null;
    }
    const stored = config.local_ai_configured && typeof config.local_ai_model === "string"
      ? config.local_ai_model
      : null;
    if (stored) return stored;
  } catch {
    // Fall through to OpenClaw config inference.
  }

  try {
    const openclawConfig = await readOpenClawConfig();
    return inferConfiguredLocalModel(openclawConfig)?.model ?? null;
  } catch {
    return null;
  }
}

/**
 * The providers the owner has switched off. The fallback slot honours the
 * switch too: a provider the gateway would quietly route to when the primary
 * fails is exactly what "switched off" promises cannot happen.
 */
/**
 * The local model that should back up `primaryModel`, or null when there is
 * none to use.
 *
 * Split out of `ensureFallbackModel` so a caller that is about to write a pile
 * of config can learn the answer BEFORE it writes, and fold the fallback into
 * the same batch instead of paying another CLI start-up for it (TASK-483).
 */
/** The switched-off providers, read from the store this route already loads. */
async function readDisabledProviders(): Promise<Set<string>> {
  return parseDisabledProviders((await getAll())[DISABLED_PROVIDERS_KEY]);
}

async function pickLocalFallbackModel(
  primaryModel?: string | null,
  preferredLocalModel?: string,
): Promise<string | null> {
  const disabled = await readDisabledProviders();
  const fallbackCandidates = [preferredLocalModel, await getStoredLocalFallbackModel()]
    .filter((model): model is string => !!model && model !== primaryModel)
    .filter((model) => !disabled.has(normalizeProviderId(model.split("/")[0]) ?? ""));
  return fallbackCandidates[0] ?? null;
}

async function ensureFallbackModel(
  primaryModel?: string | null,
  preferredLocalModel?: string,
  preferredClawboxAiToken?: string,
) {
  const localFallback = await pickLocalFallbackModel(primaryModel, preferredLocalModel);

  if (localFallback) {
    await setFallbackModels([localFallback]);
    console.log(`[AI Config] Configured local fallback model: ${logSafe(localFallback)}`);
    return;
  }

  try {
    // ClawBox AI is the last resort, and the owner's switch reaches it too.
    const clawaiSwitchedOff = (await readDisabledProviders()).has("clawai");
    const fallbackConfigured = !clawaiSwitchedOff
      && await configureClawboxAi(true, preferredClawboxAiToken);
    if (fallbackConfigured) {
      console.log("[AI Config] Configured ClawBox AI as fallback model");
      return;
    }

    await setFallbackModels([]);
    console.log("[AI Config] Cleared stale fallback (no enabled local or ClawBox AI backup available)");
  } catch (err) {
    console.warn("[AI Config] Failed to configure fallback model:", err instanceof Error ? logSafe(err.message) : err);
  }
}

// Configure a provider through its OpenAI-compatible endpoint with the key
// inline, instead of OpenClaw's native plugin. On 2026.6.8 the gateway sends
// models.providers.<p>.apiKey verbatim and authenticates the call itself —
// the only path that works for these providers: openrouter has no native
// adapter at all, while google/anthropic native plugins read a per-agent
// sqlite auth store that ClawBox's file-based auth profile doesn't populate
// (so they 401 / "No API key found" at call time).
//
// The `models` array drives resolution, so we seed the curated picker list +
// the user's pick; the chat-header switch (/setup-api/chat/model) auto-extends
// it for any other id, so we don't bake in the provider's full churny
// catalogue. We emit only id+name — contextWindow/modalities/cost are looked up
// from OpenClaw's catalog per id (a uniform cap here lied for every model whose
// real spec differed).
async function writeOpenAICompatProvider(opts: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string; // fully-qualified, e.g. "anthropic/claude-opus-4-8"
  curatedModels: readonly { id: string }[];
}): Promise<void> {
  const defaultModelId =
    extractProviderModelId(opts.defaultModel, opts.provider) ?? opts.defaultModel;
  const modelIds = new Set<string>([
    defaultModelId,
    ...opts.curatedModels.map((m) => m.id),
  ]);
  const providerDef = JSON.stringify({
    baseUrl: opts.baseUrl,
    api: "openai-completions",
    apiKey: opts.apiKey,
    models: Array.from(modelIds).map((id) => ({ id, name: id })),
  });
  await applyConfigSetGroups([
    { ops: [[`models.providers.${opts.provider}`, providerDef, "--json"]] },
    {
      ops: [["models.mode", "merge"]],
      // Non-fatal: merge is the default behavior anyway
      onError: () => {},
    },
  ]);
  await ensureFallbackModel(opts.defaultModel);
}

/**
 * Which providers route a SUBSCRIPTION credential through their own OpenClaw
 * plugin instead of through a `models.providers.<p>` openai-compat override
 * is decided by `SUBSCRIPTION_SURFACE` in provider-models.ts, and
 * {@link routesSubscriptionNatively} is imported from there.
 *
 * It used to be a `NATIVE_SUBSCRIPTION_ROUTING` Set right here, next to the
 * transport it selects — which read as the tidy choice and was the bug. The
 * model picker's `availableOnSubscription` stamp answers a question that only
 * has an answer once you know the transport ("which models can this
 * credential run?"), and it was computed from a separate table in a separate
 * file. When #532 moved anthropic's subscription onto the native route, the
 * stamp kept describing the override that had just been removed and greyed
 * out three models the box had started being able to run. One table, so the
 * next transport change moves the stamp with it.
 */

/**
 * Take a `models.providers.<p>` openai-compat override back out.
 *
 * Only ever called on the subscription path, and only when the device actually
 * has one: `openclaw config unset` exits 1 with "Config path not found" on an
 * absent path (verified on 2026.7.1-2), and a removal that genuinely fails must
 * stay loud — reporting success while the poisoned override is still on disk is
 * the failure mode this whole fix exists to remove.
 */
async function clearOpenAICompatProvider(provider: string): Promise<void> {
  const configPath = `models.providers.${provider}`;
  // STRICT read, because this check can only ever decide to do NOTHING. The
  // ordinary `readConfig` answers `{}` to an EACCES or a half-written file just
  // as it does to a clean config, and `{}` here reads as "no override to
  // remove" — so an unreadable config would skip the repair, return 200, and
  // leave the poisoned override exactly where it was. That is the failure this
  // whole fix exists to remove, so an unreadable config throws instead.
  const config = await readOpenClawConfigStrict();
  if (!config.models?.providers?.[provider]) return;
  await runOpenclawConfigUnset(configPath, { uid: CLAWBOX_UID, gid: CLAWBOX_GID });
  console.log(`[AI Config] Removed stale openai-compat override ${logSafe(configPath)}`);
}

/**
 * Decide how a cloud provider's turns leave the box, and write that decision.
 *
 * Every caller of {@link writeOpenAICompatProvider} goes through here, because
 * that helper is an API-KEY construction and nothing in its signature says so:
 * it pins the provider to `api: "openai-completions"` and inlines the
 * credential, so each turn goes out as `POST <baseUrl>/chat/completions` with a
 * bearer token and none of the provider-native headers.
 *
 * A Claude Pro/Max subscription credential is not an API key, and that surface
 * does not accept one. Anthropic answers 429 to an OAuth access token on
 * `/chat/completions` no matter how much quota is left — proven on a device
 * against one token inside one minute: `/v1/chat/completions` 429,
 * `/v1/messages` with `anthropic-beta: oauth-2025-04-20` 200 with a real
 * completion, `/v1/messages` without that header 429. The override made the
 * subscription look permanently rate-limited on the OpenClaw edition while the
 * same sign-in worked on Hermes, which routes natively.
 *
 * The override also FREEZES the credential. `apiKey` is written inline at save
 * time, and a subscription access token is short-lived — so even a save that
 * worked for a while expired within hours and never self-healed, because an
 * inline key never goes back through the auth profile that holds the refresh
 * token. An affected device was found with an inline token six hours dead.
 *
 * So on an anthropic subscription save the override is not written, and any
 * override the device already had is removed — the second half matters as much
 * as the first, because a box configured with an API key and later switched to
 * a subscription kept the old entry (nothing here ever deleted one) and stayed
 * broken. Routing then belongs to the anthropic plugin, which the primary
 * batch switches on ahead of the reference it validates (step 3) and
 * `setProviderPlugins` keeps on at step 8b while the credential exists.
 */
/**
 * True when the save wrote the openai-compat override, false when it handed the
 * provider to its native plugin.
 *
 * A boolean, and reported by the CALLER rather than logged here, because both
 * halves are needed to keep the log line clean under CodeQL: `opts` carries the
 * request body's apiKey and authMode, so anything read back off it — or
 * returned from a function that took it — is taint-tracked to `request.json()`
 * and trips js/log-injection, which does not recognise `logSafe` as a barrier.
 * A boolean carries no text into the line; the caller picks between two string
 * literals and names its own provider, which is a literal there too.
 */
async function applyCloudProviderTransport(opts: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  authMode: string;
  defaultModel: string;
  curatedModels: readonly { id: string }[];
}): Promise<boolean> {
  if (!routesSubscriptionNatively(opts.provider, opts.authMode)) {
    await writeOpenAICompatProvider(opts);
    return true;
  }

  await clearOpenAICompatProvider(opts.provider);
  // Same two writes the non-provider `else` branch below makes: cloud providers
  // auto-detect their catalog in merge mode, and the primary still needs a
  // fallback behind it.
  await applyConfigSetGroups([
    {
      ops: [["models.mode", "merge"]],
      // Non-fatal: merge is the default behavior anyway
      onError: () => {},
    },
  ]);
  await ensureFallbackModel(opts.defaultModel);
  return false;
}

/**
 * Where the OpenClaw branch of one request has left clawbox-gateway.
 *
 * `runOpenclawDoctorFix` stops the unit before `doctor --fix` migrates the
 * auth store the gateway holds open, and the matching restart is step 9 at
 * the very end of the save. systemd does not start a unit again after an
 * explicit `stop`, so every error exit between the two — the 502 rollback when
 * doctor fails, the 400 profile-key refusal, any 500 from the config-set batch
 * — used to answer with the gateway down: chat and every channel stayed dead
 * until a reboot or a later save that happened to succeed (F-07).
 */
type GatewayState =
  /** Nothing touched it: every early exit, and the API-key path before step 9. */
  | "untouched"
  /** Stopped for `doctor --fix`; no later step has restarted it. */
  | "stopped-for-doctor"
  /**
   * Step 9 issued its restart. It came up; or it had not finished coming up and
   * step 9 answered its own 200 with a warning; or the restart was refused and
   * step 9 answered its own 502. Either way the gateway is not left stopped, so
   * the wrapper below has nothing to restore.
   */
  | "restart-issued";

/** Shared by reference: `configureModel` has too many exits to return it. */
type GatewayTracker = { state: GatewayState };

/** Folded into the error the owner sees when the restore itself fails. */
const GATEWAY_OFFLINE_HINT =
  "The assistant is offline until the gateway restarts — use Restart in the system tray.";

export async function POST(request: Request) {
  const gateway: GatewayTracker = { state: "untouched" };
  let response: Response;
  try {
    response = await configureModel(request, gateway);
  } catch (err) {
    // `configureModel` answers a Response for every failure it can classify, so
    // reaching here means its own catch block threw. Restoring only off the
    // returned value would leave the gateway stopped on exactly that path —
    // the failure this whole tracker exists to prevent. Restore, then let the
    // original throw become Next's generic 500.
    if (gateway.state === "stopped-for-doctor") {
      // No readiness wait: this answer is logged and dropped — the original
      // throw becomes Next's 500 either way — so waiting out the budget would
      // only add blocking time to a request that has already failed.
      await restartGateway({ awaitReady: false }).catch((restartErr) => {
        console.error(
          "[configure] Gateway restart after an unhandled save failure also failed:",
          restartErr instanceof Error ? logSafe(restartErr.message) : restartErr,
        );
      });
    }
    throw err;
  }
  if (gateway.state !== "stopped-for-doctor") return response;
  // An error exit between the doctor stop and step 9. Only `restart` is
  // granted to the clawbox user (config/clawbox-sudoers has no `start`), and
  // it runs AFTER the rollback archived the legacy file, so the gateway does
  // not boot straight into the AuthProfileMigrationRequired it would have hit.
  try {
    // No readiness wait: the only question this restore asks is "did systemd
    // take the restart", which is what the hint below turns on. Waiting for the
    // port would widen that hint to "the gateway did not bind inside 30 s" —
    // the ordinary case on a cold box — and tell the owner to go press Restart
    // on a gateway that is already coming back, while adding the whole budget
    // to a request that has already failed.
    await restartGateway({ awaitReady: false });
    return response;
  } catch (err) {
    // A runtime mask (an update in flight) refuses the restart; never unmask
    // from here. The save already failed — tell the owner what is left to do.
    console.error(
      "[configure] Gateway restart after the failed save also failed:",
      err instanceof Error ? logSafe(err.message) : err,
    );
    return withGatewayOfflineHint(response);
  }
}

async function withGatewayOfflineHint(response: Response): Promise<Response> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  const error = typeof body.error === "string"
    ? `${body.error} ${GATEWAY_OFFLINE_HINT}`
    : GATEWAY_OFFLINE_HINT;
  return NextResponse.json({ ...body, error }, { status: response.status });
}

async function configureModel(request: Request, gateway: GatewayTracker): Promise<Response> {
  // Hoisted so the catch can classify the failure without re-parsing the body —
  // a local-model or wrong-edition failure must not be reported as a credential
  // problem (there is no credential to check).
  let requestProvider: string | undefined;
  let requestScope: ConfigureScope = "primary";
  try {
    let body: {
      provider?: string;
      apiKey?: string;
      authMode?: string;
      idToken?: string;
      refreshToken?: string;
      expiresIn?: number;
      projectId?: string;
      scope?: ConfigureScope;
      clawaiTier?: string;
      model?: string;
      oauthHandoff?: boolean;
      /**
       * Explicit "make this the model that answers", as distinct from "install
       * it and keep it available". Enabling a local model deliberately does NOT
       * take over from the provider the customer chose, so the Settings panel's
       * "Switch to Gemma 4" button had no way to actually switch — it ran the
       * same enable flow and silently left the harness where it was. This flag
       * is that missing intent; omitted, the promote policy is unchanged.
       */
      activate?: boolean;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Server-side OAuth token handoff: on the subscription handoff path the
    // browser posts no provider tokens — device-poll persisted them to a
    // server-only file. Read them here and splice them into the body so
    // everything downstream (validation + persistence) is unchanged. The file
    // is only consumed (unlinked) on the happy path, right before success, so a
    // transient failure downstream leaves it readable for a retry within its
    // 15-minute TTL rather than forcing a full re-auth.
    let pendingHandoffTokensPath: string | null = null;
    if (body.authMode === "subscription" && body.oauthHandoff) {
      let handoff: {
        provider?: string;
        access_token?: string;
        id_token?: string;
        refresh_token?: string;
        expires_in?: number;
        createdAt?: number;
      };
      let rawHandoff: string;
      try {
        rawHandoff = await fs.readFile(HANDOFF_TOKENS_PATH, "utf-8");
      } catch {
        return NextResponse.json(
          { error: "No pending OAuth tokens. Restart the sign-in flow." },
          { status: 400 },
        );
      }
      try {
        const parsed = JSON.parse(rawHandoff);
        if (!parsed || typeof parsed !== "object") throw new Error("not an object");
        handoff = parsed;
      } catch {
        // Content a retry cannot fix. Remove it rather than leave every later
        // attempt to fail on the same file until something else clears it.
        await fs.unlink(HANDOFF_TOKENS_PATH).catch(() => {});
        return NextResponse.json(
          { error: "No pending OAuth tokens. Restart the sign-in flow." },
          { status: 400 },
        );
      }
      // Age the file by its own timestamp, and only when that timestamp is one
      // we can actually compare: a missing, non-numeric, non-finite or future
      // `createdAt` yields no age, so the file cannot be shown to be inside the
      // TTL and is treated exactly like one past it. (A bare
      // `Date.now() - createdAt` comparison would pass for all of them — NaN
      // and a negative age each fail a `> TTL` test.)
      const createdAt = handoff.createdAt;
      const ageMs =
        typeof createdAt === "number" && Number.isFinite(createdAt)
          ? Date.now() - createdAt
          : null;
      // These routes write the file, and they write strings. A field of another
      // shape means the file is not one of ours to use, so it goes down the
      // same path rather than being spliced into the body for a later check to
      // reject — which would leave it on disk for every retry to trip over.
      // Trimmed, because the token is trimmed before it is used: a blank string
      // is as unusable as a missing one, and would otherwise be refused further
      // down with the file still on disk.
      const wellFormed =
        typeof handoff.access_token === "string" &&
        handoff.access_token.trim().length > 0 &&
        (handoff.provider === undefined || typeof handoff.provider === "string");
      if (
        !wellFormed ||
        ageMs === null ||
        ageMs < 0 ||
        ageMs > HANDOFF_TTL_MS
      ) {
        // Stale/invalid credential material — consume it so it can't linger.
        await fs.unlink(HANDOFF_TOKENS_PATH).catch(() => {});
        return NextResponse.json(
          { error: "OAuth tokens missing or expired. Restart the sign-in flow." },
          { status: 400 },
        );
      }
      // Trust the provider recorded alongside the tokens over the request body:
      // the tokens were minted for that provider, so binding them to a
      // different profile (from a mismatched body) would be wrong.
      if (handoff.provider) body.provider = handoff.provider;
      body.apiKey = handoff.access_token;
      body.idToken = handoff.id_token;
      body.refreshToken = handoff.refresh_token;
      body.expiresIn = handoff.expires_in;
      pendingHandoffTokensPath = HANDOFF_TOKENS_PATH;
    }

    const { provider, apiKey, authMode = "token", idToken, refreshToken, expiresIn, projectId, scope = "primary", model: bodyModel } = body;
    // The storage mode is the documented client contract (api-key vs OAuth
    // bundle) — but only these four spellings exist ("local" is what the
    // Ollama hook and the llama.cpp installer send; the route treats it as
    // key mode), and everything below branches on the value, so an unknown
    // one is refused before any write (CodeQL js/user-controlled-bypass
    // wants the guard value constrained).
    if (authMode !== "token" && authMode !== "api_key" && authMode !== "subscription" && authMode !== "local") {
      return NextResponse.json({ error: "Unsupported authMode" }, { status: 400 });
    }
    requestProvider = provider;
    requestScope = scope;
    const requestedClawboxAiTier = normalizeClawboxAiTier(body.clawaiTier);
    const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
    // Normalized once, like the key above: this handler reads the `model`
    // field in four branches, and inlining the same ternary in each let the
    // copies drift.
    const normalizedModel = typeof bodyModel === "string" ? bodyModel.trim() : "";
    const isOllama = provider === "ollama";
    const isLlamaCpp = provider === "llamacpp";
    const isClawAI = provider === "clawai";
    const isOpenRouter = provider === "openrouter";
    const isGoogle = provider === "google";
    const isAnthropic = provider === "anthropic";
    const isLocalScope = scope === "local";
    if (!provider || (!normalizedApiKey && !isOllama && !isLlamaCpp && !isClawAI)) {
      return NextResponse.json(
        { error: "Provider is required; API key required for non-local providers" },
        { status: 400 }
      );
    }
    // A `claw_…` key authenticates to the ClawBox AI proxy and to nothing else.
    // Stored as another provider's api_key profile it becomes that provider's
    // credential and 401s on every turn: measured on a box, `openai:default`
    // held one and turns on `openai/gpt-5.5` came back from api.openai.com with
    // `Incorrect API key provided: claw_***`. Worse, an eligible api_key profile
    // is a candidate ahead of nothing — it is tried, spends the request, and the
    // gateway then falls back to another model — so the owner sees a provider
    // that saved cleanly and answers as something else. Refuse the save rather
    // than store a credential that cannot work. The prefix is a build-time
    // constant and the message echoes no user input.
    //
    // This is about the AUTH PROFILE only. The image setup deliberately puts
    // the same token in `models.providers.openai.apiKey`, which is a different
    // slot with its own ownership rules (`canOwnOpenAiImageApiKey`) and its own
    // measured consequences — see the note above that function.
    // Not the local providers: for ollama / llamacpp this field carries a MODEL
    // ID, not a credential (see the branch below), so a model whose name began
    // with the prefix would be refused as if it were a key.
    if (!isClawAI && !isOllama && !isLlamaCpp && normalizedApiKey.startsWith(CLAWBOX_AI_TOKEN_PREFIX)) {
      return NextResponse.json(
        { error: "That is a ClawBox AI key. Select ClawBox AI as the provider, or paste this provider's own key." },
        { status: 400 }
      );
    }
    if (isLocalScope && !isOllama && !isLlamaCpp) {
      return NextResponse.json(
        { error: "Local AI scope is only supported for Ollama and llama.cpp" },
        { status: 400 }
      );
    }

    const baseConfig = PROVIDERS[provider];
    if (!baseConfig) {
      return NextResponse.json(
        { error: `Unknown provider: ${provider}` },
        { status: 400 }
      );
    }

    // For subscription (OAuth) providers, use the subscription-specific config
    const config = (authMode === "subscription" && baseConfig.subscriptionOverride)
      ? { ...baseConfig, ...baseConfig.subscriptionOverride }
      : { ...baseConfig };
    // Don't fail open on a config read error for ClawBox AI: previousClawaiToken
    // would silently become "" and the account-switch unpair guard below would
    // be skipped, potentially leaving ClawKeep paired to the previous account.
    // For other providers a missing config is harmless, so keep the soft default.
    let configStore: Awaited<ReturnType<typeof getAll>>;
    try {
      configStore = await getAll();
    } catch {
      if (isClawAI) {
        return NextResponse.json(
          { error: "Failed to read existing ClawBox AI configuration. Please retry." },
          { status: 503 },
        );
      }
      configStore = {} as Awaited<ReturnType<typeof getAll>>;
    }
    // Capture the previously-stored ClawBox AI token *before* it gets
    // overwritten below, so the isClawAI block can detect an account switch
    // (token change) and unpair ClawKeep.
    const previousClawaiToken =
      typeof configStore[CLAWBOX_AI_TOKEN_CONFIG_KEY] === "string"
        ? (configStore[CLAWBOX_AI_TOKEN_CONFIG_KEY] as string)
        : "";
    const clawboxAiToken = isClawAI
      ? await getConfiguredClawboxAiToken(normalizedApiKey)
      : "";
    if (isClawAI && !clawboxAiToken) {
      return NextResponse.json(
        { error: "ClawBox AI token is required" },
        { status: 400 },
      );
    }
    // A local provider borrows the `apiKey` slot to carry its MODEL id — there
    // is no key for a service on this box. On the OAuth-handoff path, though,
    // that same slot is filled from a token file on disk a few lines above,
    // and the recorded provider only overwrites `body.provider` when it is
    // present. A handoff whose provider field is missing, against a body that
    // says `ollama`, would therefore make an access token the model id — and
    // send it to the local model server in a request body. A local provider
    // never has a handoff, so the slot is simply not read when one was
    // consumed; `model` still names the model. (Found by CodeQL
    // js/file-access-to-http, which was right about the flow.)
    const localModelSlot = pendingHandoffTokensPath ? "" : normalizedApiKey;
    const llamaCppContextWindow = getLlamaCppContextWindow();
    const llamaCppMaxTokens = getLlamaCppMaxTokens();
    const ocProvider = config.profileKey.split(":")[0];
    // The ChatGPT subscription shares `ocProvider === "openai"` with the API
    // key; the auth mode is what tells the two apart from here on.
    const isChatgptSubscription = authMode === "subscription" && ocProvider === CHATGPT_PROVIDER;

    // `models.mode` as it was BEFORE this save. Six branches below write it —
    // the ClawBox AI pass, the two local-model passes, the cloud-transport
    // paths — and under `replace` the core skips the authenticated catalogue
    // for EVERY provider, so a flip changes what the gateway will route far
    // beyond the provider being saved. Captured once here and compared once at
    // step 8d rather than threaded through each branch, so a branch added
    // later cannot forget it (TASK-668).
    const modelsModeBefore = await readModelsMode();

    // BEFORE anything is written, and before this request has put anything of
    // its own in the store — a refusal is not a failure and must not leave a
    // trail, and by the time the save reaches the paste it has unpaired
    // ClawKeep on an account switch, enabled provider plugins and written the
    // profile metadata. The throw is mapped to a 409 by this handler's own
    // catch.
    //
    // Skipped where no sign-in lane exists: the two local providers have none,
    // OpenRouter is deliberately absent from OAUTH_PROVIDERS (see the
    // openrouter branch below — every save that reaches it is key-based), and
    // the ClawBox AI profile is written by this route alone. It is one CLI cold
    // start, and this is the wizard's critical path.
    if (
      authMode !== "subscription"
      && !isOllama && !isLlamaCpp && !isClawAI && !isOpenRouter
    ) {
      await assertNoSignInAt(config.profileKey);
    }

    // Codex (OpenAI subscription) authenticates with a JWT id_token, and the
    // gateway synthesizes ~/.codex/auth.json from `id` (falling back to
    // `access`). If neither is JWT-shaped, that synthesis produces an invalid
    // id_token and every request fails with "invalid ID token format" — reject
    // the save here so the failure surfaces at config time, not in the chat.
    const normalizedIdToken = typeof idToken === "string" ? idToken.trim() : "";
    const isJwtLike = (value: string) => value.split(".").length === 3;
    if (isChatgptSubscription && !isJwtLike(normalizedIdToken || normalizedApiKey)) {
      return NextResponse.json(
        {
          error:
            "OpenAI subscription OAuth did not return a valid JWT credential. Please restart the authorization flow.",
        },
        { status: 502 },
      );
    }

    // A fresh device promotes its first local model automatically; an existing
    // device only promotes when the user explicitly asked to switch to it.
    // A device that was ON the local model when it was switched off promotes it
    // again, so off -> on round-trips instead of leaving the box on nothing:
    // `local_ai_was_default` is the flag POST /setup-api/local-ai leaves behind
    // when it clears a `model.provider` that pointed at the local model.
    const localWasDefaultBeforeDisable = isLocalScope && configStore.local_ai_was_default === true;
    /**
     * Forget that the local model used to be the default, because the owner has
     * now chosen a cloud provider on purpose and re-enabling local later must
     * not evict that choice.
     *
     * Called where the cloud save LANDS, not here. It used to run the moment
     * the request was parsed, so a save the route went on to REFUSE — an
     * off-surface Claude or ChatGPT id, a Hermes provider that needs its own
     * panel — still changed how a later local re-enable behaves. A rejection
     * that has already had a side effect is not a rejection: the same rule the
     * subscription-surface guards below are placed to obey.
     *
     * Reading `configStore`, the snapshot taken at the top of the request, so
     * it stays the same question it was then; `shouldPromoteLocalToPrimary`
     * below reads that snapshot too and is unaffected by when this runs.
     */
    const forgetLocalWasDefault = async () => {
      if (isLocalScope || configStore.local_ai_was_default !== true) return;
      await setMany({ local_ai_was_default: undefined });
    };
    const shouldPromoteLocalToPrimary =
      isLocalScope && (!configStore.ai_model_configured || body.activate === true || localWasDefaultBeforeDisable);

    // Bring the runtime up BEFORE anything is registered. Registering a model
    // whose service is down produces exactly the device this task exists to fix:
    // Settings says "configured", the picker offers the model, and the first
    // message 502s. For Ollama that also ENABLES the unit, so the choice
    // survives a reboot — an unprivileged `systemctl start` had been failing
    // silently, which is why toggling Local AI off and on left ollama.service
    // dead (TASK-446).
    if (isLocalScope && (isOllama || isLlamaCpp)) {
      try {
        await activateLocalAiProvider(isOllama ? "ollama" : "llamacpp");
      } catch (err) {
        console.error("[AI Config] Local AI runtime did not come up:", err instanceof Error ? logSafe(err.message) : err);
        if (isOllama) {
          return NextResponse.json(
            {
              error: "Could not start the on-device model service, so Local AI was not switched on.",
              code: "local_ai_runtime_unavailable",
            },
            { status: 503 },
          );
        }
        // llama.cpp keeps the behaviour it always had: the proxy provisions and
        // wakes it on the first request, so a failed pre-wake is a slower first
        // message, not a failed save.
      }
    }
    // Resolve the ClawBox AI tier once and reuse it for both the primary
    // model selection (below) and the config-store write (further down).
    // Inlining the same `?? storedTier ?? DEFAULT_TIER` chain in two
    // places previously let the two sites drift on a half-applied edit;
    // a single source of truth keeps them in lockstep.
    //
    // `requestedClawboxAiTier` is the wizard's plan PICKER, and during a first
    // pairing that is whatever the card defaulted to before anyone had an
    // account to look at — "flash" (Pro). Trusting it wrote the €9 model onto
    // boxes paired with a €49 Max token, with no way to reach the frontier
    // model afterwards: the picker had already been consulted and the account
    // never was (TASK-481). We hold the token and the portal will answer
    // truthfully, so ask it, exactly as the Codex branch below asks ChatGPT
    // for entitlement and for the same reason.
    //
    // Only a definitive PAID answer overrides the picker. `unreachable`
    // (offline, timeout, 401/403 — deliberately ambiguous, see fetchPortalTier)
    // and a Free/unrecognised verdict both leave the existing chain alone, so
    // a portal outage can never downgrade a paying box mid-setup. The portal's
    // own `deviceTier` stamp is honoured inside mapPortalTier, which is what
    // keeps "Max subscriber who deliberately runs Flash on this device"
    // working rather than being force-promoted here.
    let portalConfirmedTier: ClawboxAiTier | null = null;
    if (isClawAI && clawboxAiToken) {
      try {
        const lookup = await fetchPortalTier(clawboxAiToken);
        if (lookup.source === "portal" && lookup.tier) {
          portalConfirmedTier = lookup.tier;
          if (requestedClawboxAiTier && requestedClawboxAiTier !== lookup.tier) {
            console.log(
              `[configure] ClawBox AI plan picker said "${requestedClawboxAiTier}", portal says "${lookup.tier}" — using the account`,
            );
          }
        }
      } catch (err) {
        // Never let a tier probe break pairing; fall through to the picker.
        console.warn("[configure] ClawBox AI portal tier probe failed:", err);
      }
    }
  const resolvedClawboxTier: ClawboxAiTier | null = isClawAI
      ? (portalConfirmedTier
          ?? requestedClawboxAiTier
          ?? normalizeClawboxAiTier(configStore[CLAWBOX_AI_TIER_CONFIG_KEY])
          ?? CLAWBOX_AI_DEFAULT_TIER)
      : null;
    // Set by the branch below in which the OWNER named a model, rather than one
    // that filled a default in for them. Written to the store after the save
    // succeeds, beside the other facts about what was configured.
    let explicitPickToRecord: string | null = null;
    // True when the ClawBox AI branch kept the owner's own model instead of the
    // one the badge implies. Reported in the answer so the plan card can say the
    // plan moved and the model deliberately did not, rather than returning 200
    // over a screen where nothing appears to have happened.
    let explicitPickKept = false;
    // The picks map minus the ClawBox AI entry, when this save links a DIFFERENT
    // ClawBox AI account. Written in the same batch as the new token below.
    let clawaiPicksToStore: Record<string, string> | null = null;

    // For Ollama the front-end supplies the model name (e.g. "llama3.2:3b")
    // via the `apiKey` field — there is no real API key for a local provider.
    if (isOllama) {
      // `model` is honoured too: every cloud provider sends its pick there, so
      // an API caller who wrote { model: "qwen2.5:3b" } used to have the field
      // silently ignored and llama3.2:3b saved in its place — a "success" that
      // configured a model this box does not have.
      const modelName = localModelSlot || normalizedModel || "llama3.2:3b";

      // Ask Ollama about the id BEFORE anything is written. Both refusals below
      // used to be discovered by the customer one dead chat turn at a time: an
      // id that names nothing on this machine, and — on Hermes — a model whose
      // window is under the agent's floor (qwen2.5:3b reports 32K against
      // Hermes' 64K minimum, so every turn 502s while Settings says
      // "configured", and no config override can widen a model's trained
      // window). An unreachable Ollama keeps the old behaviour and saves: on
      // the local-scope path the service was already started (and 503'd above
      // when it could not be), so a dead probe here is the primary-scope case
      // where the runtime starts Ollama on demand — "we could not ask" must
      // not brick that flow.
      const probe = await probeOllamaModel(modelName);
      // The id came off the wire and both messages below quote it back. Bound
      // and strip it the same way anything request-derived is bounded before it
      // reaches a log line — an unbounded echo is a response the caller sized.
      const quotedModel = logSafe(modelName, 120);
      if (probe.status === "not-installed") {
        return NextResponse.json(
          { error: `Ollama does not have "${quotedModel}" on this device. Pull the model first, then save it.` },
          { status: 400 },
        );
      }
      if (
        probe.status === "ok"
        && probe.contextLength !== null
        && probe.contextLength < HERMES_MINIMUM_CONTEXT_TOKENS
        && (await getActiveHarness()) === "hermes"
      ) {
        return NextResponse.json(
          {
            error:
              `"${quotedModel}" offers a ${probe.contextLength.toLocaleString("en-US")}-token context window; `
              + `the assistant needs at least ${HERMES_MINIMUM_CONTEXT_TOKENS.toLocaleString("en-US")}. `
              + "Pick a larger model.",
          },
          { status: 400 },
        );
      }
      config.defaultModel = `ollama/${modelName}`;
    } else if (isLlamaCpp) {
      // Same two slots as the Ollama branch above, for the same reason.
      const modelName = localModelSlot || normalizedModel || getDefaultLlamaCppModel();
      config.defaultModel = `llamacpp/${modelName}`;
    } else if (isClawAI && resolvedClawboxTier) {
      // The badge fills in a DEFAULT, and a default never overwrites a choice
      // (TASK-713). A re-pair arrives here carrying `clawaiTier` exactly like a
      // plan-card press does — `clawai/poll` sends the session's tier — so the
      // request cannot say which this is. What settles it is whether the owner
      // has ever picked a ClawBox AI model, which is what the marker records.
      //
      // A pick belongs to the ACCOUNT that made it. On a token change — the same
      // signal that unpairs ClawKeep at step 8 — it is not read, so the previous
      // owner's Max choice is not imposed on a Pro plan the new one is paying
      // for; and it is CLEARED in the same `setMany` that stores the new token,
      // so the two cannot come apart. A separate delete could fail on its own
      // and leave account A's pick beside account B's token, waiting for the
      // next re-pair to apply it.
      const clawaiAccountChanged = Boolean(
        previousClawaiToken && clawboxAiToken && previousClawaiToken !== clawboxAiToken,
      );
      const storedPicks = explicitPicksFrom(configStore[EXPLICIT_MODEL_PICKS_KEY]);
      if (clawaiAccountChanged && storedPicks.clawai) {
        delete storedPicks.clawai;
        clawaiPicksToStore = storedPicks;
      }
      const clawaiDecision = decideClawboxAiModelId({
        picks: clawaiAccountChanged ? {} : storedPicks,
        tierModelId: CLAWBOX_AI_MODEL_ID_BY_TIER[resolvedClawboxTier],
      });
      explicitPickKept = clawaiDecision.explicit;
      if (clawaiDecision.explicit) {
        console.log(
          `[configure] ClawBox AI: keeping the owner's own model ${clawaiDecision.modelId}`
          + ` over the ${resolvedClawboxTier} badge default`,
        );
      }
      config.defaultModel = `${CLAWBOX_AI_PROVIDER}/${clawaiDecision.modelId}`;
    } else if (isChatgptSubscription && !normalizedModel) {
      // ChatGPT sign-in with no explicit pick. The hardcoded default is
      // gpt-5.5, so a Pro account used to land a generation behind and had
      // to know to change it. We can't read entitlement from a catalog — the
      // plugin's list is static and identical for every account — so ask the
      // account directly, newest first.
      //
      // Safety: resolveEntitledCodexModel only returns a model on a positive
      // answer. Gated, ambiguous, rate-limited, offline — all leave us on
      // gpt-5.5, which every tier can use. Defaulting a non-entitled account
      // onto a gpt-5.6 model would be far worse than being conservative: the
      // upstream 400 is a surface error with no failover, so every turn fails.
      try {
        const entitled = await resolveEntitledCodexModel({
          accessToken: normalizedApiKey,
          onDiagnostic: (message) => console.log(`[configure] ${message}`),
        });
        if (entitled) {
          config.defaultModel = chatgptModelRef(entitled);
        }
      } catch (err) {
        // Never let model selection break sign-in.
        console.warn("[configure] codex entitlement probe failed:", err);
      }
    } else if (normalizedModel) {
      // User picked a specific model in the wizard (curated list or
      // custom ID). Validate shape to stop empty strings / obvious typos
      // from silently saving a broken primary. We don't check against
      // the curated list — users can type newer model IDs we haven't
      // added yet.
      //
      // Both OpenAI auth modes write `openai/<id>`; which catalogue applies
      // is the subscription surface's business (offSurfaceCodexModelMessage
      // below), not the namespace's. `config.defaultModel` already carries
      // the provider the override chose, so derive the target from it.
      const requestedModel = normalizedModel;
      const targetProvider = config.defaultModel.split("/", 1)[0];
      const supportedProviders = new Set([
        "openrouter",
        "anthropic",
        "openai",
        "google",
      ]);
      if (supportedProviders.has(targetProvider)) {
        if (!isValidModelId(targetProvider, requestedModel)) {
          const providerLabel = targetProvider === "openrouter" ? "OpenRouter" : targetProvider;
          return NextResponse.json(
            { error: `Invalid ${providerLabel} model ID: ${requestedModel}` },
            { status: 400 },
          );
        }
        config.defaultModel = `${targetProvider}/${requestedModel}`;
        // The owner named this model. Remembered for the same reason the chat
        // picker's pick is (TASK-713): a default may fill a gap, never
        // overwrite a choice — and the marker holds the LAST choice, whichever
        // provider it was about.
        explicitPickToRecord = config.defaultModel;
      }
    }

    // ── Hermes edition: no openclaw binary exists here ──────────────────────
    // Everything below configures OpenClaw — it writes ~/.openclaw, runs
    // `openclaw config set …`, and restarts the gateway. On the Hermes SKU there
    // is no openclaw binary, so the API-key path used to fail with `spawn
    // openclaw ENOENT` and then blame the user's credentials, while the local
    // (Gemma) switch failed the same way. Route to Hermes' own config store
    // instead — the same one the OAuth/token path already writes.
    if (openclawIsAbsent()) {
      try {
        if (isLocalScope && (isLlamaCpp || isOllama)) {
          // On-device model (Gemma via llama.cpp, or Ollama): persist the same
          // config-store keys the OpenClaw path would, then register it with
          // Hermes as an available provider (activating it only on a fresh
          // device, matching shouldPromoteLocalToPrimary). No gateway restart.
          await setMany({
            local_ai_configured: true,
            local_ai_provider: ocProvider,
            local_ai_model: config.defaultModel,
            local_ai_configured_at: new Date().toISOString(),
            // Consumed by shouldPromoteLocalToPrimary above; leaving it set
            // would re-promote the local model on every later save.
            local_ai_was_default: undefined,
          });
          await applyLocalAiToHermes({
            provider: ocProvider as "llamacpp" | "ollama",
            // Hermes wants the bare model id, not the `llamacpp/…` qualified form.
            model: config.defaultModel.replace(/^(?:llamacpp|ollama)\//, ""),
            makeDefault: shouldPromoteLocalToPrimary,
          });
          return NextResponse.json({ success: true });
        }
        if (isClawAI) {
          const applied = await applyClawaiToHermes(
            clawboxAiToken,
            resolvedClawboxTier ?? CLAWBOX_AI_DEFAULT_TIER,
          );
          await forgetLocalWasDefault();
          // Reported from the apply's OWN decision rather than the one taken
          // above for the OpenClaw shape: on this SKU that helper is what reads
          // the store and writes the model, so its answer is the one that
          // happened. Same field as the OpenClaw branch, so the plan card does
          // not have to know which edition it is on.
          return NextResponse.json({
            success: true,
            ...(applied.explicitPickKept
              ? { explicitPickKept: true, model: applied.model }
              : {}),
          });
        }
        if (authMode !== "subscription" && normalizedApiKey) {
          // Cloud API-key providers Hermes supports (anthropic, google→gemini,
          // openrouter). The credential lands in Hermes' own store and the
          // provider is activated through Hermes' catalog.
          const result = await applyCloudProviderKeyToHermes({
            openclawProvider: provider,
            apiKey: normalizedApiKey,
          });
          if (result.activated) {
            await forgetLocalWasDefault();
            return NextResponse.json({ success: true });
          }
          // 409, not success: the key is stored but no model is picked, so this
          // save has not chosen a provider yet and must not evict the local
          // model's claim on the primary slot.
          return NextResponse.json(
            { error: "Key saved. Open the Hermes provider panel to pick a model for it." },
            { status: 409 },
          );
        }
        // OAuth / subscription providers (and OpenAI, which is OAuth-only on
        // Hermes) sign in through the Hermes provider panel, not this route.
        return NextResponse.json(
          { error: "This provider is set up through the Hermes provider panel on this edition." },
          { status: 400 },
        );
      } catch (err) {
        if (
          err instanceof HermesCloudApplyError
          || err instanceof HermesLocalApplyError
          || err instanceof ClawaiApplyError
        ) {
          // Safe to echo because each of these classes now CLEANS its message
          // before constructing itself — `safeHermesFailureMessage` for a
          // `hermes` stream, `sanitizeErrorMessage` for an fs error — and falls
          // back to a fixed sentence when nothing survives.
          //
          // The comment here used to read "Author-controlled, non-credential
          // message — safe to echo", and it was false for all three: every one
          // of them was built from a raw `hermes` stderr or a raw Node fs
          // error, and this line published it to the save banner. The claim is
          // now an invariant the throw sites keep rather than an assumption
          // this one makes.
          return NextResponse.json({ error: err.message }, { status: 502 });
        }
        throw err; // unexpected — fall to the outer catch, which classifies it
      }
    }

    // ── The subscription surfaces ───────────────────────────────────────────
    // This route is the SECOND write path to `agents.defaults.model.primary`;
    // /setup-api/chat/model is the first, and the guards there exist "for ids
    // that arrive some other way". This is that other way. The shape check
    // above deliberately does not consult the curated list ("users can type
    // newer model IDs we haven't added yet"), and the wizard's picker exempts
    // a typed custom id from its own greying-out rule, so without these a
    // subscription box can be pinned from Settings to exactly the model the
    // chat header refuses — one its subscription cannot route.
    //
    // Judged on the SETTLED `config.defaultModel`, after every branch above
    // has had its say, so the PROVIDERS-table default is covered as well as a
    // typed id: one check for every value this save can write to primary.
    // Split once, so both rules judge the same value and cannot disagree about
    // what this save is going to write.
    //
    // AFTER the Hermes branch, because the questions they ask are about
    // `openclaw.json` and a Hermes box has none — and that branch refuses a
    // subscription save outright anyway. BEFORE `writeAuthProfiles` below,
    // because a refusal that has already persisted a credential is not a
    // refusal, it is a half-applied save. Nothing between here and there
    // writes anything (the OAuth handoff file is consumed only on success).
    const settledSlash = config.defaultModel.indexOf("/");
    const settledProvider = settledSlash > 0 ? config.defaultModel.slice(0, settledSlash) : null;
    const settledModelId = config.defaultModel.slice(settledSlash + 1);

    // ChatGPT: the same gap as the Claude one below, on the other
    // subscription — and the one that ARMS it, because an off-surface id has
    // to reach `agents.defaults.model.primary` before the chat header can
    // restore it, and this save is the only way in. `isValidModelId` above
    // checks SHAPE only and `resolveEntitledCodexModel` runs solely in the
    // nothing-was-typed branch, so `gpt-5.4-pro` typed into the custom-model
    // field was written as the subscription's primary — precisely the id
    // /setup-api/chat/model has refused since it was written. Every turn
    // afterwards fails upstream.
    //
    // Gated on the auth MODE: both OpenAI modes write `openai/<id>`, and only
    // the subscription is confined to the ChatGPT surface — an API-key save
    // routes the -pro tiers fine, which is exactly the switch the refusal
    // recommends.
    const offSurfaceCodex = offSurfaceCodexModelMessage(settledProvider, settledModelId, isChatgptSubscription);
    if (offSurfaceCodex) {
      return NextResponse.json({ error: offSurfaceCodex }, { status: 400 });
    }

    // The ClawBox AI image entry, judged on the same settled value. It sits in
    // `models.providers.openai.models[]` on every paired box, and
    // `isValidModelId` is shape-only — so `gpt-image-1-mini` typed into the
    // OpenAI panel's custom-model field was written as
    // `openai/gpt-image-1-mini` and every turn afterwards failed. The absent
    // `api` only NARROWS where OpenClaw offers it (see the docblock in
    // src/lib/clawbox-ai-models.ts: `models.mode: "replace"` bypasses the gate
    // and the configured-row exemption leaves OpenClaw's own pickers open), so
    // this door and /setup-api/chat/model's are the wall, not a backstop — and
    // they are for ids that arrive ANY other way: typed here, or already
    // pinned by an older build.
    if (isClawboxAiImageModelRef(config.defaultModel)) {
      // Names the fix, not just the refusal: this id can reach here from a box
      // an older build pinned to it, and an owner who never typed it needs to
      // be told which control to change.
      return NextResponse.json(
        {
          error: `${settledModelId} is the ClawBox AI image model, not a chat model. Pick a chat model from the Model list and save again.`,
        },
        { status: 400 },
      );
    }

    // Claude: only a SUBSCRIPTION save can create the hazard here. An API-key
    // save writes the anthropic key, so after it lands the box is not
    // subscription-only and there is nothing to refuse. That mattered more
    // when the surface was narrower than the API catalogue and the refusal
    // recommended switching to a key; since #532 the subscription routes
    // natively on the same catalogue, and what is left to refuse is an id no
    // Anthropic catalogue on this box carries at all.
    if (authMode === "subscription") {
      const offSurface = await offSurfaceClaudeModelMessage(
        settledProvider,
        settledModelId,
        async () => {
          // Ask about the profiles this save is ABOUT TO leave behind, not the
          // ones already on disk: this sign-in is what writes the OAuth
          // profile that makes the box subscription-only, so disk alone would
          // wave the very first Claude sign-in straight through. A key held
          // under some other profile key still counts, and still allows.
          let existing: OpenClawConfig | null = null;
          try {
            existing = await readOpenClawConfig();
          } catch {
            // No readable config yet (fresh box). The projected profile below
            // still answers the question on its own.
          }
          return isClaudeSubscriptionOnly({
            ...(existing?.auth?.profiles ?? {}),
            // Exactly what `baseOps` writes for this profile key below.
            [config.profileKey]: { provider: ocProvider, mode: "oauth" },
          });
        },
      );
      if (offSurface) {
        return NextResponse.json({ error: offSurface }, { status: 400 });
      }
    }

    // 1. Write token to auth-profiles.json
    //
    // ── AUDIT: schema-drift risk ───────────────────────────────────
    // We construct the auth profile JSON inline and write it directly to
    // ~/.openclaw/agents/main/agent/auth-profiles.json plus mirror the
    // public metadata into openclaw.json via `openclaw config set
    // auth.profiles.<key> {...}` (step 3 below). The canonical OpenClaw
    // path is `openclaw onboard --auth-choice <provider>-api-key
    // --<provider>-api-key <value> --non-interactive --accept-risk`
    // (see `openclaw onboard --help` for the full --auth-choice list).
    //
    // If OpenClaw adds a required field to the auth-profile schema —
    // e.g. a key-rotation timestamp or a per-key scope tag — our writes
    // here will silently produce non-conformant profiles that the
    // gateway then rejects with cryptic errors at chat time. The fix is
    // to migrate each provider branch below to the `onboard` CLI:
    //
    //   * anthropic     → --auth-choice apiKey --anthropic-api-key
    //   * openai (api)  → --auth-choice openai-api-key --openai-api-key
    //   * openai (ChatGPT) → `models auth login --provider openai` (the OAuth bundle below is its output)
    //   * google        → --auth-choice gemini-api-key --gemini-api-key
    //   * openrouter    → --auth-choice openrouter-api-key --openrouter-api-key
    //   * deepseek      → no canonical onboard equivalent today; we use
    //                     a custom proxy URL + DeepSeek-compatible API
    //                     so direct write is unavoidable until OpenClaw
    //                     ships a `--clawbox-ai-token` choice.
    //   * ollama, llamacpp → onboard has --auth-choice ollama / lmstudio
    //                     but we set baseUrl/model server-side from
    //                     env-derived runtime config; not a 1:1 mapping.
    //
    // API-key credentials now DO go through the CLI (`models auth
    // paste-api-key`, see pasteAuthApiKey) — only the OAuth bundle below
    // still writes the file inline, because no paste command carries a
    // refresh token. DO NOT add new fields to it without first checking
    // the gateway's auth-profile schema. If
    // OpenClaw bumps the schema and we see profile-rejected errors in
    // production, the migration target is `openclaw onboard`.
    if (authMode !== "subscription") {
      // Every API-key credential goes through `models auth paste-api-key`
      // (stdin): on OpenClaw 2 a hand-written auth-profiles.json is a LEGACY
      // store the gateway refuses to hydrate — AuthProfileMigrationRequired
      // killed it after every provider save until doctor ran. The CLI writes
      // the store of the running generation and the openclaw.json metadata
      // itself. `type: "api_key"` semantics are the CLI's own (a token-mode
      // profile stopped authenticating on 2026.6.8 — see git history).
      const apiKeyValue = isClawAI
        ? clawboxAiToken
        : isOllama || isLlamaCpp
          ? getLocalAiToken()
          : normalizedApiKey;
      if (isOllama || isLlamaCpp) {
        // Ollama/llama.cpp run locally — the auth-profile key must match the
        // per-install bearer token the local-ai proxy validates (see
        // src/lib/local-ai-token.ts). Stamp the migration flag so legacy
        // "ollama-local" / "llamacpp-local" sentinels stop authenticating.
        markLocalAiTokenMigrated();
      }
      await pasteAuthApiKey(ocProvider, config.profileKey, apiKeyValue);
    } else {
      const authProfiles = await readAuthProfiles();
      if (authMode === "subscription") {
        // OAuth credential format expected by OpenClaw:
        // { type: "oauth", provider, access, id?, refresh, expires, projectId? }
        // `id` is the OAuth id_token (a JWT). The Codex app-server authenticates
        // with it, and gateway-pre-start's ~/.codex/auth.json synthesis uses
        // `id` (falling back to `access`). Persisting it keeps the synthesized
        // id_token a valid JWT instead of whatever `access` happens to be.
        authProfiles.profiles[config.profileKey] = {
          type: "oauth",
          provider: ocProvider,
          access: normalizedApiKey,
          ...(normalizedIdToken ? { id: normalizedIdToken } : {}),
          refresh: refreshToken || "",
          expires: expiresIn
            ? Date.now() + expiresIn * 1000
            : Date.now() + 8 * 60 * 60 * 1000, // default 8h
          ...(projectId ? { projectId } : {}),
        };
      }
      await writeAuthProfiles(authProfiles);
      // OpenClaw 2 refuses to hydrate this LEGACY file: run the doctor
      // migration IMMEDIATELY, before the config-set batch, catalog refresh
      // and session sweep execute against a poisoned shared auth store (it
      // also backs the CLI itself, so those calls would start failing too).
      // Fail closed on a v2 box: archiving the file we just wrote and answering
      // 502 beats "success" with a dead agent. A migrated sibling is sufficient
      // proof; an early doctor failure may create none, so the installed binary
      // version is the second authority. An explicit v1 keeps its legitimate
      // legacy file and the old best-effort behavior.
      // The stop inside is unconditional; POST restores the unit if no later
      // step restarts it.
      gateway.state = "stopped-for-doctor";
      // WHAT KIND of doctor failure this was (TASK-741). It still FAILS — the
      // migration provably did not happen, and a legacy auth-profiles.json left
      // in place is what stops an OpenClaw 2 gateway from starting — so the
      // rollback below is unchanged. What changes is the sentence: telling the
      // owner to "run `openclaw doctor --fix` from the Terminal" is advice for
      // the command that is blocked, and he can do nothing with it.
      let doctorBlockedByApprovals = false;
      try {
        if (await runOpenclawDoctorFix() === "blocked-by-legacy-exec-approvals") {
          doctorBlockedByApprovals = true;
          // Into the SAME failure path, deliberately: the v1/v2 decision below
          // is what says whether the legacy file may stay, and a second copy of
          // that judgement here is how the two would come to disagree.
          throw new Error("openclaw doctor --fix is blocked by a legacy exec approvals file");
        }
      } catch (doctorErr) {
        const siblings = await fs.readdir(path.dirname(AUTH_PROFILES_PATH)).catch(() => [] as string[]);
        const migratedStore = siblings.some((name) => name.startsWith("auth-profiles.json.migrated-"));
        console.error(
          "[configure] doctor --fix failed after the OAuth store write:",
          doctorErr instanceof Error ? JSON.stringify(logSafe(doctorErr.message)) : doctorErr,
        );
        let mustRollBack = migratedStore;
        if (!mustRollBack) {
          try {
            mustRollBack = await installedOpenclawUsesSqliteAuthStore();
          } catch (versionErr) {
            // An unknown generation cannot prove that the legacy file is safe.
            // Credential writes fail closed; the owner can retry once the CLI
            // is healthy instead of receiving success with a dead gateway.
            mustRollBack = true;
            console.error(
              "[configure] could not verify OpenClaw generation after doctor failure:",
              versionErr instanceof Error ? JSON.stringify(logSafe(versionErr.message)) : versionErr,
            );
          }
        }
        if (mustRollBack) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          await fs.rename(AUTH_PROFILES_PATH, `${AUTH_PROFILES_PATH}.failed-${stamp}`).catch(() => {});
          return NextResponse.json(
            {
              // Both outcomes named, in the order the owner meets them. The
              // boot path moves a clearable blocker aside on the next start —
              // but a file that provably holds approvals of HIS is left alone
              // by design (TASK-737), and for that box a restart changes
              // nothing. Leading with "restart and retry" alone would send
              // exactly those owners round a loop.
              error: doctorBlockedByApprovals
                ? "Credential migration is blocked by a legacy exec-approvals file, so the subscription sign-in"
                  + " was rolled back. Restart the device and sign in again: the gateway moves that file aside on"
                  + " its next start unless it holds approvals of yours. If the sign-in is refused again, the"
                  + " gateway boot log names the file to move aside by hand."
                : "Credential migration failed. The subscription sign-in was rolled back — try again, or run 'openclaw doctor --fix' from the Terminal.",
            },
            { status: 502 },
          );
        }
      }
    }

    // 2. Validate profileKey before interpolating into config path
    if (!PROFILE_KEY_RE.test(config.profileKey)) {
      return NextResponse.json(
        { error: "Invalid profile key format" },
        { status: 400 }
      );
    }

    // 2b. The ChatGPT sign-in and the OpenAI API key are two profiles of ONE
    //     provider on OpenClaw 2, and whichever the owner saved last is the
    //     one chat must prefer. That preference is the core's own
    //     `models auth order` (docs/cli/models.md), stored in the agent's auth
    //     store with precedence over config — asked, not re-implemented — and
    //     it is revised on BOTH saves. Set once and never revisited, it hid
    //     the credential the owner added afterwards.
    //
    //     After the validation above, not before it: the profile ids reach the
    //     CLI as argv.
    let chatgptOrderWarning: string | undefined;
    // Set when the primary was written past the CLI's catalog check AND the id
    // is in no list this box has. It used to be a console.warn and nothing
    // else: the box answered a clean `{success:true}`, Settings said
    // "Configured", and the owner found out on the first turn. That is how
    // `openai/gpt-5` — an id no openai catalogue on the pinned core carries —
    // sat in the PROVIDERS table unnoticed. The id is fixed below; this is what
    // makes the NEXT one visible.
    //
    // On the REFUSAL alone it would be noise, because the refusal is a
    // documented normal state: a placeholder key (the wizard's "save the
    // profile without validating the key" contract), a provider plugin on its
    // first boot, and `models.providers.llamacpp` written later in this same
    // request all produce it over an id that is perfectly right. Warning there
    // is the false failure this route already knows not to raise, and a warning
    // on the happy path is a warning nobody reads.
    //
    // Reaches a human only from Settings today: the ClawBox AI device-login
    // poll, the llama.cpp install route, the Ollama hook and the first-run
    // wizard branch all discard the field. Recorded rather than widened here.
    let unvalidatedPrimaryWarning: string | undefined;
    if (ocProvider === CHATGPT_PROVIDER) {
      // ONE config read for both OpenAI decisions this save makes: which
      // credential to prefer, and whether the previous lane left the Codex
      // runtime armed on the reference this lane is about to write.
      const openAiConfig = await readOpenClawConfig().catch(() => null);
      chatgptOrderWarning = await applyOpenAiAuthOrder(
        config.profileKey,
        openAiConfig,
        configStore[OPENAI_AUTH_ORDER_KEY] === true,
      );
      if (!isChatgptSubscription && (!isLocalScope || shouldPromoteLocalToPrimary)) {
        chatgptOrderWarning = await clearChatgptRuntimeArm(config.defaultModel, openAiConfig)
          ?? chatgptOrderWarning;
      }
    }

    // 3. Auth profile, primary model, compaction reserve and the local-access
    //    gateway settings. These are seven independent leaf writes with no
    //    reads between them, so they go out as ONE `config set --batch-json`.
    //    Issued one at a time they cost seven CLI cold starts — about a minute
    //    on a Jetson, for seven keys (TASK-483). They still must not be
    //    *parallel* writes: concurrent `openclaw config set` processes race on
    //    the same file and lose to ConfigMutationConflictError. One batched
    //    process is not concurrency, it is one validated read-modify-write.
    const baseOps: OpenclawConfigSetArgs[] = [
      [
        `auth.profiles.${config.profileKey}`,
        // Subscription → "oauth"; every key-based provider → "api_key". The old
        // "token" mode 401s on 2026.6.8+ (see the auth-profile write above).
        JSON.stringify(authMode === "subscription"
          ? { provider: ocProvider, mode: "oauth" }
          : { provider: ocProvider, mode: "api_key" }),
        "--json",
      ],
    ];
    if (!isLocalScope || shouldPromoteLocalToPrimary) {
      // The plugin the new primary resolves through rides in the SAME batch,
      // ahead of the reference: OpenClaw 2 validates every model reference a
      // batch touches against the enabled plugins' catalogs after applying
      // the whole batch to one snapshot, so this is what lets a Claude save on
      // a box whose plugin an earlier gate switched off validate at all — in
      // one spawn, and atomically: a refused batch leaves the flag as it was
      // (src/lib/provider-plugin-ops.ts).
      baseOps.unshift(...enableProviderPluginOps([config.defaultModel]));
      baseOps.push(["agents.defaults.model.primary", config.defaultModel]);
      // The reference is `openai/<id>` for both OpenAI auth modes; this entry
      // is what says the turn belongs to the ChatGPT account and runs on the
      // Codex app-server — the key the core itself keeps when it migrates a
      // `codex/*` reference (src/lib/chatgpt-subscription.ts).
      if (isChatgptSubscription) {
        baseOps.push(chatgptRuntimeArmOp(config.defaultModel));
      }
      if (shouldPromoteLocalToPrimary) {
        console.log(`[AI Config] Promoted local model to active primary: ${logSafe(config.defaultModel)}`);
      }
    }
    // No compaction write any more: OpenClaw 2 replaced the reserve-tuning
    // keys with compaction.mode (whose safeguard default needs no seeding)
    // and fails validation on the retired reserveTokensFloor.

    // 4c. Local device gateway setup: keep token auth enabled for LAN binding,
    // but relax Control UI browser checks because the setup surface runs over
    // plain HTTP on the local device.
    //
    // The token is per-device random (32 bytes hex) — earlier builds wrote
    // the literal "clawbox", which is public via the open-source repo and
    // let anyone on the LAN connect straight to the gateway WS bypassing the
    // wizard login. `getOrGenerateGatewayToken` reuses the existing token
    // when one is already in place so re-saving Settings doesn't break open
    // WS connections, and rotates legacy "clawbox" tokens automatically.
    console.log(`[AI Config] Configuring gateway for local access (provider: ${provider})`);
    const gatewayToken = await getOrGenerateGatewayToken();
    baseOps.push(["gateway.auth.mode", "token"]);
    // A null result means the token is externally managed. Preserve the
    // SecretRef/interpolation instead of replacing it with plaintext.
    if (gatewayToken !== null) {
      baseOps.push(["gateway.auth.token", gatewayToken]);
    }
    // OpenClaw 2 retired gateway.controlUi.allowInsecureAuth and
    // dangerouslyDisableDeviceAuth — a config carrying either fails
    // validation outright. Browsers authenticate with the gateway token plus
    // a device identity now (src/lib/gateway-device-identity.ts), so there
    // is nothing to write here any more.
    // ClawBox AI rides the deepseek provider, which OpenClaw 2 unbundled
    // into its own plugin — without it the catalog resolves zero models and
    // the primary write below is refused even with a VALID token (the fresh
    // e2e container reproduced exactly that). gateway-pre-start heals this on
    // boot, but only once a deepseek provider already exists in the config —
    // which is what THIS route is in the middle of creating — so the first
    // configure has to bring the plugin itself, pinned to the running core
    // the same way (src/lib/openclaw-deepseek-plugin.ts says why). Best
    // effort: a failed install falls through to the direct primary write
    // below and the gateway's own readiness report names the missing plugin
    // loudly.
    if (isClawAI) {
      try {
        await fs.access(path.join(OPENCLAW_HOME_DIR, "extensions", "deepseek", "openclaw.plugin.json"));
      } catch {
        console.log("[AI Config] Installing @openclaw/deepseek-provider (OpenClaw 2 unbundled it)...");
        const plugin = await installDeepseekProviderPlugin();
        if (plugin.installed) {
          console.log(`[AI Config] deepseek provider plugin installed (${plugin.installed})`);
          // The plugin the boot script may have marked for repair is on disk
          // again, and this route goes on to write the provider itself — so
          // this IS the outcome, and the "Needs repair" badge on the ClawBox AI
          // row has to go with it. Deliberately here rather than inside
          // `installDeepseekProviderPlugin`: the Retry route calls that same
          // helper and clears the marker only after `plugins inspect --runtime`
          // says the plugin actually loaded, and a clear inside the installer
          // would have thrown the badge away before that question was asked.
          // PUT THE ENTRY BACK FIRST. `plugins install` leaves an entry that
          // is explicitly `false` alone, and the boot script's boot-without
          // wrote exactly that — so clearing here on the install alone would
          // take the badge off a plugin still switched off, and this route's
          // installer is a bare `plugins install` with no enable step of its
          // own. Only for a row that says CLAWBOX disabled it.
          const switchedOff = await clawboxDisabledEntryId("deepseek").catch(() => null);
          let backOn = true;
          if (switchedOff) {
            try {
              await runOpenclawConfigSet(
                [`plugins.entries["${switchedOff}"].enabled`, "true", "--strict-json"],
                { uid: CLAWBOX_UID, gid: CLAWBOX_GID },
              );
            } catch (err) {
              // The badge STAYS: it is the only true thing left on screen, and
              // the Retry it offers runs the same write again.
              backOn = false;
              console.warn(
                "[AI Config] the deepseek plugin was installed but could not be switched back on;"
                + " leaving its repair record in place:",
                err instanceof Error ? err.message : err,
              );
            }
          }
          // SAID, not swallowed. The install succeeded and this route's own
          // answer is about the provider, so a failed clear must not fail it —
          // but a badge left on a row that works is a false failure the owner
          // cannot act on, and the log is where it is looked for.
          if (backOn) {
            await clearPluginRepair("deepseek").catch((err: unknown) => {
              console.warn(
                "[AI Config] the deepseek repair marker could not be cleared; Settings may still show a Retry:",
                err instanceof Error ? err.message : err,
              );
            });
          }
        } else {
          console.warn(
            "[AI Config] deepseek provider plugin install did not complete:",
            JSON.stringify(logSafe(plugin.failures.join("; "))),
          );
        }
      }
    }

    const primaryIdx = baseOps.findIndex((op) => op[0] === "agents.defaults.model.primary");
    try {
      await runConfigSetBatch(baseOps);
    } catch (batchErr) {
      const message = batchErr instanceof Error ? batchErr.message : String(batchErr);
      // Only the OpenClaw 2 catalog-validation refusal of the primary falls
      // through — anything else keeps its existing failure path. v2 checks a
      // model reference against a freshly refreshed provider catalog, so a
      // placeholder key (the wizard's documented "save the profile without
      // validating the key" contract) or a provider plugin on its first boot
      // resolves ZERO models and the whole batch was refused with it.
      if (primaryIdx === -1 || !/Cannot set model reference/i.test(message)) {
        throw batchErr;
      }
      const remaining = baseOps.filter((_, index) => index !== primaryIdx);
      if (remaining.length > 0) {
        await runConfigSetBatch(remaining);
      }
      // Direct atomic write for the primary alone, the same way this route
      // already writes provider entries the CLI's schema lags behind. The
      // gateway tolerates an unresolvable primary at rest; the model is
      // proven the first time it speaks, exactly as before OpenClaw 2.
      const primaryModel = String(baseOps[primaryIdx][1]);
      // The narrow helper performs a strict read under the same cross-process
      // sidecar lock OpenClaw's CLI/gateway use. That prevents a complete-file
      // write from overwriting a concurrent auth/provider/gateway mutation and
      // refuses malformed input instead of rebuilding the config from a fragment.
      //
      // Three routes write `agents.defaults.model.primary` and they hold three
      // different policies on this same CLI refusal, deliberately, because they
      // are asked three different questions:
      //   * here (a credential save)   — write past it, and warn below if the
      //     id is in no catalogue: refusing would make a placeholder key or a
      //     plugin's first boot unable to finish setup at all;
      //   * chat/model (a model PICK)  — refuse it (`refuseUnresolvableModel`):
      //     the owner chose from a list and can choose again;
      //   * local-ai/exclusive         — let it throw.
      // Said here so a fourth writer does not invent a fourth policy.
      await setPrimaryModelWithoutCatalogValidation(primaryModel);
      // The retry above re-lands the plugin enable with the rest of the
      // batch (it is not the primary), so the refusal here is the catalog's.
      console.warn(
        "[AI Config] Primary written directly — the CLI refused the reference (empty catalog for this key/plugin):",
        // JSON-quoted: the modeled sanitizer for js/log-injection (see 3ef684a1).
        JSON.stringify(logSafe(message)),
      );
      // …and only NOW decide whether a human needs to hear about it: is the id
      // one this box has? `readKnownModelIds` is the picker's own list — the
      // catalog route's cached enumeration unioned with the curated catalogue,
      // read-only and spawn-free. Null is UNKNOWN (no enumeration yet, or a
      // provider with no curated catalogue at all: llamacpp, ollama, deepseek)
      // and stays silent, because the whole point is to name an id that exists
      // NOWHERE, not to report a cold cache.
      const primaryProvider = primaryModel.includes("/") ? primaryModel.split("/", 1)[0] : "";
      const primaryId = extractProviderModelId(primaryModel, primaryProvider) ?? "";
      const knownIds = primaryProvider && primaryId ? await readKnownModelIds(primaryProvider) : null;
      if (knownIds && !knownIds.has(primaryId)) {
        unvalidatedPrimaryWarning =
          `Saved, but ${primaryModel} is in no model list this box has for ${primaryProvider}, `
          + "and OpenClaw refused to validate it. Chat turns on it will fail. "
          + "Pick a model in Settings to change it.";
      }
    }

    // 5. Ensure openclaw config files are owned by clawbox
    await Promise.all(
      ["openclaw.json", "openclaw.json.bak", "openclaw.json.bak.1", "openclaw.json.bak.2"]
        .map(name => fs.chown(path.join(OPENCLAW_HOME_DIR, name), CLAWBOX_UID, CLAWBOX_GID).catch(() => {}))
    );

    // 6. Persist to ClawBox config store. Re-uses `resolvedClawboxTier`
    // computed earlier so the value stored alongside the token always
    // matches the tier that drove `agents.defaults.model.primary` above.
    const clawboxAiTierForStore = resolvedClawboxTier;
    // The coding agent's three tools — `coding_agent_run`, `_status`, `_stop` —
    // are registered CONDITIONALLY by the ClawBox MCP server, from a probe it
    // makes ONCE while it boots; it is then a long-lived stdio child of the
    // agent. `getCodingAgentStatus().ready` is `enabled` AND the coding harness
    // installed AND ClawBox AI connected, and "connected" IS the `clawai_token`
    // the batches below write. So this route can flip readiness, and until now
    // it was the one writer of that key that never said so: the panel went
    // "ready" and the running agent still had none of the three tools.
    //
    // `/setup-api/hermes/clawai` closes the same gap by sampling the verdict
    // ahead of its own write, and `coding-agent-mcp-refresh`'s docblock states
    // the invariant as "every Hermes connect entry point funnels through
    // `applyClawaiToHermes`". THIS path is the counter-example, and it is
    // reachable: `openclawIsAbsent()` is `readEdition() === "hermes"`, so an
    // `edition=dual` box running the Hermes harness comes down here rather than
    // through the Hermes branch above (TASK-577).
    //
    // BEFORE the write, for the reason that route spells out: read it a line
    // later and the answer is always true, the before/after guard sees no
    // change, and nothing is refreshed. Only for a save that can write the key
    // — `undefined` everywhere else, so no other save pays for two status
    // reads — and `undefined` again on a probe that threw, which must not turn
    // a save into a 500 or buy a reload nobody asked for.
    const codingAgentReadyBefore = isClawAI ? await codingAgentReady() : undefined;
    if (isLocalScope) {
      await setMany({
        local_ai_configured: true,
        local_ai_provider: ocProvider,
        local_ai_model: config.defaultModel,
        local_ai_configured_at: new Date().toISOString(),
        // Consumed by shouldPromoteLocalToPrimary above.
        local_ai_was_default: undefined,
        // UNREACHABLE today, and it must stay that way or be given the pick
        // clear its sibling batch below carries: `isLocalScope` with neither
        // Ollama nor llama.cpp is refused with a 400 long before this, so
        // `isClawAI && isLocalScope` cannot happen. If that guard ever loosens,
        // this becomes a ClawBox AI token write with no `ai_model_explicit_picks`
        // beside it — the previous account's model choice surviving into the
        // next account's box (TASK-713).
        ...(isClawAI ? { [CLAWBOX_AI_TOKEN_CONFIG_KEY]: clawboxAiToken } : {}),
        ...(clawboxAiTierForStore ? { [CLAWBOX_AI_TIER_CONFIG_KEY]: clawboxAiTierForStore } : {}),
      });
      // Everything above configures OpenClaw. On a Hermes device that left the
      // model running and unreachable: Settings said "configured" while the
      // chat's provider picker had never heard of it, because Hermes keeps its
      // own providers block. Register it there too — as an available provider,
      // not as the new default, since enabling a private fallback shouldn't
      // quietly take the device off the provider the customer chose.
      if ((ocProvider === "llamacpp" || ocProvider === "ollama") && (await getActiveHarness()) === "hermes") {
        try {
          await applyLocalAiToHermes({
            provider: ocProvider,
            // Hermes wants the bare model id, not the `llamacpp/…` qualified
            // form — matching the openclaw-absent branch above.
            model: config.defaultModel.replace(/^(?:llamacpp|ollama)\//, ""),
            // This branch runs on the `dual` SKU, where OpenClaw exists but
            // Hermes is the harness actually answering. Without carrying the
            // promotion through, "Switch to Gemma 4" moved OpenClaw's primary
            // and left Hermes pointed at its old provider — the same
            // configured-but-not-active split this change exists to remove,
            // reproduced on the one SKU that has both.
            makeDefault: shouldPromoteLocalToPrimary,
          });
        } catch (err) {
          // Non-fatal: the local model is configured and running either way.
          console.error("[ai-models/configure] Hermes local provider registration failed:", err);
        }
      }
    } else {
      await setMany({
        ai_model_configured: true,
        ai_model_provider: ocProvider,
        ai_model_configured_at: new Date().toISOString(),
        ...(isClawAI ? { [CLAWBOX_AI_TOKEN_CONFIG_KEY]: clawboxAiToken } : {}),
        ...(clawboxAiTierForStore ? { [CLAWBOX_AI_TIER_CONFIG_KEY]: clawboxAiTierForStore } : {}),
        // The owner named a model in this save (TASK-713), or this save linked a
        // different ClawBox AI account and the previous owner's pick goes with
        // it. Either way in the SAME batch as the other facts about the save, so
        // a token that landed and a pick that was remembered — or forgotten —
        // cannot come apart.
        ...(explicitPickToRecord
          ? {
            [EXPLICIT_MODEL_PICKS_KEY]: {
              ...(clawaiPicksToStore ?? explicitPicksFrom(configStore[EXPLICIT_MODEL_PICKS_KEY])),
              [normalizeProviderId(ocProvider) ?? ocProvider]: explicitPickToRecord,
            },
          }
          : clawaiPicksToStore
            ? { [EXPLICIT_MODEL_PICKS_KEY]: clawaiPicksToStore }
            : {}),
      });
      // The cloud save has landed — see `forgetLocalWasDefault`.
      await forgetLocalWasDefault();
    }

    // The credential is on disk, so ask the agent to rebuild its tool list if
    // — and only if — this save is what made the coding agent usable. Only that
    // direction is live here: `getConfiguredClawboxAiToken` falls back to the
    // stored token and an empty one is refused with a 400 long before this, so
    // a ClawBox AI save can never CLEAR `clawaiConnected`. The guard is the
    // helper's either way: a reload respawns every
    // MCP child and invalidates the model's prompt cache, so a re-save of a
    // token the box already held must not buy one. Best effort by design; the
    // owner's save has already landed and an edition with no dashboard to ask
    // re-probes at the next respawn on its own.
    if (codingAgentReadyBefore !== undefined) {
      const readyAfter = await codingAgentReady();
      if (readyAfter !== undefined) {
        await refreshCodingAgentToolsIfReadinessChanged(codingAgentReadyBefore, readyAfter);
      }
    }

    // Connecting a provider is the owner saying "use this one": a provider the
    // switch had turned off comes back on, or the save below would route the
    // chat to something the provider list still shows as switched off.
    // Non-fatal — the switch is bookkeeping, the credential write is the save.
    try {
      await setProviderEnabled(ocProvider, true);
    } catch (err) {
      console.error("[ai-models/configure] could not re-enable the provider:", err instanceof Error ? err.message : err);
    }

    // 7. For ClawBox AI (DeepSeek) or Ollama, define a custom provider in openclaw.json
    // and set models.mode=replace so the gateway uses our definition.
    if (isClawAI) {
      // ONE provisioning pass, not two. This used to call configureClawboxAi()
      // and then ensureFallbackModel(), which — with no local model to fall
      // back to, which is the normal case — called configureClawboxAi() a
      // SECOND time for the sole purpose of writing
      // `agents.defaults.model.fallbacks`. Every write in it therefore paid the
      // CLI's ~8 s cold start twice. Decide the fallback first and hand both
      // that decision and `models.mode` to the single pass, so the whole
      // ClawBox AI provisioning is one `config set --batch-json` (TASK-483).
      const localFallback = await pickLocalFallbackModel(config.defaultModel, undefined);
      // The two fallback outcomes keep the fatality they had when they lived in
      // ensureFallbackModel: a local fallback was written before its try block
      // and so was fatal, while the ClawBox AI one was written inside it and so
      // only warned. Inherited, not chosen — batching them must not quietly
      // change either.
      const fallbackGroup: ConfigSetGroup = localFallback
        ? {
            ops: [[
              "agents.defaults.model.fallbacks",
              JSON.stringify([localFallback]),
              "--json",
            ]],
            onApplied: () =>
              console.log(`[AI Config] Configured local fallback model: ${logSafe(localFallback)}`),
          }
        : {
            ops: [[
              "agents.defaults.model.fallbacks",
              JSON.stringify([CLAWBOX_AI_MODEL]),
              "--json",
            ]],
            onApplied: () => console.log("[AI Config] Configured ClawBox AI as fallback model"),
            onError: (err) =>
              console.warn(
                "[AI Config] Failed to configure fallback model:",
                err instanceof Error ? logSafe(err.message) : err,
              ),
          };
      const clawboxAiConfigured = await configureClawboxAi(
        false,
        clawboxAiToken,
        {
          requiredOps: [["models.mode", "merge"]],
          groups: [fallbackGroup],
          // Answered HERE, from the snapshot taken before this request's own
          // `setMany` — see the field's docblock. `previousClawaiToken` is the
          // same value the ClawKeep account-switch guard below reads, so a
          // re-link cannot be a credential change for one of them and not the
          // other.
          credentialChanged: clawboxAiToken !== previousClawaiToken,
        },
      );
      if (!clawboxAiConfigured) {
        // Unreachable in practice — the handler already 400s when ClawBox AI
        // has no token — but keep the old shape rather than silently leave a
        // stale fallback naming a provider this box no longer has.
        await runConfigSetBatch([["models.mode", "merge"]]);
        await ensureFallbackModel(config.defaultModel, undefined, clawboxAiToken);
      }
      console.log(`[AI Config] Set ClawBox AI provider in openclaw.json via proxy ${CLAWBOX_AI_PROXY_URL}`);

      // Account-switch safety: ClawKeep pairs separately and is bound to its
      // own token (the portal resolves token -> account -> storage prefix), so
      // after switching ClawBox AI accounts it would keep backing up to the
      // OLD account's cloud storage. When the clawai token changes from a
      // previously-stored one, the user has switched accounts — unpair ClawKeep
      // locally so it re-pairs against the current account. The clawai token is
      // opaque (no embedded account id), so a changed token is the only signal
      // available; in this flow that means the account changed.
      if (previousClawaiToken && previousClawaiToken !== clawboxAiToken) {
        try {
          // clearStats: the old account's backup history doesn't belong to the
          // new account, so wipe it rather than leave it on the dashboard.
          await unpairClawKeep({ clearStats: true });
          console.log("[AI Config] ClawBox AI account changed — unpaired ClawKeep so it reconnects to the new account");
        } catch (err) {
          console.error("[AI Config] Failed to unpair ClawKeep after account change:", err);
        }
      }
    } else if (isOllama) {
      const modelName = config.defaultModel.replace(/^ollama\//, "");
      const providerDef = JSON.stringify({
        baseUrl: getLocalAiProxyBaseUrl("ollama"),
        api: "ollama",
        apiKey: getLocalAiToken(),
        models: [{
          id: modelName,
          name: modelName,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: OLLAMA_CONTEXT_WINDOW,
          maxTokens: OLLAMA_MAX_TOKENS,
        }],
      });
      await runConfigSetBatch([
        ["models.providers.ollama", providerDef, "--json"],
        ["models.mode", isLocalScope ? "merge" : "replace"],
      ]);
      await ensureFallbackModel(shouldPromoteLocalToPrimary ? config.defaultModel : (isLocalScope ? null : config.defaultModel), config.defaultModel);
      // Ensure Ollama service has memory optimizations (q8_0 KV cache, flash attention)
      try {
        await runCommand("sudo", ["/usr/local/libexec/clawbox/optimize-ollama.sh"]);
      } catch (err) {
        // Non-fatal: Ollama will still work, just use more memory
        console.warn("[AI Config] Failed to optimize Ollama service:", err instanceof Error ? logSafe(err.message) : err);
      }
      console.log(`[AI Config] Set ollama provider in openclaw.json: ${logSafe(modelName)} (context=${OLLAMA_CONTEXT_WINDOW}, mode=replace)`);
    } else if (isLlamaCpp) {
      const modelName = config.defaultModel.replace(/^llamacpp\//, "");
      const providerDef = JSON.stringify({
        baseUrl: getLlamaCppProxyBaseUrl(),
        api: "openai-completions",
        apiKey: getLocalAiToken(),
        models: [{
          id: modelName,
          name: modelName,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: llamaCppContextWindow,
          maxTokens: llamaCppMaxTokens,
        }],
      });
      await runConfigSetBatch([
        ["models.providers.llamacpp", providerDef, "--json"],
        ["models.mode", isLocalScope ? "merge" : "replace"],
      ]);
      await ensureFallbackModel(shouldPromoteLocalToPrimary ? config.defaultModel : (isLocalScope ? null : config.defaultModel), config.defaultModel);
      console.log(`[AI Config] Set llama.cpp provider in openclaw.json: ${logSafe(modelName)} (context=${llamaCppContextWindow}, mode=replace)`);
    } else if (isOpenRouter) {
      // OpenRouter has no native OpenClaw adapter, so without this explicit
      // provider entry the chat turn silently returns usage 0/0/0 — and no
      // OAuth flow either (it is absent from OAUTH_PROVIDERS), so every save
      // that reaches here is key-based and keeps the override.
      const openrouterWroteOverride = await applyCloudProviderTransport({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: normalizedApiKey,
        authMode,
        defaultModel: config.defaultModel,
        curatedModels: OPENROUTER_CURATED_MODELS,
      });
      console.log(`[AI Config] Set openrouter provider (${openrouterWroteOverride ? "openai-compat" : "native plugin, subscription auth"}): ${logSafe(config.defaultModel)}`);
    } else if (isGoogle) {
      // Native google plugin registers Gemini models but its 2026.6.8 auth
      // fails at call time (runs fall back with reason=auth). Route through
      // Google's OpenAI-compat endpoint instead — for the SUBSCRIPTION
      // (Gemini Code Assist OAuth) sign-in too. Google is the one sibling of
      // the anthropic bug fixed here, and it is deliberately left alone: see
      // `routesSubscriptionNatively` for why taking its override away without
      // a device to prove the native route on would repeat the same mistake.
      const googleWroteOverride = await applyCloudProviderTransport({
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: normalizedApiKey,
        authMode,
        defaultModel: config.defaultModel,
        curatedModels: GOOGLE_MODELS,
      });
      console.log(`[AI Config] Set google provider (${googleWroteOverride ? "openai-compat" : "native plugin, subscription auth"}): ${logSafe(config.defaultModel)}`);
    } else if (isAnthropic) {
      // With an API KEY: the native anthropic plugin reads a per-agent sqlite
      // auth store that ClawBox's file auth profile doesn't populate, so it
      // fails with "No API key found" at call time — route through Anthropic's
      // OpenAI-compat endpoint with the key inline instead.
      //
      // With a Claude Pro/Max SUBSCRIPTION: that same override is what made
      // every turn 429. applyCloudProviderTransport keeps the two apart; see
      // its doc comment for the transport proof.
      const anthropicWroteOverride = await applyCloudProviderTransport({
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: normalizedApiKey,
        authMode,
        defaultModel: config.defaultModel,
        curatedModels: ANTHROPIC_MODELS,
      });
      console.log(`[AI Config] Set anthropic provider (${anthropicWroteOverride ? "openai-compat" : "native plugin, subscription auth"}): ${logSafe(config.defaultModel)}`);
    } else {
      // Switching away from Ollama/ClawBox AI — reset models.mode so cloud providers
      // auto-detect their model catalog normally.
      try {
        await runCommand(OPENCLAW_BIN, [
          "config", "set", "models.mode", "merge",
        ]);
      } catch {
        // Non-fatal: merge is the default behavior anyway
      }

      await ensureFallbackModel(config.defaultModel);
    }

    // 8. Sweep every existing session's per-session override to the new
    //    primary model, tagged `source: "user"` so OpenClaw's per-turn
    //    model resolver returns early and doesn't flip the session back
    //    to the previous provider on the first message after the switch.
    //    Without this, a session that was bound to e.g. codex
    //    keeps routing to codex even after the user changes the
    //    primary provider to ClawBox AI / DeepSeek / etc. — the new
    //    default only seeds future sessions. Mirror of the sweep in
    //    /setup-api/chat/model (see PR #73 for context on why "user" is
    //    the only sticky source value).
    //
    //    Only sweep when this configure call actually set a new primary
    //    (skip for local-only local-AI setups that leave the primary
    //    alone).
    if (!isLocalScope || shouldPromoteLocalToPrimary) {
      const parsedPrimary = parseFullyQualifiedModel(config.defaultModel);
      if (parsedPrimary) {
        try {
          await applyModelOverrideToAllAgentSessions({
            provider: parsedPrimary.provider,
            modelId: parsedPrimary.modelId,
            source: "user",
          });
        } catch (err) {
          // Non-fatal: the default change above still takes effect for
          // brand-new sessions; worst case the user resets the open chat.
          console.error("[configure] Failed to sweep session overrides:", err);
        }
      }
    }

    // 8b. The OFF half of the gate: switch the anthropic plugin off only when
    //     nothing on the box could use it — the primary is elsewhere AND no
    //     usable Anthropic credential remains (the ON half rode in the primary
    //     batch at step 3). See setProviderPlugins for the catalog measurement
    //     behind the rule.
    if (!isLocalScope || shouldPromoteLocalToPrimary) {
      const primaryProvider = config.defaultModel.split("/", 1)[0];
      // Same gate, same rule: it returns the provider whose plugin it flipped,
      // which is a catalogue change for THAT provider — not for the one this
      // save is about, which step 8c counts below.
      const flippedProvider = await setProviderPlugins(primaryProvider);
      if (flippedProvider) notifyProviderSetChanged(flippedProvider);
    }

    // 8c. Kick off a catalog refresh for the just-configured provider so
    //     the picker shows the full live model list instead of whatever
    //     the boot-time warmup found before the user added their API key.
    //     Without this, a device that adds Anthropic / OpenAI / etc. credentials
    //     after first boot stays stuck on the pre-auth snapshot — which is
    //     often a single fallback entry or empty — until the next service
    //     restart. The refresh runs out-of-band; we don't await it. Single-
    //     flight guarded inside refreshInBackground, so concurrent configure
    //     calls collapse to one openclaw fork.
    //
    //     `notifyProviderSetChanged` owns the openclaw-id mapping and the
    //     catalogue-membership test, so this call site does not repeat them.
    //     It COUNTS the change — the plugin was switched on and the credential
    //     written one step above, so any earlier pre-auth enumeration and any
    //     backoff it recorded describe a box that no longer exists. A client's
    //     `?refresh=1` cannot count it; only a write can.
    notifyProviderSetChanged(ocProvider);

    // 8d. Did this save flip `models.mode`? Then every recorded model COUNT was
    //     taken under a rule that no longer holds — under `replace` the core
    //     serves the configured rows alone, which is how google goes from ten
    //     models to none — so none of them may keep a Providers row hidden.
    //     Forgetting them shows every row again at once, at the cost of one
    //     small file write and no enumeration at all; each provider records the
    //     new truth on the next refresh that happens for its own reasons.
    //     Compared against the config as it is NOW, so a write that did not
    //     land counts for nothing.
    if ((await readModelsMode()) !== modelsModeBefore) await forgetProviderEnumerations();

    // Codex 2026.6.x reads its ChatGPT session from the Codex CLI's own
    // ~/.codex/auth.json, which gateway-pre-start.sh synthesizes from this
    // OAuth profile (write-if-missing). On an explicit (re)login, clear the
    // stale file so the restart below regenerates it with the fresh token —
    // afterward the Codex app-server owns its own refresh, so we don't touch
    // it again.
    //
    // Every agent's `codex-home/auth.json` goes with it. That file is the
    // Codex app-server's own CODEX_HOME copy, and scripts/codex-auth-mirror.js
    // deliberately refuses to overwrite one holding a refresh token core does
    // not have: overwriting a live app-server rotation with core's spent copy
    // is what burnt the token family in #278. On a 2026.8 box that script can
    // no longer write core's store back (the per-agent `auth_profile_store`
    // row holds zero profiles after `doctor --fix`), so a diverged file never
    // leaves that state — it keeps the PREVIOUS account's token for the life of
    // the box and the sync timer warns about it every ten minutes, advising a
    // re-login that did not clear it. A sign-in is the one moment the account
    // genuinely changes, which makes it the only place the divergence can be
    // settled without guessing.
    if (isChatgptSubscription) {
      const agentsRoot = path.join(OPENCLAW_HOME_DIR, "agents");
      const agentIds = await fs.readdir(agentsRoot).catch((err: unknown) => {
        // Not fatal — the sign-in itself succeeded — but a box that could not
        // be enumerated keeps its stale codex-home mirrors, and that state is
        // otherwise invisible: `force: true` swallows ENOENT, not EACCES.
        console.warn("[configure] Could not enumerate agent dirs to clear stale Codex mirrors:", err instanceof Error ? logSafe(err.message) : err);
        return [] as string[];
      });
      const staleMirrors = [
        path.join(CLAWBOX_HOME_DIR, ".codex", "auth.json"),
        ...agentIds.map((id) => path.join(agentsRoot, id, "agent", "codex-home", "auth.json")),
      ];
      await Promise.all(
        staleMirrors.map((file) =>
          fs.rm(file, { force: true }).catch((err: unknown) => {
            console.warn("[configure] Could not clear a stale Codex mirror:", logSafe(file), err instanceof Error ? logSafe(err.message) : err);
          }),
        ),
      );
    }

    // (The OAuth doctor migration runs right after the store write in step 1
    // — see the subscription branch — so nothing here executes against an
    // un-migrated auth store.)

    // 9. Restart OpenClaw gateway so it picks up the new auth profile and model
    gateway.state = "restart-issued";
    let gatewayWarning: string | undefined;
    // `setup_complete` flips at the very end of the wizard
    // (/setup-api/setup/complete), so "not true" is exactly "the first-run
    // wizard is still driving this box".
    //
    // Read through route-auth, NOT through the config-store snapshot above.
    // `readConfig()` there is fail-OPEN — a damaged config.json reads as `{}` —
    // and route-auth exists precisely to say that must not decide this key: it
    // fails CLOSED, so an unreadable config is "provisioned", which is also
    // what `/setup-api/setup/status` and middleware serve. Fail open here and a
    // box whose config.json is truncated renders Settings while this route
    // treats it as the wizard and silently drops the notice Settings is the one
    // branch that renders. Re-read per request; nothing is cached.
    const firstRunWizard = !readSetupGateFacts().setupComplete;
    try {
      // The readiness answer is worth waiting for only where something reads
      // it, and in the wizard nothing does: AIModelsStep's wizard branch logs
      // `warning` and calls onNext() (Settings is the branch that renders it),
      // and llamacpp/install, clawai/poll and useOllamaModels all drop it too.
      // The cost is not theoretical — e2e-install measured THIS request at
      // 52 894 ms on a cold first boot: ~23 s of config writes and `systemctl
      // restart`, then the whole 30 s budget, expired. So first boot pays the
      // full budget for a value with no consumer, on the one path where the
      // budget is not even enough to answer. Skip the port poll there, exactly
      // as /setup-api/system/hostname does for its own discarded answer.
      //
      // Only the poll is skipped, never the restart: a REFUSED restart still
      // throws from the exec below and still 502s, in the wizard too. And a
      // gateway that never comes back is not silent either — the chat the
      // wizard hands off to cannot open a session without one.
      await restartGateway({ awaitReady: !firstRunWizard });
    } catch (err) {
      console.error("[configure] Gateway restart failed after configuring", ocProvider, ":", err instanceof Error ? logSafe(err.message) : err);
      // A gateway that has not finished coming back is NOT a failed configure.
      // The provider, the credential and the model are all written by the time
      // this runs; only the wait gave up. This 502 predates the readiness wait,
      // when it could fire only if `systemctl restart` itself failed — the wait
      // widened it to "the port did not open inside 30 s", which is a state the
      // box recovers from on its own, and reporting it as a failure stops the
      // first-boot wizard dead at the AI step and tells the owner to reboot a
      // box that needed ten more seconds.
      //
      // A restart that was REFUSED is a different fact: nothing is coming, and
      // the owner does have to act. That one keeps the 502.
      if (!(err instanceof GatewayNotReadyError)) {
        return NextResponse.json(
          { error: "AI model configured but gateway failed to restart. Try rebooting the device." },
          { status: 502 },
        );
      }
      gatewayWarning = "Saved, but the gateway has not finished restarting — the new model applies once it is serving again.";
    }

    // Configuration fully applied — now consume the OAuth handoff file (if any).
    // Deferring the unlink to here means a failure that returned EARLY left the
    // file intact, so the client can retry within the TTL. A gateway that has
    // not finished restarting is not one of those: it falls through to here and
    // consumes the file, which is right — the configure landed, and a retry
    // would redo a completed save.
    if (pendingHandoffTokensPath) {
      await fs.unlink(pendingHandoffTokensPath).catch(() => {});
    }

    const warning = [chatgptOrderWarning, unvalidatedPrimaryWarning, gatewayWarning]
      .filter(Boolean)
      .join(" ");
    return NextResponse.json({
      success: true,
      ...(warning ? { warning } : {}),
      // The plan may have moved while the model deliberately did not (TASK-713).
      // Reported so the plan card can say so, rather than answering 200 over a
      // screen where nothing appears to have happened.
      ...(explicitPickKept ? { explicitPickKept: true, model: config.defaultModel } : {}),
    });
  } catch (err) {
    // The one refusal that is not a failure: the save was REFUSED before
    // anything was written, and the owner can act on it. Its own status and
    // code, and the sentence names the credential slot so the Terminal
    // instruction can be followed literally. Answered before the sanitising
    // branch below, which would otherwise turn it into "check your
    // credentials" over a key that is perfectly good (TASK-662).
    if (err instanceof SignInWouldBeLostError) {
      console.warn(
        `[configure] refused an API key that would replace the sign-in at ${err.profileId}`,
      );
      return NextResponse.json(
        {
          error: "This box is signed in to that provider, and the sign-in is stored in the same "
            + `credential slot (${err.profileId}). Saving an API key here would delete it. `
            + "Remove the sign-in first — in the Terminal: "
            // Unpinned, exactly as the guard read and the paste wrote: the
            // core resolves the same agent for all three, and naming one here
            // would send the owner at a store none of them touched. Argument
            // order is the command's own
            // (`models auth logout [options] <profileId>`, read from its
            // --help on 2026.8.1).
            + `openclaw models auth logout ${err.profileId}`
            + " — then paste the key.",
          code: "sign_in_would_be_lost",
          profileId: err.profileId,
        },
        { status: 409 },
      );
    }
    // Never surface the raw error: it can carry CLI internals and filesystem
    // paths. Log it server-side for diagnosis and return a generic, actionable
    // message (mirrors the sanitized gateway-restart branch above).
    console.error(
      "[configure] Failed to configure AI model:",
      err instanceof Error ? logSafe(err.message) : err,
    );
    // Classify so the message matches the cause. A local on-device model has no
    // credentials, and an edition without the openclaw binary is not something
    // the user can fix by re-checking a key — "check your credentials" is wrong
    // and un-actionable for both.
    const isLocalRequest =
      requestScope === "local" || requestProvider === "ollama" || requestProvider === "llamacpp";
    let message: string;
    if (err instanceof OpenclawUnavailableError) {
      message = "This action isn't available on this edition.";
    } else if (isLocalRequest) {
      message = "Couldn't set up the on-device model. Please try again.";
    } else {
      message = "Failed to configure AI model. Please check your credentials and try again.";
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
