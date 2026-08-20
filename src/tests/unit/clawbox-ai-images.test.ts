import { describe, it, expect, vi } from "vitest";
import {
  CLAWBOX_AI_IMAGE_PROVIDER,
  CLAWBOX_AI_IMAGE_MODEL,
  CLAWBOX_AI_IMAGE_MODEL_ID,
  CLAWBOX_AI_IMAGE_MODEL_LABEL,
  CLAWBOX_AI_MONTHLY_IMAGE_LIMITS,
  CLAWBOX_AI_PLAN_LABEL,
  normalizeClawboxAiPlan,
  monthlyImageLimitForPlan,
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

describe("monthlyImageLimitForPlan", () => {
  it.each<[ClawboxAiPlan, number]>([
    ["free", 5],
    ["pro", 50],
    ["max", 200],
  ])("reports %s = %i images/month", (plan, expected) => {
    expect(monthlyImageLimitForPlan(plan)).toBe(expected);
    expect(CLAWBOX_AI_MONTHLY_IMAGE_LIMITS[plan]).toBe(expected);
  });

  it("returns null — not 0 — for an unknown plan", () => {
    // Load-bearing: when the portal is unreachable we do not know which
    // allowance applies. Callers render nothing on null; a 0 would read as
    // "you have no images left" and a default would be a guess at someone's
    // subscription. `?? 0` anywhere downstream is a bug.
    const limit = monthlyImageLimitForPlan(null);
    expect(limit).toBeNull();
    expect(limit).not.toBe(0);
  });

  it("round-trips a portal string end to end", () => {
    expect(monthlyImageLimitForPlan(normalizeClawboxAiPlan("MAX "))).toBe(200);
    expect(monthlyImageLimitForPlan(normalizeClawboxAiPlan("enterprise"))).toBeNull();
  });

  it("gives every plan a positive allowance and a label", () => {
    for (const plan of ["free", "pro", "max"] as const) {
      expect(CLAWBOX_AI_MONTHLY_IMAGE_LIMITS[plan]).toBeGreaterThan(0);
      expect(CLAWBOX_AI_PLAN_LABEL[plan].trim()).not.toBe("");
    }
    // Free is a real allowance, not an absence of one — which is exactly why
    // the status route keeps `plan` alongside `tier` instead of collapsing
    // Free into the same null as "portal said something we don't recognise".
    expect(CLAWBOX_AI_MONTHLY_IMAGE_LIMITS.free).toBe(5);
  });

  it("orders the allowances free < pro < max", () => {
    const { free, pro, max } = CLAWBOX_AI_MONTHLY_IMAGE_LIMITS;
    expect(free).toBeLessThan(pro);
    expect(pro).toBeLessThan(max);
  });
});
