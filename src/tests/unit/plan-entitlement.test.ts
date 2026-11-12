/**
 * TASK-2501: the plan-gated features read ONE answer to "which paid plan does
 * this box's owner have", whichever way the account reached the box — the
 * ClawBox AI credential, or a subscription linked for its plan alone.
 *
 * The names are off by one (`flash` is the Pro plan, `pro` is Max), which is
 * why "the stronger plan" is spelled out case by case below.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, unknown>());
const unreadable = vi.hoisted(() => ({ on: false }));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => {
    if (unreadable.on) throw new Error("EACCES");
    return store.get(key);
  }),
  set: vi.fn(),
  setMany: vi.fn(),
}));

import {
  PLAN_ENTITLEMENT_SOURCES,
  planEntitlementFromStore,
  readPlanEntitlement,
  strongestEntitlement,
  type PlanEntitlementSource,
} from "@/lib/plan-entitlement";
import { readPlanGate } from "@/lib/paid-plan-gate-server";

const TOKEN = "claw_0123456789abcdef0123456789abcdef";

beforeEach(() => {
  store.clear();
  unreadable.on = false;
});

describe("strongestEntitlement", () => {
  it("is nothing when no source vouches for a paid plan", () => {
    expect(strongestEntitlement([])).toEqual({ tier: null, source: null });
    expect(strongestEntitlement([
      { id: "clawai", tier: "free" },
      { id: "subscription_link", tier: null },
    ])).toEqual({ tier: null, source: null });
  });

  it("takes Max over Pro whichever source it comes from", () => {
    expect(strongestEntitlement([
      { id: "clawai", tier: "flash" },
      { id: "subscription_link", tier: "pro" },
    ])).toEqual({ tier: "pro", source: "subscription_link" });
    expect(strongestEntitlement([
      { id: "clawai", tier: "pro" },
      { id: "subscription_link", tier: "flash" },
    ])).toEqual({ tier: "pro", source: "clawai" });
  });

  it("settles a tie on the first source, so a ClawBox AI box keeps answering as one", () => {
    expect(strongestEntitlement([
      { id: "clawai", tier: "flash" },
      { id: "subscription_link", tier: "flash" },
    ])).toEqual({ tier: "flash", source: "clawai" });
  });

  it("vouches for nothing on a word it does not know", () => {
    expect(strongestEntitlement([{ id: "subscription_link", tier: "business" }]).tier).toBeNull();
  });
});

describe("planEntitlementFromStore", () => {
  it("reads a link-only box — no ClawBox AI keys at all", () => {
    expect(planEntitlementFromStore({
      subscription_link_token: TOKEN,
      subscription_link_plan: "flash",
    })).toEqual({ tier: "flash", source: "subscription_link" });
  });

  it("does not count a linked plan with no link token beside it", () => {
    expect(planEntitlementFromStore({ subscription_link_plan: "pro" })).toEqual({ tier: null, source: null });
  });

  it("lets a paid link unlock what a Free ClawBox AI account does not", () => {
    expect(planEntitlementFromStore({
      clawai_tier: "flash",
      clawai_plan_tier: "free",
      subscription_link_token: TOKEN,
      subscription_link_plan: "pro",
    })).toEqual({ tier: "pro", source: "subscription_link" });
  });

  it("keeps the ClawBox AI rule as it was: the plan, then the badge", () => {
    expect(planEntitlementFromStore({ clawai_tier: "flash" })).toEqual({ tier: "flash", source: "clawai" });
    expect(planEntitlementFromStore({ clawai_tier: "flash", clawai_plan_tier: "free" })).toEqual({ tier: null, source: null });
  });
});

describe("readPlanEntitlement", () => {
  it("reads the two sources off the store", async () => {
    expect(PLAN_ENTITLEMENT_SOURCES.map((source) => source.id)).toEqual(["clawai", "subscription_link"]);
    store.set("subscription_link_token", TOKEN);
    store.set("subscription_link_plan", "pro");
    expect(await readPlanEntitlement()).toEqual({ tier: "pro", source: "subscription_link" });
  });

  it("a source that fails vouches for nothing, and does not hide one that answers", async () => {
    const sources: PlanEntitlementSource[] = [
      { id: "clawai", readTier: () => { throw new Error("sync throw"); } },
      { id: "subscription_link", readTier: async () => "flash" },
    ];
    expect(await readPlanEntitlement(sources)).toEqual({ tier: "flash", source: "subscription_link" });
    expect(await readPlanEntitlement([
      { id: "clawai", readTier: async () => { throw new Error("EIO"); } },
    ])).toEqual({ tier: null, source: null });
  });
});

describe("readPlanGate (the two enable routes' reader)", () => {
  it("opens for a subscription linked for its plan alone", async () => {
    store.set("subscription_link_token", TOKEN);
    store.set("subscription_link_plan", "flash");
    expect(await readPlanGate()).toEqual({ required: true, satisfied: true, plan: "flash" });
  });

  it("stays shut for a linked Free account and for a link whose plan is not known yet", async () => {
    store.set("subscription_link_token", TOKEN);
    store.set("subscription_link_plan", "free");
    expect((await readPlanGate()).satisfied).toBe(false);
    store.delete("subscription_link_plan");
    expect((await readPlanGate()).satisfied).toBe(false);
  });

  it("stays shut on a store that cannot be read", async () => {
    store.set("subscription_link_token", TOKEN);
    store.set("subscription_link_plan", "pro");
    unreadable.on = true;
    expect(await readPlanGate()).toEqual({ required: true, satisfied: false, plan: null });
  });
});
