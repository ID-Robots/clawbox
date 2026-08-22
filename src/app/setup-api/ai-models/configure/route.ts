export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { getAll, setMany } from "@/lib/config-store";
import { HANDOFF_TOKENS_PATH, HANDOFF_TTL_MS } from "@/lib/oauth-handoff";
import {
  restartGateway,
  findOpenclawBin,
  runOpenclawConfigSet,
  compactionReserveFloorForContext,
  inferConfiguredLocalModel,
  readConfig as readOpenClawConfig,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
  setProviderPlugins,
  openclawIsAbsent,
  OpenclawUnavailableError,
  type OpenClawConfig,
} from "@/lib/openclaw-config";
import { getActiveHarness } from "@/lib/harness";
import { applyLocalAiToHermes, HermesLocalApplyError } from "@/lib/hermes-local-ai";
import { applyClawaiToHermes, ClawaiApplyError } from "@/lib/hermes-clawai";
import { applyCloudProviderKeyToHermes, HermesCloudApplyError } from "@/lib/hermes-cloud-provider";
import {
  getDefaultLlamaCppModel,
  getLlamaCppContextWindow,
  getLlamaCppMaxTokens,
  getLlamaCppProxyBaseUrl,
} from "@/lib/llamacpp";
import { getLocalAiProxyBaseUrl } from "@/lib/local-ai-runtime";
import { unpairLocal as unpairClawKeep } from "@/lib/clawkeep";
import { getLocalAiToken, markLocalAiTokenMigrated } from "@/lib/local-ai-token";
import { getOrGenerateGatewayToken } from "@/lib/gateway-proxy";
import {
  CLAWBOX_AI_PROVIDER,
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_PRO_MODEL_ID,
  CLAWBOX_AI_MODEL_BY_TIER,
  CLAWBOX_AI_DEFAULT_TIER,
  CLAWBOX_AI_IMAGE_PROVIDER,
  CLAWBOX_AI_IMAGE_MODEL,
  CLAWBOX_AI_IMAGE_MODEL_ID,
  CLAWBOX_AI_IMAGE_MODEL_LABEL,
  CLAWBOX_AI_VISION_MODEL,
  CLAWBOX_AI_VISION_MODEL_ID,
  CLAWBOX_AI_VISION_MODEL_LABEL,
  CLAWBOX_AI_VISION_INPUT_MODALITIES,
  CLAWBOX_AI_VISION_MAX_TOKENS,
  normalizeClawboxAiTier,
  type ClawboxAiTier,
} from "@/lib/clawbox-ai-models";
import { OPENROUTER_CURATED_MODELS, OPENROUTER_DEFAULT_MODEL_ID } from "@/lib/openrouter-models";
import { resolveEntitledCodexModel } from "@/lib/codex-model-probe";
import { fetchPortalTier } from "@/lib/clawbox-ai-portal-tier";
import { isValidModelId, isCatalogProvider, GOOGLE_MODELS, ANTHROPIC_MODELS, extractProviderModelId } from "@/lib/provider-models";
import { refreshInBackground as refreshCatalogInBackground } from "@/app/setup-api/ai-models/catalog/route";
// The model name on this route arrives in the request body. For a local
// provider it is the whole of `apiKey`, which nothing further constrains, and
// it reaches the lines below both directly and inside a subprocess error that
// quotes the command it ran. Bound every such field before logging it — see
// src/lib/log-safe.ts.
import { logSafe } from "@/lib/log-safe";

const OPENCLAW_BIN = findOpenclawBin();
const OPENCLAW_HOME_DIR =
  process.env.OPENCLAW_HOME || path.join(process.env.HOME ?? "/home/clawbox", ".openclaw");
const CLAWBOX_HOME_DIR = process.env.HOME ?? "/home/clawbox";
const AUTH_PROFILES_PATH = path.join(
  OPENCLAW_HOME_DIR,
  "agents",
  "main",
  "agent",
  "auth-profiles.json",
);
const CLAWBOX_UID = process.getuid?.() ?? 1000;
const CLAWBOX_GID = process.getgid?.() ?? 1000;
const CLAWBOX_AI_PROXY_URL = process.env.CLAWBOX_AI_PROXY_URL?.trim() || "https://clawbox.com/api/ai";
const CLAWBOX_AI_TOKEN_CONFIG_KEY = "clawai_token";
const CLAWBOX_AI_TIER_CONFIG_KEY = "clawai_tier";
const CLAWBOX_AI_PROFILE_KEY = "deepseek:default";
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
    defaultModel: "anthropic/claude-sonnet-4-6",
    profileKey: "anthropic:default",
  },
  openai: {
    defaultModel: "openai/gpt-5",
    profileKey: "openai:default",
    subscriptionOverride: {
      // Newest model every ChatGPT tier can run, Free included. Entitled
      // accounts are moved up to gpt-5.6 by the sign-in probe below.
      defaultModel: "codex/gpt-5.5",
      profileKey: "codex:default",
    },
  },
  google: {
    defaultModel: "google/gemini-2.5-flash",
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

async function getConfiguredClawboxAiToken(preferredToken?: string) {
  const trimmedPreferred = preferredToken?.trim();
  if (trimmedPreferred) {
    return trimmedPreferred;
  }

  try {
    const config = await getAll();
    const storedToken = typeof config[CLAWBOX_AI_TOKEN_CONFIG_KEY] === "string"
      ? config[CLAWBOX_AI_TOKEN_CONFIG_KEY].trim()
      : "";
    if (storedToken) {
      return storedToken;
    }
  } catch {
    // Fall through to the empty-token return below.
  }

  return "";
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

function buildClawboxAiProviderDefinition(apiKey: string) {
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
        id: CLAWBOX_AI_VISION_MODEL_ID,
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
 * - **No `api` field.** This is what keeps the image model out of the chat
 *   model picker. The catalog row source skips a configured model entry that
 *   declares no `api`, so the entry is invisible to `openclaw models list` and
 *   to everything downstream of it. Measured on 2026-08-20: with `api` absent
 *   `models list --provider openai --all` returns the same 7 chat rows as an
 *   unconfigured box; adding `api: "openai-completions"` makes it 8, with
 *   `openai/gpt-image-1-mini` offered as a conversational model that would
 *   fail on every turn. The image path is unaffected either way because it
 *   reads raw config, not the normalised catalog.
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
function upsertClawboxAiImageModel(existing: unknown): OpenAiModelEntry[] {
  const rows: OpenAiModelEntry[] = Array.isArray(existing)
    ? existing.filter((row): row is OpenAiModelEntry => typeof row === "object" && row !== null)
    : [];
  const ours = rows.find((row) => row.id === CLAWBOX_AI_IMAGE_MODEL_ID);
  if (!ours) {
    return [
      ...rows,
      {
        id: CLAWBOX_AI_IMAGE_MODEL_ID,
        name: CLAWBOX_AI_IMAGE_MODEL_LABEL,
        baseUrl: CLAWBOX_AI_PROXY_URL,
      },
    ];
  }
  return rows.map((row) => {
    if (row !== ours) return row;
    const { api: _api, ...rest } = row;
    return {
      ...rest,
      name: typeof row.name === "string" && row.name.trim() ? row.name : CLAWBOX_AI_IMAGE_MODEL_LABEL,
      baseUrl: CLAWBOX_AI_PROXY_URL,
    };
  });
}

function buildClawboxAiImageProviderModels(existing?: unknown) {
  return JSON.stringify(upsertClawboxAiImageModel(existing));
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
  return trimmed === "" || trimmed.startsWith("claw_");
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
function foreignOpenAiRoute(provider: OpenAiProviderConfig | undefined): string | null {
  if (!provider) return null;
  const proxyHost = hostOfUrl(CLAWBOX_AI_PROXY_URL);
  const isForeign = (baseUrl: string) => {
    const host = hostOfUrl(baseUrl);
    return host === null || proxyHost === null || host !== proxyHost;
  };

  const providerBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl.trim() : "";
  if (providerBaseUrl && isForeign(providerBaseUrl)) return providerBaseUrl;

  const rows = Array.isArray(provider.models) ? provider.models : [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    if (row.id === CLAWBOX_AI_IMAGE_MODEL_ID) continue;
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
async function configureClawboxAiImages(clawboxAiToken: string): Promise<boolean> {
  let existingOpenAiProvider: OpenAiProviderConfig | undefined;
  let existingImageModel: unknown;
  try {
    const config = await readOpenClawConfig();
    existingOpenAiProvider = config.models?.providers?.[CLAWBOX_AI_IMAGE_PROVIDER];
    existingImageModel = config.agents?.defaults?.imageGenerationModel;
  } catch {
    // No readable config yet (fresh box) — nothing to preserve.
    existingOpenAiProvider = undefined;
    existingImageModel = undefined;
  }
  if (typeof existingOpenAiProvider !== "object" || existingOpenAiProvider === null) {
    existingOpenAiProvider = undefined;
  }

  if (!canOwnOpenAiImageApiKey(existingOpenAiProvider?.apiKey)) {
    console.warn(
      "[AI Config] Skipped ClawBox AI image provider: models.providers.openai.apiKey holds a non-ClawBox key we will not overwrite",
    );
    return false;
  }

  const foreignRoute = foreignOpenAiRoute(existingOpenAiProvider);
  if (foreignRoute) {
    console.warn(
      `[AI Config] Skipped ClawBox AI image provider: models.providers.openai already routes to ${logSafe(foreignRoute)}, and the apiKey we would write there is the credential for that route too`,
    );
    return false;
  }

  // Leaf-path writes, not a whole-provider `config set models.providers.openai`:
  // replacing the object would drop any other openai settings the box carries.
  await runCommand(OPENCLAW_BIN, [
    "config",
    "set",
    `models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}.apiKey`,
    clawboxAiToken,
  ]);
  await runCommand(OPENCLAW_BIN, [
    "config",
    "set",
    `models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}.models`,
    buildClawboxAiImageProviderModels(existingOpenAiProvider?.models),
    "--json",
  ]);
  if (hasToolModelConfig(existingImageModel)) {
    console.log(
      "[AI Config] Left agents.defaults.imageGenerationModel alone: it already names an image model",
    );
    return true;
  }
  await runCommand(OPENCLAW_BIN, [
    "config",
    "set",
    "agents.defaults.imageGenerationModel",
    JSON.stringify({ primary: CLAWBOX_AI_IMAGE_MODEL }),
    "--json",
  ]);
  return true;
}

async function configureClawboxAi(setFallback: boolean, preferredToken?: string) {
  const clawboxAiToken = await getConfiguredClawboxAiToken(preferredToken);
  if (!clawboxAiToken) {
    return false;
  }

  const authProfiles = await readAuthProfiles();
  authProfiles.profiles[CLAWBOX_AI_PROFILE_KEY] = {
    type: "api_key",
    provider: CLAWBOX_AI_PROVIDER,
    key: clawboxAiToken,
  };
  await writeAuthProfiles(authProfiles);

  await runCommand(OPENCLAW_BIN, [
    "config",
    "set",
    `auth.profiles.${CLAWBOX_AI_PROFILE_KEY}`,
    JSON.stringify({ provider: CLAWBOX_AI_PROVIDER, mode: "api_key" }),
    "--json",
  ]);
  await runCommand(OPENCLAW_BIN, [
    "config",
    "set",
    `models.providers.${CLAWBOX_AI_PROVIDER}`,
    buildClawboxAiProviderDefinition(clawboxAiToken),
    "--json",
  ]);

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
  try {
    let existingVisionModel: unknown;
    try {
      existingVisionModel = (await readOpenClawConfig()).agents?.defaults?.imageModel;
    } catch {
      // No readable config yet (fresh box) — nothing to preserve.
      existingVisionModel = undefined;
    }
    if (hasToolModelConfig(existingVisionModel)) {
      console.log(
        "[AI Config] Left agents.defaults.imageModel alone: it already names a vision model",
      );
    } else {
      await runCommand(OPENCLAW_BIN, [
        "config",
        "set",
        "agents.defaults.imageModel",
        JSON.stringify({ primary: CLAWBOX_AI_VISION_MODEL }),
        "--json",
      ]);
      console.log(
        `[AI Config] Set ClawBox AI vision model ${CLAWBOX_AI_VISION_MODEL} via proxy ${CLAWBOX_AI_PROXY_URL}`,
      );
    }
  } catch (err) {
    console.warn(
      "[AI Config] Failed to configure ClawBox AI vision model:",
      err instanceof Error ? logSafe(err.message) : err,
    );
  }

  // Images ride on the same token and the same proxy, so they are provisioned
  // here rather than behind a separate opt-in — a box that has ClawBox AI has
  // an image allowance whether or not ClawBox AI is also the chat provider.
  // Non-fatal: a chat provider that works is worth more than an image tool, so
  // a failure here must not fail the whole "Connect ClawBox AI" flow.
  try {
    if (await configureClawboxAiImages(clawboxAiToken)) {
      console.log(
        `[AI Config] Set ClawBox AI image provider ${CLAWBOX_AI_IMAGE_MODEL} via proxy ${CLAWBOX_AI_PROXY_URL}`,
      );
    }
  } catch (err) {
    // `logSafe`, not the raw message: this one is built from a subprocess
    // failure, so it carries whatever `openclaw` wrote to stderr — a value that
    // reached the CLI from this route's request body, control characters and
    // all. Unbounded and un-escaped, it would be the caller deciding how many
    // journal records one API call produces. The command line itself is already
    // safe: `spawnOpenclawConfigSet` names the config path and elides the value,
    // which for this call is the portal token (see `configSetLabelArgs`).
    console.warn(
      "[AI Config] Failed to configure ClawBox AI image provider:",
      err instanceof Error ? logSafe(err.message) : err,
    );
  }

  if (setFallback) {
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "agents.defaults.model.fallbacks",
      JSON.stringify([CLAWBOX_AI_MODEL]),
      "--json",
    ]);
  }

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

async function ensureFallbackModel(
  primaryModel?: string | null,
  preferredLocalModel?: string,
  preferredClawboxAiToken?: string,
) {
  const fallbackCandidates = [preferredLocalModel, await getStoredLocalFallbackModel()]
    .filter((model): model is string => !!model && model !== primaryModel);

  if (fallbackCandidates.length > 0) {
    await setFallbackModels([fallbackCandidates[0]]);
    console.log(`[AI Config] Configured local fallback model: ${logSafe(fallbackCandidates[0])}`);
    return;
  }

  try {
    const fallbackConfigured = await configureClawboxAi(true, preferredClawboxAiToken);
    if (fallbackConfigured) {
      console.log("[AI Config] Configured ClawBox AI as fallback model");
      return;
    }

    await setFallbackModels([]);
    console.log("[AI Config] Cleared stale fallback (no local or ClawBox AI backup available)");
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
  await runCommand(OPENCLAW_BIN, [
    "config", "set", `models.providers.${opts.provider}`, providerDef, "--json",
  ]);
  try {
    await runCommand(OPENCLAW_BIN, ["config", "set", "models.mode", "merge"]);
  } catch {
    // Non-fatal: merge is the default behavior anyway
  }
  await ensureFallbackModel(opts.defaultModel);
}

export async function POST(request: Request) {
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
    requestProvider = provider;
    requestScope = scope;
    const requestedClawboxAiTier = normalizeClawboxAiTier(body.clawaiTier);
    const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
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
    const llamaCppContextWindow = getLlamaCppContextWindow();
    const llamaCppMaxTokens = getLlamaCppMaxTokens();
    const ocProvider = config.profileKey.split(":")[0];

    // Codex (OpenAI subscription) authenticates with a JWT id_token, and the
    // gateway synthesizes ~/.codex/auth.json from `id` (falling back to
    // `access`). If neither is JWT-shaped, that synthesis produces an invalid
    // id_token and every request fails with "invalid ID token format" — reject
    // the save here so the failure surfaces at config time, not in the chat.
    const normalizedIdToken = typeof idToken === "string" ? idToken.trim() : "";
    const isJwtLike = (value: string) => value.split(".").length === 3;
    if (
      authMode === "subscription" &&
      ocProvider === "codex" &&
      !isJwtLike(normalizedIdToken || normalizedApiKey)
    ) {
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
    const shouldPromoteLocalToPrimary =
      isLocalScope && (!configStore.ai_model_configured || body.activate === true);
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
    // For Ollama the front-end supplies the model name (e.g. "llama3.2:3b")
    // via the `apiKey` field — there is no real API key for a local provider.
    if (isOllama) {
      const modelName = normalizedApiKey || "llama3.2:3b";
      config.defaultModel = `ollama/${modelName}`;
    } else if (isLlamaCpp) {
      const modelName = normalizedApiKey || getDefaultLlamaCppModel();
      config.defaultModel = `llamacpp/${modelName}`;
    } else if (isClawAI && resolvedClawboxTier) {
      config.defaultModel = CLAWBOX_AI_MODEL_BY_TIER[resolvedClawboxTier];
    } else if (
      authMode === "subscription"
      && ocProvider === "codex"
      && !(typeof bodyModel === "string" && bodyModel.trim())
    ) {
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
          config.defaultModel = `codex/${entitled}`;
        }
      } catch (err) {
        // Never let model selection break sign-in.
        console.warn("[configure] codex entitlement probe failed:", err);
      }
    } else if (typeof bodyModel === "string" && bodyModel.trim()) {
      // User picked a specific model in the wizard (curated list or
      // custom ID). Validate shape to stop empty strings / obvious typos
      // from silently saving a broken primary. We don't check against
      // the curated list — users can type newer model IDs we haven't
      // added yet.
      //
      // Provider namespace differs between auth modes:
      //   openai + token        → openai/<id>       (api.openai.com)
      //   openai + subscription → codex/<id>        (chatgpt.com backend)
      // The two catalogs are NOT the same — `gpt-5.4` only exists on
      // codex; `gpt-5` only exists on openai direct. The
      // `config.defaultModel` was already set to the correct namespace
      // above by applying subscriptionOverride, so we derive the
      // target provider from the existing default instead of `provider`.
      const requestedModel = bodyModel.trim();
      const targetProvider = config.defaultModel.split("/", 1)[0];
      const supportedProviders = new Set([
        "openrouter",
        "anthropic",
        "openai",
        "codex",
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
          await applyClawaiToHermes(clawboxAiToken, resolvedClawboxTier ?? CLAWBOX_AI_DEFAULT_TIER);
          return NextResponse.json({ success: true });
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
            return NextResponse.json({ success: true });
          }
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
          // Author-controlled, non-credential message — safe to echo.
          return NextResponse.json({ error: err.message }, { status: 502 });
        }
        throw err; // unexpected — fall to the outer catch, which classifies it
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
    //   * codex         → ChatGPT app-server auth (~/.codex/auth.json, written by gateway-pre-start.sh)
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
    // For now: keep the inline write but DO NOT add new fields here
    // without first checking the gateway's auth-profile schema. If
    // OpenClaw bumps the schema and we see profile-rejected errors in
    // production, the migration target is `openclaw onboard`.
    {
      const authProfiles = await readAuthProfiles();
      if (isClawAI) {
        // ClawBox AI uses the portal token generated by the user.
        authProfiles.profiles[config.profileKey] = {
          type: "api_key",
          provider: ocProvider,
          key: clawboxAiToken,
        };
      } else if (isOllama) {
        // Ollama runs locally — auth-profile key must match the per-install
        // bearer token the local-ai proxy validates (see src/lib/local-ai-token.ts).
        authProfiles.profiles[config.profileKey] = {
          type: "api_key",
          provider: ocProvider,
          key: getLocalAiToken(),
        };
        // Stamp the migration flag so legacy "ollama-local" / "llamacpp-local"
        // sentinels stop authenticating on this device — the new per-install
        // token is now the only valid credential.
        markLocalAiTokenMigrated();
      } else if (isLlamaCpp) {
        authProfiles.profiles[config.profileKey] = {
          type: "api_key",
          provider: ocProvider,
          key: getLocalAiToken(),
        };
        markLocalAiTokenMigrated();
      } else if (authMode === "subscription") {
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
      } else {
        // API-key providers (anthropic, openai, google, openrouter) authenticate
        // with a bearer key. OpenClaw <=2026.6.6 tolerated a `type: "token"`
        // profile here, but 2026.6.8 reworked auth resolution and no longer
        // turns a token-mode profile into an Authorization header — the request
        // goes out unauthenticated and the provider returns "401 Missing
        // Authentication header". Write the same `type: "api_key"` shape the
        // working providers above use (clawai/ollama/llamacpp) so the gateway
        // applies the key on every release.
        authProfiles.profiles[config.profileKey] = {
          type: "api_key",
          provider: ocProvider,
          key: normalizedApiKey,
        };
      }
      await writeAuthProfiles(authProfiles);
    }

    // 2. Validate profileKey before interpolating into config path
    if (!PROFILE_KEY_RE.test(config.profileKey)) {
      return NextResponse.json(
        { error: "Invalid profile key format" },
        { status: 400 }
      );
    }

    // 3. Set auth profile and primary model sequentially (parallel writes cause
    //    ConfigMutationConflictError because openclaw config set reads/writes the
    //    same file).
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      `auth.profiles.${config.profileKey}`,
      // Subscription → "oauth"; every key-based provider → "api_key". The old
      // "token" mode 401s on 2026.6.8+ (see the auth-profile write above).
      JSON.stringify(authMode === "subscription"
        ? { provider: ocProvider, mode: "oauth" }
        : { provider: ocProvider, mode: "api_key" }),
      "--json",
    ]);
    if (!isLocalScope || shouldPromoteLocalToPrimary) {
      await runCommand(OPENCLAW_BIN, [
        "config",
        "set",
        "agents.defaults.model.primary",
        config.defaultModel,
      ]);
      if (shouldPromoteLocalToPrimary) {
        console.log(`[AI Config] Promoted local model to active primary: ${logSafe(config.defaultModel)}`);
      }
    }
    // Reserve sized to the active model's context window. Local models run on
    // small windows (Ollama 32K) where the flat default leaves no room for the
    // agent's heavy system prompt + tools; cloud models (unbounded window)
    // fall through to the full default.
    const activeContextWindow = isOllama
      ? OLLAMA_CONTEXT_WINDOW
      : isLlamaCpp
        ? llamaCppContextWindow
        : Number.POSITIVE_INFINITY;
    const compactionReserveFloor = compactionReserveFloorForContext(activeContextWindow);
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "agents.defaults.compaction.reserveTokensFloor",
      `${compactionReserveFloor}`,
    ]);

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
    await runCommand(OPENCLAW_BIN, [
      "config", "set", "gateway.auth.mode", "token",
    ]);
    // A null result means the token is externally managed. Preserve the
    // SecretRef/interpolation instead of replacing it with plaintext.
    if (gatewayToken !== null) {
      await runCommand(OPENCLAW_BIN, [
        "config", "set", "gateway.auth.token", gatewayToken,
      ]);
    }
    await runCommand(OPENCLAW_BIN, [
      "config", "set", "gateway.controlUi.allowInsecureAuth", "true", "--json",
    ]);
    await runCommand(OPENCLAW_BIN, [
      "config", "set", "gateway.controlUi.dangerouslyDisableDeviceAuth", "true", "--json",
    ]);

    // 5. Ensure openclaw config files are owned by clawbox
    await Promise.all(
      ["openclaw.json", "openclaw.json.bak", "openclaw.json.bak.1", "openclaw.json.bak.2"]
        .map(name => fs.chown(path.join(OPENCLAW_HOME_DIR, name), CLAWBOX_UID, CLAWBOX_GID).catch(() => {}))
    );

    // 6. Persist to ClawBox config store. Re-uses `resolvedClawboxTier`
    // computed earlier so the value stored alongside the token always
    // matches the tier that drove `agents.defaults.model.primary` above.
    const clawboxAiTierForStore = resolvedClawboxTier;
    if (isLocalScope) {
      await setMany({
        local_ai_configured: true,
        local_ai_provider: ocProvider,
        local_ai_model: config.defaultModel,
        local_ai_configured_at: new Date().toISOString(),
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
      });
    }

    // 7. For ClawBox AI (DeepSeek) or Ollama, define a custom provider in openclaw.json
    // and set models.mode=replace so the gateway uses our definition.
    if (isClawAI) {
      await configureClawboxAi(false, clawboxAiToken);
      await runCommand(OPENCLAW_BIN, [
        "config", "set", "models.mode", "merge",
      ]);
      await ensureFallbackModel(config.defaultModel, undefined, clawboxAiToken);
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
      await runCommand(OPENCLAW_BIN, [
        "config", "set", "models.providers.ollama", providerDef, "--json",
      ]);
      await runCommand(OPENCLAW_BIN, [
        "config", "set", "models.mode", isLocalScope ? "merge" : "replace",
      ]);
      await ensureFallbackModel(shouldPromoteLocalToPrimary ? config.defaultModel : (isLocalScope ? null : config.defaultModel), config.defaultModel);
      // Ensure Ollama service has memory optimizations (q8_0 KV cache, flash attention)
      try {
        await runCommand("sudo", ["/home/clawbox/clawbox/scripts/optimize-ollama.sh"]);
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
      await runCommand(OPENCLAW_BIN, [
        "config", "set", "models.providers.llamacpp", providerDef, "--json",
      ]);
      await runCommand(OPENCLAW_BIN, [
        "config", "set", "models.mode", isLocalScope ? "merge" : "replace",
      ]);
      await ensureFallbackModel(shouldPromoteLocalToPrimary ? config.defaultModel : (isLocalScope ? null : config.defaultModel), config.defaultModel);
      console.log(`[AI Config] Set llama.cpp provider in openclaw.json: ${logSafe(modelName)} (context=${llamaCppContextWindow}, mode=replace)`);
    } else if (isOpenRouter) {
      // OpenRouter has no native OpenClaw adapter, so without this explicit
      // provider entry the chat turn silently returns usage 0/0/0.
      await writeOpenAICompatProvider({
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: normalizedApiKey,
        defaultModel: config.defaultModel,
        curatedModels: OPENROUTER_CURATED_MODELS,
      });
      console.log(`[AI Config] Set openrouter provider (openai-compat): ${logSafe(config.defaultModel)}`);
    } else if (isGoogle) {
      // Native google plugin registers Gemini models but its 2026.6.8 auth
      // fails at call time (runs fall back with reason=auth). Route through
      // Google's OpenAI-compat endpoint instead.
      await writeOpenAICompatProvider({
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: normalizedApiKey,
        defaultModel: config.defaultModel,
        curatedModels: GOOGLE_MODELS,
      });
      console.log(`[AI Config] Set google provider (openai-compat): ${logSafe(config.defaultModel)}`);
    } else if (isAnthropic) {
      // Native anthropic plugin reads a per-agent sqlite auth store that
      // ClawBox's file auth profile doesn't populate, so it fails with
      // "No API key found" at call time. Route through Anthropic's OpenAI-compat
      // endpoint with the key inline instead.
      await writeOpenAICompatProvider({
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: normalizedApiKey,
        defaultModel: config.defaultModel,
        curatedModels: ANTHROPIC_MODELS,
      });
      console.log(`[AI Config] Set anthropic provider (openai-compat): ${logSafe(config.defaultModel)}`);
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

    // 8b. Gate the anthropic plugin to only when the active primary provider
    //     actually needs it. The plugin's tool schemas otherwise add several
    //     seconds to every agent prep — see setProviderPlugins.
    if (!isLocalScope || shouldPromoteLocalToPrimary) {
      const primaryProvider = config.defaultModel.split("/", 1)[0];
      await setProviderPlugins(primaryProvider);
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
    //     `ocProvider` is the openclaw-side provider id (e.g. "anthropic",
    //     "openai", "codex", "google", "deepseek"). The catalog uses
    //     "clawai" for ClawBox AI rather than "deepseek", so map that case.
    //     Skip providers that aren't part of the catalog (local-only, llamacpp).
    const catalogProvider = ocProvider === "deepseek" ? "clawai" : ocProvider;
    if (isCatalogProvider(catalogProvider)) {
      refreshCatalogInBackground(catalogProvider);
    }

    // Codex 2026.6.x reads its ChatGPT session from the Codex CLI's own
    // ~/.codex/auth.json, which gateway-pre-start.sh synthesizes from this
    // OAuth profile (write-if-missing). On an explicit (re)login, clear the
    // stale file so the restart below regenerates it with the fresh token —
    // afterward the Codex app-server owns its own refresh, so we don't touch
    // it again.
    if (ocProvider === "codex") {
      await fs
        .rm(path.join(CLAWBOX_HOME_DIR, ".codex", "auth.json"), { force: true })
        .catch(() => {});
    }

    // 9. Restart OpenClaw gateway so it picks up the new auth profile and model
    try {
      await restartGateway();
    } catch (err) {
      console.error("[configure] Gateway restart failed after configuring", ocProvider, ":", err instanceof Error ? logSafe(err.message) : err);
      return NextResponse.json(
        { error: "AI model configured but gateway failed to restart. Try rebooting the device." },
        { status: 502 },
      );
    }

    // Configuration fully applied — now consume the OAuth handoff file (if any).
    // Deferring the unlink to here means a transient failure above returned
    // early with the file intact, so the client can retry within the TTL.
    if (pendingHandoffTokensPath) {
      await fs.unlink(pendingHandoffTokensPath).catch(() => {});
    }

    return NextResponse.json({ success: true });
  } catch (err) {
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
