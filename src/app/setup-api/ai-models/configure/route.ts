export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { getAll, setMany } from "@/lib/config-store";
import {
  restartGateway,
  findOpenclawBin,
  runOpenclawConfigSet,
  DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR,
  inferConfiguredLocalModel,
  readConfig as readOpenClawConfig,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
  setProviderPlugins,
} from "@/lib/openclaw-config";
import {
  getDefaultLlamaCppModel,
  getLlamaCppContextWindow,
  getLlamaCppMaxTokens,
  getLlamaCppProxyBaseUrl,
} from "@/lib/llamacpp";
import { getLocalAiProxyBaseUrl } from "@/lib/local-ai-runtime";
import { getOrGenerateGatewayToken } from "@/lib/gateway-proxy";
import {
  CLAWBOX_AI_PROVIDER,
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_PRO_MODEL_ID,
  CLAWBOX_AI_MODEL_BY_TIER,
  CLAWBOX_AI_DEFAULT_TIER,
  normalizeClawboxAiTier,
  type ClawboxAiTier,
} from "@/lib/clawbox-ai-models";
import { OPENROUTER_CURATED_MODELS, OPENROUTER_DEFAULT_MODEL_ID } from "@/lib/openrouter-models";
import { isValidModelId } from "@/lib/provider-models";

const OPENCLAW_BIN = findOpenclawBin();
const AUTH_PROFILES_PATH =
  "/home/clawbox/.openclaw/agents/main/agent/auth-profiles.json";
const CLAWBOX_UID = process.getuid?.() ?? 1000;
const CLAWBOX_GID = process.getgid?.() ?? 1000;
const CLAWBOX_AI_PROXY_URL = process.env.CLAWBOX_AI_PROXY_URL?.trim() || "https://openclawhardware.dev/api/ai";
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
      defaultModel: "openai-codex/gpt-5.4",
      profileKey: "openai-codex:default",
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
      cwd: "/home/clawbox",
      uid: CLAWBOX_UID,
      gid: CLAWBOX_GID,
      env: { ...process.env, HOME: "/home/clawbox" },
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
  } catch {
    return { version: 1, profiles: {} };
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

function buildClawboxAiProviderDefinition(apiKey: string) {
  // Only emit fields that override defaults: the proxy URL, our auth, and
  // per-tier identity/branding/reasoning. contextWindow, maxTokens, and
  // input modalities are intentionally omitted — OpenClaw's bundled
  // provider catalog (2026.4.24+) already knows the canonical V4 specs
  // (1M context, 384K output, text-in/text-out), so duplicating them
  // here just creates drift the next time DeepSeek bumps a number.
  // `cost` stays zero to mark these as included-in-subscription so the
  // gateway doesn't surface DeepSeek's real per-token prices in the UI.
  return JSON.stringify({
    baseUrl: CLAWBOX_AI_PROXY_URL,
    api: "openai-completions",
    apiKey,
    // `reasoning: true` on both entries is what tells the OpenClaw
    // gateway to forward `reasoning_effort` (and `thinking: { type:
    // "disabled" }` for off) to DeepSeek. Both V4 surfaces are
    // thinking-capable per OpenClaw's built-in catalog; flipping
    // either to false silently makes the chat's Effort picker a no-op.
    //
    // `compat.supportedReasoningEfforts: ["high", "xhigh"]` is what
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
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["high", "xhigh"],
        },
      },
      {
        id: CLAWBOX_AI_PRO_MODEL_ID,
        name: "ClawBox AI Pro",
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["high", "xhigh"],
        },
      },
    ],
  });
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
    console.log(`[AI Config] Configured local fallback model: ${fallbackCandidates[0]}`);
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
    console.warn("[AI Config] Failed to configure fallback model:", err instanceof Error ? err.message : err);
  }
}

export async function POST(request: Request) {
  try {
    let body: {
      provider?: string;
      apiKey?: string;
      authMode?: string;
      refreshToken?: string;
      expiresIn?: number;
      projectId?: string;
      scope?: ConfigureScope;
      clawaiTier?: string;
      model?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { provider, apiKey, authMode = "token", refreshToken, expiresIn, projectId, scope = "primary", model: bodyModel } = body;
    const requestedClawboxAiTier = normalizeClawboxAiTier(body.clawaiTier);
    const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
    const isOllama = provider === "ollama";
    const isLlamaCpp = provider === "llamacpp";
    const isClawAI = provider === "clawai";
    const isOpenRouter = provider === "openrouter";
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
    const configStore = await getAll().catch(() => ({} as Awaited<ReturnType<typeof getAll>>));
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
    const shouldPromoteLocalToPrimary = isLocalScope && !configStore.ai_model_configured;
    // Resolve the ClawBox AI tier once and reuse it for both the primary
    // model selection (below) and the config-store write (further down).
    // Inlining the same `?? storedTier ?? DEFAULT_TIER` chain in two
    // places previously let the two sites drift on a half-applied edit;
    // a single source of truth keeps them in lockstep.
    const resolvedClawboxTier: ClawboxAiTier | null = isClawAI
      ? (requestedClawboxAiTier
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
    } else if (typeof bodyModel === "string" && bodyModel.trim()) {
      // User picked a specific model in the wizard (curated list or
      // custom ID). Validate shape to stop empty strings / obvious typos
      // from silently saving a broken primary. We don't check against
      // the curated list — users can type newer model IDs we haven't
      // added yet.
      //
      // Provider namespace differs between auth modes:
      //   openai + token        → openai/<id>       (api.openai.com)
      //   openai + subscription → openai-codex/<id> (chatgpt.com backend)
      // The two catalogs are NOT the same — `gpt-5.4` only exists on
      // openai-codex; `gpt-5` only exists on openai direct. The
      // `config.defaultModel` was already set to the correct namespace
      // above by applying subscriptionOverride, so we derive the
      // target provider from the existing default instead of `provider`.
      const requestedModel = bodyModel.trim();
      const targetProvider = config.defaultModel.split("/", 1)[0];
      const supportedProviders = new Set([
        "openrouter",
        "anthropic",
        "openai",
        "openai-codex",
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
    //   * openai-codex  → --auth-choice openai-codex (OAuth flow)
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
        // Ollama runs locally — use a dummy api_key entry
        authProfiles.profiles[config.profileKey] = {
          type: "api_key",
          provider: ocProvider,
          key: "ollama-local",
        };
      } else if (isLlamaCpp) {
        authProfiles.profiles[config.profileKey] = {
          type: "api_key",
          provider: ocProvider,
          key: "llamacpp-local",
        };
      } else if (authMode === "subscription") {
        // OAuth credential format expected by OpenClaw:
        // { type: "oauth", provider, access, refresh, expires, projectId? }
        authProfiles.profiles[config.profileKey] = {
          type: "oauth",
          provider: ocProvider,
          access: normalizedApiKey,
          refresh: refreshToken || "",
          expires: expiresIn
            ? Date.now() + expiresIn * 1000
            : Date.now() + 8 * 60 * 60 * 1000, // default 8h
          ...(projectId ? { projectId } : {}),
        };
      } else {
        authProfiles.profiles[config.profileKey] = {
          type: "token",
          provider: ocProvider,
          token: normalizedApiKey,
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
      JSON.stringify((isOllama || isLlamaCpp || isClawAI)
        ? { provider: ocProvider, mode: "api_key" }
        : { provider: ocProvider, mode: authMode === "subscription" ? "oauth" : "token" }),
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
        console.log(`[AI Config] Promoted local model to active primary: ${config.defaultModel}`);
      }
    }
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "agents.defaults.compaction.reserveTokensFloor",
      `${DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR}`,
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
    await runCommand(OPENCLAW_BIN, [
      "config", "set", "gateway.auth.token", gatewayToken,
    ]);
    await runCommand(OPENCLAW_BIN, [
      "config", "set", "gateway.controlUi.allowInsecureAuth", "true", "--json",
    ]);
    await runCommand(OPENCLAW_BIN, [
      "config", "set", "gateway.controlUi.dangerouslyDisableDeviceAuth", "true", "--json",
    ]);

    // 5. Ensure openclaw config files are owned by clawbox
    await Promise.all(
      ["openclaw.json", "openclaw.json.bak", "openclaw.json.bak.1", "openclaw.json.bak.2"]
        .map(name => fs.chown(path.join("/home/clawbox/.openclaw", name), CLAWBOX_UID, CLAWBOX_GID).catch(() => {}))
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
    } else if (isOllama) {
      const modelName = config.defaultModel.replace(/^ollama\//, "");
      const providerDef = JSON.stringify({
        baseUrl: getLocalAiProxyBaseUrl("ollama"),
        api: "ollama",
        apiKey: "ollama-local",
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
        console.warn("[AI Config] Failed to optimize Ollama service:", err instanceof Error ? err.message : err);
      }
      console.log(`[AI Config] Set ollama provider in openclaw.json: ${modelName} (context=${OLLAMA_CONTEXT_WINDOW}, mode=replace)`);
    } else if (isLlamaCpp) {
      const modelName = config.defaultModel.replace(/^llamacpp\//, "");
      const providerDef = JSON.stringify({
        baseUrl: getLlamaCppProxyBaseUrl(),
        api: "openai-completions",
        apiKey: "llamacpp-local",
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
      console.log(`[AI Config] Set llama.cpp provider in openclaw.json: ${modelName} (context=${llamaCppContextWindow}, mode=replace)`);
    } else if (isOpenRouter) {
      // OpenClaw has no built-in provider adapter for OpenRouter the way it
      // does for openai / anthropic / google, so without this explicit
      // provider definition the runtime has no baseUrl to call — the chat
      // turn silently returns `usage: 0/0/0` and the UI appears dead.
      // Writing this entry restores the full OpenAI-compatible path.
      //
      // The `models` array drives model resolution: OpenClaw needs every
      // selectable id present here, otherwise mid-conversation switches
      // (curated or custom) fail silently because the runtime can't
      // resolve the new slug. We seed with the user-picked id plus a
      // tiny static fallback (cold-start coverage). The chat-header
      // model switch in /setup-api/chat/model auto-extends this array
      // when the user picks a model that isn't already in it, so we
      // don't need to bake in OpenRouter's full 340+ catalogue at save
      // time — that catalogue churns and the seed-everything strategy
      // bit us four times during the original PR.
      //
      // We intentionally emit only `id` + `name`. contextWindow,
      // maxTokens, input modalities and cost are looked up from
      // OpenClaw's bundled provider catalog per model id — the previous
      // uniform 131K/8K caps lied for every model whose real spec
      // differed (Kimi K2 256K, GPT-5 400K, Claude Haiku 200K, etc.),
      // triggering compaction far too early and silently truncating
      // long outputs on capable models.
      const defaultModelId = config.defaultModel.replace(/^openrouter\//, "");
      const modelIds = new Set<string>([
        defaultModelId,
        ...OPENROUTER_CURATED_MODELS.map((option) => option.id),
      ]);
      const providerDef = JSON.stringify({
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        apiKey: "openrouter-ref",
        models: Array.from(modelIds).map((id) => ({ id, name: id })),
      });
      await runCommand(OPENCLAW_BIN, [
        "config", "set", "models.providers.openrouter", providerDef, "--json",
      ]);
      try {
        await runCommand(OPENCLAW_BIN, [
          "config", "set", "models.mode", "merge",
        ]);
      } catch {
        // Non-fatal: merge is the default behavior anyway
      }
      await ensureFallbackModel(config.defaultModel);
      console.log(`[AI Config] Set openrouter provider in openclaw.json: default=${defaultModelId}`);
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
    //    Without this, a session that was bound to e.g. openai-codex
    //    keeps routing to openai-codex even after the user changes the
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

    // 9. Restart OpenClaw gateway so it picks up the new auth profile and model
    try {
      await restartGateway();
    } catch (err) {
      console.error("[configure] Gateway restart failed after configuring", ocProvider, ":", err instanceof Error ? err.message : err);
      return NextResponse.json(
        { error: "AI model configured but gateway failed to restart. Try rebooting the device." },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to configure AI model",
      },
      { status: 500 }
    );
  }
}
