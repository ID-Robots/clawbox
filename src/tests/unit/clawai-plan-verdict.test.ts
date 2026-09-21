import { describe, expect, it } from "vitest";

import { mapPortalPlanTier, mapPortalPlanVerdict } from "@/lib/clawbox-ai-portal-tier";
import { CLAWBOX_AI_PLAN_UNPAID } from "@/lib/clawbox-ai-models";

/**
 * TASK-744. The one function on the box that may decide a ClawBox AI account
 * pays for nothing.
 *
 * `mapPortalPlanTier` answers `null` to three different facts — a genuinely
 * unpaid account, a `tier` field the response omits (optional in this repo's
 * own `DeviceInfoResponse`), and a plan word this build has never seen — and
 * only the first is a downgrade. Both boot scripts read a RECORDED plan as one
 * the box was told, and one of them deletes the customer's cloud voice over it,
 * so the writer that fills that key has to be able to tell the three apart.
 *
 * Every word this function accepts as unpaid authorises that delete, which is
 * why the accepted set is pinned here by name rather than by property: adding
 * one is a decision, and it should have to be made in this file too.
 */
describe("mapPortalPlanVerdict — the only door to 'this account pays for nothing'", () => {
  it("maps the two paid plans exactly as the tier reader does", () => {
    expect(mapPortalPlanVerdict({ tier: "max" })).toBe("pro");
    expect(mapPortalPlanVerdict({ tier: "pro" })).toBe("flash");
    // The plan reading ignores the device stamp entirely — that is the whole
    // point of it. A Max subscriber may run Flash on this box.
    expect(mapPortalPlanVerdict({ tier: "max", deviceTier: "flash" })).toBe("pro");
    expect(mapPortalPlanTier({ tier: "max", deviceTier: "flash" })).toBe("pro");
  });

  it("accepts exactly one word as unpaid, and it is the one the portal sends", () => {
    // Every device-info fixture in this repository spells it `free`, and
    // `mapPortalTier` has always read it as no paid plan.
    expect(mapPortalPlanVerdict({ tier: "free" })).toBe(CLAWBOX_AI_PLAN_UNPAID);
    expect(mapPortalPlanVerdict({ tier: " Free " })).toBe(CLAWBOX_AI_PLAN_UNPAID);
  });

  it.each([
    // Stripe's `cancel_at_period_end` leaves the subscription ACTIVE and the
    // customer served to the end of the period. Reading the obvious rendering
    // of it as unpaid would delete a Max subscriber's cloud voice with weeks
    // left on his plan.
    "canceled",
    "cancelled",
    // A dunning or grace state — still paid, still served.
    "past_due",
    "expired",
    "unpaid",
    // A trial is access, not the absence of it.
    "trialing",
    // A plan tier this build simply predates.
    "enterprise",
    "team",
    // And the shapes that are not a word at all.
    "",
    "   ",
  ])("refuses to call %o unpaid", (tier) => {
    expect(mapPortalPlanVerdict({ tier })).toBeNull();
  });

  it("refuses a response that carries no tier field at all", () => {
    // `tier` is optional in our own type, and `allowedModelsForCompat` exists
    // because older portal builds answer with less than current ones do. An
    // absent field is not a statement about the plan.
    expect(mapPortalPlanVerdict({})).toBeNull();
    expect(mapPortalPlanVerdict({ deviceTier: "pro" })).toBeNull();
  });

  it("is never more permissive than the tier reader about what is PAID", () => {
    // The two must not drift into disagreeing about which accounts pay: every
    // word one calls paid, the other calls paid.
    for (const tier of ["max", "pro", "free", "enterprise", "canceled", ""]) {
      const paid = mapPortalPlanTier({ tier });
      if (paid) expect(mapPortalPlanVerdict({ tier })).toBe(paid);
    }
  });
});
