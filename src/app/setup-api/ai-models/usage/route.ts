import { NextResponse } from "next/server";
import { resolveClawaiToken } from "@/lib/harness/credentials";
import { isClawboxAiToken } from "@/lib/clawai-token";
import { fetchClawaiUsage } from "@/lib/clawai-usage-portal";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function boxTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * GET /setup-api/ai-models/usage — this box's ClawBox AI allowances, for the
 * usage card in Settings → Providers.
 *
 * The portal's usage answer, asked with the box's own `claw_*` credential (see
 * `src/lib/clawai-usage-portal.ts`) and normalized by `normalizeClawaiUsage`:
 * the rolling weekly pool, the 5-hour burst ceiling, the four weekly meters and
 * the prepaid credits when the portal sends them, and the older daily fields
 * exactly as they came when it does not.
 *
 * Always 200 with `available`; `reason` names each "no" (`not_connected`,
 * `refused`, `unreachable`, `invalid`) so the card can draw it.
 *
 * The legacy top-level fields (`percentUsed`, `resetIn`, `isOverLimit`, `tier`,
 * `tierDisplayName`, `buckets`) ride along on an available answer, derived from
 * the weekly pool when the portal no longer sends them, for the one release
 * that may still read them.
 */
export async function GET(): Promise<NextResponse> {
  const token = await resolveClawaiToken();
  if (!token || !isClawboxAiToken(token)) {
    return NextResponse.json({ available: false, reason: "not_connected" }, { headers: NO_STORE });
  }

  const answer = await fetchClawaiUsage(token);
  if (!answer.available) return NextResponse.json(answer, { headers: NO_STORE });

  const { legacy } = answer.usage;
  return NextResponse.json(
    {
      available: true,
      // "Frees up at" is read in the BOX's clock, and the browser drawing the
      // card may be somewhere else.
      timeZone: boxTimeZone(),
      usage: answer.usage,
      percentUsed: legacy.percentUsed,
      resetIn: legacy.resetIn,
      isOverLimit: legacy.isOverLimit,
      tier: legacy.tier,
      tierDisplayName: legacy.tierDisplayName,
      buckets: legacy.buckets,
    },
    { headers: NO_STORE },
  );
}
