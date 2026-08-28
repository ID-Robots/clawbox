import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("util", () => ({ promisify: vi.fn() }));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
}));

vi.mock("fs", () => ({
  promises: { readFile: vi.fn() },
}));

vi.mock("@/lib/openclaw-config", () => ({
  inferConfiguredLocalModel: vi.fn(),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
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
function codexSubscriptionBox(modelIds: string[]) {
  return {
    auth: { profiles: { "codex:default": { provider: "codex", mode: "oauth" } } },
    models: {
      mode: "merge",
      providers: {
        codex: { models: modelIds.map((id) => ({ id, name: id })) },
      },
    },
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
  let POST: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    vi.mocked(promisify).mockReturnValue(vi.fn().mockResolvedValue({ stdout: "", stderr: "" }) as never);
    vi.mocked(runOpenclawConfigSet).mockResolvedValue(undefined);
    vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0 });
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

    POST = (await import("@/app/setup-api/chat/model/route")).POST;
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
      expect.arrayContaining([`agents.defaults.models.codex/${OFF_SURFACE}.agentRuntime.id`]),
    );
  });

  it("still switches to a codex model the subscription can run", async () => {
    vi.mocked(readConfig).mockResolvedValue(codexSubscriptionBox([ON_SURFACE]) as never);

    const response = await postModel(POST, `codex/${ON_SURFACE}`);

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      `codex/${ON_SURFACE}`,
    ]);
  });

  it("still restores a supported codex model through {source: primary}", async () => {
    vi.mocked(readConfig).mockResolvedValue(codexSubscriptionBox([ON_SURFACE]) as never);
    vi.mocked(sqliteGet).mockResolvedValue(`codex/${ON_SURFACE}`);

    const response = await postSource(POST, "primary");

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      `codex/${ON_SURFACE}`,
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
