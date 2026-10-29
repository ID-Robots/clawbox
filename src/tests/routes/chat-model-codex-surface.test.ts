import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("util", () => ({ promisify: vi.fn() }));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
  // A successful switch records the owner's explicit model pick (TASK-713).
  getKnown: vi.fn(async () => ({ value: undefined, known: true })),
  setMany: vi.fn(),
}));

vi.mock("fs", () => ({
  promises: { readFile: vi.fn() },
}));

const { configSetMock } = vi.hoisted(() => ({ configSetMock: vi.fn() }));

// The catalogue is told out-of-band when the plugin gate changes the provider
// set; the real module forks `openclaw models list`.
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  notifyProviderSetChanged: vi.fn(),
  refreshInBackground: vi.fn(),
}));
vi.mock("@/lib/openclaw-config", () => ({
  // GET decorates its rows with the gateway's thinking levels; no gateway here.
  gatewayIsAbsent: vi.fn(() => true),
  inferConfiguredLocalModel: vi.fn(),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  // Strict: the ON half of the plugin gate decides from ABSENCE, and plain
  // `readConfig` cannot tell an unreadable config from one carrying no flag.
  readConfigStrict: vi.fn(async () => ({})),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
  repairClawboxAiFlashModelPolicy: vi.fn(async () => false),
  // A real class, not a vi.fn(): the route narrows a restart failure with
  // `instanceof`, and an undefined export there throws instead of narrowing.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {},
  runOpenclawConfigSet: configSetMock,
  // The route writes the primary in a batch now. Record every assignment of
  // a batch on `runOpenclawConfigSet` too, the way config-set-calls flattens
  // both forms for the configure suites: the assertions here are about which
  // assignments were made, not about how many processes carried them.
  runOpenclawConfigSetBatch: vi.fn(async (ops: string[][]) => {
    for (const op of ops) await configSetMock(op);
  }),
  applyModelOverrideToAllAgentSessions: vi.fn(),
  parseFullyQualifiedModel: vi.fn(),
  setProviderPlugins: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/sqlite-store", () => ({
  sqliteGet: vi.fn(),
  sqliteSet: vi.fn(),
}));

import { promises as fsp } from "fs";
import { getAll } from "@/lib/config-store";
import {
  inferConfiguredLocalModel,
  readConfig,
  restartGateway,
  runOpenclawConfigSet,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
} from "@/lib/openclaw-config";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";
import { promisify } from "util";

/** An API-key-only model: the `-pro` tiers 400 on the ChatGPT-account route. */
const OFF_SURFACE = "gpt-5.4-pro";
/** Available on every ChatGPT tier including Free. */
const ON_SURFACE = "gpt-5.5";

/**
 * A box signed in with ChatGPT (Codex OAuth) and no OpenAI API key, whose
 * active model is the LOCAL one — so the codex row in `state.options` takes
 * its model from the provider definition rather than from the active primary.
 */
/**
 * A box signed in with ChatGPT the way OpenClaw 2 files it: an OAuth profile
 * of the openai provider (src/lib/chatgpt-subscription.ts). The ids reach
 * this route as `codex/<id>` from a stale tab or `openai/<id>` from a fresh
 * one, and both are judged on the ChatGPT surface; the box has no provider
 * override for it, exactly as a real one has not.
 */
function codexSubscriptionBox(_modelIds: string[]) {
  return {
    auth: { profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } },
    models: { mode: "merge", providers: {} },
    agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
  };
}

async function postModel(POST: (r: Request) => Promise<Response>, model: string) {
  return POST(new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  }));
}

async function postSource(POST: (r: Request) => Promise<Response>, source: string) {
  return POST(new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  }));
}

/**
 * The ChatGPT-subscription half of the two-guard-sites rule.
 *
 * The route resolves a target through THREE doors and only one of them is the
 * custom-model branch: an id listed in `models.providers.codex.models` matches
 * `state.options` first, and `{"source":"primary"}` skips the branch entirely.
 * The Claude and OpenAI guards are applied at both sites for exactly that
 * reason; the codex one was applied only inside the branch, so an
 * API-key-only id arriving through either other door was written to
 * `agents.defaults.model.primary`, additionally armed with
 * `agentRuntime.id=codex`, and reported back as a successful switch — after
 * which every turn fails upstream with nothing on screen to explain it.
 *
 * /setup-api/providers/default is a fourth caller of this same POST: it reads
 * the provider's row out of this route's own state and re-posts
 * `option.model`, i.e. door two, from a button that says "make this default".
 */
describe("/setup-api/chat/model and the ChatGPT subscription surface", () => {
  let GET: () => Promise<Response>;
  let POST: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.mocked(promisify).mockReturnValue(vi.fn().mockResolvedValue({ stdout: "", stderr: "" }) as never);
    vi.mocked(runOpenclawConfigSet).mockResolvedValue(undefined);
    vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0, sessionsSkipped: 0 });
    vi.mocked(parseFullyQualifiedModel).mockImplementation((fq: string) => {
      const idx = fq.indexOf("/");
      if (idx <= 0 || idx === fq.length - 1) return null;
      return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
    });
    vi.mocked(getAll).mockResolvedValue({
      ai_model_provider: "openai",
      local_ai_provider: "llamacpp",
      local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
    });
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    vi.mocked(sqliteGet).mockResolvedValue(null);
    vi.mocked(sqliteSet).mockResolvedValue();
    vi.mocked(restartGateway).mockResolvedValue();
    vi.mocked(readConfig).mockResolvedValue(codexSubscriptionBox([OFF_SURFACE]) as never);
    vi.mocked(fsp.readFile).mockRejectedValue(new Error("ENOENT") as never);

    ({ GET, POST } = await import("@/app/setup-api/chat/model/route"));
  });

  /** Nothing was written and the gateway was not bounced. */
  function expectNoSideEffects() {
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
  }

  it("refuses an unsupported codex id typed into the custom-model field", async () => {
    // Site one, already guarded before this change — pinned so extracting the
    // rule into a shared helper cannot quietly drop it.
    vi.mocked(readConfig).mockResolvedValue(codexSubscriptionBox([ON_SURFACE]) as never);

    const response = await postModel(POST, `codex/${OFF_SURFACE}`);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("ChatGPT subscription auth");
    expectNoSideEffects();
  });

  it("refuses an unsupported codex id that arrives as an id already in state.options", async () => {
    const response = await postModel(POST, `codex/${OFF_SURFACE}`);

    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error).toContain(OFF_SURFACE);
    expect(error).toContain("ChatGPT subscription auth");
    expectNoSideEffects();
  });

  it("refuses an unsupported codex id restored via {source: primary}", async () => {
    vi.mocked(sqliteGet).mockResolvedValue(`codex/${OFF_SURFACE}`);

    const response = await postSource(POST, "primary");

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(OFF_SURFACE);
    expectNoSideEffects();
  });

  it("does not arm the codex agentRuntime for a model it refused", async () => {
    // The write at step 1b is what makes the breakage look permanent: the box
    // ends up pointing at an id it cannot run AND told to route it through the
    // Codex app-server harness.
    await postModel(POST, `codex/${OFF_SURFACE}`);

    expect(runOpenclawConfigSet).not.toHaveBeenCalledWith(
      expect.arrayContaining([`agents.defaults.models["openai/${OFF_SURFACE}"].agentRuntime.id`]),
    );
  });

  it("still switches to a codex model the subscription can run", async () => {
    vi.mocked(readConfig).mockResolvedValue(codexSubscriptionBox([ON_SURFACE]) as never);

    const response = await postModel(POST, `codex/${ON_SURFACE}`);

    expect(response.status).toBe(200);
    // Written where OpenClaw 2 resolves it, with the ChatGPT account's runtime
    // armed on it — the retired namespace is only ever what arrived.
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      `openai/${ON_SURFACE}`,
    ]);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      `agents.defaults.models["openai/${ON_SURFACE}"].agentRuntime.id`,
      "codex",
    ]);
  });

  it("still restores a supported codex model through {source: primary}", async () => {
    vi.mocked(readConfig).mockResolvedValue(codexSubscriptionBox([ON_SURFACE]) as never);
    vi.mocked(sqliteGet).mockResolvedValue(`codex/${ON_SURFACE}`);

    const response = await postSource(POST, "primary");

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      `openai/${ON_SURFACE}`,
    ]);
  });

  // TASK-2055. This box's config store still names `openai` (the beforeEach
  // fixture) — the provider hint the picker builds a row from. On its own it
  // built an available "OpenAI GPT" row, the API-key one, on a box whose only
  // OpenAI credential is the ChatGPT sign-in: a row every pick on was refused.
  it("offers no OpenAI API-key row on a box signed in with ChatGPT only", async () => {
    const body = await (await GET()).json();

    const providers = body.options.map((option: { provider: string | null }) => option.provider);
    expect(providers).toContain("codex");
    expect(providers).not.toContain("openai");
  });

  it("still offers both OpenAI rows on a box holding the API key too", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      ...codexSubscriptionBox([ON_SURFACE]),
      auth: {
        profiles: {
          "openai:chatgpt": { provider: "openai", mode: "oauth" },
          "openai:default": { provider: "openai", mode: "api_key" },
        },
      },
    } as never);

    const body = await (await GET()).json();

    const rows = body.options.filter((option: { available: boolean; isLocal: boolean }) => option.available && !option.isLocal);
    expect(rows.map((option: { provider: string }) => option.provider).sort()).toEqual(["codex", "openai"]);
  });

  it.each([ON_SURFACE, OFF_SURFACE])(
    "refuses %s picked on the OpenAI API-key row of a keyless box, naming what is missing",
    async (modelId) => {
      // From a tab that still shows the row. A model the subscription runs was
      // moved onto the ChatGPT account without a word; any other was refused
      // as "requires OpenAI API-key mode" — a mode the owner had picked.
      const response = await POST(new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `openai/${modelId}`, provider: "openai" }),
      }));

      expect(response.status).toBe(400);
      const refusal = await response.json();
      expect(refusal).toMatchObject({ kind: "provider_credential_missing", provider: "openai" });
      expect(refusal.error).toContain("OpenAI GPT needs an OpenAI API key");
      expect(refusal.error).toContain("signed in with ChatGPT only");
      expect(refusal.error).toContain("OpenAI Codex row");
      expectNoSideEffects();
    },
  );

  it("refuses an OpenAI pick on a box with no OpenAI credential at all, saying so", async () => {
    // Was "gpt-5.5 requires OpenAI API-key mode. ChatGPT subscription auth
    // supports … GPT-5.5 …" — a sentence that refuses a model it lists.
    vi.mocked(readConfig).mockResolvedValue({
      ...codexSubscriptionBox([ON_SURFACE]),
      auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
    } as never);

    const response = await postModel(POST, `openai/${ON_SURFACE}`);

    expect(response.status).toBe(400);
    const refusal = await response.json();
    expect(refusal).toMatchObject({ kind: "provider_credential_missing", provider: "openai" });
    expect(refusal.error).toContain("OpenAI GPT is not connected on this box");
    expectNoSideEffects();
  });

  it("still routes a keyless pick on the ChatGPT row through the subscription", async () => {
    vi.mocked(readConfig).mockResolvedValue(codexSubscriptionBox([ON_SURFACE]) as never);

    const response = await POST(new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: `openai/${ON_SURFACE}`, provider: "codex" }),
    }));

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      `agents.defaults.models["openai/${ON_SURFACE}"].agentRuntime.id`,
      "codex",
    ]);
  });

  it("leaves a non-codex provider alone", async () => {
    // `gpt-5.4-pro` under the `openai/` namespace is an API-key model and
    // perfectly routable — the rule is about the namespace, not the id.
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
      models: {
        mode: "merge",
        providers: { openai: { models: [{ id: OFF_SURFACE, name: OFF_SURFACE }] } },
      },
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    } as never);

    const response = await postModel(POST, `openai/${OFF_SURFACE}`);

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      `openai/${OFF_SURFACE}`,
    ]);
  });
});
