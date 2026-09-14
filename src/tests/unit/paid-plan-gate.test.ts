/**
 * The paid-plan gate's arithmetic — the one place the tier rule lives, shared
 * by the two enable routes and the two wizards.
 *
 * THE NAMES ARE OFF BY ONE, and that is the whole reason this has a test of
 * its own: the internal `flash` is the plan marketed as **Pro** and the
 * internal `pro` is **Max** (see CLAWBOX_AI_TIER_LABEL). "Pro or Max" is
 * therefore both paid tiers, and anything else — the portal's positive `free`
 * word, an absent key, a plan name this build does not know — is not paid.
 */
import { describe, expect, it } from "vitest";
import {
  bodyWouldEnable,
  enableBlockedBy,
  isPaidPlan,
  isPlanGate,
  paidPlanRefusalText,
  planGateFor,
  PAID_FEATURES,
} from "@/lib/paid-plan-gate";

describe("isPaidPlan", () => {
  it("accepts both paid tiers under their internal names", () => {
    expect(isPaidPlan("flash")).toBe(true); // the Pro plan
    expect(isPaidPlan("pro")).toBe(true);   // the Max plan
  });

  it("refuses Free, an unknown plan and an absent one", () => {
    for (const value of ["free", "business", "", null, undefined, 0, {}]) {
      expect(isPaidPlan(value), String(value)).toBe(false);
    }
  });
});

describe("planGateFor", () => {
  it("carries the plan it found so a surface can name it", () => {
    expect(planGateFor("pro")).toEqual({ required: true, satisfied: true, plan: "pro" });
  });

  it("reports Free and not-connected identically — both are no paid plan", () => {
    expect(planGateFor("free")).toEqual({ required: true, satisfied: false, plan: null });
    expect(planGateFor(undefined)).toEqual({ required: true, satisfied: false, plan: null });
  });

  it("is satisfied by anything once the gate is switched off", () => {
    // The flipped case is reachable today, which is the point of the
    // parameter: the day the owner rules one of these ships on Free, the only
    // line that changes is the constant.
    expect(planGateFor(undefined, false)).toEqual({ required: false, satisfied: true, plan: null });
  });
});

describe("bodyWouldEnable", () => {
  it("is true only for a body that switches on or finishes the wizard", () => {
    expect(bodyWouldEnable({ enabled: true })).toBe(true);
    expect(bodyWouldEnable({ setupComplete: true })).toBe(true);
  });

  it("leaves everything else alone — a lapsed box must still be switchable OFF", () => {
    expect(bodyWouldEnable({ enabled: false })).toBe(false);
    expect(bodyWouldEnable({ setupComplete: false })).toBe(false);
    expect(bodyWouldEnable({})).toBe(false);
    // Not truthiness: only the boolean `true` means "switch it on".
    expect(bodyWouldEnable({ enabled: "yes" as unknown })).toBe(false);
  });
});

describe("isPlanGate", () => {
  it("accepts the shape the routes answer with", () => {
    expect(isPlanGate({ required: true, satisfied: false, plan: null })).toBe(true);
    expect(isPlanGate({ required: true, satisfied: true, plan: "flash" })).toBe(true);
  });

  it("refuses a half-read object, so an older server draws nothing", () => {
    for (const value of [undefined, null, {}, { required: true }, { required: true, satisfied: true }]) {
      expect(isPlanGate(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("the refusal sentence", () => {
  it("names the plans as the customer knows them, never the internal ids", () => {
    for (const feature of PAID_FEATURES) {
      const text = paidPlanRefusalText(feature);
      expect(text).toMatch(/Pro or Max/);
      expect(text).not.toMatch(/flash/);
    }
  });
});

describe("enableBlockedBy", () => {
  const unsatisfied = { required: true, satisfied: false, plan: null };

  it("holds the OFF-to-ON move when the plan does not cover the feature", () => {
    expect(enableBlockedBy(unsatisfied, false)).toBe(true);
  });

  it("never holds the other direction — off is always allowed", () => {
    // A box already enabled when the subscription lapsed is not auto-disabled,
    // so the switch that turns it off has to keep working.
    expect(enableBlockedBy(unsatisfied, true)).toBe(false);
  });

  it("holds nothing when the gate is satisfied, absent, or not required", () => {
    expect(enableBlockedBy({ required: true, satisfied: true, plan: "pro" }, false)).toBe(false);
    expect(enableBlockedBy(undefined, false)).toBe(false);
    expect(enableBlockedBy({ required: false, satisfied: true, plan: null }, false)).toBe(false);
  });
});
