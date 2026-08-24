import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({ readConfig: vi.fn() }));
vi.mock("@/lib/config-store", () => ({ get: vi.fn() }));
vi.mock("@/lib/hermes-model-options", () => ({ getModelOptions: vi.fn() }));

let GET: () => Promise<Response>;
let getActiveHarness: Mock;
let hasClawaiToken: Mock;
let readConfig: Mock;
let getConfigValue: Mock;
let getModelOptions: Mock;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as { getActiveHarness: Mock });
  ({ hasClawaiToken } = (await import("@/lib/harness/credentials")) as unknown as { hasClawaiToken: Mock });
  ({ readConfig } = (await import("@/lib/openclaw-config")) as unknown as { readConfig: Mock });
  ({ get: getConfigValue } = (await import("@/lib/config-store")) as unknown as { get: Mock });
  ({ getModelOptions } = (await import("@/lib/hermes-model-options")) as unknown as { getModelOptions: Mock });
  getConfigValue.mockResolvedValue(null);
  hasClawaiToken.mockResolvedValue(false);
  ({ GET } = await import("@/app/setup-api/providers/status/route"));
});

function hermesPayload(overrides: Record<string, unknown> = {}) {
  return {
    providers: [
      { id: "anthropic", name: "Anthropic", authenticated: true, isUserDefined: false, source: "d", total: 3, models: [] },
      { id: "openrouter", name: "OpenRouter", authenticated: false, isUserDefined: false, source: "d", total: 0, models: [] },
      { id: "gemini", name: "Gemini", authenticated: null, isUserDefined: false, source: "d", total: 0, models: [] },
    ],
    current: { provider: "anthropic", model: "claude-sonnet-5" },
    reasoning: "medium",
    fetchedAt: Date.now(),
    source: "dashboard",
    stale: false,
    ...overrides,
  };
}

const rowFor = (body: { providers: { id: string }[] }, id: string) =>
  body.providers.find((p) => p.id === id);

describe("GET /setup-api/providers/status — Hermes", () => {
  beforeEach(() => getActiveHarness.mockResolvedValue("hermes"));

  it("answers for EVERY provider in one call, not just the active one", async () => {
    getModelOptions.mockResolvedValue(hermesPayload());
    const body = await (await GET()).json();

    // The whole point of the endpoint: no selecting a provider to learn about it.
    expect(body.providers.length).toBeGreaterThan(3);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining(["clawai", "anthropic", "openrouter", "gemini"]),
    );
  });

  it("maps the three credential answers onto the three honest states", async () => {
    getModelOptions.mockResolvedValue(hermesPayload());
    const body = await (await GET()).json();

    expect(rowFor(body, "anthropic")!.state).toBe("connected");
    expect(rowFor(body, "openrouter")!.state).toBe("disconnected");
    // `authenticated: null` is "we could not tell", NOT "not connected" —
    // telling someone their working key is gone is the worse of the two lies.
    expect(rowFor(body, "gemini")!.state).toBe("unknown");
  });

  it("marks the harness's configured provider as the default", async () => {
    getModelOptions.mockResolvedValue(hermesPayload());
    const body = await (await GET()).json();

    expect(body.defaultProvider).toBe("anthropic");
    expect(rowFor(body, "anthropic")!.isDefault).toBe(true);
    expect(body.providers.filter((p: { isDefault: boolean }) => p.isDefault)).toHaveLength(1);
  });

  it("calls the default provider 'needs-reauth' when it cannot authenticate", async () => {
    // The box is pointed at a provider it has no working credential for. That
    // is the one failure worth its own colour: chat is broken until it is fixed.
    getModelOptions.mockResolvedValue(
      hermesPayload({ current: { provider: "openrouter", model: "x" } }),
    );
    const body = await (await GET()).json();

    expect(rowFor(body, "openrouter")!.state).toBe("needs-reauth");
    expect(rowFor(body, "anthropic")!.state).toBe("connected");
  });

  it("reads ClawBox AI from the credential rather than the dashboard row", async () => {
    getModelOptions.mockResolvedValue(hermesPayload());
    hasClawaiToken.mockResolvedValue(true);
    const body = await (await GET()).json();

    // The dashboard never enumerated a `clawai` row; the box is linked anyway.
    expect(rowFor(body, "clawai")!.state).toBe("connected");
  });

  it("shows a provider configured outside our curated list", async () => {
    getModelOptions.mockResolvedValue(
      hermesPayload({ current: { provider: "fireworks", model: "y" } }),
    );
    const body = await (await GET()).json();

    expect(rowFor(body, "fireworks")).toBeDefined();
    expect(rowFor(body, "fireworks")!.isDefault).toBe(true);
  });

  it("passes a stale catalogue through as degraded", async () => {
    getModelOptions.mockResolvedValue(hermesPayload({ stale: true }));
    expect((await (await GET()).json()).degraded).toBe(true);
  });

  it("degrades rather than throwing when the box cannot be asked", async () => {
    getModelOptions.mockRejectedValue(new Error("dashboard down"));
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.providers).toEqual([]);
  });
});

describe("GET /setup-api/providers/status — OpenClaw", () => {
  beforeEach(() => getActiveHarness.mockResolvedValue("openclaw"));

  it("counts an auth profile and a provider key as connected", async () => {
    readConfig.mockResolvedValue({
      auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
      models: { providers: { openrouter: { apiKey: "sk-or-secret" } } },
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    });
    const body = await (await GET()).json();

    expect(rowFor(body, "anthropic")!.state).toBe("connected");
    expect(rowFor(body, "openrouter")!.state).toBe("connected");
    expect(rowFor(body, "google")!.state).toBe("disconnected");
    expect(body.defaultProvider).toBe("anthropic");
  });

  it("collapses the wire spellings of one vendor onto one row", async () => {
    // `deepseek` is ClawBox AI's provider id in openclaw.json, and `codex` is
    // the ChatGPT-subscription spelling of OpenAI. Two rows for one vendor in a
    // strip whose job is to be scannable is worse than none.
    readConfig.mockResolvedValue({
      auth: { profiles: { "deepseek:default": { provider: "deepseek" }, "codex:default": { provider: "codex" } } },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    });
    const body = await (await GET()).json();

    expect(body.providers.filter((p: { id: string }) => p.id === "clawai")).toHaveLength(1);
    expect(rowFor(body, "clawai")!.state).toBe("connected");
    expect(rowFor(body, "openai")!.state).toBe("connected");
    expect(body.defaultProvider).toBe("clawai");
  });

  it("lists a configured local engine, and points it at its own section", async () => {
    readConfig.mockResolvedValue({ agents: { defaults: { model: { primary: "llamacpp/gemma-4" } } } });
    getConfigValue.mockResolvedValue("llamacpp");
    const body = await (await GET()).json();

    expect(rowFor(body, "llamacpp")!.state).toBe("connected");
    // Sending someone to the AI Provider panel to change a local model lands
    // them on a panel that cannot change it.
    expect(rowFor(body, "llamacpp")!.section).toBe("localAi");
    expect(rowFor(body, "anthropic")!.section).toBe("ai");
  });
});

describe("the response carries statuses, never credentials", () => {
  // The rule `/setup-api/chat/capabilities` already states, enforced: a page
  // needs to know whether a provider WORKS, not what the key is.
  const SECRETS = [
    "sk-ant-verysecretkeymaterial",
    "claw_portaltokenverysecret",
    "sk-or-v1-openroutersecretkey",
  ];

  it("does not echo key material from either harness's config", async () => {
    getActiveHarness.mockResolvedValue("openclaw");
    hasClawaiToken.mockResolvedValue(true);
    readConfig.mockResolvedValue({
      auth: { profiles: { "anthropic:default": { provider: "anthropic" } } },
      models: {
        providers: {
          anthropic: { apiKey: SECRETS[0] },
          clawai: { apiKey: SECRETS[1] },
          openrouter: { apiKey: SECRETS[2] },
        },
      },
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    });

    const raw = await (await GET()).text();
    for (const secret of SECRETS) expect(raw).not.toContain(secret);
    // And nothing token-SHAPED, in case a future field carries one by accident.
    expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(raw).not.toMatch(/claw_[A-Za-z0-9_-]{8,}/);
    expect(raw).not.toMatch(/"apiKey"|"api_key"|"token"|"baseUrl"/);
  });

  it("emits only the four fields the strip renders", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    getModelOptions.mockResolvedValue(hermesPayload());
    const body = await (await GET()).json();

    expect(Object.keys(body).sort()).toEqual(
      ["defaultProvider", "degraded", "harness", "providers"],
    );
    for (const row of body.providers) {
      expect(Object.keys(row).sort()).toEqual(["id", "isDefault", "label", "section", "state"]);
      expect(typeof row.isDefault).toBe("boolean");
      expect(["connected", "disconnected", "needs-reauth", "unknown"]).toContain(row.state);
    }
  });
});
