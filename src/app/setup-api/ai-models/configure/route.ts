import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { set } from "@/lib/config-store";

const OPENCLAW_BIN = "/home/clawbox/.npm-global/bin/openclaw";
const AUTH_PROFILES_PATH =
  "/home/clawbox/.openclaw/agents/main/agent/auth-profiles.json";

interface ProviderConfig {
  defaultModel: string;
  profileKey: string;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    defaultModel: "anthropic/claude-sonnet-4-5-20250929",
    profileKey: "anthropic:default",
  },
  openai: {
    defaultModel: "openai/gpt-4o",
    profileKey: "openai:default",
  },
  google: {
    defaultModel: "google/gemini-2.0-flash",
    profileKey: "google:default",
  },
  openrouter: {
    defaultModel: "openrouter/anthropic/claude-sonnet-4-5",
    profileKey: "openrouter:default",
  },
};

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(stderr.trim() || `${cmd} exited with code ${code}`)
        );
    });
    child.stdin.end();
  });
}

export async function POST(request: Request) {
  try {
    let body: { provider?: string; apiKey?: string; authMode?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { provider, apiKey, authMode = "token" } = body;
    if (!provider || !apiKey) {
      return NextResponse.json(
        { error: "Provider and API key are required" },
        { status: 400 }
      );
    }

    const config = PROVIDERS[provider];
    if (!config) {
      return NextResponse.json(
        { error: `Unknown provider: ${provider}` },
        { status: 400 }
      );
    }

    // 1. Write token to auth-profiles.json
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
    const tokenType = authMode === "subscription" ? "setup-token" : "token";
    authProfiles.profiles[config.profileKey] = {
      type: tokenType,
      provider,
      token: apiKey,
    };
    await fs.mkdir(path.dirname(AUTH_PROFILES_PATH), { recursive: true });
    const tmpPath = AUTH_PROFILES_PATH + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(authProfiles, null, 2), {
      mode: 0o600,
    });
    await fs.rename(tmpPath, AUTH_PROFILES_PATH);

    // 2. Set auth profile in main config
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      `auth.profiles.${config.profileKey}`,
      JSON.stringify({ provider, mode: tokenType }),
      "--json",
    ]);

    // 3. Set primary model
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "agents.defaults.model.primary",
      config.defaultModel,
    ]);

    // 4. Persist to ClawBox config store
    await set("ai_model_configured", true);
    await set("ai_model_provider", provider);
    await set("ai_model_configured_at", new Date().toISOString());

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
