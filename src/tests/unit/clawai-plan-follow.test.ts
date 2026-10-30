import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Following a ClawBox AI plan that moved while the box runs
 * (src/lib/clawai-plan-follow.ts). The defect: an account upgraded from Free to
 * Max kept "ClawBox cloud — not available" in Settings → Voice until the box
 * restarted, because on OpenClaw only the gateway's boot script arms the cloud
 * voice. Pinned here: the gateway is restarted ONCE to let that script arm it —
 * only on OpenClaw, only for the plan that covers the voice, only when the box
 * cannot call one yet — and the cloud defaults are applied after it.
 */

const h = vi.hoisted(() => ({
  order: [] as string[],
  harness: vi.fn(async () => "openclaw" as "openclaw" | "hermes"),
  gatewayAbsent: vi.fn(() => false),
  token: vi.fn(async (): Promise<string | null> => "claw_device_token"),
  voiceConfig: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  updateLocked: vi.fn(async () => false),
  restart: vi.fn(async () => ({ back: Promise.resolve(true) })),
  apply: vi.fn<(options?: unknown) => Promise<{ moved: string[]; failed: unknown[] }>>(async () => ({ moved: [], failed: [] })),
}));

vi.mock("@/lib/harness", () => ({ getActiveHarness: h.harness }));
vi.mock("@/lib/openclaw-config", () => ({ gatewayIsAbsent: h.gatewayAbsent }));
vi.mock("@/lib/harness/credentials", () => ({ resolveClawaiToken: h.token }));
vi.mock("@/lib/voice-box", () => ({ readVoiceConfig: h.voiceConfig }));
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
/** What gateway-pre-start.sh writes for a Max box. */
const ARMED = {
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

  it("a plan without the cloud voice restarts nothing; an unpaid or unknown one does nothing at all", async () => {
    await follow.followClawaiPlanChange({ previous: "free", next: "flash" });
    expect(h.order).toEqual(["apply"]);
    h.order.length = 0;
    await follow.followClawaiPlanChange({ previous: "pro", next: "free" });
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
