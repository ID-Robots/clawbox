/**
 * Which account, which model, and how hard it thinks, for each role of a
 * coding team (src/lib/coding-role-models.ts): a planner defaults to the
 * provider's best model, a worker and a reviewer to its middle one, a planner
 * and a reviewer at no more than `xhigh`, a worker at the owner's effort, and
 * the owner may override the provider, the model and the effort per role — a
 * box that never chose stores nothing and runs on the defaults, and a box that
 * stored the older tier-only shape runs exactly as it did.
 */
import { describe, expect, it } from "vitest";
import {
  applyRoleModelsPatch,
  isRoleModelId,
  MODEL_ROLES,
  modelRoleOf,
  RELATIVE_MODEL_COST,
  relativeModelCost,
  resolveRoleRun,
  ROLE_AUTO,
  ROLE_DEFAULT_MODELS,
  ROLE_DEFAULTS,
  ROLE_EFFORT_LEVELS,
  roleMaxTurns,
  roleModelOptions,
  roleModelsFrom,
  roleModelsView,
  weakerEffort,
  type RoleModels,
} from "@/lib/coding-role-models";
import { ANTHROPIC_MODELS, CODING_PROVIDERS, DEFAULT_ANTHROPIC_MODEL, ECONOMY_MODELS, economyModelForProvider, isRecordableModel, OPENAI_MODELS } from "@/lib/coding-provider";
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
    expect(isRecordableModel("anthropic", "claude-fable-5-1")).toBe(true);
    expect(isRecordableModel("anthropic", null)).toBe(false);
  });

  it("has three roles; a stored `bulk` — the fourth, until 2026-10-30 — is dropped as unknown", () => {
    expect([...MODEL_ROLES]).toEqual(["planner", "worker", "reviewer"]);
    expect(roleModelsFrom({ bulk: { provider: "clawbox-ai", model: "deepseek-v4-flash" }, worker: { effort: "low" } })).toEqual({ worker: { effort: "low" } });
    expect(applyRoleModelsPatch({}, { bulk: { provider: "clawbox-ai" } })).toEqual({ ok: false, error: 'Unknown role "bulk". Use one of: planner, worker, reviewer.' });
  });

  it("gives the lead the planner's choice", () => {
    expect(modelRoleOf("lead")).toBe("planner");
    expect(modelRoleOf("planner")).toBe("planner");
    expect(modelRoleOf("reviewer")).toBe("reviewer");
    expect(modelRoleOf("worker")).toBe("worker");
  });

  it("orders effort for the cap", () => {
    expect(weakerEffort("ultracode", "xhigh")).toBe("xhigh");
    expect(weakerEffort("low", "xhigh")).toBe("low");
    expect(weakerEffort("max", "max")).toBe("max");
  });
});

describe("the models a role may name", () => {
  it("is the coding fence on Anthropic — Fable 5.1 included — and the flash tier alone on ClawBox AI", () => {
    expect([...roleModelOptions("anthropic")]).toEqual([...ANTHROPIC_MODELS]);
    expect(roleModelOptions("anthropic")).toContain("claude-fable-5-1");
    expect([...roleModelOptions("clawbox-ai")]).toEqual(["deepseek-v4-flash"]);
  });

  it("is the Codex CLI's own listed models on OpenAI, its economy model among them", () => {
    expect([...roleModelOptions("openai")]).toEqual([...OPENAI_MODELS]);
    expect(roleModelOptions("openai")).toContain("gpt-5.6-luna");
    expect(isRoleModelId("openai", "gpt-6-astra")).toBe(true);
    expect(isRoleModelId("openai", "claude-opus-5-5")).toBe(false);
    expect(isRoleModelId("anthropic", "gpt-6-astra")).toBe(false);
  });

  it("puts an OpenAI role's economy tier on the cheapest OpenAI model it offers", () => {
    const run = resolveRoleRun("planner", "openai", "gpt-6-astra", "max", { planner: { model: "economy" } });
    expect(run.provider).toBe("openai");
    expect(run.model).toBe("gpt-5.6-luna");
    expect(run.tier).toBe("economy");
    const costs = OPENAI_MODELS.map((m) => relativeModelCost("openai", m)!);
    expect(relativeModelCost("openai", "gpt-5.6-luna")).toBe(Math.min(...costs));
  });

  it("never offers the Max-plan-only pro tier, under any spelling", () => {
    for (const provider of CODING_PROVIDERS) {
      expect(roleModelOptions(provider).some((m) => m.includes("pro"))).toBe(false);
      expect(isRoleModelId(provider, "deepseek-v4-pro")).toBe(false);
    }
  });

  it("keeps a model to its own provider", () => {
    expect(isRoleModelId("anthropic", "claude-fable-5-1")).toBe(true);
    expect(isRoleModelId("clawbox-ai", "claude-fable-5-1")).toBe(false);
    expect(isRoleModelId("anthropic", "deepseek-v4-flash")).toBe(false);
    expect(isRoleModelId("anthropic", 5)).toBe(false);
  });

  it("is something a run's record may carry, every one of them", () => {
    // A role pinned to a model its record would drop is a timeline that names
    // the wrong model.
    for (const provider of CODING_PROVIDERS) {
      for (const model of roleModelOptions(provider)) expect(isRecordableModel(provider, model), `${provider} ${model}`).toBe(true);
    }
  });
});

describe("relative cost", () => {
  it("prices every model a role may name, the flash tier at 1", () => {
    expect(RELATIVE_MODEL_COST["deepseek-v4-flash"]).toBe(1);
    for (const provider of CODING_PROVIDERS) {
      for (const model of roleModelOptions(provider)) {
        const cost = relativeModelCost(provider, model);
        expect(cost, `${provider} ${model}`).toBeTypeOf("number");
        expect(cost!).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("orders them as their prices do: flash, then Sonnet, then Opus, Fable at the top", () => {
    const cost = (m: string) => RELATIVE_MODEL_COST[m];
    expect(cost("deepseek-v4-flash")).toBeLessThan(cost("claude-sonnet-5"));
    expect(cost("claude-sonnet-5")).toBeLessThan(cost("claude-opus-5-5"));
    expect(cost("claude-opus-5")).toBeLessThanOrEqual(cost("claude-opus-5-5"));
    expect(cost("claude-opus-5-5")).toBeLessThanOrEqual(cost("claude-fable-5-1"));
  });

  it("reads a missing model as the provider's default, and says null where nobody can tell", () => {
    expect(relativeModelCost("anthropic", null)).toBe(RELATIVE_MODEL_COST[DEFAULT_ANTHROPIC_MODEL]);
    // ClawBox AI's own default is whatever the plan decides.
    expect(relativeModelCost("clawbox-ai", null)).toBeNull();
    // A model on the wrong provider, or one nobody offers, has no price here.
    expect(relativeModelCost("clawbox-ai", "claude-opus-5-5")).toBeNull();
    expect(relativeModelCost("anthropic", "deepseek-v4-flash")).toBeNull();
    expect(relativeModelCost("anthropic", "claude-3-opus")).toBeNull();
    expect(relativeModelCost("anthropic", "constructor")).toBeNull();
  });
});

describe("the defaults — a box that never chose", () => {
  // Every provider × every role, with nothing stored: the planner on the
  // provider's best model, a worker and a reviewer on its middle one; ClawBox
  // AI on its flash tier throughout, never the pro tier.
  const EXPECTED = {
    anthropic: { planner: "claude-fable-5-1", worker: "claude-opus-5-5", reviewer: "claude-opus-5-5" },
    openai: { planner: "gpt-6-astra", worker: "gpt-5.6-sol", reviewer: "gpt-5.6-sol" },
    "clawbox-ai": { planner: "deepseek-v4-flash", worker: "deepseek-v4-flash", reviewer: "deepseek-v4-flash" },
  } as const;
  const OWNER_MODEL = { anthropic: DEFAULT_ANTHROPIC_MODEL, openai: "gpt-6-astra", "clawbox-ai": null } as const;

  for (const provider of CODING_PROVIDERS) {
    for (const role of MODEL_ROLES) {
      it(`runs a ${role} on ${provider} on ${EXPECTED[provider][role]}`, () => {
        const run = resolveRoleRun(role, provider, OWNER_MODEL[provider], "ultracode", {});
        expect(run).toEqual({
          provider,
          tier: "default",
          model: EXPECTED[provider][role],
          effort: role === "worker" ? "ultracode" : "xhigh",
          auto: true,
        });
        expect(ROLE_DEFAULT_MODELS[provider][role]).toBe(EXPECTED[provider][role]);
        // A model the role may name and its run's record may carry — never a
        // typo that fails a planner minutes in.
        expect(isRoleModelId(provider, run.model), `${provider} ${role}`).toBe(true);
        expect(isRecordableModel(provider, run.model)).toBe(true);
      });
    }
  }

  it("gives planning the provider's most capable model, never less than the others", () => {
    for (const provider of CODING_PROVIDERS) {
      const cost = (role: (typeof MODEL_ROLES)[number]) => relativeModelCost(provider, ROLE_DEFAULT_MODELS[provider][role])!;
      expect(cost("planner")).toBe(Math.max(...roleModelOptions(provider).map((m) => relativeModelCost(provider, m)!)));
      expect(cost("planner")).toBeGreaterThanOrEqual(cost("worker"));
      expect(cost("planner")).toBeGreaterThanOrEqual(cost("reviewer"));
    }
  });

  it("is not the economy tier anywhere a cheaper model exists (the OpenAI planner on luna was the bug)", () => {
    expect(resolveRoleRun("planner", "openai", "gpt-6-astra", "max", {}).model).not.toBe(ECONOMY_MODELS.openai);
    expect(resolveRoleRun("planner", "anthropic", DEFAULT_ANTHROPIC_MODEL, "max", {}).model).not.toBe(ECONOMY_MODELS.anthropic);
  });

  it("is the role's default whatever model the team's runs would carry", () => {
    expect(resolveRoleRun("worker", "anthropic", "claude-opus-5", "high", {}).model).toBe("claude-opus-5-5");
    expect(resolveRoleRun("planner", "openai", "gpt-5.2", "high", {}).model).toBe("gpt-6-astra");
  });

  it("stays the default when only the effort is stored", () => {
    expect(resolveRoleRun("planner", "openai", "gpt-6-astra", "max", { planner: { effort: "medium" } })).toEqual({ provider: "openai", tier: "default", model: "gpt-6-astra", effort: "medium", auto: true });
  });

  it("never raises a role ABOVE the owner's own effort", () => {
    expect(resolveRoleRun("planner", "clawbox-ai", null, "low", {}).effort).toBe("low");
    expect(resolveRoleRun("reviewer", "anthropic", DEFAULT_ANTHROPIC_MODEL, "high", {}).effort).toBe("high");
  });

  it("keeps the caps in the table the panel draws from", () => {
    expect(ROLE_DEFAULTS.planner).toEqual({ effortCap: "xhigh", turnsCap: 100 });
    expect(ROLE_DEFAULTS.reviewer).toEqual({ effortCap: "xhigh", turnsCap: 100 });
    expect(ROLE_DEFAULTS.worker).toEqual({ effortCap: null, turnsCap: null });
  });
});

describe("the caps on a role that reads", () => {
  it("holds a planner and a reviewer at xhigh even when the owner stored more", () => {
    // Ultracode is xhigh plus the Workflow fan-out, and a reader has nothing
    // to fan out; `max` is the same money for the same page of answer.
    for (const role of ["planner", "reviewer"] as const) {
      for (const effort of ["ultracode", "max"] as const) {
        expect(resolveRoleRun(role, "clawbox-ai", null, "ultracode", { [role]: { effort } }).effort).toBe("xhigh");
        expect(resolveRoleRun(role, "anthropic", DEFAULT_ANTHROPIC_MODEL, "low", { [role]: { effort } }).effort).toBe("xhigh");
      }
      // The cap is a ceiling, never a floor: a lower stored choice stands.
      expect(resolveRoleRun(role, "clawbox-ai", null, "ultracode", { [role]: { effort: "medium" } }).effort).toBe("medium");
    }
  });

  it("leaves a worker on whatever the owner stored", () => {
    expect(resolveRoleRun("worker", "clawbox-ai", null, "low", { worker: { effort: "ultracode" } }).effort).toBe("ultracode");
  });

  it("caps a planner's and a reviewer's steps at 100, and lets the owner's ceiling stand below it", () => {
    for (const role of ["planner", "reviewer"] as const) {
      expect(roleMaxTurns(role, 2000)).toBe(100);
      expect(roleMaxTurns(role, 200)).toBe(100);
      expect(roleMaxTurns(role, 40)).toBe(40);
    }
    // The owner's ceiling is sized for the roles that write.
    expect(roleMaxTurns("worker", 2000)).toBe(2000);
    expect(roleMaxTurns("worker", 40)).toBe(40);
  });
});

describe("old settings — the tier-only shape a box may already hold", () => {
  // Stored before a role could name a provider or a model: exactly what the
  // previous release wrote, read back by this one.
  const OLD = { planner: { model: "standard" }, reviewer: { effort: "max" }, worker: { model: "economy", effort: "low" } };

  it("loads unchanged", () => {
    expect(roleModelsFrom(OLD)).toEqual(OLD);
    expect(roleModelsView(roleModelsFrom(OLD))).toEqual({
      planner: { provider: ROLE_AUTO, model: "standard", effort: ROLE_AUTO },
      worker: { provider: ROLE_AUTO, model: "economy", effort: "low" },
      reviewer: { provider: ROLE_AUTO, model: ROLE_AUTO, effort: "max" },
    });
  });

  it("resolves on the team's own provider exactly as before", () => {
    const stored = roleModelsFrom(OLD);
    expect(resolveRoleRun("planner", "anthropic", DEFAULT_ANTHROPIC_MODEL, "ultracode", stored)).toEqual({ provider: "anthropic", tier: "standard", model: DEFAULT_ANTHROPIC_MODEL, effort: "xhigh", auto: false });
    expect(resolveRoleRun("planner", "clawbox-ai", null, "ultracode", stored)).toEqual({ provider: "clawbox-ai", tier: "standard", model: null, effort: "xhigh", auto: false });
    // A stored `max` for a reader is held at the cap; with no model stored the
    // reviewer is on its role's default.
    expect(resolveRoleRun("reviewer", "clawbox-ai", null, "low", stored)).toEqual({ provider: "clawbox-ai", tier: "default", model: "deepseek-v4-flash", effort: "xhigh", auto: true });
    expect(resolveRoleRun("reviewer", "openai", "gpt-6-astra", "low", stored)).toEqual({ provider: "openai", tier: "default", model: "gpt-5.6-sol", effort: "xhigh", auto: true });
    expect(resolveRoleRun("worker", "anthropic", DEFAULT_ANTHROPIC_MODEL, "ultracode", stored)).toEqual({ provider: "anthropic", tier: "economy", model: "claude-sonnet-5", effort: "low", auto: false });
  });

  it("keeps a stored tier on every provider: economy the cheaper model, standard the team's own", () => {
    for (const provider of CODING_PROVIDERS) {
      for (const role of MODEL_ROLES) {
        expect(resolveRoleRun(role, provider, null, "high", { [role]: { model: "economy" } })).toMatchObject({ provider, model: ECONOMY_MODELS[provider], tier: "economy", auto: false });
      }
    }
    expect(resolveRoleRun("planner", "openai", "gpt-6-astra", "high", { planner: { model: "economy" } }).model).toBe("gpt-5.6-luna");
    // `standard` is the model the team's runs carry, even one the start named.
    expect(resolveRoleRun("worker", "anthropic", "claude-opus-5", "high", { worker: { model: "standard" } })).toMatchObject({ model: "claude-opus-5", tier: "standard" });
    expect(resolveRoleRun("planner", "clawbox-ai", null, "high", { planner: { model: "standard" } })).toMatchObject({ model: null, tier: "standard" });
  });
});

describe("a provider and a model per role — mixed providers", () => {
  // The owner's example: planner on Fable, workers on Auto, reviewers on the
  // ClawBox AI flash tier — while the team itself runs on Anthropic.
  const MIXED: RoleModels = {
    planner: { provider: "anthropic", model: "claude-fable-5-1" },
    reviewer: { provider: "clawbox-ai", model: "deepseek-v4-flash" },
  };

  it("puts each role on its own provider and model", () => {
    expect(resolveRoleRun("planner", "anthropic", DEFAULT_ANTHROPIC_MODEL, "ultracode", MIXED)).toEqual({ provider: "anthropic", tier: "chosen", model: "claude-fable-5-1", effort: "xhigh", auto: false });
    expect(resolveRoleRun("worker", "anthropic", DEFAULT_ANTHROPIC_MODEL, "ultracode", MIXED)).toEqual({ provider: "anthropic", tier: "default", model: "claude-opus-5-5", effort: "ultracode", auto: true });
    expect(resolveRoleRun("reviewer", "anthropic", DEFAULT_ANTHROPIC_MODEL, "ultracode", MIXED)).toEqual({ provider: "clawbox-ai", tier: "chosen", model: "deepseek-v4-flash", effort: "xhigh", auto: false });
  });

  it("does the same on a team whose own provider is the other one", () => {
    expect(resolveRoleRun("planner", "clawbox-ai", null, "max", MIXED)).toMatchObject({ provider: "anthropic", model: "claude-fable-5-1", tier: "chosen" });
    expect(resolveRoleRun("worker", "clawbox-ai", null, "max", MIXED)).toMatchObject({ provider: "clawbox-ai", model: "deepseek-v4-flash", tier: "default" });
  });

  it("reads a provider without a model as that provider's default model", () => {
    const stored: RoleModels = { planner: { provider: "anthropic" }, reviewer: { provider: "clawbox-ai" } };
    // Another provider than the team's: its own default.
    expect(resolveRoleRun("planner", "clawbox-ai", null, "high", stored)).toEqual({ provider: "anthropic", tier: "standard", model: DEFAULT_ANTHROPIC_MODEL, effort: "high", auto: false });
    expect(resolveRoleRun("reviewer", "anthropic", DEFAULT_ANTHROPIC_MODEL, "high", stored)).toEqual({ provider: "clawbox-ai", tier: "standard", model: null, effort: "high", auto: false });
    // The team's own provider: the model the team's runs carry.
    expect(resolveRoleRun("planner", "anthropic", "claude-opus-5", "high", stored).model).toBe("claude-opus-5");
  });

  it("takes a tier on the role's provider", () => {
    const stored: RoleModels = { reviewer: { provider: "anthropic", model: "economy" }, planner: { provider: "clawbox-ai", model: "standard" } };
    expect(resolveRoleRun("reviewer", "clawbox-ai", null, "high", stored)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", tier: "economy" });
    expect(resolveRoleRun("planner", "anthropic", DEFAULT_ANTHROPIC_MODEL, "high", stored)).toMatchObject({ provider: "clawbox-ai", model: null, tier: "standard" });
  });

  it("never runs a model on a provider that does not offer it, even from a hand-built map", () => {
    const stored = { planner: { provider: "clawbox-ai", model: "claude-fable-5-1" } } as RoleModels;
    expect(resolveRoleRun("planner", "anthropic", DEFAULT_ANTHROPIC_MODEL, "high", stored)).toMatchObject({ provider: "clawbox-ai", model: null, tier: "standard" });
  });
});

describe("the owner's edits", () => {
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

  it("stores a provider and a model together, for any role", () => {
    expect(applyRoleModelsPatch({}, {
      planner: { provider: "anthropic", model: "claude-fable-5-1" },
      reviewer: { provider: "clawbox-ai", model: "deepseek-v4-flash", effort: "medium" },
      worker: { provider: "anthropic" },
    })).toEqual({ ok: true, value: {
      planner: { provider: "anthropic", model: "claude-fable-5-1" },
      reviewer: { provider: "clawbox-ai", model: "deepseek-v4-flash", effort: "medium" },
      worker: { provider: "anthropic" },
    } });
  });

  it("checks the model against the provider whatever order the body names them in", () => {
    expect(applyRoleModelsPatch({}, { planner: { model: "claude-fable-5-1", provider: "anthropic" } }).ok).toBe(true);
  });

  it("lets a model be named alone where the role already has a provider", () => {
    const out = applyRoleModelsPatch({ planner: { provider: "anthropic" } }, { planner: { model: "claude-sonnet-5" } });
    expect(out).toEqual({ ok: true, value: { planner: { provider: "anthropic", model: "claude-sonnet-5" } } });
  });

  it("drops a model the new provider does not offer when only the provider changes", () => {
    const stored: RoleModels = { planner: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" } };
    expect(applyRoleModelsPatch(stored, { planner: { provider: "clawbox-ai" } })).toEqual({ ok: true, value: { planner: { provider: "clawbox-ai", effort: "high" } } });
    // Reset to auto: an id cannot stand without its provider.
    expect(applyRoleModelsPatch(stored, { planner: { provider: ROLE_AUTO } })).toEqual({ ok: true, value: { planner: { effort: "high" } } });
    // The same provider again changes nothing; a tier survives any change.
    expect(applyRoleModelsPatch(stored, { planner: { provider: "anthropic" } })).toEqual({ ok: true, value: stored });
    expect(applyRoleModelsPatch({ planner: { provider: "anthropic", model: "economy" } }, { planner: { provider: "clawbox-ai" } }))
      .toEqual({ ok: true, value: { planner: { provider: "clawbox-ai", model: "economy" } } });
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
      { planner: { provider: "mistral" } },
      { planner: { provider: 1 } },
      { planner: { model: 5, provider: "anthropic" } },
      { planner: { model: "" , provider: "anthropic" } },
      // Invalid pairs.
      { planner: { provider: "clawbox-ai", model: "claude-fable-5-1" } },
      { planner: { provider: "anthropic", model: "deepseek-v4-flash" } },
      { planner: { provider: "openai", model: "claude-opus-5-5" } },
      { planner: { provider: "anthropic", model: "gpt-6-astra" } },
      { reviewer: { provider: "clawbox-ai", model: "deepseek-v4-pro" } },
      { planner: { provider: ROLE_AUTO, model: "claude-opus-5-5" } },
      // A model id with no provider anywhere.
      { worker: { model: "claude-fable-5-1" } },
      // A good role beside a bad one: none of it is saved.
      { planner: { provider: "anthropic", model: "claude-fable-5-1" }, reviewer: { provider: "anthropic", model: "deepseek-v4-flash" } },
    ];
    for (const patch of bad) {
      const out = applyRoleModelsPatch({}, patch);
      expect(out.ok, JSON.stringify(patch)).toBe(false);
      if (!out.ok) expect(out.error).toMatch(/role|provider|model|effort|object/i);
    }
  });

  it("says what is wrong with a pair in words the caller can act on", () => {
    const wrongProvider = applyRoleModelsPatch({}, { planner: { provider: "clawbox-ai", model: "claude-fable-5-1" } });
    expect(wrongProvider.ok).toBe(false);
    if (!wrongProvider.ok) expect(wrongProvider.error).toMatch(/not offered on clawbox-ai.*deepseek-v4-flash/);
    const noProvider = applyRoleModelsPatch({}, { worker: { model: "claude-fable-5-1" } });
    expect(noProvider.ok).toBe(false);
    if (!noProvider.ok) expect(noProvider.error).toMatch(/roleModels\.worker\.provider/);
    const unknown = applyRoleModelsPatch({}, { worker: { model: "cheapest" } });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/roleModels\.worker\.model.*claude-fable-5-1/);
  });

  it("reads back only what it could have written, so a hand-edited config is the defaults rather than an error", () => {
    expect(roleModelsFrom(undefined)).toEqual({});
    expect(roleModelsFrom("economy")).toEqual({});
    expect(roleModelsFrom({ planner: { model: "economy", effort: "turbo", extra: 1 }, lead: { model: "standard" }, worker: [] })).toEqual({ planner: { model: "economy" } });
    // A model without its provider, or off its provider's list, goes alone;
    // the provider the owner chose stays.
    expect(roleModelsFrom({
      planner: { model: "claude-fable-5-1" },
      reviewer: { provider: "clawbox-ai", model: "deepseek-v4-pro", effort: "high" },
      worker: { provider: "openai", model: "gpt-5" },
      // A role until 2026-10-30: a choice stored for it goes whole.
      bulk: { provider: "clawbox-ai", model: "deepseek-v4-flash" },
      lead: { provider: "mistral" },
    })).toEqual({
      reviewer: { provider: "clawbox-ai", effort: "high" },
      // OpenAI is a provider the box knows; "gpt-5" is not on its list.
      worker: { provider: "openai" },
    });
  });

  it("answers every role and every half to the panel, `auto` where nothing is stored", () => {
    const view = roleModelsView({ reviewer: { model: "standard" }, worker: { provider: "clawbox-ai", model: "deepseek-v4-flash" } });
    expect(Object.keys(view)).toEqual([...MODEL_ROLES]);
    expect(view.planner).toEqual({ provider: ROLE_AUTO, model: ROLE_AUTO, effort: ROLE_AUTO });
    expect(view.reviewer).toEqual({ provider: ROLE_AUTO, model: "standard", effort: ROLE_AUTO });
    expect(view.worker).toEqual({ provider: "clawbox-ai", model: "deepseek-v4-flash", effort: ROLE_AUTO });
  });
});
