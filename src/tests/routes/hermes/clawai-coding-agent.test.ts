import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pasting a ClawBox AI token has to re-advertise the coding-agent tools.
 *
 * This route is the one connect entry point that persists the token ITSELF,
 * before it hands it to `applyClawaiToHermes` — so a "was the coding agent
 * runnable before this request" snapshot taken inside the apply reads the token
 * this route just wrote and is already true. The guard then sees
 * before === after, skips the reload, and the box ends up exactly where it was
 * without the fix: panel says ready, running MCP child still has no
 * `coding_agent_run`. The snapshot has to be taken here, ahead of the write.
 */

const store: Record<string, unknown> = {};
const rpcMock = vi.hoisted(() => vi.fn());
const statusMock = vi.hoisted(() => vi.fn());
const optionsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store[key] ?? null),
  // The tri-state reader the explicit-pick marker uses (TASK-713), over the
  // same fixture store.
  getKnown: vi.fn(async (key: string) => ({ value: store[key], known: true })),
  setMany: vi.fn(async (values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) store[key] = value;
  }),
}));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
// Key-aware: the GET now answers with the harness's OWN `model.default` while
// ClawBox AI is the active provider (TASK-713), so a blanket "clawai" would
// stand in for the model as well as the provider.
/** What `hermes config get <key>` answers in a given test. */
const hermesConfig: Record<string, string> = {};
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGet: vi.fn(async (key: string) => hermesConfig[key] ?? ""),
}));
const cliMock = vi.hoisted(() => vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })));
vi.mock("@/lib/hermes-cli", () => ({
  runHermesCli: cliMock,
}));
// The box already draws, so the image family cannot be what asks for a reload
// below — anything this test counts belongs to the coding-agent family.
vi.mock("@/lib/harness/hermes-features", () => ({ hermesAgentDrawsImages: vi.fn(async () => true) }));
vi.mock("@/lib/hermes-model-options", () => ({
  invalidateModelOptions: vi.fn(),
  // Connecting ClawBox AI also credentials the `clawai` provider, so the fourth
  // boot-time snapshot — `ctx.providers` — moves on this path too. Answering
  // the same catalogue either side of the write keeps THAT family out of the
  // reload counts below, so anything this suite counts still belongs to the
  // coding-agent family. The provider family has its own suite in
  // src/tests/unit/provider-mcp-refresh.test.ts.
  getModelOptions: optionsMock,
}));
vi.mock("@/lib/hermes-env", () => ({ setHermesEnvValues: vi.fn() }));
vi.mock("@/lib/hermes-image-plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-image-plugin")>()),
  installHermesImagePlugin: vi.fn(),
}));
vi.mock("@/lib/clawbox-ai-vision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clawbox-ai-vision")>()),
  resolveVisionModelId: vi.fn(async () => ({ id: "vision", verified: true, reason: "proxy-allows" })),
}));
// `ready` is `enabled AND harness installed AND ClawBox AI connected`, and the
// third of those is the config-store key this route writes. Modelling it off the
// same store is what makes the ordering trap reproducible.
vi.mock("@/lib/coding-agent", () => ({
  getCodingAgentStatus: statusMock,
}));
vi.mock("@/lib/hermes-dashboard-rpc", () => ({ dashboardRpc: rpcMock }));
vi.mock("@/lib/hermes-dashboard-control", () => ({ bounceHermesDashboard: vi.fn(async () => "restarted") }));

import { GET, POST } from "@/app/setup-api/hermes/clawai/route";
import { EXPLICIT_MODEL_PICKS_KEY } from "@/lib/explicit-model-pick";

/** A well-formed pasted token: charset+length is all the route checks. */
const PASTED = "claw_abcdef0123456789";

/** What `hermes config set model.default` was given, if it was called. */
function modelDefaultWrite(): string | undefined {
  for (const call of cliMock.mock.calls as unknown as Array<[string[]]>) {
    const args = call[0];
    if (Array.isArray(args) && args[1] === "set" && args[2] === "model.default") return args[3];
  }
  return undefined;
}

function post(body: unknown): Request {
  return new Request("http://localhost/setup-api/hermes/clawai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** How many GLOBAL MCP respawns this request asked the agent for. */
function reloadCount(): number {
  return rpcMock.mock.calls.filter((call) => call[0] === "reload.mcp").length;
}

/** A catalogue that names the same providers before and after the write. */
function unchangedCatalogue() {
  return {
    providers: [
      {
        id: "clawai",
        name: "ClawBox AI",
        authenticated: true,
        verified: null,
        isUserDefined: false,
        source: "dashboard",
        total: 1,
        models: [{ id: "deepseek-v4-flash", description: "" }],
      },
    ],
    current: { provider: "clawai", model: "deepseek-v4-flash" },
    reasoning: "",
    fetchedAt: Date.now(),
    source: "dashboard" as const,
    stale: false,
  };
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  cliMock.mockClear();
  rpcMock.mockReset();
  statusMock.mockReset();
  optionsMock.mockReset();
  optionsMock.mockImplementation(async () => unchangedCatalogue());
  rpcMock.mockImplementation(async (method: string) =>
    method === "image.generate" ? { available: true } : { status: "ok" },
  );
  // The owner's switch is on; connecting is the only thing left.
  statusMock.mockImplementation(async () => ({
    ready: typeof store.clawai_token === "string" && store.clawai_token !== "",
  }));
});

describe("POST /setup-api/hermes/clawai", () => {
  it("re-advertises the coding-agent tools when a pasted token is what connected the box", async () => {
    const response = await POST(post({ token: PASTED, tier: "flash" }));
    expect(response.status).toBe(200);
    expect(reloadCount()).toBe(1);
  });

  it("does not reload when the box was already connected and already ready", async () => {
    // Re-applying a tier. Nothing about the tool list moved, and a reload
    // invalidates the model's prompt cache.
    store.clawai_token = PASTED;
    const response = await POST(post({ tier: "pro" }));
    expect(response.status).toBe(200);
    expect(reloadCount()).toBe(0);
  });

  it("drops the previous account's model pick when a DIFFERENT token is pasted", async () => {
    // TASK-713, through the route rather than the helper. This route persists a
    // pasted token BEFORE it applies it, so a `previousToken` read inside the
    // apply would answer with the token it is being asked about: the account
    // change would be invisible, and account A's Max choice would be handed to
    // account B's Pro plan on a box they had only just paired. The previous
    // token is captured here, ahead of that write, and passed in — the same
    // shape, and for the same reason, as `codingAgentReadyBefore` beside it.
    store.clawai_token = "claw_ACCOUNT_A0000000";
    store[EXPLICIT_MODEL_PICKS_KEY] = { clawai: "deepseek/deepseek-v4-pro" };

    const response = await POST(post({ token: PASTED, tier: "flash" }));

    expect(response.status).toBe(200);
    expect(store[EXPLICIT_MODEL_PICKS_KEY]).toEqual({});
    // ...and the badge, not the replaced account's pick, decided the model.
    const modelWrite = modelDefaultWrite();
    expect(modelWrite).toBe("deepseek-v4-flash");
  });

  it("keeps the pick when the SAME account re-applies its tier", async () => {
    store.clawai_token = PASTED;
    store[EXPLICIT_MODEL_PICKS_KEY] = { clawai: "deepseek/deepseek-v4-pro" };

    const response = await POST(post({ token: PASTED, tier: "flash" }));

    expect(response.status).toBe(200);
    expect(store[EXPLICIT_MODEL_PICKS_KEY]).toEqual({ clawai: "deepseek/deepseek-v4-pro" });
    const modelWrite = modelDefaultWrite();
    expect(modelWrite).toBe("deepseek-v4-pro");
  });

  it("still asks only ONCE when the link moves the providers too", async () => {
    // Connecting ClawBox AI credentials the `clawai` provider AND makes the
    // coding agent runnable. `reload.mcp` is global — it rebuilds every
    // family's tool list — so a link that moves three families is still one
    // fact about one box and must cost one prompt-cache invalidation.
    let seen = 0;
    optionsMock.mockImplementation(async () => {
      const payload = unchangedCatalogue();
      // Before the link this box had no credentialed provider and was on none.
      if (seen++ === 0) {
        payload.providers = [];
        payload.current = { provider: "", model: "" };
      }
      return payload;
    });
    const response = await POST(post({ token: PASTED, tier: "flash" }));
    expect(response.status).toBe(200);
    expect(reloadCount()).toBe(1);
  });
});

/**
 * TASK-713 — the panel renders this field as "Model: …", so it has to name the
 * model the box RUNS, not the one the tier badge implies. Once an explicit pick
 * outlives the badge, those are two different questions.
 */
describe("GET /setup-api/hermes/clawai", () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    for (const key of Object.keys(hermesConfig)) delete hermesConfig[key];
    store.clawai_token = "claw_token_abc";
  });

  it("names the tier's model when the owner has picked none", async () => {
    // Some other provider is active, so this is what a LINK would write.
    hermesConfig["model.provider"] = "anthropic";
    hermesConfig["model.default"] = "anthropic/claude-opus-5";
    store.clawai_tier = "flash";

    const body = await (await GET()).json();

    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.active).toBe(false);
    expect(body.tier).toBe("flash");
  });

  it("names the owner's own model when there is one, whatever the badge says", async () => {
    // Again a link's answer, not the box's: ClawBox AI is not the active
    // provider here, so the pick is what would be written.
    hermesConfig["model.provider"] = "anthropic";
    hermesConfig["model.default"] = "anthropic/claude-opus-5";
    store.clawai_tier = "flash";
    store[EXPLICIT_MODEL_PICKS_KEY] = { clawai: "deepseek/deepseek-v4-pro" };

    const body = await (await GET()).json();

    expect(body.model).toBe("deepseek-v4-pro");
    // The badge itself is untouched — it is the PLAN, and it is still what the
    // plan card renders.
    expect(body.tier).toBe("flash");
  });

  it("names what the box is CONFIGURED with while ClawBox AI is the active provider", async () => {
    // Nothing derived can beat the harness's own answer. A pick that disagrees
    // with `model.default` — an out-of-band `hermes config set`, a link that
    // half-landed — must not be painted as the model in use.
    hermesConfig["model.provider"] = "clawai";
    hermesConfig["model.default"] = "deepseek-v4-flash";
    store.clawai_tier = "pro";
    store[EXPLICIT_MODEL_PICKS_KEY] = { clawai: "deepseek/deepseek-v4-pro" };

    const body = await (await GET()).json();

    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.active).toBe(true);
  });
});
