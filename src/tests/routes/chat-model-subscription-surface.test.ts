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

/** Model ids the `claude-cli` (Claude-subscription) surface really carries. */
const SURFACE_IDS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
];

/** The catalog route's disk cache for a surface provider, as it writes it. */
function surfaceCache(ids: string[]) {
  return JSON.stringify({
    provider: "claude-cli",
    models: ids.map((id) => ({ id, label: id, contextWindow: 200_000 })),
    defaultModelId: ids[0],
    allowCustom: false,
    fetchedAt: Date.now(),
  });
}

/** An anthropic auth profile in the given mode, plus a complete providerDef. */
function anthropicConfig(mode: "oauth" | "api_key", extraProfiles = {}) {
  return {
    auth: {
      profiles: {
        "anthropic:default": { provider: "anthropic", mode },
        ...extraProfiles,
      },
    },
    models: {
      mode: "merge",
      providers: {
        anthropic: {
          apiKey: "placeholder",
          baseUrl: "https://api.anthropic.com/v1",
          api: "openai-completions",
          models: [{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" }],
        },
      },
    },
    agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
  };
}

async function postModel(POST: (r: Request) => Promise<Response>, model: string) {
  return POST(new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  }));
}

/**
 * The pill in the chat header is not the only way a model id reaches this
 * route — a stale tab, a scripted call, or a browser that never received the
 * catalogue stamp can all submit an API-key-only Claude model while the box is
 * on Claude subscription auth. The route already refuses this class for
 * OpenAI/Codex; anthropic fell straight through to the openai-compat
 * auto-extend, which either pinned the box to a model that cannot route or
 * answered 409 "not fully configured, re-save it in Settings" — a wrong next
 * step for a box whose settings are fine.
 */
describe("/setup-api/chat/model and the Claude subscription surface", () => {
  let GET: () => Promise<Response>;
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
    vi.mocked(getAll).mockResolvedValue({ ai_model_provider: "anthropic" });
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    vi.mocked(sqliteGet).mockResolvedValue(null);
    vi.mocked(sqliteSet).mockResolvedValue();
    vi.mocked(restartGateway).mockResolvedValue();
    vi.mocked(readConfig).mockResolvedValue(anthropicConfig("oauth") as never);
    vi.mocked(fsp.readFile).mockResolvedValue(surfaceCache(SURFACE_IDS) as never);

    const mod = await import("@/app/setup-api/chat/model/route");
    GET = mod.GET;
    POST = mod.POST;
  });

  it("tells the browser which providers are on subscription auth", async () => {
    // Without this the header has the stamped catalogue but no idea whether
    // the stamp applies to THIS box, so it cannot grey anything out.
    const body = await (await GET()).json();
    expect(body.subscriptionProviders).toEqual(["anthropic"]);
  });

  it("reports no subscription provider when the box holds an API key", async () => {
    vi.mocked(readConfig).mockResolvedValue(anthropicConfig("api_key") as never);
    const body = await (await GET()).json();
    expect(body.subscriptionProviders).toEqual([]);
  });

  it("does not call a provider subscription-only when BOTH credentials exist", async () => {
    // An API key alongside the OAuth profile means the box can still route the
    // API-only models; greying them out would be a restriction it invented.
    vi.mocked(readConfig).mockResolvedValue(
      anthropicConfig("oauth", { "anthropic:key": { provider: "anthropic", mode: "api_key" } }) as never,
    );
    const body = await (await GET()).json();
    expect(body.subscriptionProviders).toEqual([]);
  });

  /**
   * `deepseek` and `clawai` are the same provider wearing two names: the wire
   * format is deepseek (Mike's gateway forwards there), the UI id is clawai.
   * Classifying credentials BEFORE collapsing the alias makes an OAuth profile
   * under one name and an API key under the other look like two providers, and
   * the box gets reported as subscription-only on a credential it does not
   * actually lack.
   */
  it.each([
    ["deepseek OAuth + clawai API key", "deepseek", "clawai"],
    ["clawai OAuth + deepseek API key", "clawai", "deepseek"],
  ])("collapses the deepseek/clawai alias before classifying: %s", async (_name, oauthAs, keyedAs) => {
    vi.mocked(readConfig).mockResolvedValue({
      auth: {
        profiles: {
          "a:oauth": { provider: oauthAs, mode: "oauth" },
          "b:key": { provider: keyedAs, mode: "api_key" },
        },
      },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    } as never);

    const body = await (await GET()).json();
    expect(body.subscriptionProviders).toEqual([]);
  });

  it("still reports the alias as subscription-only when there is no key at all", async () => {
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "oauth" } } },
      agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
    } as never);

    // Reported under the UI's id, which is what the header pill carries.
    const body = await (await GET()).json();
    expect(body.subscriptionProviders).toEqual(["clawai"]);
  });

  it("refuses a Claude model the subscription surface does not carry", async () => {
    const response = await postModel(POST, "anthropic/claude-fable-5");

    expect(response.status).toBe(400);
    const { error } = await response.json();
    // Name the surface, so the message is diagnosable rather than mysterious.
    expect(error).toContain("claude-cli");
    expect(error).toContain("claude-fable-5");
    // And it must NOT be the auto-extend's wrong advice.
    expect(error).not.toContain("Re-save it in Settings");
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("accepts a Claude model the subscription surface does carry", async () => {
    const response = await postModel(POST, "anthropic/claude-opus-4-8");

    expect(response.status).toBe(200);
    expect(runOpenclawConfigSet).toHaveBeenCalledWith([
      "agents.defaults.model.primary",
      "anthropic/claude-opus-4-8",
    ]);
  });

  it("lets every Claude model through on an API-key box", async () => {
    vi.mocked(readConfig).mockResolvedValue(anthropicConfig("api_key") as never);
    const response = await postModel(POST, "anthropic/claude-fable-5");
    expect(response.status).toBe(200);
  });

  it("lets the pick through when the surface could not be read at all", async () => {
    // UNKNOWN is not "no". A cold box with no catalog cache yet must not have
    // its whole Claude list refused by a guard that never verified anything.
    vi.mocked(fsp.readFile).mockRejectedValue(new Error("ENOENT") as never);
    const response = await postModel(POST, "anthropic/claude-fable-5");
    expect(response.status).toBe(200);
  });

  it("lets the pick through when the cached surface is empty", async () => {
    // An empty set is the same unknown wearing a different hat — treating it
    // as authoritative would strike out every Claude model at once.
    vi.mocked(fsp.readFile).mockResolvedValue(surfaceCache([]) as never);
    const response = await postModel(POST, "anthropic/claude-fable-5");
    expect(response.status).toBe(200);
  });

  /**
   * The custom-model branch is not the only way an id becomes the target.
   * A model already listed in `models.providers.anthropic.models` shows up in
   * `state.options` and matches BEFORE that branch; `{"source":"primary"}`
   * skips it entirely. Both matter here in particular, because the very defect
   * this PR fixes is what writes an off-surface Claude id into that list — so a
   * box broken by the old behaviour could re-arm itself through either door.
   *
   * The OpenAI guard is applied twice for exactly this reason (once in the
   * branch, once on the resolved target). The Claude one has to be too.
   */
  describe("a target that never passes through the custom-model branch", () => {
    /** Active model is LOCAL, so the anthropic row takes its model from the
     * provider definition — which is where the old auto-extend wrote. */
    function boxWithOffSurfaceModelConfigured() {
      return {
        auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
        models: {
          mode: "merge",
          providers: {
            anthropic: {
              apiKey: "placeholder",
              baseUrl: "https://api.anthropic.com/v1",
              api: "openai-completions",
              models: [{ id: "claude-fable-5", name: "claude-fable-5" }],
            },
          },
        },
        agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
      };
    }

    beforeEach(() => {
      vi.mocked(readConfig).mockResolvedValue(boxWithOffSurfaceModelConfigured() as never);
      vi.mocked(getAll).mockResolvedValue({
        ai_model_provider: "anthropic",
        local_ai_provider: "llamacpp",
        local_ai_model: "llamacpp/gemma4-e2b-it-q4_0",
      });
    });

    it("refuses it when it arrives as an id already in state.options", async () => {
      const response = await postModel(POST, "anthropic/claude-fable-5");

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("claude-cli");
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
      expect(restartGateway).not.toHaveBeenCalled();
    });

    it("refuses it when it is restored via {source: primary}", async () => {
      const response = await POST(new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "primary" }),
      }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("claude-cli");
      expect(runOpenclawConfigSet).not.toHaveBeenCalled();
      expect(restartGateway).not.toHaveBeenCalled();
    });

    it("still restores a supported Claude model through {source: primary}", async () => {
      const config = boxWithOffSurfaceModelConfigured();
      config.models.providers.anthropic.models = [
        { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
      ];
      vi.mocked(readConfig).mockResolvedValue(config as never);

      const response = await POST(new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "primary" }),
      }));

      expect(response.status).toBe(200);
      expect(runOpenclawConfigSet).toHaveBeenCalledWith([
        "agents.defaults.model.primary",
        "anthropic/claude-sonnet-4-6",
      ]);
    });

    it("leaves the local model alone", async () => {
      // The guard must not reach past its own provider.
      const response = await POST(new Request("http://localhost/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "local" }),
      }));

      // Already the active model, so the route answers with state and no write.
      expect(response.status).toBe(200);
    });
  });

  it("judges one request against ONE snapshot of the surface", async () => {
    // The two guard sites straddle the auto-extend's config write. If the
    // catalog route's background refresh lands between them, the first guard
    // sees UNKNOWN and allows, the write happens, and the second guard then
    // refuses — a failure reported over an operation that already succeeded,
    // leaving the id in `models.providers.anthropic.models` anyway.
    //
    // The surface is read once per request, so both guards agree. Either they
    // both allow (write, report success) or they both refuse — and a refusal
    // lands at the FIRST site, before the write.
    vi.mocked(fsp.readFile)
      .mockRejectedValueOnce(new Error("ENOENT") as never)
      .mockResolvedValue(surfaceCache(SURFACE_IDS) as never);

    const response = await postModel(POST, "anthropic/claude-fable-5");

    expect(response.status).toBe(200);
    expect(vi.mocked(fsp.readFile)).toHaveBeenCalledTimes(1);
  });

  /**
   * Gap A1's other half, in the OTHER route that knows about
   * `OPENAI_COMPAT_PROVIDERS`.
   *
   * Once ai-models/configure stops writing the openai-completions override for
   * a subscription sign-in, a subscription box correctly has NO
   * `models.providers.anthropic` at all. This block's auto-extend exists only
   * to keep that override's `models` list in sync, and its "is it complete?"
   * check reads a missing entry as a half-written one — so every model switch
   * on a fixed box would answer 409 "Re-save it in Settings", which is exactly
   * the wrong next step for a box whose settings are now right.
   *
   * Native routing needs no list: the plugin resolves ids from its own
   * catalog, which is why clawai/openai/codex never enter this block.
   */
  describe("a subscription box that routes natively", () => {
    /** Subscription auth, and no openai-compat override — the fixed state. */
    function nativeSubscriptionConfig(mode: "oauth" | "api_key" = "oauth") {
      return {
        auth: { profiles: { "anthropic:default": { provider: "anthropic", mode } } },
        models: { mode: "merge", providers: {} },
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      };
    }

    it("switches model without demanding a re-save", async () => {
      vi.mocked(readConfig).mockResolvedValue(nativeSubscriptionConfig() as never);

      const response = await postModel(POST, "anthropic/claude-opus-4-8");

      expect(response.status).toBe(200);
      expect(runOpenclawConfigSet).toHaveBeenCalledWith([
        "agents.defaults.model.primary",
        "anthropic/claude-opus-4-8",
      ]);
    });

    it("does not recreate the override it was just freed from", async () => {
      // Appending to `models.providers.anthropic.models` would resurrect the
      // very entry whose presence made every turn 429.
      vi.mocked(readConfig).mockResolvedValue(nativeSubscriptionConfig() as never);

      await postModel(POST, "anthropic/claude-opus-4-8");

      const wrotePaths = vi.mocked(runOpenclawConfigSet).mock.calls
        .map(([args]) => (args as string[])[0]);
      expect(wrotePaths).not.toContain("models.providers.anthropic.models");
    });

    it("still demands a re-save when an API-key box has no provider entry", async () => {
      // The guard keys on subscription auth, not on "entry missing". An
      // API-key box with no override cannot authenticate through the native
      // plugin (it reads a sqlite auth store ClawBox does not populate), so
      // that case keeps the 409 it has always had.
      vi.mocked(readConfig).mockResolvedValue(nativeSubscriptionConfig("api_key") as never);

      const response = await postModel(POST, "anthropic/claude-opus-4-8");

      expect(response.status).toBe(409);
      const { error } = await response.json();
      expect(error).toContain("Re-save it in Settings");
    });
  });

  it("re-reads the surface on every request instead of probing once", async () => {
    // The cache is refreshed by the catalog route on its own schedule. A
    // module-level memo here would pin this guard to whatever the surface
    // looked like the first time anyone switched model after a restart.
    await postModel(POST, "anthropic/claude-fable-5");
    vi.mocked(fsp.readFile).mockResolvedValue(
      surfaceCache([...SURFACE_IDS, "claude-fable-5"]) as never,
    );
    const response = await postModel(POST, "anthropic/claude-fable-5");
    expect(response.status).toBe(200);
  });
});
