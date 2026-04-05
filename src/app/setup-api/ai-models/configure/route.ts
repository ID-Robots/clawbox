export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { setMany } from "@/lib/config-store";
import { restartGateway, findOpenclawBin } from "@/lib/openclaw-config";

const OPENCLAW_BIN = findOpenclawBin();
const AUTH_PROFILES_PATH =
  "/home/clawbox/.openclaw/agents/main/agent/auth-profiles.json";
const CLAWBOX_UID = process.getuid?.() ?? 1000;
const CLAWBOX_GID = process.getgid?.() ?? 1000;

// Ollama pre-allocates KV cache for the full context window. The default 128K
// context would need ~12.5 GB on a 3B model, exceeding the Jetson's 8 GB.
// OpenClaw requires minimum 16K context. At Q4_K_M this uses ~3.5-4 GB total.
// We define the model in openclaw.json with a capped contextWindow so the
// gateway generates models.json with the correct value on every restart.
const OLLAMA_CONTEXT_WINDOW = 16384;
const OLLAMA_MAX_TOKENS = 8192;

const CLAWAI_API_KEY = "sk-d79a8071b0634ff7a809b1abe3d963f3";
const CLAWAI_CONTEXT_WINDOW = 65536;
const CLAWAI_MAX_TOKENS = 8192;

interface ProviderConfig {
  defaultModel: string;
  profileKey: string;
  /** Override config used when authMode is "subscription" (OAuth). */
  subscriptionOverride?: { defaultModel: string; profileKey?: string };
}

const PROVIDERS: Record<string, ProviderConfig> = {
  clawai: {
    defaultModel: "deepseek/deepseek-chat",
    profileKey: "deepseek:default",
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
    defaultModel: "openrouter/moonshotai/kimi-k2.5",
    profileKey: "openrouter:default",
  },
  ollama: {
    defaultModel: "ollama/llama3.2:3b",
    profileKey: "ollama:default",
  },
};

const PROFILE_KEY_RE = /^[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)*$/;
const COMMAND_TIMEOUT_MS = 30_000;

function runCommand(cmd: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<void> {
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

export async function POST(request: Request) {
  try {
    let body: {
      provider?: string;
      apiKey?: string;
      authMode?: string;
      refreshToken?: string;
      expiresIn?: number;
      projectId?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { provider, apiKey, authMode = "token", refreshToken, expiresIn, projectId } = body;
    const isOllama = provider === "ollama";
    const isClawAI = provider === "clawai";
    if (!provider || (!apiKey && !isOllama && !isClawAI)) {
      return NextResponse.json(
        { error: "Provider is required; API key required for non-local providers" },
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
    const ocProvider = config.profileKey.split(":")[0];

    // For Ollama the front-end supplies the model name (e.g. "llama3.2:3b")
    // via the `apiKey` field — there is no real API key for a local provider.
    if (isOllama) {
      const modelName = apiKey || "llama3.2:3b";
      config.defaultModel = `ollama/${modelName}`;
    }

    // 1. Write token to auth-profiles.json
    {
      let authProfiles: {
        version: number;
        profiles: Record<string, unknown>;
      };
      try {
        const raw = await fs.readFile(AUTH_PROFILES_PATH, "utf-8");
        authProfiles = JSON.parse(raw);
      } catch {
        authProfiles = { version: 1, profiles: {} };
      }
      if (isClawAI) {
        // ClawBox AI uses a pre-configured DeepSeek API key
        authProfiles.profiles[config.profileKey] = {
          type: "api_key",
          provider: ocProvider,
          key: CLAWAI_API_KEY,
        };
      } else if (isOllama) {
        // Ollama runs locally — use a dummy api_key entry
        authProfiles.profiles[config.profileKey] = {
          type: "api_key",
          provider: ocProvider,
          key: "ollama-local",
        };
      } else if (authMode === "subscription") {
        // OAuth credential format expected by OpenClaw:
        // { type: "oauth", provider, access, refresh, expires, projectId? }
        authProfiles.profiles[config.profileKey] = {
          type: "oauth",
          provider: ocProvider,
          access: apiKey,
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
          token: apiKey,
        };
      }
      await fs.mkdir(path.dirname(AUTH_PROFILES_PATH), { recursive: true });
      const tmpPath = AUTH_PROFILES_PATH + `.tmp.${Date.now()}.${process.pid}`;
      await fs.writeFile(tmpPath, JSON.stringify(authProfiles, null, 2), {
        mode: 0o600,
      });
      await fs.rename(tmpPath, AUTH_PROFILES_PATH);
      // Fix ownership so the gateway (running as clawbox) can read it
      await fs.chown(AUTH_PROFILES_PATH, CLAWBOX_UID, CLAWBOX_GID);
    }

    // 2. Validate profileKey before interpolating into config path
    if (!PROFILE_KEY_RE.test(config.profileKey)) {
      return NextResponse.json(
        { error: "Invalid profile key format" },
        { status: 400 }
      );
    }

    // 3. Set auth profile and primary model in parallel
    await Promise.all([
      runCommand(OPENCLAW_BIN, [
        "config",
        "set",
        `auth.profiles.${config.profileKey}`,
        JSON.stringify((isOllama || isClawAI)
          ? { provider: ocProvider, mode: "api_key" }
          : { provider: ocProvider, mode: authMode === "subscription" ? "oauth" : "token" }),
        "--json",
      ]),
      runCommand(OPENCLAW_BIN, [
        "config",
        "set",
        "agents.defaults.model.primary",
        config.defaultModel,
      ]),
    ]);

    // 4c. Local device gateway setup: disable gateway auth (no HTTPS for browser
    // token exchange) and disable device identity checks (no secure context for
    // browser crypto key-pair). The gateway is only reachable via local proxy.
    console.log(`[AI Config] Configuring gateway for local access (provider: ${provider})`);
    await Promise.all([
      runCommand(OPENCLAW_BIN, [
        "config", "set", "gateway.auth.mode", "none",
      ]),
      runCommand(OPENCLAW_BIN, [
        "config", "set", "gateway.controlUi.allowInsecureAuth", "true", "--json",
      ]),
      runCommand(OPENCLAW_BIN, [
        "config", "set", "gateway.controlUi.dangerouslyDisableDeviceAuth", "true", "--json",
      ]),
    ]);

    // 5. Ensure openclaw config files are owned by clawbox
    await Promise.all(
      ["openclaw.json", "openclaw.json.bak", "openclaw.json.bak.1", "openclaw.json.bak.2"]
        .map(name => fs.chown(path.join("/home/clawbox/.openclaw", name), CLAWBOX_UID, CLAWBOX_GID).catch(() => {}))
    );

    // 6. Persist to ClawBox config store
    await setMany({
      ai_model_configured: true,
      ai_model_provider: ocProvider,
      ai_model_configured_at: new Date().toISOString(),
    });

    // 7. For ClawBox AI (DeepSeek) or Ollama, define a custom provider in openclaw.json
    // and set models.mode=replace so the gateway uses our definition.
    if (isClawAI) {
      const providerDef = JSON.stringify({
        baseUrl: "https://api.deepseek.com",
        api: "openai-completions",
        apiKey: CLAWAI_API_KEY,
        models: [{
          id: "deepseek-chat",
          name: "DeepSeek V3",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: CLAWAI_CONTEXT_WINDOW,
          maxTokens: CLAWAI_MAX_TOKENS,
        }],
      });
      await Promise.all([
        runCommand(OPENCLAW_BIN, [
          "config", "set", "models.providers.deepseek", providerDef, "--json",
        ]),
        runCommand(OPENCLAW_BIN, [
          "config", "set", "models.mode", "replace",
        ]),
      ]);
      console.log(`[AI Config] Set ClawBox AI (DeepSeek) provider in openclaw.json (context=${CLAWAI_CONTEXT_WINDOW}, mode=replace)`);
    } else if (isOllama) {
      const modelName = config.defaultModel.replace(/^ollama\//, "");
      const providerDef = JSON.stringify({
        baseUrl: "http://127.0.0.1:11434",
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
      await Promise.all([
        runCommand(OPENCLAW_BIN, [
          "config", "set", "models.providers.ollama", providerDef, "--json",
        ]),
        runCommand(OPENCLAW_BIN, [
          "config", "set", "models.mode", "replace",
        ]),
      ]);
      // Ensure Ollama service has memory optimizations (q8_0 KV cache, flash attention)
      try {
        await runCommand("sudo", ["/home/clawbox/clawbox/scripts/optimize-ollama.sh"]);
      } catch (err) {
        // Non-fatal: Ollama will still work, just use more memory
        console.warn("[AI Config] Failed to optimize Ollama service:", err instanceof Error ? err.message : err);
      }
      console.log(`[AI Config] Set ollama provider in openclaw.json: ${modelName} (context=${OLLAMA_CONTEXT_WINDOW}, mode=replace)`);
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

      // Always configure ClawBox AI (DeepSeek) as backup provider alongside
      // the primary, so the agent has a fallback if the primary provider fails.
      try {
        // Add DeepSeek backup to the auth-profiles file
        const rawProfiles = await fs.readFile(AUTH_PROFILES_PATH, "utf-8").catch(() => '{"version":1,"profiles":{}}');
        const profiles = JSON.parse(rawProfiles);
        profiles.profiles["deepseek:default"] = { type: "api_key", provider: "deepseek", key: CLAWAI_API_KEY };
        await fs.writeFile(AUTH_PROFILES_PATH, JSON.stringify(profiles, null, 2));
        await fs.chown(AUTH_PROFILES_PATH, CLAWBOX_UID, CLAWBOX_GID);
        await runCommand(OPENCLAW_BIN, [
          "config", "set", "auth.profiles.deepseek:default",
          JSON.stringify({ provider: "deepseek", mode: "api_key" }),
          "--json",
        ]);
        console.log("[AI Config] Configured ClawBox AI (DeepSeek) as backup provider");
      } catch (err) {
        // Non-fatal: backup is a nice-to-have
        console.warn("[AI Config] Failed to configure backup provider:", err instanceof Error ? err.message : err);
      }
    }

    // 8. Restart OpenClaw gateway so it picks up the new auth profile and model
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
