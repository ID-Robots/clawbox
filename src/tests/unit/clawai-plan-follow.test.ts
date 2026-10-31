import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Following a ClawBox AI plan that moved while the box runs
 * (src/lib/clawai-plan-follow.ts). The defects: an account upgraded from Free
 * to Max kept "ClawBox cloud — not available" in Settings → Voice until the box
 * restarted, and one moved from Max to Free kept every cloud voice — because on
 * OpenClaw only the gateway's boot script arms and withdraws the cloud voice.
 * Pinned here: the gateway is restarted ONCE to let that script do it — only on
 * OpenClaw; up for the plan that covers the voice when the box cannot call one
 * yet, down for a plan we were told does not cover it when the box still holds
 * the entry the boot stamped — and the cloud defaults are applied after it for
 * a paid plan.
 */

const h = vi.hoisted(() => ({
  order: [] as string[],
  harness: vi.fn(async () => "openclaw" as "openclaw" | "hermes"),
  gatewayAbsent: vi.fn(() => false),
  token: vi.fn(async (): Promise<string | null> => "claw_device_token"),
  voiceConfig: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  /** openclaw.json as it is on disk — what the withdrawal reads. */
  rawConfig: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  /** data/config.json — the plan on record. */
  store: {} as Record<string, unknown>,
  updateLocked: vi.fn(async () => false),
  restart: vi.fn(async () => ({ back: Promise.resolve(true) })),
  apply: vi.fn<(options?: unknown) => Promise<{ moved: string[]; failed: unknown[] }>>(async () => ({ moved: [], failed: [] })),
}));

vi.mock("@/lib/harness", () => ({ getActiveHarness: h.harness }));
vi.mock("@/lib/openclaw-config", () => ({ gatewayIsAbsent: h.gatewayAbsent, readConfig: h.rawConfig }));
vi.mock("@/lib/harness/credentials", () => ({ resolveClawaiToken: h.token }));
vi.mock("@/lib/voice-box", () => ({
  readVoiceConfig: h.voiceConfig,
  clawboxAiProxyUrls: () => ["https://proxy.example/api/ai"],
}));
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => h.store[key]),
  set: vi.fn(async (key: string, value: unknown) => { h.store[key] = value; }),
}));
vi.mock("@/lib/update-lock", () => ({ isUpdateLocked: h.updateLocked }));
vi.mock("@/lib/gateway-hot-apply", () => ({
  restartGatewayAnsweringEarly: vi.fn(async () => {
    h.order.push("restart");
    return h.restart();
  }),
}));
vi.mock("@/lib/clawai-cloud-defaults", () => ({
  applyClawaiCloudDefaults: vi.fn(async (options: unknown) => {
    h.order.push("apply");
    return h.apply(options);
  }),
}));

/** The voice of a Free box: our token in the slot, no endpoint — the panel's "not available". */
const UNARMED = { tts: { providers: { openai: { apiKey: "claw_device_token" } } } };
/** The box's ClawBox AI chat credential, which the boot reads before it calls the proxy ours. */
const LINKED = { models: { providers: { deepseek: { apiKey: "claw_device_token" } } } };
/** What gateway-pre-start.sh writes for a Max box. */
const ARMED = {
  ...LINKED,
  tts: {
    providers: {
      openai: { apiKey: "claw_device_token", baseUrl: "https://proxy.example/api/ai", model: "gpt-4o-mini-tts", clawboxManaged: true },
    },
  },
};

let follow: typeof import("@/lib/clawai-plan-follow");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  h.order.length = 0;
  h.harness.mockResolvedValue("openclaw");
  h.gatewayAbsent.mockReturnValue(false);
  h.token.mockResolvedValue("claw_device_token");
  h.voiceConfig.mockResolvedValue(UNARMED);
  h.rawConfig.mockResolvedValue(UNARMED);
  for (const key of Object.keys(h.store)) delete h.store[key];
  h.updateLocked.mockResolvedValue(false);
  h.restart.mockImplementation(async () => ({ back: Promise.resolve(true) }));
  h.apply.mockResolvedValue({ moved: [], failed: [] });
  follow = await import("@/lib/clawai-plan-follow");
});

describe("followClawaiPlanChange", () => {
  it("Free → Max on OpenClaw: restarts the gateway once so its boot script arms the voice, then applies the cloud defaults", async () => {
    await follow.followClawaiPlanChange({ previous: "free", next: "pro" });
    expect(h.order).toEqual(["restart", "apply"]);
    expect(h.apply).toHaveBeenCalledWith({ trigger: "plan" });
  });

  it("waits for the restarted gateway before applying the defaults", async () => {
    let gatewayBack!: (ok: boolean) => void;
    h.restart.mockImplementation(async () => ({ back: new Promise<boolean>((r) => { gatewayBack = r; }) }));
    const run = follow.followClawaiPlanChange({ previous: "free", next: "pro" });
    await vi.waitFor(() => expect(h.order).toEqual(["restart"]));
    expect(follow.clawaiPlanFollowPending()).toBe(true);
    gatewayBack(true);
    await run;
    expect(h.order).toEqual(["restart", "apply"]);
    expect(follow.clawaiPlanFollowPending()).toBe(false);
  });

  it("does not restart a gateway whose cloud voice is already armed", async () => {
    h.voiceConfig.mockResolvedValue(ARMED);
    await follow.followClawaiPlanChange({ previous: "flash", next: "pro" });
    expect(h.order).toEqual(["apply"]);
  });

  it("does not restart for an owner's own cloud key — it already speaks", async () => {
    h.voiceConfig.mockResolvedValue({ tts: { providers: { openai: { apiKey: "sk-owners-own" } } } });
    await follow.followClawaiPlanChange({ previous: "free", next: "pro" });
    expect(h.order).toEqual(["apply"]);
  });

  it("restarts nothing on Hermes, where the voice is read from the plan on every request", async () => {
    h.harness.mockResolvedValue("hermes");
    await follow.followClawaiPlanChange({ previous: "free", next: "pro" });
    expect(h.order).toEqual(["apply"]);
    h.order.length = 0;
    h.harness.mockResolvedValue("openclaw");
    h.gatewayAbsent.mockReturnValue(true);
    await follow.followClawaiPlanChange({ previous: "free", next: "pro" });
    expect(h.order).toEqual(["apply"]);
  });

  it("restarts nothing for a box with no ClawBox AI credential", async () => {
    h.token.mockResolvedValue(null);
    await follow.followClawaiPlanChange({ previous: "free", next: "pro" });
    expect(h.order).toEqual(["apply"]);
  });

  it("leaves the restart to an update that owns the box", async () => {
    h.updateLocked.mockResolvedValue(true);
    await follow.followClawaiPlanChange({ previous: "free", next: "pro" });
    expect(h.order).toEqual(["apply"]);
  });

  it("a plan without the cloud voice and nothing of ours armed restarts nothing; an unknown plan does nothing at all", async () => {
    await follow.followClawaiPlanChange({ previous: "free", next: "flash" });
    expect(h.order).toEqual(["apply"]);
    h.order.length = 0;
    await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    expect(h.order).toEqual([]);
    h.rawConfig.mockResolvedValue(ARMED);
    await follow.followClawaiPlanChange({ previous: "pro", next: null });
    expect(h.order).toEqual([]);
  });

  it("still applies the defaults when the restart is refused, and never rejects", async () => {
    h.restart.mockRejectedValue(new Error("Start request repeated too quickly"));
    await expect(follow.followClawaiPlanChange({ previous: "free", next: "pro" })).resolves.toBeUndefined();
    expect(h.order).toEqual(["restart", "apply"]);
    h.apply.mockRejectedValue(new Error("applier failed"));
    await expect(follow.followClawaiPlanChange({ previous: "free", next: "pro" })).resolves.toBeUndefined();
    expect(follow.clawaiPlanFollowPending()).toBe(false);
  });

  it("follows one change at a time: a second poll's change waits for the first", async () => {
    let gatewayBack!: (ok: boolean) => void;
    h.restart.mockImplementationOnce(async () => ({ back: new Promise<boolean>((r) => { gatewayBack = r; }) }));
    const first = follow.followClawaiPlanChange({ previous: "free", next: "pro" });
    await vi.waitFor(() => expect(h.order).toEqual(["restart"]));
    // The first restart armed the voice; the second change finds it armed.
    h.voiceConfig.mockResolvedValue(ARMED);
    const second = follow.followClawaiPlanChange({ previous: "free", next: "pro" });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.order).toEqual(["restart"]);
    gatewayBack(true);
    await Promise.all([first, second]);
    expect(h.order).toEqual(["restart", "apply", "apply"]);
  });
});

describe("followClawaiPlanChange — a downgrade", () => {
  beforeEach(() => {
    // A Max box: the boot script armed the voice.
    h.voiceConfig.mockResolvedValue(ARMED);
    h.rawConfig.mockResolvedValue(ARMED);
  });

  it("Max → Free on OpenClaw: restarts the gateway once so its boot script withdraws the voice, and applies no defaults", async () => {
    await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    expect(h.order).toEqual(["restart"]);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("Max → Flash: withdraws the voice, then still applies the Flash plan's defaults", async () => {
    await follow.followClawaiPlanChange({ previous: "pro", next: "flash" });
    expect(h.order).toEqual(["restart", "apply"]);
    expect(h.apply).toHaveBeenCalledWith({ trigger: "plan" });
  });

  it("reads the gateway's FILE, not the voice view — the view already leaves a withdrawn voice out", async () => {
    h.voiceConfig.mockResolvedValue(UNARMED);
    await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    expect(h.order).toEqual(["restart"]);
  });

  it("is never 'setting up': the panel says not available at once", async () => {
    let gatewayBack!: (ok: boolean) => void;
    h.restart.mockImplementation(async () => ({ back: new Promise<boolean>((r) => { gatewayBack = r; }) }));
    const run = follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    await vi.waitFor(() => expect(h.order).toEqual(["restart"]));
    expect(follow.clawaiPlanFollowPending()).toBe(false);
    gatewayBack(true);
    await run;
  });

  it("takes back only the entry the boot stamped: an owner's own voice, or ours re-aimed, stays", async () => {
    const openai = (entry: Record<string, unknown>) => ({ ...LINKED, tts: { providers: { openai: entry } } });
    for (const entry of [
      { apiKey: "sk-owners-own", baseUrl: "https://api.openai.com/v1" },
      { apiKey: "claw_device_token", baseUrl: "https://speech.owner.example/v1", clawboxManaged: true },
      // Somebody else's key on our stamped entry: the owner re-aimed it.
      { apiKey: "sk-owners-own", baseUrl: "https://proxy.example/api/ai", clawboxManaged: true },
      // Ours without the stamp is somebody's hand-written config.
      { apiKey: "claw_device_token", baseUrl: "https://proxy.example/api/ai" },
    ]) {
      h.rawConfig.mockResolvedValue(openai(entry));
      await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    }
    // And a box that no longer holds a ClawBox AI chat credential is not ours to touch.
    h.rawConfig.mockResolvedValue({ tts: ARMED.tts });
    await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    expect(h.order).toEqual([]);
  });

  it("finds the stamped entry in the legacy home too", async () => {
    h.rawConfig.mockResolvedValue({ ...LINKED, messages: { tts: ARMED.tts } });
    await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    expect(h.order).toEqual(["restart"]);
  });

  it("restarts nothing on Hermes, without a gateway, or while an update owns the box", async () => {
    h.harness.mockResolvedValue("hermes");
    await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    h.harness.mockResolvedValue("openclaw");
    h.gatewayAbsent.mockReturnValue(true);
    await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    h.gatewayAbsent.mockReturnValue(false);
    h.updateLocked.mockResolvedValue(true);
    await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    expect(h.order).toEqual([]);
  });

  it("never rejects when the restart is refused", async () => {
    h.restart.mockRejectedValue(new Error("Start request repeated too quickly"));
    await expect(follow.followClawaiPlanChange({ previous: "pro", next: "free" })).resolves.toBeUndefined();
    expect(h.order).toEqual(["restart"]);
  });
});

describe("followClawaiPlanOnRecord", () => {
  beforeEach(() => {
    h.rawConfig.mockResolvedValue(ARMED);
  });

  it("brings the gateway round to a plan on record without the voice, at most once per plan", async () => {
    h.store.clawai_plan_tier = "free";
    await follow.followClawaiPlanOnRecord();
    await follow.followClawaiPlanOnRecord();
    expect(h.order).toEqual(["restart"]);
    // A different plan on record is a new reason to look.
    h.store.clawai_plan_tier = "flash";
    await follow.followClawaiPlanOnRecord();
    expect(h.order).toEqual(["restart", "restart"]);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("does nothing for a plan that covers the voice, or one not on record", async () => {
    h.store.clawai_plan_tier = "pro";
    await follow.followClawaiPlanOnRecord();
    delete h.store.clawai_plan_tier;
    await follow.followClawaiPlanOnRecord();
    h.store.clawai_plan_tier = "something-new";
    await follow.followClawaiPlanOnRecord();
    expect(h.order).toEqual([]);
  });

  it("does nothing once the boot script has taken the entry away", async () => {
    h.store.clawai_plan_tier = "free";
    h.rawConfig.mockResolvedValue(UNARMED);
    await follow.followClawaiPlanOnRecord();
    expect(h.order).toEqual([]);
  });

  it("does not repeat a withdrawal the recorded change already restarted for; retries one whose restart was refused", async () => {
    h.store.clawai_plan_tier = "free";
    await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
    await follow.followClawaiPlanOnRecord();
    expect(h.order).toEqual(["restart"]);
    h.order.length = 0;
    h.store.clawai_plan_tier = "flash";
    h.restart.mockRejectedValueOnce(new Error("Start request repeated too quickly"));
    await follow.followClawaiPlanChange({ previous: "free", next: "flash" });
    await follow.followClawaiPlanOnRecord();
    await follow.followClawaiPlanOnRecord();
    expect(h.order).toEqual(["restart", "apply", "restart"]);
  });

  it("may look again once a recorded change has been followed", async () => {
    h.store.clawai_plan_tier = "free";
    await follow.followClawaiPlanOnRecord();
    // Free → Max → Free while the box runs: the second downgrade is its own.
    h.voiceConfig.mockResolvedValue(ARMED);
    await follow.followClawaiPlanChange({ previous: "free", next: "pro" });
    await follow.followClawaiPlanOnRecord();
    expect(h.order).toEqual(["restart", "apply", "restart"]);
  });

  it("never rejects", async () => {
    h.store.clawai_plan_tier = "free";
    h.rawConfig.mockRejectedValue(new Error("EACCES"));
    await expect(follow.followClawaiPlanOnRecord()).resolves.toBeUndefined();
    expect(h.order).toEqual([]);
  });
});
