export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";
import { runHermesCli } from "@/lib/hermes-cli";
import { getActiveHarness } from "@/lib/harness";
import {
  CLAWBOX_AI_FLASH_MODEL_ID,
  CLAWBOX_AI_PRO_MODEL_ID,
  normalizeClawboxAiTier,
  type ClawboxAiTier,
} from "@/lib/clawbox-ai-models";

// ClawBox AI runs THROUGH Hermes. It's an OpenAI-compatible proxy, so we point a
// Hermes custom provider ("clawai") at it with the device token — only the
// device-login that mints the token is ClawBox-custom; inference is
// Hermes-native (same base_url mechanism as any other provider). Verified
// on-device: this config yields a real ClawBox AI (deepseek) response.
const CLAWBOX_AI_PROXY_URL =
  process.env.CLAWBOX_AI_PROXY_URL?.trim() || "https://clawbox.com/api/ai";
const CLAWAI_PROVIDER = "clawai";

// BARE model id (no `deepseek/` vendor prefix) — the proxy returns
// "HTTP 400: Model not allowed" for a prefixed slug.
function modelForTier(tier: ClawboxAiTier): string {
  return tier === "pro" ? CLAWBOX_AI_PRO_MODEL_ID : CLAWBOX_AI_FLASH_MODEL_ID;
}

async function readToken(): Promise<string> {
  const t = await get("clawai_token");
  return typeof t === "string" ? t.trim() : "";
}
async function readTier(): Promise<ClawboxAiTier> {
  return normalizeClawboxAiTier(await get("clawai_tier")) ?? "flash";
}

async function requireHermes(): Promise<NextResponse | null> {
  if ((await getActiveHarness()) !== "hermes") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

// Is ClawBox AI available (token present) and currently the active Hermes provider?
export async function GET() {
  const blocked = await requireHermes();
  if (blocked) return blocked;

  const [token, tier] = await Promise.all([readToken(), readTier()]);
  let active = false;
  try {
    const r = await runHermesCli(["config", "get", "model.provider"], { timeoutMs: 10_000 });
    active = r.code === 0 && r.stdout.trim() === CLAWAI_PROVIDER;
  } catch {
    // hermes missing → not active
  }
  return NextResponse.json({ hasToken: Boolean(token), tier, active, model: modelForTier(tier) });
}

// Configure Hermes to use ClawBox AI from the stored device token. Optional
// { tier } override.
export async function POST(request: Request) {
  const blocked = await requireHermes();
  if (blocked) return blocked;

  let tier = await readTier();
  try {
    const body = await request.json();
    const override = normalizeClawboxAiTier(body?.tier);
    if (override) tier = override;
  } catch {
    // no/invalid body → use the stored tier
  }

  const token = await readToken();
  if (!token || token.startsWith("-")) {
    return NextResponse.json(
      { error: "Sign in to ClawBox AI first to get a device token." },
      { status: 409 },
    );
  }
  const model = modelForTier(tier);

  const steps: string[][] = [
    ["config", "set", `providers.${CLAWAI_PROVIDER}.base_url`, CLAWBOX_AI_PROXY_URL],
    ["config", "set", `providers.${CLAWAI_PROVIDER}.api_key`, token],
    ["config", "set", `providers.${CLAWAI_PROVIDER}.api_mode`, "openai"],
    ["config", "set", "model.provider", CLAWAI_PROVIDER],
    ["config", "set", "model.default", model],
    // Clear any global custom-endpoint override a prior provider may have left,
    // so it doesn't shadow the clawai provider block.
    ["config", "unset", "model.base_url"],
    ["config", "unset", "model.api_key"],
  ];

  try {
    for (const args of steps) {
      const r = await runHermesCli(args, { timeoutMs: 15_000 });
      // `unset` of an absent key is a no-op; only a failing `set` is fatal.
      if (r.code !== 0 && args[1] === "set") {
        return NextResponse.json(
          { error: r.stderr || "Failed to configure ClawBox AI" },
          { status: 502 },
        );
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "hermes config failed" },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, provider: CLAWAI_PROVIDER, model, tier });
}
