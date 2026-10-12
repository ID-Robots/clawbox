/**
 * Which model, and how hard it thinks, for each role of a coding team
 * (src/lib/coding-role-models.ts): a planner and a reviewer default to the
 * provider's cheaper model at no more than `xhigh`, a worker keeps the owner's
 * model and effort, and the owner may override either half per role — a box
 * that never chose stores nothing and runs on the defaults.
 */
import { describe, expect, it } from "vitest";
import {
  applyRoleModelsPatch,
  MODEL_ROLES,
  modelRoleOf,
  resolveRoleRun,
  ROLE_AUTO,
  ROLE_DEFAULTS,
  ROLE_EFFORT_LEVELS,
  roleModelsFrom,
  roleModelsView,
  weakerEffort,
} from "@/lib/coding-role-models";
import { ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODEL, ECONOMY_MODELS, economyModelForProvider, isRecordableModel } from "@/lib/coding-provider";
import { EFFORT_LEVELS } from "@/lib/coding-agent";

describe("the vocabulary", () => {
  it("restates the runner's effort levels, weakest first, exactly", () => {
    expect([...ROLE_EFFORT_LEVELS]).toEqual([...EFFORT_LEVELS]);
  });

  it("names a cheaper model per provider: Sonnet on Anthropic, the plan's flash tier on ClawBox AI", () => {
    expect(ECONOMY_MODELS.anthropic).toBe("claude-sonnet-5");
    expect(ECONOMY_MODELS["clawbox-ai"]).toBe("deepseek-v4-flash");
    // The Anthropic one is a model a caller may name too — never a typo that
    // fails a planner several minutes in.
    expect(ANTHROPIC_MODELS).toContain(economyModelForProvider("anthropic"));
  });

  it("lets a ClawBox AI record carry its economy model and nothing else", () => {
    expect(isRecordableModel("clawbox-ai", "deepseek-v4-flash")).toBe(true);
    expect(isRecordableModel("clawbox-ai", "deepseek-v4-pro[1m]")).toBe(false);
    expect(isRecordableModel("clawbox-ai", "claude-opus-5-5")).toBe(false);
    expect(isRecordableModel("anthropic", "claude-opus-5")).toBe(true);
    expect(isRecordableModel("anthropic", null)).toBe(false);
  });

  it("gives the lead the planner's choice: it is the planner, back for a moment", () => {
    expect(modelRoleOf("lead")).toBe("planner");
    expect(modelRoleOf("reviewer")).toBe("reviewer");
    expect(modelRoleOf("worker")).toBe("worker");
  });

  it("orders effort for the cap", () => {
    expect(weakerEffort("ultracode", "xhigh")).toBe("xhigh");
    expect(weakerEffort("low", "xhigh")).toBe("low");
    expect(weakerEffort("max", "max")).toBe("max");
  });
});

describe("the defaults — a box that never chose", () => {
  it("runs a planner and a reviewer on the cheaper model at no more than xhigh", () => {
    for (const role of ["planner", "reviewer"] as const) {
      expect(resolveRoleRun(role, "anthropic", DEFAULT_ANTHROPIC_MODEL, "ultracode", {})).toEqual({ tier: "economy", model: "claude-sonnet-5", effort: "xhigh" });
      expect(resolveRoleRun(role, "clawbox-ai", null, "ultracode", {})).toEqual({ tier: "economy", model: "deepseek-v4-flash", effort: "xhigh" });
    }
  });

  it("never raises a role ABOVE the owner's own effort", () => {
    expect(resolveRoleRun("planner", "clawbox-ai", null, "low", {}).effort).toBe("low");
    expect(resolveRoleRun("reviewer", "anthropic", DEFAULT_ANTHROPIC_MODEL, "high", {}).effort).toBe("high");
  });

  it("leaves a worker on the owner's model and effort", () => {
    expect(resolveRoleRun("worker", "anthropic", DEFAULT_ANTHROPIC_MODEL, "ultracode", {})).toEqual({ tier: "standard", model: DEFAULT_ANTHROPIC_MODEL, effort: "ultracode" });
    expect(resolveRoleRun("worker", "clawbox-ai", null, "max", {})).toEqual({ tier: "standard", model: null, effort: "max" });
  });

  it("says so in the table the panel draws from", () => {
    expect(ROLE_DEFAULTS.planner).toEqual({ model: "economy", effortCap: "xhigh" });
    expect(ROLE_DEFAULTS.reviewer).toEqual({ model: "economy", effortCap: "xhigh" });
    expect(ROLE_DEFAULTS.worker).toEqual({ model: "standard", effortCap: null });
  });
});

describe("the owner's overrides", () => {
  it("takes either half per role, and leaves the other half on its default", () => {
    const stored = { planner: { model: "standard" as const }, reviewer: { effort: "max" as const }, worker: { model: "economy" as const, effort: "low" as const } };
    expect(resolveRoleRun("planner", "anthropic", DEFAULT_ANTHROPIC_MODEL, "ultracode", stored)).toEqual({ tier: "standard", model: DEFAULT_ANTHROPIC_MODEL, effort: "xhigh" });
    expect(resolveRoleRun("reviewer", "clawbox-ai", null, "low", stored)).toEqual({ tier: "economy", model: "deepseek-v4-flash", effort: "max" });
    expect(resolveRoleRun("worker", "anthropic", DEFAULT_ANTHROPIC_MODEL, "ultracode", stored)).toEqual({ tier: "economy", model: "claude-sonnet-5", effort: "low" });
  });

  it("applies an edit, and `auto` (or null) puts a half back to the default", () => {
    const first = applyRoleModelsPatch({}, { planner: { model: "standard", effort: "max" } });
    expect(first).toEqual({ ok: true, value: { planner: { model: "standard", effort: "max" } } });
    if (!first.ok) return;
    const second = applyRoleModelsPatch(first.value, { planner: { model: ROLE_AUTO }, reviewer: { effort: "low" } });
    expect(second).toEqual({ ok: true, value: { planner: { effort: "max" }, reviewer: { effort: "low" } } });
    if (!second.ok) return;
    // Both halves back to auto: the role goes from the stored value altogether.
    expect(applyRoleModelsPatch(second.value, { planner: { effort: null } })).toEqual({ ok: true, value: { reviewer: { effort: "low" } } });
  });

  it("refuses an edit it does not understand WHOLE, naming what was wrong", () => {
    const bad: unknown[] = [
      null, [], "economy",
      { lead: { model: "economy" } },
      { planner: "economy" },
      { planner: { model: "cheap" } },
      { planner: { effort: "turbo" } },
      { planner: { temperature: 0 } },
      { planner: { model: "economy" }, worker: { effort: "MAX" } },
    ];
    for (const patch of bad) {
      const out = applyRoleModelsPatch({}, patch);
      expect(out.ok, JSON.stringify(patch)).toBe(false);
      if (!out.ok) expect(out.error).toMatch(/role|model|effort|object/i);
    }
  });

  it("reads back only what it could have written, so a hand-edited config is the defaults rather than an error", () => {
    expect(roleModelsFrom(undefined)).toEqual({});
    expect(roleModelsFrom("economy")).toEqual({});
    expect(roleModelsFrom({ planner: { model: "economy", effort: "turbo", extra: 1 }, lead: { model: "standard" }, worker: [] })).toEqual({ planner: { model: "economy" } });
  });

  it("answers every role and every half to the panel, `auto` where nothing is stored", () => {
    const view = roleModelsView({ reviewer: { model: "standard" } });
    expect(Object.keys(view)).toEqual([...MODEL_ROLES]);
    expect(view.planner).toEqual({ model: ROLE_AUTO, effort: ROLE_AUTO });
    expect(view.reviewer).toEqual({ model: "standard", effort: ROLE_AUTO });
  });
});
