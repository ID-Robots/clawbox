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
} from "@/lib/openclaw-config";
import {
  getDefaultLlamaCppModel,
  getLlamaCppContextWindow,
  getLlamaCppMaxTokens,
  getLlamaCppProxyBaseUrl,
} from "@/lib/llamacpp";
import { getLocalAiProxyBaseUrl } from "@/lib/local-ai-runtime";

const OPENCLAW_BIN = findOpenclawBin();
const AUTH_PROFILES_PATH =
  "/home/clawbox/.openclaw/agents/main/agent/auth-profiles.json";
const CLAWBOX_UID = process.getuid?.() ?? 1000;
const CLAWBOX_GID = process.getgid?.() ?? 1000;
const CLAWBOX_AI_PROXY_URL = process.env.CLAWBOX_AI_PROXY_URL?.trim() || "https://openclawhardware.dev/api/ai";
const CLAWBOX_AI_TOKEN_CONFIG_KEY = "clawai_token";
const CLAWBOX_AI_PROFILE_KEY = "deepseek:default";
const CLAWBOX_AI_PROVIDER = "deepseek";
const CLAWBOX_AI_MODEL = "deepseek/deepseek-chat";

// Ollama pre-allocates KV cache for the full context window. The default 128K
// context would need ~12.5 GB, exceeding the Jetson's 8 GB RAM.
// 32K is the practical max — fits in RAM+swap without excessive thrashing.
// We define the model in openclaw.json with a capped contextWindow so the
// gateway generates models.json with the correct value on every restart.
const OLLAMA_CONTEXT_WINDOW = 32768;
const OLLAMA_MAX_TOKENS = 8192;

const CLAWBOX_AI_CONTEXT_WINDOW = 65536;
const CLAWBOX_AI_MAX_TOKENS = 8192;

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
    defaultModel: "openai/gpt-5.4",
    profileKey: "openai:default",
    subscriptionOverride: {
      defaultModel: "openai-codex/gpt-5.4",
      profileKey: "openai-codex:default",
    },
  },
  google: {
    defaultModel: "google/gemini-2.0-flash",
    profileKey: "google:default",
  },
  openrouter: {
    defaultModel: "openrouter/moonshotai/kimi-k2-0905",
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
  return JSON.stringify({
    baseUrl: CLAWBOX_AI_PROXY_URL,
    api: "openai-completions",
    apiKey,
    models: [{
      id: "deepseek-chat",
      name: "ClawBox AI",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CLAWBOX_AI_CONTEXT_WINDOW,
      maxTokens: CLAWBOX_AI_MAX_TOKENS,
    }],
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
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { provider, apiKey, authMode = "token", refreshToken, expiresIn, projectId, scope = "primary" } = body;
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
    // For Ollama the front-end supplies the model name (e.g. "llama3.2:3b")
    // via the `apiKey` field — there is no real API key for a local provider.
    if (isOllama) {
      const modelName = normalizedApiKey || "llama3.2:3b";
      config.defaultModel = `ollama/${modelName}`;
    } else if (isLlamaCpp) {
      const modelName = normalizedApiKey || getDefaultLlamaCppModel();
      config.defaultModel = `llamacpp/${modelName}`;
    }

    // 1. Write token to auth-profiles.json
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
    console.log(`[AI Config] Configuring gateway for local access (provider: ${provider})`);
    await runCommand(OPENCLAW_BIN, [
      "config", "set", "gateway.auth.mode", "token",
    ]);
    await runCommand(OPENCLAW_BIN, [
      "config", "set", "gateway.auth.token", "clawbox",
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

    // 6. Persist to ClawBox config store
    if (isLocalScope) {
      await setMany({
        local_ai_configured: true,
        local_ai_provider: ocProvider,
        local_ai_model: config.defaultModel,
        local_ai_configured_at: new Date().toISOString(),
        ...(isClawAI ? { [CLAWBOX_AI_TOKEN_CONFIG_KEY]: clawboxAiToken } : {}),
      });
    } else {
      await setMany({
        ai_model_configured: true,
        ai_model_provider: ocProvider,
        ai_model_configured_at: new Date().toISOString(),
        ...(isClawAI ? { [CLAWBOX_AI_TOKEN_CONFIG_KEY]: clawboxAiToken } : {}),
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
      console.log(`[AI Config] Set ClawBox AI provider in openclaw.json via proxy ${CLAWBOX_AI_PROXY_URL} (context=${CLAWBOX_AI_CONTEXT_WINDOW})`);
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
      // The `models` array is used for UI enumeration only; OpenClaw
      // routes any `openrouter/<slug>` string through the same baseUrl, so
      // listing just the default is enough to make every OpenRouter model
      // reachable via `agents.defaults.model.primary`.
      const defaultModelId = config.defaultModel.replace(/^openrouter\//, "");
      const providerDef = JSON.stringify({
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        apiKey: "openrouter-ref",
        models: [{
          id: defaultModelId,
          name: defaultModelId,
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
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
