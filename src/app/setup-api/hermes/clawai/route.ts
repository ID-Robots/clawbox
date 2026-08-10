export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";
import { runHermesCli } from "@/lib/hermes-cli";
import { getActiveHarness } from "@/lib/harness";
import {
  CLAWAI_PROVIDER,
  ClawaiApplyError,
  applyClawaiToHermes,
  clawaiModelForTier,
} from "@/lib/hermes-clawai";
import { normalizeClawboxAiTier, type ClawboxAiTier } from "@/lib/clawbox-ai-models";
import { normalizeClawaiUiTier, uiTierToDeviceTier } from "@/lib/clawbox-ai-tiers";

async function readToken(): Promise<string> {
  const t = await get("clawai_token");
  return typeof t === "string" ? t.trim() : "";
}

/** The RAW stored tier, before the display coercion below. `null` means the
 *  portal reconciled the account down to Free (the status route writes
 *  clawai_tier: null), which the UI must render as Free — not as "Pro plan €9". */
async function readStoredTier(): Promise<ClawboxAiTier | null> {
  return normalizeClawboxAiTier(await get("clawai_tier"));
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

  const [token, tierStored] = await Promise.all([readToken(), readStoredTier()]);
  const tier: ClawboxAiTier = tierStored ?? "flash";
  let active = false;
  try {
    const r = await runHermesCli(["config", "get", "model.provider"], { timeoutMs: 10_000 });
    active = r.code === 0 && r.stdout.trim() === CLAWAI_PROVIDER;
  } catch {
    // hermes missing → not active
  }
  return NextResponse.json({
    hasToken: Boolean(token),
    tier,
    tierStored,
    active,
    model: clawaiModelForTier(tier),
  });
}

// Configure Hermes to use ClawBox AI from the stored device token. Optional
// { tier } override — accepts the UI's three-tier vocabulary ("free"/"flash"/
// "pro") as well as the device's two ("flash"/"pro").
export async function POST(request: Request) {
  const blocked = await requireHermes();
  if (blocked) return blocked;

  let tier: ClawboxAiTier = (await readStoredTier()) ?? "flash";
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // No body → keep the stored tier.
  }
  const requested = (body as { tier?: unknown } | null)?.tier;
  if (requested !== undefined) {
    // A present-but-unrecognised tier is a 400, NOT a silent fall back to the
    // stored value: falling back meant a user who picked Free stayed on the €49
    // frontier model. Matches /setup-api/ai-models/clawai/start's strictness.
    const uiTier = normalizeClawaiUiTier(requested);
    if (!uiTier) {
      return NextResponse.json(
        { error: "tier must be 'free', 'flash', or 'pro' when provided" },
        { status: 400 },
      );
    }
    tier = uiTierToDeviceTier(uiTier);
  }

  const token = await readToken();
  // A token starting with "-" would be read by hermes as a flag, so it is as
  // unusable as no token at all.
  if (!token || token.startsWith("-")) {
    return NextResponse.json(
      { error: "Sign in to ClawBox AI first to get a device token." },
      { status: 409 },
    );
  }

  try {
    const result = await applyClawaiToHermes(token, tier);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Only OUR own error text is safe to echo — a raw spawn error can carry the
    // hermes binary path.
    return NextResponse.json(
      { error: err instanceof ClawaiApplyError ? err.message : "Couldn't configure ClawBox AI" },
      { status: 502 },
    );
  }
}
