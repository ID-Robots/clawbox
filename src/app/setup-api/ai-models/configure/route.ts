export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { setMany } from "@/lib/config-store";
import { restartGateway } from "@/lib/openclaw-config";

const OPENCLAW_BIN = "/home/clawbox/.npm-global/bin/openclaw";
const AUTH_PROFILES_PATH =
  "/home/clawbox/.openclaw/agents/main/agent/auth-profiles.json";
const CLAWBOX_UID = process.getuid?.() ?? 1000;
const CLAWBOX_GID = process.getgid?.() ?? 1000;

const MODELS_JSON_PATH =
  "/home/clawbox/.openclaw/agents/main/agent/models.json";

// Ollama pre-allocates KV cache for the full context window. The default 128K
// context would need ~12.5 GB on a 3B model, exceeding the Jetson's 8 GB.
// We patch models.json after gateway restart to cap the context window.
const OLLAMA_CONTEXT_WINDOW = 8192;
const OLLAMA_MAX_TOKENS = 4096;

interface ProviderConfig {
  defaultModel: string;
  profileKey: string;
  /** Override config used when authMode is "subscription" (OAuth). */
  subscriptionOverride?: { defaultModel: string; profileKey: string };
}

const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    defaultModel: "anthropic/claude-sonnet-4-5-20250929",
    profileKey: "anthropic:default",
  },
  openai: {
    defaultModel: "openai/gpt-4o",
    profileKey: "openai:default",
    subscriptionOverride: {
      defaultModel: "openai-codex/gpt-5.3-codex",
      profileKey: "openai-codex:default",
    },
  },
  google: {
    defaultModel: "google/gemini-2.0-flash",
    profileKey: "google:default",
    subscriptionOverride: {
      defaultModel: "google-gemini-cli/gemini-2.5-flash",
      profileKey: "google-gemini-cli:default",
    },
  },
  openrouter: {
    defaultModel: "openrouter/anthropic/claude-sonnet-4.5",
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
    if (!provider || (!apiKey && !isOllama)) {
      return NextResponse.json(
        { error: "Provider is required; API key required for non-Ollama providers" },
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
      ? { ...baseConfig.subscriptionOverride }
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
      if (isOllama) {
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

    // 3. Set auth profile in main config
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      `auth.profiles.${config.profileKey}`,
      JSON.stringify(isOllama
        ? { provider: ocProvider, mode: "api_key" }
        : { provider: ocProvider, mode: authMode === "subscription" ? "oauth" : "token" }),
      "--json",
    ]);

    // 4. Set primary model
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "agents.defaults.model.primary",
      config.defaultModel,
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

    // 7. Restart OpenClaw gateway so it picks up the new auth profile and model
    try {
      await restartGateway();
    } catch (err) {
      console.error("[configure] Gateway restart failed after configuring", ocProvider, ":", err instanceof Error ? err.message : err);
      return NextResponse.json(
        { error: "AI model configured but gateway failed to restart. Try rebooting the device." },
        { status: 502 },
      );
    }

    // 8. For Ollama, patch models.json to cap contextWindow. OpenClaw passes
    // the model's native context length (128K) as num_ctx to Ollama, which
    // pre-allocates KV cache for it — exceeding the Jetson's 8GB RAM.
    // We patch after gateway restart so we overwrite any auto-generated values.
    if (isOllama) {
      try {
        const raw = await fs.readFile(MODELS_JSON_PATH, "utf-8");
        const modelsConfig = JSON.parse(raw);
        let patched = false;
        for (const prov of Object.values(modelsConfig.providers ?? {}) as Array<{ models?: Array<{ contextWindow?: number; maxTokens?: number }> }>) {
          for (const m of prov.models ?? []) {
            if ((m.contextWindow ?? 0) > OLLAMA_CONTEXT_WINDOW) {
              m.contextWindow = OLLAMA_CONTEXT_WINDOW;
              m.maxTokens = OLLAMA_MAX_TOKENS;
              patched = true;
            }
          }
        }
        if (patched) {
          const tmp = MODELS_JSON_PATH + `.tmp.${Date.now()}`;
          await fs.writeFile(tmp, JSON.stringify(modelsConfig, null, 2), { mode: 0o600 });
          await fs.rename(tmp, MODELS_JSON_PATH);
          await fs.chown(MODELS_JSON_PATH, CLAWBOX_UID, CLAWBOX_GID);
          console.log(`[AI Config] Patched models.json contextWindow to ${OLLAMA_CONTEXT_WINDOW}`);
        }
      } catch (err) {
        console.warn("[AI Config] Failed to patch models.json:", err instanceof Error ? err.message : err);
      }
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
