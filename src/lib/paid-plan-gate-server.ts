/**
 * The paid-plan gate's server half: reading the tier off the box, and the one
 * refusal both enable routes answer with.
 *
 * SERVER ONLY — `readClawaiEntitlementTier` opens `data/config.json`. The
 * arithmetic itself is in `@/lib/paid-plan-gate`, which the wizards import;
 * this file adds nothing to it but the read and the response shape, so a route
 * and a screen can never disagree about what "paid" means.
 *
 * The refusal is a plain `Response` rather than a `NextResponse` on purpose:
 * `getMemoryStatus` reads the gate too, and that path is reached from
 * `src/instrumentation.ts` at boot — a status read should not pull `next/server`
 * behind it for a helper that only ever sets a status code and a JSON body.
 * A route handler may return either.
 */

import { readClawaiEntitlementTier } from "@/lib/clawai-plan-tier";
import {
  PAID_PLAN_REQUIRED_CODE,
  paidPlanRefusalText,
  planGateFor,
  type PaidFeature,
  type PlanGate,
} from "@/lib/paid-plan-gate";

/**
 * The gate as this box stands.
 *
 * `readClawaiEntitlementTier` is the ONE reader of the plan/badge pair — the
 * portal's plan when it has answered for this account, the device badge until
 * then — so the gate cannot disagree with the Providers page or the Harness
 * card about which plan the box is on. A store that cannot be read is "no plan
 * on record", which fails the gate: the refusal is recoverable (connect the
 * account, press the button again) and the alternative is handing a Free box a
 * paid feature on a failed read.
 */
export async function readPlanGate(): Promise<PlanGate> {
  try {
    return planGateFor(await readClawaiEntitlementTier());
  } catch {
    return planGateFor(null);
  }
}

/**
 * 402, with the code every locale words and the plan that was actually found.
 *
 * `error` carries the stable name rather than a sentence because that is the
 * field the gate's callers match on; `message` is the English floor for a
 * surface that has no catalogue entry yet.
 */
export function refusePaidPlan(feature: PaidFeature, gate: PlanGate): Response {
  return Response.json(
    {
      error: PAID_PLAN_REQUIRED_CODE,
      code: PAID_PLAN_REQUIRED_CODE,
      message: paidPlanRefusalText(feature),
      feature,
      plan: gate.plan,
    },
    { status: 402, headers: { "Cache-Control": "no-store" } },
  );
}
