import { describe, it, expect, vi } from "vitest";
import {
  CLAWBOX_AI_IMAGE_PROVIDER,
  CLAWBOX_AI_IMAGE_MODEL,
  CLAWBOX_AI_IMAGE_MODEL_ID,
  CLAWBOX_AI_IMAGE_MODEL_LABEL,
  CLAWBOX_AI_DAILY_IMAGE_LIMITS,
  CLAWBOX_AI_PLAN_LABEL,
  normalizeClawboxAiPlan,
  dailyImageLimitForPlan,
  readImageAllowance,
  type ClawboxAiPlan,
} from "@/lib/clawbox-ai-models";

// The image-generation half of the ClawBox AI constants (TASK-413). The plan
// table is user-facing copy backed by what the cloud proxy actually enforces,
// and `null` is a distinct answer from "0 images" everywhere it appears.

/**
 * Run `load` with `CLAWBOX_AI_IMAGE_MODEL_ID` set to `override` (or unset when
 * `undefined`) and the module registry cleared, then restore the ambient value.
 *
 * The module reads the variable at load time, so a static `import` binds
 * whatever the environment held when the file was first evaluated — which makes
 * any assertion about the value a statement about the test runner's shell.
 */
async function withImageModelIdOverride<T>(override: string | undefined, load: () => Promise<T>): Promise<T> {
  const ambient = process.env.CLAWBOX_AI_IMAGE_MODEL_ID;
  if (override === undefined) delete process.env.CLAWBOX_AI_IMAGE_MODEL_ID;
  else process.env.CLAWBOX_AI_IMAGE_MODEL_ID = override;
  vi.resetModules();
  try {
    return await load();
  } finally {
    if (ambient === undefined) delete process.env.CLAWBOX_AI_IMAGE_MODEL_ID;
    else process.env.CLAWBOX_AI_IMAGE_MODEL_ID = ambient;
    vi.resetModules();
  }
}

describe("ClawBox AI image model identifiers", () => {
  it("registers under the `openai` provider", () => {
    // OpenClaw ships BUILTIN_IMAGE_GENERATION_PROVIDERS = []; `openai` is the
    // only bundled plugin that both speaks POST {baseUrl}/images/generations
    // and honours a per-model baseUrl override. A ClawBox-specific provider id
    // simply would not be an image provider as far as the gateway is concerned.
    expect(CLAWBOX_AI_IMAGE_PROVIDER).toBe("openai");
  });

  it("exposes the model ref as provider/id", () => {
    expect(CLAWBOX_AI_IMAGE_MODEL).toBe(`${CLAWBOX_AI_IMAGE_PROVIDER}/${CLAWBOX_AI_IMAGE_MODEL_ID}`);
    const [provider, ...rest] = CLAWBOX_AI_IMAGE_MODEL.split("/");
    expect(provider).toBe("openai");
    expect(rest.join("/")).toBe(CLAWBOX_AI_IMAGE_MODEL_ID);
  });

  it("has no slash — the proxy matches the bare id", () => {
    expect(CLAWBOX_AI_IMAGE_MODEL_ID).not.toContain("/");
  });

  it("defaults to the tier-blind gpt-image-1-mini", async () => {
    // Provisioning runs before the portal has told us the plan, so the default
    // must be a model every plan is allowed to call. gpt-image-2 is Max-only
    // and would turn every Free-box request into a model-gate rejection.
    //
    // Loaded with the env override cleared, on purpose: the constant resolves
    // `process.env.CLAWBOX_AI_IMAGE_MODEL_ID` once at module load, so a shell
    // or CI job that exports it for a staging proxy would fail this assertion
    // while nothing is actually wrong. What is being pinned here is the
    // documented default, which is a property of the source, not of the
    // environment the suite happens to run in.
    const fresh = await withImageModelIdOverride(undefined, () => import("@/lib/clawbox-ai-models"));

    expect(fresh.CLAWBOX_AI_IMAGE_MODEL_ID).toBe("gpt-image-1-mini");
    expect(fresh.CLAWBOX_AI_IMAGE_MODEL).toBe("openai/gpt-image-1-mini");
  });

  it("lets CLAWBOX_AI_IMAGE_MODEL_ID retarget a staging proxy's alias map", async () => {
    // The other half of the same coupling, and the reason it exists.
    const fresh = await withImageModelIdOverride("gpt-image-staging", () => import("@/lib/clawbox-ai-models"));

    expect(fresh.CLAWBOX_AI_IMAGE_MODEL_ID).toBe("gpt-image-staging");
    expect(fresh.CLAWBOX_AI_IMAGE_MODEL).toBe("openai/gpt-image-staging");
  });

  it("carries a non-empty label — OpenClaw's schema requires models[].name", () => {
    // Without it the config fails validation ("models.providers.openai.models
    // .0.name: Invalid input") and the gateway refuses to start.
    expect(CLAWBOX_AI_IMAGE_MODEL_LABEL.trim()).not.toBe("");
  });
});

describe("normalizeClawboxAiPlan", () => {
  it.each<[string, ClawboxAiPlan]>([
    ["free", "free"],
    ["pro", "pro"],
    ["max", "max"],
  ])("accepts the portal's %s", (input, expected) => {
    expect(normalizeClawboxAiPlan(input)).toBe(expected);
  });

  it.each(["FREE", "Pro", "MaX"])("is case-insensitive (%s)", (input) => {
    expect(normalizeClawboxAiPlan(input)).toBe(input.toLowerCase());
  });

  it.each(["  pro  ", "\tmax\n", " free"])("trims surrounding whitespace (%j)", (input) => {
    expect(normalizeClawboxAiPlan(input)).toBe(input.trim().toLowerCase());
  });

  it.each(["", "   ", "enterprise", "flash", "premium", "free plan", "pro/max"])(
    "returns null for the unrecognised %j",
    (input) => {
      expect(normalizeClawboxAiPlan(input)).toBeNull();
    },
  );

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["a number", 1],
    ["a boolean", true],
    ["an object", { tier: "pro" }],
    ["an array", ["pro"]],
  ])("returns null for %s rather than throwing", (_label, input) => {
    expect(normalizeClawboxAiPlan(input)).toBeNull();
  });

  it("does not confuse the device tier with the subscription plan", () => {
    // ClawboxAiTier is flash|pro (which chat model to use); ClawboxAiPlan is
    // free|pro|max (what the account pays for). "flash" is not a plan.
    expect(normalizeClawboxAiPlan("flash")).toBeNull();
  });
});

describe("dailyImageLimitForPlan", () => {
  // Yanko's final table, TASK-485. Daily, not monthly: the previous 5/50/200
  // were per calendar MONTH, and a monthly cap locked a customer who explored
  // on the 2nd out for twenty-eight days.
  it.each<[ClawboxAiPlan, number]>([
    ["free", 1],
    ["pro", 5],
    ["max", 20],
  ])("reports %s = %i images/day", (plan, expected) => {
    expect(dailyImageLimitForPlan(plan)).toBe(expected);
    expect(CLAWBOX_AI_DAILY_IMAGE_LIMITS[plan]).toBe(expected);
  });

  it("returns null — not 0 — for an unknown plan", () => {
    // Load-bearing: when the portal is unreachable we do not know which
    // allowance applies. Callers render nothing on null; a 0 would read as
    // "you have no images left" and a default would be a guess at someone's
    // subscription. `?? 0` anywhere downstream is a bug.
    const limit = dailyImageLimitForPlan(null);
    expect(limit).toBeNull();
    expect(limit).not.toBe(0);
  });

  it("round-trips a portal string end to end", () => {
    expect(dailyImageLimitForPlan(normalizeClawboxAiPlan("MAX "))).toBe(20);
    expect(dailyImageLimitForPlan(normalizeClawboxAiPlan("enterprise"))).toBeNull();
  });

  it("gives every plan a positive allowance and a label", () => {
    for (const plan of ["free", "pro", "max"] as const) {
      expect(CLAWBOX_AI_DAILY_IMAGE_LIMITS[plan]).toBeGreaterThan(0);
      expect(CLAWBOX_AI_PLAN_LABEL[plan].trim()).not.toBe("");
    }
    // Free is a real allowance, not an absence of one — which is exactly why
    // the status route keeps `plan` alongside `tier` instead of collapsing
    // Free into the same null as "portal said something we don't recognise".
    expect(CLAWBOX_AI_DAILY_IMAGE_LIMITS.free).toBe(1);
  });

  it("orders the allowances free < pro < max", () => {
    const { free, pro, max } = CLAWBOX_AI_DAILY_IMAGE_LIMITS;
    expect(free).toBeLessThan(pro);
    expect(pro).toBeLessThan(max);
  });
});

describe("readImageAllowance", () => {
  // The parser between the status route and the only surface that renders a
  // cap to an owner. Its entire job is to answer "nothing" confidently: a
  // wrong allowance on screen is worse than the silence this task started
  // from, because silence is a gap and a wrong cap is a refund conversation.
  const good = {
    supported: true,
    model: "gpt-image-1-mini",
    plan: "max",
    planLabel: "Max",
    dailyLimit: 20,
    used: 3,
  };

  it("reads a complete block", () => {
    expect(readImageAllowance(good)).toEqual({
      plan: "max",
      planLabel: "Max",
      limit: 20,
      used: 3,
      percentUsed: 15,
    });
  });

  it("keeps the ceiling when only the usage half is unusable", () => {
    // Knowing the ceiling is still worth showing — a device talking to a
    // portal that predates the meters block should say "20 images a day on
    // Max", not go silent.
    const parsed = readImageAllowance({ ...good, used: undefined });
    expect(parsed).toMatchObject({ limit: 20, used: null, percentUsed: null });
  });

  it.each([
    ["a missing block", null],
    ["a non-object", "20"],
    ["an unpaired box", { ...good, supported: false }],
    ["an unknown plan", { ...good, plan: "enterprise" }],
    ["a plan the portal did not resolve", { ...good, plan: null }],
    ["a limit the portal did not resolve", { ...good, dailyLimit: null }],
    ["a zero limit", { ...good, dailyLimit: 0 }],
    ["a negative limit", { ...good, dailyLimit: -5 }],
    ["a fractional limit", { ...good, dailyLimit: 2.5 }],
    ["a stringly-typed limit", { ...good, dailyLimit: "20" }],
    // Above MAX_SAFE_INTEGER: isInteger says yes and the arithmetic silently
    // loses, so a percentage computed from it is not wrong by a rounding, it
    // is meaningless.
    ["a limit past what a count can represent", { ...good, dailyLimit: 2 ** 53 }],
    ["Infinity as a limit", { ...good, dailyLimit: Number.POSITIVE_INFINITY }],
    ["NaN as a limit", { ...good, dailyLimit: Number.NaN }],
  ])("renders nothing for %s", (_label, block) => {
    expect(readImageAllowance(block)).toBeNull();
  });

  it.each([
    ["a negative count", -1],
    ["a fractional count", 1.5],
    ["a stringly-typed count", "3"],
    ["a null count", null],
    ["a count past what a count can represent", 2 ** 53],
    ["Infinity as a count", Number.POSITIVE_INFINITY],
  ])("drops %s but keeps the allowance", (_label, used) => {
    const parsed = readImageAllowance({ ...good, used });
    expect(parsed?.limit).toBe(20);
    expect(parsed?.used).toBeNull();
  });

  it("never reports more than a full day, even over the cap", () => {
    // A reservation can land the counter on the limit exactly; a refund race
    // or a multi-image request settling could in principle overshoot. "140%"
    // reads as a bug to the person looking at it.
    expect(readImageAllowance({ ...good, used: 28 })?.percentUsed).toBe(100);
    expect(readImageAllowance({ ...good, used: 20 })?.percentUsed).toBe(100);
  });

  it("crosses the warning line exactly where the panel warns", () => {
    // 80% is the decided warning point (TASK-469). Asserted here so the
    // number the component compares against and the number this produces
    // cannot be rounded apart.
    expect(readImageAllowance({ ...good, dailyLimit: 5, used: 4 })?.percentUsed).toBe(80);
    expect(readImageAllowance({ ...good, dailyLimit: 5, used: 3 })?.percentUsed).toBe(60);
    expect(readImageAllowance({ ...good, dailyLimit: 1, used: 0 })?.percentUsed).toBe(0);
  });

  it("reads a Free box's single picture as a real allowance", () => {
    // Free is 1 a day, and 1 is a number worth rendering. Collapsing "Free"
    // into the same null as "we could not tell" is the bug the status route
    // keeps `plan` alongside `tier` to avoid.
    expect(readImageAllowance({ ...good, plan: "free", dailyLimit: 1, used: 0 })).toEqual({
      plan: "free",
      planLabel: "Free",
      limit: 1,
      used: 0,
      percentUsed: 0,
    });
  });
});
