export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { set } from "@/lib/config-store";

const OPENCLAW_BIN = "/home/clawbox/.npm-global/bin/openclaw";
const AUTH_PROFILES_PATH =
  "/home/clawbox/.openclaw/agents/main/agent/auth-profiles.json";
const CLAWBOX_UID = 1000; // clawbox user

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

const PROFILE_KEY_RE = /^[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)*$/;
const COMMAND_TIMEOUT_MS = 30_000;

function runCommand(cmd: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/home/clawbox",
      uid: CLAWBOX_UID,
      gid: CLAWBOX_UID,
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
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { provider, apiKey, authMode = "token", refreshToken, expiresIn } = body;
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
    if (authMode === "subscription") {
      // OAuth credential format expected by OpenClaw:
      // { type: "oauth", provider, access, refresh, expires }
      authProfiles.profiles[config.profileKey] = {
        type: "oauth",
        provider,
        access: apiKey,
        refresh: refreshToken || "",
        expires: expiresIn
          ? Date.now() + expiresIn * 1000
          : Date.now() + 8 * 60 * 60 * 1000, // default 8h
      };
    } else {
      authProfiles.profiles[config.profileKey] = {
        type: "token",
        provider,
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
    await fs.chown(AUTH_PROFILES_PATH, CLAWBOX_UID, CLAWBOX_UID);

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
      JSON.stringify({ provider, mode: authMode === "subscription" ? "oauth" : "token" }),
      "--json",
    ]);

    // 4. Set primary model
    await runCommand(OPENCLAW_BIN, [
      "config",
      "set",
      "agents.defaults.model.primary",
      config.defaultModel,
    ]);

    // 5. Ensure openclaw config files are owned by clawbox
    for (const name of ["openclaw.json", "openclaw.json.bak", "openclaw.json.bak.1", "openclaw.json.bak.2"]) {
      await fs.chown(path.join("/home/clawbox/.openclaw", name), CLAWBOX_UID, CLAWBOX_UID).catch(() => {});
    }

    // 6. Persist to ClawBox config store
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
