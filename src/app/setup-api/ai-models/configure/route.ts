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
    if (!provider || !apiKey) {
      return NextResponse.json(
        { error: "Provider and API key are required" },
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
      ? baseConfig.subscriptionOverride
      : baseConfig;
    const ocProvider = config.profileKey.split(":")[0];

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
    if (authMode === "subscription") {
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
      JSON.stringify({ provider: ocProvider, mode: authMode === "subscription" ? "oauth" : "token" }),
      "--json",
    ]);

    // 4. Set primary model
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "agents.defaults.model.primary",
      config.defaultModel,
    ]);

    // 4b. Allow insecure auth for control UI (needed for HTTP proxy from Next.js on local device)
    if (process.env.ALLOW_INSECURE_CONTROL_UI === "true") {
      await runCommand(OPENCLAW_BIN, [
        "config",
        "set",
        "gateway.controlUi.allowInsecureAuth",
        "true",
        "--json",
      ]);
    }

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
