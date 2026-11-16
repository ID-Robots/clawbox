/**
 * TASK-2501: `/setup-api/ai-models/status` on a box whose subscription is
 * linked for its PLAN alone — the poll every plan surface reads (the paid-plan
 * gates, Remote Control, the tier celebration).
 *
 * The box chats through its local engine or the owner's own key; ClawBox AI is
 * not a chat model of it, so `clawaiConfigured` stays false. The plan must
 * still reach the surfaces, and an upgrade on the portal must reach the box —
 * without arming anything that follows a ClawBox AI plan (the cloud voice).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/openclaw-config", () => ({ readConfigStrict: vi.fn() }));

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    if (value === undefined) store.delete(key);
    else store.set(key, value);
  }),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGetMany: vi.fn(),
  hermesConfigReadPending: vi.fn(() => false),
}));
const follow = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/clawai-plan-follow", () => ({ followClawaiPlanChange: follow }));

import { readConfigStrict } from "@/lib/openclaw-config";
import { getActiveHarness } from "@/lib/harness";
import { hermesConfigGetMany } from "@/lib/hermes-config-cache";

const mockReadConfig = vi.mocked(readConfigStrict);
const mockHarness = vi.mocked(getActiveHarness);
const mockHermesConfig = vi.mocked(hermesConfigGetMany);

const LINK_TOKEN = "claw_0123456789abcdef0123456789abcdef";
const CHAT_TOKEN = "claw_fedcba9876543210fedcba9876543210";

/** An OpenClaw box chatting through its local engine: no ClawBox AI profile anywhere. */
const LOCAL_ENGINE_CONFIG = {
  auth: { profiles: { "llamacpp:default": { provider: "llamacpp", mode: "api_key" } } },
  agents: { defaults: { model: { primary: "llamacpp/gemma-4" } } },
};

/** The portal's device-info answer per bearer token. */
let plans: Record<string, { status: number; body: unknown }>;
let fetchMock: ReturnType<typeof vi.fn>;

async function poll(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/setup-api/ai-models/status/route");
  return (await GET()).json();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  store.clear();
  mockHarness.mockResolvedValue("openclaw");
  mockReadConfig.mockResolvedValue(LOCAL_ENGINE_CONFIG as never);
  mockHermesConfig.mockResolvedValue({});
  plans = {};
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    const answer = plans[auth.replace(/^Bearer /, "")];
    if (!answer) throw new Error("no portal stub for this token");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a box with a linked subscription and no ClawBox AI", () => {
  it("reports the linked plan, linked, and still not a ClawBox AI box", async () => {
    store.set("subscription_link_token", LINK_TOKEN);
    store.set("subscription_link_plan", "pro");
    plans[LINK_TOKEN] = { status: 200, body: { tier: "max" } };

    const body = await poll();

    expect(body).toMatchObject({
      provider: "llamacpp",
      model: "llamacpp/gemma-4",
      clawaiPlan: "pro", // the Max plan
      subscriptionLinked: true,
      subscriptionLinkRejected: false,
      clawaiConfigured: false,
      clawaiTier: null,
      clawaiAccountTier: null,
    });
    expect(body.clawaiPlanChanged).toBeUndefined();
    // Nothing on the ClawBox AI side was written.
    expect(store.has("clawai_tier")).toBe(false);
    expect(store.has("clawai_plan_tier")).toBe(false);
  });

  it("records an upgrade on the portal, says the plan moved, and arms nothing a ClawBox AI plan would", async () => {
    store.set("subscription_link_token", LINK_TOKEN);
    store.set("subscription_link_plan", "free");
    plans[LINK_TOKEN] = { status: 200, body: { tier: "pro" } };

    const body = await poll();

    expect(body).toMatchObject({ clawaiPlan: "flash", clawaiPlanChanged: true, subscriptionLinked: true });
    expect(store.get("subscription_link_plan")).toBe("flash");
    // `followClawaiPlanChange` arms the cloud voice of a Max ClawBox AI plan;
    // a linked subscription carries no chat credential and asked for no cloud.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(follow).not.toHaveBeenCalled();
    expect(store.has("clawai_plan_tier")).toBe(false);
  });

  it("says the plan is not known while the portal has not answered for the link — never Free", async () => {
    store.set("subscription_link_token", LINK_TOKEN);
    // No stub for the token: the portal does not answer.
    const body = await poll();
    expect(body).toMatchObject({ clawaiPlan: null, subscriptionLinked: true, subscriptionLinkRejected: false });
  });

  it("flags a link the portal refused, and stops vouching for its plan", async () => {
    store.set("subscription_link_token", LINK_TOKEN);
    store.set("subscription_link_plan", "flash");
    plans[LINK_TOKEN] = { status: 401, body: { error: { code: "invalid_token" } } };

    const body = await poll();

    expect(body).toMatchObject({ clawaiPlan: null, subscriptionLinked: true, subscriptionLinkRejected: true });
    expect(store.has("subscription_link_plan")).toBe(false);
    // The ClawBox AI refusal is a different credential's fact.
    expect(body.clawaiTokenRejected).toBe(false);
  });

  it("still answers the link when the agent config cannot be read", async () => {
    // A half-written openclaw.json throws to the route's "not known" answer;
    // the link does not live there, and the paid gates must not drop to their
    // Connect card for one bad read.
    mockReadConfig.mockRejectedValue(new Error("Unexpected end of JSON input"));
    store.set("subscription_link_token", LINK_TOKEN);
    store.set("subscription_link_plan", "pro");
    plans[LINK_TOKEN] = { status: 200, body: { tier: "max" } };

    const body = await poll();

    expect(body).toMatchObject({
      connected: false,
      clawaiConfigured: false,
      subscriptionLinked: true,
      clawaiPlan: "pro",
    });
  });

  it("works the same on Hermes, where the box chats through the on-device model", async () => {
    mockHarness.mockResolvedValue("hermes");
    mockHermesConfig.mockResolvedValue({ "model.provider": "clawlocal", "model.default": "gemma-4", "providers.clawai.base_url": "" });
    store.set("subscription_link_token", LINK_TOKEN);
    store.set("subscription_link_plan", "flash");
    plans[LINK_TOKEN] = { status: 200, body: { tier: "pro" } };

    const body = await poll();

    expect(body).toMatchObject({
      provider: "clawlocal",
      clawaiPlan: "flash",
      subscriptionLinked: true,
      clawaiConfigured: false,
    });
  });
});

describe("the poll without a link", () => {
  it("is unchanged: no link, no extra portal ask, and no ClawBox AI account pays for nothing", async () => {
    const body = await poll();
    expect(body).toMatchObject({ clawaiPlan: "free", subscriptionLinked: false, subscriptionLinkRejected: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a box with both a ClawBox AI account and a linked subscription", () => {
  const CLAWAI_CONFIG = {
    auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
    agents: { defaults: { model: { primary: "clawai/deepseek-v4-flash" } } },
    models: { providers: { deepseek: { apiKey: CHAT_TOKEN } } },
  };

  it("reports the better of the two plans", async () => {
    mockReadConfig.mockResolvedValue(CLAWAI_CONFIG as never);
    store.set("subscription_link_token", LINK_TOKEN);
    store.set("subscription_link_plan", "pro");
    plans[CHAT_TOKEN] = { status: 200, body: { tier: "free" } };
    plans[LINK_TOKEN] = { status: 200, body: { tier: "max" } };

    const body = await poll();

    expect(body).toMatchObject({ clawaiConfigured: true, subscriptionLinked: true, clawaiPlan: "pro" });
    // The ClawBox AI account's own plan is still recorded as ITS plan.
    expect(store.get("clawai_plan_tier")).toBe("free");
  });

  it("keeps the ClawBox AI plan when it is the better one", async () => {
    mockReadConfig.mockResolvedValue(CLAWAI_CONFIG as never);
    store.set("subscription_link_token", LINK_TOKEN);
    store.set("subscription_link_plan", "free");
    plans[CHAT_TOKEN] = { status: 200, body: { tier: "pro" } };
    plans[LINK_TOKEN] = { status: 200, body: { tier: "free" } };

    expect((await poll()).clawaiPlan).toBe("flash");
  });
});
