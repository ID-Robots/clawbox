export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { clawboxAiModelIdOf, readExplicitModelPicks } from "@/lib/explicit-model-pick";
import { get, setMany } from "@/lib/config-store";
import { forgetClawaiCredentialRefusal } from "@/lib/harness/credentials";
import { hermesConfigGet } from "@/lib/hermes-config-cache";
import { getActiveHarness } from "@/lib/harness";
import { getCodingAgentStatus } from "@/lib/coding-agent";
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

/**
 * Shape check for a pasted ClawBox AI token. Deliberately a charset+length
 * test rather than a prefix match: the token becomes `providers.clawai.api_key`
 * via argv, so what matters is that it cannot be read as a flag or carry
 * anything argv-hostile. Whether it is a VALID credential is the proxy's call —
 * a wrong-but-well-formed token surfaces as an auth failure on the first turn,
 * which is a clearer signal than us guessing at the format.
 */
function isPlausibleClawaiToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{15,255}$/.test(value);
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

  const [token, tierStored, picks] = await Promise.all([
    readToken(),
    readStoredTier(),
    readExplicitModelPicks(),
  ]);
  const tier: ClawboxAiTier = tierStored ?? "flash";
  // Memoised against config.yaml's mtime: this GET runs on every chat open and
  // every Settings visit, and the CLI spawn behind it costs ~600 ms each time.
  // The second key is free once the first has warmed that cache.
  const [activeProvider, storedModel] = await Promise.all([
    hermesConfigGet("model.provider"),
    hermesConfigGet("model.default"),
  ]);
  const active = activeProvider === CLAWAI_PROVIDER;
  return NextResponse.json({
    hasToken: Boolean(token),
    tier,
    tierStored,
    active,
    // The model this box RUNS for ClawBox AI, which is no longer the same
    // question as which tier the badge shows: an explicit pick outlives the
    // badge (TASK-713), and the panel renders this string as "Model: …".
    // While ClawBox AI is the ACTIVE provider the harness's own `model.default`
    // is the answer — no derivation can beat what the box is configured with.
    // Otherwise it is what a link would write: the owner's pick if there is one,
    // else the badge's default.
    model: (active && storedModel.trim())
      || clawboxAiModelIdOf(picks.clawai)
      || clawaiModelForTier(tier),
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

  // A caller may PASTE a token instead of running the device-code flow — the
  // portal shows one, and on a device that can't open a browser (or where the
  // handoff failed) that is the only way in. A supplied token is stored first
  // so the rest of the product (the wizard's status route, ClawKeep pairing,
  // a later re-apply) sees the same value the config does.
  const suppliedToken = typeof (body as { token?: unknown } | null)?.token === "string"
    ? ((body as { token?: string }).token || "").trim()
    : "";
  // Storing it first is also why the coding-agent verdict has to be sampled
  // HERE rather than inside the apply. The ClawBox MCP server registers
  // `coding_agent_run`/`_status`/`_stop` only when `getCodingAgentStatus().ready`
  // is true, and `ready` is `enabled` AND the harness installed AND ClawBox AI
  // connected — where "connected" IS the `clawai_token` the next line stores.
  // Read it a line later and the answer is always true, the apply's
  // before/after guard sees no change, and a box whose switch was already on
  // ends up with a panel that says ready over an agent that still has none of
  // the three tools. Left undefined on the no-token path, where the apply's own
  // snapshot is taken before any write and is honest; and on a probe that threw,
  // which must not turn a link into a 500.
  let codingAgentReadyBefore: boolean | undefined;
  // The SAME hazard, one field over: the apply drops the stored model pick when
  // the ClawBox AI account changes, and it cannot see that change if this route
  // has already written the new token into the store it would read (TASK-713).
  // Captured here, ahead of that write, and handed over explicitly.
  let previousClawaiToken: string | undefined;
  if (suppliedToken) {
    if (!isPlausibleClawaiToken(suppliedToken)) {
      return NextResponse.json({ error: "That doesn't look like a ClawBox AI token." }, { status: 400 });
    }
    codingAgentReadyBefore = await getCodingAgentStatus()
      .then((status) => status.ready)
      .catch(() => undefined);
    previousClawaiToken = await readToken();
    await setMany({ clawai_token: suppliedToken });
    // A refusal the proxy gave the token being replaced is about that token,
    // not this one. Dropped here as well as in `applyClawaiToHermes`, because a
    // paste that never reaches the apply still changed the credential.
    forgetClawaiCredentialRefusal();
  }

  const token = suppliedToken || (await readToken());
  // A token starting with "-" would be read by hermes as a flag, so it is as
  // unusable as no token at all.
  if (!token || token.startsWith("-")) {
    return NextResponse.json(
      { error: "Sign in to ClawBox AI first, or paste a token from the portal." },
      { status: 409 },
    );
  }

  try {
    const result = await applyClawaiToHermes(token, tier, {
      codingAgentReadyBefore,
      previousClawaiToken,
    });
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
