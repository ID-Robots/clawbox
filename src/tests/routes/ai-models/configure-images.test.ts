import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";
import fsp from "fs/promises";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import {
  CLAWBOX_AI_IMAGE_MODEL,
  CLAWBOX_AI_IMAGE_MODEL_ID,
  CLAWBOX_AI_IMAGE_PROVIDER,
  CLAWBOX_AI_LEGACY_IMAGE_MODEL,
  CLAWBOX_AI_LEGACY_IMAGE_PROVIDER,
} from "@/lib/clawbox-ai-models";

// The ClawBox AI image-provider half of POST /setup-api/ai-models/configure
// (TASK-413). Without it a provisioned box cannot generate an image at all:
// OpenClaw registers `image_generate` only when an image-generation provider is
// configured, and ClawBox provisioning configured none.
//
// Mocks are the same set configure.test.ts uses — the route's collaborators,
// with `runOpenclawConfigSet` as the boundary every `openclaw config set` goes
// through, so the assertions below are about the exact commands the route runs.

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// PARTIAL mock — only the setup-gate read is replaceable, and it is pinned
// rather than left to the filesystem. Without it `readSetupGateFacts()` runs
// for real, reads `${CLAWBOX_ROOT}/data/config.json` under the hermetic floor
// vitest.config.ts sets, gets ENOENT and answers `setupComplete: false` — so
// every case in this file silently exercised the FIRST-RUN WIZARD branch
// (`awaitReady: false`), which is not the box these Settings-side cases
// describe. Deterministic, but named by accident; the first assertion on
// restartGateway's argument added here would have pinned the wrong one.
vi.mock("@/lib/route-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/route-auth")>("@/lib/route-auth");
  return { ...actual, readSetupGateFacts: () => ({ setupComplete: true, passwordConfigured: true }) };
});

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    chown: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
  setMany: vi.fn(),
  // The route reads and clears the persisted credential refusal through these
  // (@/lib/clawai-credential-refusal). Omit them and the calls throw inside
  // their own catch, so the route behaves as if nothing were ever on record and
  // this file goes on passing over a gate that never ran.
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => {}),
}));

vi.mock("@/lib/clawkeep", () => ({
  unpairLocal: vi.fn(),
}));

// Out-of-band catalog refresh the route deliberately does not await; stubbing
// it stops its late console write from racing worker teardown. See the long
// note in configure.test.ts.
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  refreshInBackground: vi.fn(),
  notifyProviderSetChanged: vi.fn(),
}));

const { parseFullyQualifiedModelImpl, LLAMACPP_PROXY_BASE_URL } = vi.hoisted(() => ({
  parseFullyQualifiedModelImpl(fq: string) {
    const idx = fq.indexOf("/");
    if (idx <= 0 || idx === fq.length - 1) return null;
    return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
  },
  LLAMACPP_PROXY_BASE_URL: "http://127.0.0.1/setup-api/local-ai/llamacpp/v1",
}));

vi.mock("@/lib/openclaw-config", () => ({
  // A REAL class, not `vi.fn()` and not an omitted export: the configure route
  // narrows on `instanceof GatewayNotReadyError` to tell "the gateway has not
  // finished coming back" from "the restart was refused", and `instanceof
  // undefined` throws a TypeError the first time a test makes it reject.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
  DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR: 24000,
  compactionReserveFloorForContext: (contextWindow: number) =>
    Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.min(24000, Math.max(4096, Math.round(contextWindow / 4)))
      : 24000,
  restartGateway: vi.fn(),
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  // The configure route reads the config STRICTLY before it removes an
  // openai-compat override, so the mock has to carry both readers.
  readConfigStrict: vi.fn().mockResolvedValue({}),
  inferConfiguredLocalModel: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  spawnOpenclawCli: vi.fn().mockResolvedValue(""),
  runOpenclawDoctorFix: vi.fn().mockResolvedValue(undefined),
  runOpenclawConfigSetBatch: vi.fn(),
  runOpenclawConfigUnset: vi.fn(),
  applyModelOverrideToAllAgentSessions: vi.fn().mockResolvedValue(undefined),
  parseFullyQualifiedModel: vi.fn(parseFullyQualifiedModelImpl),
  setProviderPlugins: vi.fn().mockResolvedValue(undefined),
  openclawIsAbsent: vi.fn().mockReturnValue(false),
  OpenclawUnavailableError: class OpenclawUnavailableError extends Error {},
}));

vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: vi.fn().mockReturnValue("gemma4-e2b-it-q4_0"),
  getLlamaCppContextWindow: vi.fn().mockReturnValue(131072),
  getLlamaCppMaxTokens: vi.fn().mockReturnValue(131072),
  getLlamaCppProxyBaseUrl: vi.fn().mockReturnValue(LLAMACPP_PROXY_BASE_URL),
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyBaseUrl: vi.fn((provider: string) =>
    provider === "llamacpp"
      ? LLAMACPP_PROXY_BASE_URL
      : `http://127.0.0.1/setup-api/local-ai/${provider}`,
  ),
}));

// The INSTALLED core decides which of the two image-model homes is written
// (TASK-755), and on a machine with no core the honest answer is `unknown`,
// which writes neither. Every case here is about a box that HAS one, so the
// generation is stated rather than inherited from wherever the suite runs.
vi.mock("@/lib/openclaw-core-generation", () => ({
  installedOpenclawCoreGeneration: vi.fn(async () => "v2"),
}));

vi.mock("@/lib/local-ai-token", () => ({
  getLocalAiToken: vi.fn().mockReturnValue("a".repeat(64)),
  verifyLocalAiBearer: vi.fn().mockReturnValue(true),
  markLocalAiTokenMigrated: vi.fn(),
}));

import { getAll, setMany, get as configGet, set as configSet } from "@/lib/config-store";
import { unpairLocal } from "@/lib/clawkeep";
import {
  inferConfiguredLocalModel,
  readConfig,
  readConfigStrict,
  restartGateway,
  runOpenclawConfigSet,
  runOpenclawConfigSetBatch,
  runOpenclawConfigUnset,
  applyModelOverrideToAllAgentSessions,
  parseFullyQualifiedModel,
} from "@/lib/openclaw-config";
import { configSetCalls as recordedConfigSetCalls, failConfigSetsMatching } from "./config-set-calls";
import { installedOpenclawCoreGeneration } from "@/lib/openclaw-core-generation";

const mockSpawn = vi.mocked(childProcess.spawn);
const mockGetAll = vi.mocked(getAll);
const mockSetMany = vi.mocked(setMany);
const mockReadConfig = vi.mocked(readConfig);
const mockReadConfigStrict = vi.mocked(readConfigStrict);
const mockRunOpenclawConfigSet = vi.mocked(runOpenclawConfigSet);
const mockRunOpenclawConfigSetBatch = vi.mocked(runOpenclawConfigSetBatch);
const mockRunOpenclawConfigUnset = vi.mocked(runOpenclawConfigUnset);
const mockFs = vi.mocked(fsp);

function createSuccessfulChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  emitter.stdin = { end: vi.fn() } as unknown as ChildProcess["stdin"];
  emitter.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  emitter.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  emitter.kill = vi.fn();
  queueMicrotask(() => emitter.emit("close", 0));
  return emitter;
}

const CLAWAI_TOKEN = "claw_token123";
const PROXY_URL = "https://clawbox.com/api/ai";

describe("POST /setup-api/ai-models/configure — ClawBox AI image provider", () => {
  let configurePost: (req: Request) => Promise<Response>;

  // The two config paths this feature is about: where the image credential
  // lives now, and where every box in the field still has it.
  const IMAGE_KEY = `models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}.apiKey`;
  const IMAGE_BASE_URL = `models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}.baseUrl`;
  const LEGACY_PROVIDER = `models.providers.${CLAWBOX_AI_LEGACY_IMAGE_PROVIDER}`;

  function jsonRequest(body: unknown): Request {
    return new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * Every `openclaw config set` assignment the route made, as [path, ...rest]
   * tuples — whether it went out on its own or inside a batch.
   */
  function configSetCalls(): string[][] {
    return recordedConfigSetCalls(mockRunOpenclawConfigSet, mockRunOpenclawConfigSetBatch)
      .map((call) => call.args);
  }

  function callFor(path: string): string[] | undefined {
    return configSetCalls().find((args) => args[0] === path);
  }

  /** Every `openclaw config unset <path>` the route ran. */
  function unsetPaths(): string[] {
    return mockRunOpenclawConfigUnset.mock.calls.map((call) => String(call[0]));
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, profiles: {} }));
    mockFs.writeFile.mockResolvedValue();
    mockFs.rename.mockResolvedValue();
    mockFs.chown.mockResolvedValue();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.rm.mockResolvedValue(undefined);
    mockFs.unlink.mockResolvedValue(undefined);
    mockGetAll.mockResolvedValue({});
    mockReadConfig.mockResolvedValue({});
    mockReadConfigStrict.mockResolvedValue({});
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    mockSetMany.mockResolvedValue();
    vi.mocked(restartGateway).mockResolvedValue();
    mockSpawn.mockImplementation(() => createSuccessfulChildProcess());
    mockRunOpenclawConfigSet.mockResolvedValue(undefined);
    mockRunOpenclawConfigSetBatch.mockResolvedValue(undefined);
    mockRunOpenclawConfigUnset.mockResolvedValue(undefined);
    vi.mocked(unpairLocal).mockResolvedValue(undefined);
    vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0, sessionsSkipped: 0 });
    vi.mocked(parseFullyQualifiedModel).mockImplementation(parseFullyQualifiedModelImpl);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));

    const mod = await import("@/app/setup-api/ai-models/configure/route");
    configurePost = mod.POST;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function connectClawai(token = CLAWAI_TOKEN) {
    const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: token }));
    expect(res.status).toBe(200);
    return res;
  }

  describe("provisioning", () => {
    it("points the ClawBox AI image provider at the proxy, on its own provider id", async () => {
      await connectClawai();

      expect(callFor(IMAGE_KEY)).toEqual([IMAGE_KEY, CLAWAI_TOKEN]);
      expect(callFor(IMAGE_BASE_URL)).toEqual([IMAGE_BASE_URL, PROXY_URL]);
    });

    it("never puts the ClawBox AI token on the openai provider's auth", async () => {
      // THE DEFECT this change exists for. On the pinned core a literal
      // `models.providers.openai.apiKey` makes `prepareAgentRuntimeAuth` infer
      // an api-key route requirement for the WHOLE provider — with no
      // `auth: "api-key"` field anywhere — and `selectProviderModelRouteAuth`
      // then keeps only profiles whose mode maps to that requirement. An OAuth
      // profile maps to `subscription`, so a ChatGPT (Codex) sign-in is
      // filtered out of its own provider and the portal token is sent to
      // api.openai.com: 401 on every turn, then a silent failover.
      await connectClawai();

      const paths = configSetCalls().map((args) => args[0]);
      expect(paths).not.toContain(`${LEGACY_PROVIDER}.apiKey`);
      expect(paths).not.toContain(`${LEGACY_PROVIDER}.models`);
      expect(paths.filter((path) => path.startsWith(`${LEGACY_PROVIDER}.`))).toEqual([]);
    });

    it("writes leaf paths, never the whole provider object", async () => {
      // `config set models.providers.<id> <blob>` would drop every other
      // setting the box carries under that id.
      await connectClawai();

      const paths = configSetCalls().map((args) => args[0]);
      expect(paths).not.toContain(`models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}`);
      expect(paths).toContain(IMAGE_KEY);
      expect(paths).toContain(IMAGE_BASE_URL);
    });

    it("writes no models[] row at all", async () => {
      // A configured row is exempt from the core's picker hide rule, so the
      // `openai` row this replaces stayed offerable as a chat model in
      // OpenClaw's own surfaces whatever ClawBox did. The generic
      // OpenAI-compatible image provider reads the provider-level baseUrl and
      // passes `req.model` straight through, so the row has no job left.
      await connectClawai();

      expect(callFor(`models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}.models`)).toBeUndefined();
    });

    it("sets agents.defaults.mediaModels.image — the write that makes the tool appear", async () => {
      // It is also what enables the bundled image plugin at gateway start:
      // `collectConfiguredGenerationProviderIds` reads the provider id out of
      // this slot. Not `imageModel`: that is a separate key selecting vision.
      await connectClawai();

      const call = callFor("agents.defaults.mediaModels.image");
      expect(call?.[2]).toBe("--json");
      expect(JSON.parse(call?.[1] ?? "null")).toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
      const visionCall = callFor("agents.defaults.imageModel");
      expect(JSON.parse(visionCall?.[1] ?? "null")).not.toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });

    it("names the model under the provider whose entry it just wrote", async () => {
      await connectClawai();

      const slot = JSON.parse(callFor("agents.defaults.mediaModels.image")?.[1] ?? "null");
      expect(slot.primary).toBe(`${CLAWBOX_AI_IMAGE_PROVIDER}/${CLAWBOX_AI_IMAGE_MODEL_ID}`);
    });

    it("provisions images on the fallback path too", async () => {
      // configureClawboxAi also runs from ensureFallbackModel — i.e. the user
      // is configuring some other provider and ClawBox AI is only the fallback.
      // Image generation belongs to the token, not to the chat choice.
      mockGetAll.mockResolvedValue({ clawai_token: CLAWAI_TOKEN });

      const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-key" }));

      expect(res.status).toBe(200);
      expect(callFor(IMAGE_KEY)).toBeDefined();
      expect(callFor("agents.defaults.mediaModels.image")).toBeDefined();
    });

    it("does not touch the image provider when there is no ClawBox AI token", async () => {
      const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-key" }));

      expect(res.status).toBe(200);
      expect(callFor(IMAGE_KEY)).toBeUndefined();
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });
  });

  describe("migrating a box provisioned on the openai provider", () => {
    /** The shape in the field: our key and our row on `models.providers.openai`. */
    const OUR_LEGACY_ROW = {
      id: CLAWBOX_AI_IMAGE_MODEL_ID,
      name: "ClawBox AI Images",
      baseUrl: PROXY_URL,
    };

    function legacyBox(openai: Record<string, unknown> = { apiKey: "claw_old", models: [OUR_LEGACY_ROW] }, defaults?: unknown) {
      mockReadConfig.mockResolvedValue({
        models: { providers: { openai } },
        ...(defaults === undefined ? {} : { agents: { defaults } }),
      } as never);
    }

    /** The `models[]` the route wrote back to the legacy provider, or undefined. */
    function writtenLegacyModels(): unknown {
      const call = mockRunOpenclawConfigSet.mock.calls
        .map((c) => c[0] as string[])
        .find((args) => args[0] === `${LEGACY_PROVIDER}.models`);
      return call === undefined ? undefined : JSON.parse(call[1]);
    }

    /** The flags that `models[]` write carried, or undefined. */
    function writtenLegacyModelsFlags(): string[] | undefined {
      const call = mockRunOpenclawConfigSet.mock.calls
        .map((c) => c[0] as string[])
        .find((args) => args[0] === `${LEGACY_PROVIDER}.models`);
      return call?.filter((arg) => arg.startsWith("--"));
    }

    it("removes the whole openai entry when nothing but ours was in it", async () => {
      legacyBox();

      await connectClawai();

      // `config set` cannot remove a key, and a present-but-empty
      // `models.providers.openai` is still a provider entry the core reads.
      expect(unsetPaths()).toContain(LEGACY_PROVIDER);
      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
    });

    it("keeps the rest of an openai entry the owner configured", async () => {
      // Leaf by leaf: the key and the rows are unset, and anything else the
      // owner put on that entry is never named at all.
      legacyBox({ apiKey: "claw_old", request: { timeoutMs: 90000 }, models: [OUR_LEGACY_ROW] });

      await connectClawai();

      expect(unsetPaths()).toEqual(
        expect.arrayContaining([`${LEGACY_PROVIDER}.apiKey`, `${LEGACY_PROVIDER}.models`]),
      );
      expect(unsetPaths()).not.toContain(LEGACY_PROVIDER);
      expect(unsetPaths()).not.toContain(`${LEGACY_PROVIDER}.request`);
    });

    it("keeps a sibling row of the owner's and removes only ours", async () => {
      const sibling = { id: "house-model", name: "House model", api: "openai-completions", baseUrl: PROXY_URL };
      legacyBox({ apiKey: "claw_old", models: [sibling, OUR_LEGACY_ROW] });

      await connectClawai();

      expect(writtenLegacyModels()).toEqual([sibling]);
      // `models.providers.<id>.models` is a PROTECTED path: a replacement that
      // removes entries is REFUSED without `--replace`, and `--batch-json` drops
      // per-entry flags — so this write has to be its own call, with the flag.
      expect(writtenLegacyModelsFlags()).toEqual(expect.arrayContaining(["--json", "--replace"]));
      expect(unsetPaths()).toContain(`${LEGACY_PROVIDER}.apiKey`);
      expect(unsetPaths()).not.toContain(`${LEGACY_PROVIDER}.models`);
    });

    it("removes every duplicate of our row, not just the first", async () => {
      legacyBox({ apiKey: "claw_old", models: [OUR_LEGACY_ROW, { ...OUR_LEGACY_ROW, api: "openai-completions" }] });

      await connectClawai();

      expect(unsetPaths()).toContain(LEGACY_PROVIDER);
    });

    it("recognises our row on a RETIRED proxy host as ours", async () => {
      // A box paired before the clawbox.com move still names an old host. The
      // ownership set carries every host ClawBox has ever written.
      legacyBox({
        apiKey: "claw_old",
        models: [{ ...OUR_LEGACY_ROW, baseUrl: "https://www.openclawhardware.dev/api/ai" }],
      });

      await connectClawai();

      expect(unsetPaths()).toContain(LEGACY_PROVIDER);
    });

    it("recognises a row naming the default port explicitly", async () => {
      // `new URL(u).host` drops :443 and the boot migration's python normaliser
      // once kept it, so the two writers disagreed about the same row.
      legacyBox({ apiKey: "claw_old", models: [{ ...OUR_LEGACY_ROW, baseUrl: "https://clawbox.com:443/api/ai" }] });

      await connectClawai();

      expect(unsetPaths()).toContain(LEGACY_PROVIDER);
    });

    it("repoints a slot that still names the legacy ref", async () => {
      legacyBox({ apiKey: "claw_old", models: [OUR_LEGACY_ROW] }, {
        mediaModels: { image: { primary: CLAWBOX_AI_LEGACY_IMAGE_MODEL } },
      });

      await connectClawai();

      expect(JSON.parse(callFor("agents.defaults.mediaModels.image")?.[1] ?? "null"))
        .toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });

    it("repoints a bare-string slot naming the legacy ref", async () => {
      // The core resolves a bare string as a model, and this one names the
      // provider entry the migration has just removed.
      legacyBox({ apiKey: "claw_old", models: [OUR_LEGACY_ROW] }, {
        mediaModels: { image: CLAWBOX_AI_LEGACY_IMAGE_MODEL },
      });

      await connectClawai();

      expect(JSON.parse(callFor("agents.defaults.mediaModels.image")?.[1] ?? "null"))
        .toEqual({ primary: CLAWBOX_AI_IMAGE_MODEL });
    });

    it("leaves our legacy primary alone once the owner has added fallbacks to it", async () => {
      // We only ever wrote `{primary: <our ref>}` into an EMPTY slot.
      legacyBox({ apiKey: "claw_old", models: [OUR_LEGACY_ROW] }, {
        mediaModels: { image: { primary: CLAWBOX_AI_LEGACY_IMAGE_MODEL, fallbacks: ["replicate/flux-pro"] } },
      });

      await connectClawai();

      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("leaves an owner's own OpenAI key and their row of our id exactly as they are", async () => {
      // ClawBox has never written a non-`claw_` key there, so it is the owner's
      // credential; and `gpt-image-1-mini` on their own host is their row.
      const theirs = { id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "My Azure image model", baseUrl: "https://my-azure.example/openai/v1" };
      legacyBox({ apiKey: "sk-proj-users-own-key", models: [theirs] });

      await connectClawai();

      expect(writtenLegacyModels()).toBeUndefined();
      expect(unsetPaths().filter((path) => path.startsWith(LEGACY_PROVIDER))).toEqual([]);
    });

    it("still gives such a box its own image provider on the new id", async () => {
      // The owner's OpenAI setup is not a reason to withhold pictures: the two
      // providers are independent now, which is the whole point of the move.
      legacyBox({ apiKey: "sk-proj-users-own-key" });

      await connectClawai();

      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
      expect(callFor("agents.defaults.mediaModels.image")).toBeDefined();
    });

    it("removes the key even when the new provider is one we refuse to touch", async () => {
      // The key is a defect on its own, so the cleanup is not conditional on
      // the new write landing. A box running a real LiteLLM proxy gets no
      // ClawBox image provider — and still gets its ChatGPT lane back.
      mockReadConfig.mockResolvedValue({
        models: {
          providers: {
            openai: { apiKey: "claw_old", models: [OUR_LEGACY_ROW] },
            [CLAWBOX_AI_IMAGE_PROVIDER]: { apiKey: "sk-litellm-users-own-key" },
          },
        },
      } as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await connectClawai();
      } finally {
        warn.mockRestore();
      }

      expect(unsetPaths()).toContain(LEGACY_PROVIDER);
      expect(callFor(IMAGE_KEY)).toBeUndefined();
    });

    it("removes the key on a box whose credential the proxy has refused", async () => {
      // The image path stands down there (TASK-727), and the key still has to
      // come off: a dead credential is no reason to keep hiding a sign-in.
      const keys: Record<string, unknown> = {
        clawai_credential_refused_at: 1_788_000_000_000,
        clawai_token: CLAWAI_TOKEN,
      };
      vi.mocked(configGet).mockImplementation(async (key: string) => keys[key]);
      mockGetAll.mockImplementation(async () => ({ ...keys }));
      legacyBox();

      const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-test" }));

      expect(res.status).toBe(200);
      expect(unsetPaths()).toContain(LEGACY_PROVIDER);
      expect(callFor(IMAGE_KEY)).toBeUndefined();
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("does nothing to a box that never had an openai entry", async () => {
      await connectClawai();

      expect(unsetPaths()).toEqual([]);
      expect(callFor(LEGACY_PROVIDER)).toBeUndefined();
    });

    it("does not report failure when the removal of an absent path fails", async () => {
      // `config unset` exits 1 on a path that is already gone, and a tidy-up
      // that could not run must not fail a ClawBox AI connect that did.
      legacyBox();
      mockRunOpenclawConfigUnset.mockRejectedValue(new Error("Config path not found"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await connectClawai();
        expect(res.status).toBe(200);
        expect(warn.mock.calls.map((call) => call.join(" ")).join("\n"))
          .toContain("Failed to remove the legacy ClawBox AI image provider entry");
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("ownership of the image provider's apiKey", () => {
    // ClawBox has never written this field on the new provider id, so a literal
    // value there is the owner's own LiteLLM credential and we refuse rather
    // than overwrite it.
    it.each<[string, unknown]>([
      ["absent", undefined],
      ["null", null],
      ["an empty string", ""],
      ["whitespace", "   "],
      ["a claw_ token we wrote", "claw_older_token"],
    ])("claims the slot when it holds %s", async (_label, apiKey) => {
      mockReadConfig.mockResolvedValue({
        models: { providers: { [CLAWBOX_AI_IMAGE_PROVIDER]: { apiKey } } },
      } as never);

      await connectClawai();

      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
      expect(callFor("agents.defaults.mediaModels.image")).toBeDefined();
    });

    it.each<[string, unknown]>([
      ["a real LiteLLM key", "sk-litellm-users-own-key"],
      ["a padded key", "  sk-litellm-users-own-key  "],
      ["a number", 12345],
      ["an object", { $env: "LITELLM_API_KEY" }],
      ["an array", ["sk-litellm-key"]],
    ])("backs off entirely when it holds %s", async (_label, apiKey) => {
      mockReadConfig.mockResolvedValue({
        models: { providers: { [CLAWBOX_AI_IMAGE_PROVIDER]: { apiKey } } },
      } as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let res: Response;
      try {
        res = await connectClawai();
      } finally {
        warn.mockRestore();
      }

      expect(res.status).toBe(200); // still a successful ClawBox AI connect
      expect(callFor(IMAGE_KEY)).toBeUndefined();
      expect(callFor(IMAGE_BASE_URL)).toBeUndefined();
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
      // …and the chat provider was configured regardless.
      expect(callFor("models.providers.deepseek")).toBeDefined();
    });

    it("treats an unreadable config as a fresh box with nothing to preserve", async () => {
      mockReadConfig.mockRejectedValue(new Error("ENOENT"));

      await connectClawai();

      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
    });
  });

  describe("will not make the portal token the credential for someone else's endpoint", () => {
    // `models.providers.<id>.apiKey` is provider-wide — nothing scopes it to the
    // image model — so before writing it we have to know that every route
    // already configured under that id stays on our own proxy.
    async function backsOff(entry: Record<string, unknown>) {
      mockReadConfig.mockResolvedValue({
        models: { providers: { [CLAWBOX_AI_IMAGE_PROVIDER]: entry } },
      } as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await connectClawai();

        expect(res.status).toBe(200); // ClawBox AI chat still connected
        expect(callFor(IMAGE_KEY)).toBeUndefined();
        expect(callFor(IMAGE_BASE_URL)).toBeUndefined();
        expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
        expect(callFor("models.providers.deepseek")).toBeDefined();
        return warn.mock.calls.map((call) => call.join(" ")).join("\n");
      } finally {
        warn.mockRestore();
      }
    }

    it("backs off on a sibling row that resolves to the provider's default host", async () => {
      const logged = await backsOff({ models: [{ id: "gpt-5", name: "GPT-5", api: "openai-completions" }] });

      expect(logged).toContain("Skipped ClawBox AI image provider");
      expect(logged).toContain("localhost:4000");
    });

    it("backs off on a sibling row pointing at a third-party host", async () => {
      await backsOff({
        models: [{ id: "local-gpt", name: "Local GPT", api: "openai-completions", baseUrl: "https://someone-elses-proxy.example/v1" }],
      });
    });

    it("backs off on a provider-level baseUrl that is not ours", async () => {
      // The owner's own LiteLLM proxy. Every row without a baseUrl of its own
      // inherits this one.
      const logged = await backsOff({ baseUrl: "https://someone-elses-proxy.example/v1" });

      expect(logged).toContain("someone-elses-proxy.example");
    });

    it("backs off on a baseUrl it cannot parse", async () => {
      await backsOff({ models: [{ id: "mystery", name: "Mystery", baseUrl: "not-a-url" }] });
    });

    it("leaves an owner's own row of OUR id on their private proxy alone", async () => {
      // `gpt-image-1-mini` is a real OpenAI model id, and a self-hosted
      // OpenAI-compatible gateway is where a power user's row of it lives.
      const logged = await backsOff({
        models: [{
          id: CLAWBOX_AI_IMAGE_MODEL_ID,
          name: "My Azure image model",
          baseUrl: "https://my-azure.example/openai/v1",
        }],
      });

      expect(logged).toContain("my-azure.example");
    });

    it("leaves an owner's row of OUR id with no baseUrl alone", async () => {
      // ClawBox has always written a baseUrl on its own row, so a row without
      // one is the owner's, inheriting whatever the provider block says.
      await backsOff({
        models: [{ id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "gpt-image-1-mini", api: "openai-completions" }],
      });
    });

    it("proceeds when a sibling row points at a RETIRED ClawBox proxy host", async () => {
      // The foreignness test asks "would our token leave the building?", so it
      // has to know every host ClawBox has ever written — and the boot
      // migration, which this mirrors, has to agree.
      mockReadConfig.mockResolvedValue({
        models: {
          providers: {
            deepseek: { apiKey: CLAWAI_TOKEN, baseUrl: PROXY_URL },
            [CLAWBOX_AI_IMAGE_PROVIDER]: {
              models: [{ id: "house-model", name: "House model", baseUrl: "https://www.openclawhardware.dev/api/ai" }],
            },
          },
        },
      } as never);
      await connectClawai();

      expect(callFor(IMAGE_KEY)).toBeDefined();
    });

    it("still aborts when the deepseek entry is a RAW key at a genuine third party", async () => {
      // install.sh's CLAWBOX_AI_API_KEY branch provisions a raw DeepSeek key at
      // api.deepseek.com. Seeding the proxy-host set from the live baseUrl
      // would make that host "not foreign" and write the portal token as the
      // bearer for a route that leaves for DeepSeek.
      mockReadConfig.mockResolvedValue({
        models: {
          providers: {
            deepseek: { apiKey: "sk-deepseek-raw", baseUrl: "https://api.deepseek.com" },
            [CLAWBOX_AI_IMAGE_PROVIDER]: {
              models: [{ id: "deepseek-chat", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" }],
            },
          },
        },
      } as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await connectClawai();
        expect(warn.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("Skipped ClawBox AI image provider");
      } finally {
        warn.mockRestore();
      }

      expect(callFor(IMAGE_KEY)).toBeUndefined();
    });

    it("proceeds when a sibling row points at the same proxy we do", async () => {
      mockReadConfig.mockResolvedValue({
        models: { providers: { [CLAWBOX_AI_IMAGE_PROVIDER]: { models: [{ id: "house-model", name: "House model", baseUrl: PROXY_URL }] } } },
      } as never);

      await connectClawai();

      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
    });

    it("proceeds on a box whose only row is one of ours from an older build", async () => {
      // Re-configuring must not back off on this route's own previous output.
      mockReadConfig.mockResolvedValue({
        models: {
          providers: {
            [CLAWBOX_AI_IMAGE_PROVIDER]: {
              apiKey: "claw_old",
              models: [{ id: CLAWBOX_AI_IMAGE_MODEL_ID, name: "ClawBox AI Images", baseUrl: PROXY_URL }],
            },
          },
        },
      } as never);

      await connectClawai();

      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
    });
  });

  describe("does not steal an image model the owner already chose", () => {
    /**
     * `undefined` means the KEY IS ABSENT, not present holding undefined.
     * openclaw.json is JSON, so a key can be missing or `null` and never
     * `undefined` — and since TASK-743 the difference decides the answer: a
     * legacy key that is THERE, whatever it holds, is a migration the core
     * still owes this box.
     */
    async function connectWithImageModel(imageGenerationModel?: unknown) {
      const defaults = arguments.length === 0
        ? {}
        : { imageGenerationModel };
      mockReadConfig.mockResolvedValue({ agents: { defaults } } as never);
      await connectClawai();
    }

    it("leaves an existing primary alone", async () => {
      await connectWithImageModel({ primary: "replicate/flux-pro" });
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("leaves a fallbacks-only config alone", async () => {
      // The write replaces the whole object, so testing `primary` alone would
      // delete the owner's fallbacks. OpenClaw's own gate (hasToolModelConfig)
      // accepts primary OR a non-empty fallback.
      await connectWithImageModel({ fallbacks: ["replicate/flux-pro"] });
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("leaves a primary+fallbacks config alone", async () => {
      await connectWithImageModel({ primary: "replicate/flux-pro", fallbacks: ["stability/sd3"] });
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("still provisions the provider entry when the slot is taken", async () => {
      // The credential and the endpoint are ours regardless; only the slot is not.
      await connectWithImageModel({ fallbacks: ["replicate/flux-pro"] });

      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
      expect(callFor(IMAGE_BASE_URL)).toBeDefined();
    });

    it("leaves a BARE STRING in the v2 home alone — the core resolves one (TASK-755)", async () => {
      // Measured on 2026.8.1: `resolvePrimaryStringValue` returns the string
      // itself, so `hasExplicitToolModelConfig` answers true. A dict-only test
      // reads that as an empty slot and replaces it — an owner-authored model
      // gone, on a save about some other provider.
      mockReadConfig.mockResolvedValue({
        agents: { defaults: { mediaModels: { image: "replicate/flux-pro" } } },
      } as never);

      await connectClawai();

      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
      // …and the provider entry is still ours to write.
      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
    });

    it("leaves a bare string in the LEGACY home alone for the same reason", async () => {
      await connectWithImageModel("replicate/flux-pro");

      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
    });

    it("leaves a bare string in agents.defaults.imageModel alone", async () => {
      // The SAME helper reads the vision slot, and the core coerces a string
      // there too. Claiming it would overrule the model the owner chose for
      // looking at pictures he sends.
      mockReadConfig.mockResolvedValue({
        agents: { defaults: { imageModel: "openai/gpt-4o" } },
      } as never);

      await connectClawai();

      expect(callFor("agents.defaults.imageModel")).toBeUndefined();
    });

    it.each<[string, unknown]>([
      ["a blank string", "   "],
      ["an empty string", ""],
    ])("still claims the v2 home when it holds %s", async (_label, existing) => {
      mockReadConfig.mockResolvedValue({
        agents: { defaults: { mediaModels: { image: existing } } },
      } as never);

      await connectClawai();

      expect(callFor("agents.defaults.mediaModels.image")).toBeDefined();
    });

    it("does not steal it on the fallback path either", async () => {
      mockGetAll.mockResolvedValue({ clawai_token: CLAWAI_TOKEN });
      mockReadConfig.mockResolvedValue({
        agents: { defaults: { imageGenerationModel: { fallbacks: ["replicate/flux-pro"] } } },
      } as never);

      await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-key" }));

      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("leaves an owner's own mediaModels.image alone", async () => {
      mockReadConfig.mockResolvedValue({
        agents: { defaults: { mediaModels: { image: { primary: "replicate/flux-pro" } } } },
      } as never);
      await connectClawai();

      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
      // The provider entry is still ours to write; only the slot is not.
      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
    });

    it("leaves an owner's fallbacks-only mediaModels.image alone", async () => {
      mockReadConfig.mockResolvedValue({
        agents: { defaults: { mediaModels: { image: { fallbacks: ["replicate/flux-pro"] } } } },
      } as never);
      await connectClawai();

      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("claims the slot when the legacy key is absent altogether", async () => {
      await connectWithImageModel();

      expect(JSON.parse(callFor("agents.defaults.mediaModels.image")?.[1] ?? "null")).toEqual({
        primary: CLAWBOX_AI_IMAGE_MODEL,
      });
    });

    /**
     * TASK-743 — the same stand-down `scripts/gateway-pre-start.sh` gained, in
     * the OTHER writer of this slot. Both homes present is what OpenClaw 2026.8
     * refuses outright (`agents.defaults: Unrecognized key:
     * "imageGenerationModel"`, gateway exit 78), and it strands the box: the
     * core's loader migration moves the legacy key only into a home that is
     * EMPTY, so a `mediaModels.image` written here stops it being moved.
     */
    it.each<[string, unknown]>([
      ["null", null],
      ["an empty object", {}],
      ["a blank primary", { primary: "   " }],
      ["an empty fallbacks list", { fallbacks: [] }],
      ["fallbacks holding only blanks", { fallbacks: ["", "  "] }],
      ["fallbacks that is not a list", { fallbacks: "replicate/flux-pro" }],
      ["a non-string primary", { primary: 42 }],
      ["a plain string", "replicate/flux-pro"],
    ])("stands down while a legacy key holding %s is still on the box", async (_label, existing) => {
      await connectWithImageModel(existing);

      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
      // The provider entry is still ours to write — only the slot waits.
      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
      expect(callFor(IMAGE_BASE_URL)).toBeDefined();
      // …and nothing writes the legacy key back: this route is not the
      // migrator either.
      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
    });
  });

  describe("which home the installed core decides (TASK-755)", () => {
    /**
     * `agents.defaults` is `.strict()` on BOTH generations, so the wrong name
     * is `Unrecognized key` and gateway exit 78 — not a key quietly ignored.
     */
    it("writes the legacy home on a v1 core", async () => {
      vi.mocked(installedOpenclawCoreGeneration).mockResolvedValueOnce("v1");

      await connectClawai();

      expect(callFor("agents.defaults.imageGenerationModel")?.[1])
        .toBe(JSON.stringify({ primary: CLAWBOX_AI_IMAGE_MODEL }));
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("writes NEITHER home when the installed core cannot be identified", async () => {
      // A half-finished update is exactly the state in which the core cannot be
      // read AND in which a guess from the repository pin would be wrong.
      vi.mocked(installedOpenclawCoreGeneration).mockResolvedValueOnce("unknown");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let res: Response;
      try {
        res = await connectClawai();
      } finally {
        warn.mockRestore();
      }

      expect(res.status).toBe(200);
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
      // …and the provider entry is written regardless: it has one home on both
      // generations.
      expect(callFor(IMAGE_KEY)?.[1]).toBe(CLAWAI_TOKEN);
      expect(callFor(IMAGE_BASE_URL)).toBeDefined();
    });

    it("writes the legacy home on a v1 core whose legacy key is present but empty", async () => {
      // On a v1 core that key is not legacy at all — it is the slot's ONLY home
      // — so standing down over it leaves the box with no image path while the
      // boot script, whose sibling guard IS generation-gated, writes it.
      vi.mocked(installedOpenclawCoreGeneration).mockResolvedValue("v1");
      mockReadConfig.mockResolvedValue({
        agents: { defaults: { imageGenerationModel: { primary: "" } } },
      } as never);

      await connectClawai();

      expect(callFor("agents.defaults.imageGenerationModel")?.[1])
        .toBe(JSON.stringify({ primary: CLAWBOX_AI_IMAGE_MODEL }));
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
    });

    it("still stands down on a v2 core whose legacy key is present but empty", async () => {
      vi.mocked(installedOpenclawCoreGeneration).mockResolvedValue("v2");
      mockReadConfig.mockResolvedValue({
        agents: { defaults: { imageGenerationModel: { primary: "" } } },
      } as never);

      await connectClawai();

      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
    });

    it("does not ask the core at all when the slot is already configured", async () => {
      // The probe sits below every early return on purpose: the ordinary save
      // must not pay a file read for a decision it never reaches.
      vi.mocked(installedOpenclawCoreGeneration).mockClear();

      mockReadConfig.mockResolvedValue({
        agents: { defaults: { mediaModels: { image: { primary: "replicate/flux-pro" } } } },
      } as never);

      await connectClawai();

      expect(installedOpenclawCoreGeneration).not.toHaveBeenCalled();
    });
  });

  describe("what the failure path is allowed to write to the journal", () => {
    /** The single journal record the image-provider catch produced. */
    async function failImageWritesWith(message: string): Promise<string> {
      failConfigSetsMatching(
        mockRunOpenclawConfigSet,
        mockRunOpenclawConfigSetBatch,
        (path) => path.startsWith(`models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}`),
        () => new Error(message),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await connectClawai();
        const records = warn.mock.calls
          .map((call) => call.map(String).join(" "))
          .filter((record) => record.includes("ClawBox AI image provider"));
        // One distinct record is what matters here — the route may report the
        // same failure more than once (the combined batch fails first, then the
        // image group fails again on its own boundary), but it must never
        // produce two DIFFERENT records from one subprocess message.
        expect(records.length).toBeGreaterThan(0);
        expect(new Set(records).size).toBe(1);
        return records[0];
      } finally {
        warn.mockRestore();
      }
    }

    it("does not let a subprocess error forge extra log records", async () => {
      // CodeQL "Log injection": the message is built from whatever `openclaw`
      // wrote to stderr, and a value reaches that CLI straight from this
      // route's request body.
      const logged = await failImageWritesWith("boom\nWARN forged record\r\n[31mred");

      expect(logged).toContain("Failed to configure ClawBox AI image provider");
      expect(logged).not.toContain("\n[31m");
      expect(logged.split("\n")).toHaveLength(1);
      expect(logged).toContain("�");
    });

    it("bounds the record instead of letting the CLI size it", async () => {
      const logged = await failImageWritesWith("x".repeat(5000));

      expect(logged.length).toBeLessThan(400);
      expect(logged).toContain("chars]");
    });
  });

  /*
   * TASK-727, the TypeScript half of the boot script's stand-down.
   *
   * `scripts/gateway-pre-start.sh` takes the image provider and the image slot
   * back when the proxy has permanently refused this box's credential — and
   * this function writes exactly those keys. It also runs on saves that have
   * nothing to do with ClawBox AI: `ensureFallbackModel` calls
   * `configureClawboxAi(true, undefined)` whenever a box with no local model
   * saves ANY provider, re-pasting the STORED token.
   */
  describe("a credential the proxy has refused", () => {
    function refusedBox(storedToken = CLAWAI_TOKEN) {
      const keys: Record<string, unknown> = {
        clawai_credential_refused_at: 1_788_000_000_000,
        clawai_token: storedToken,
      };
      vi.mocked(configGet).mockImplementation(async (key: string) => keys[key]);
      vi.mocked(configSet).mockImplementation(async (key: string, value: unknown) => {
        if (value === undefined) delete keys[key];
        else keys[key] = value;
      });
      mockGetAll.mockImplementation(async () => ({ ...keys }));
      // `setMany` MUST land in the same store, or the fixture models a box the
      // route never sees.
      mockSetMany.mockImplementation(async (entries: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(entries)) {
          if (value === undefined) delete keys[key];
          else keys[key] = value;
        }
      });
    }

    it("writes no image ops while a refusal is on record", async () => {
      refusedBox();

      const res = await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-test" }));

      expect(res.status).toBe(200);
      expect(configSetCalls().filter(([path]) => path.startsWith(`models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}`))).toEqual([]);
      expect(callFor("agents.defaults.mediaModels.image")).toBeUndefined();
      expect(callFor("agents.defaults.imageGenerationModel")).toBeUndefined();
    });

    it("does not retire the refusal on a pass that re-pastes the same token", async () => {
      // The mark is about the CREDENTIAL. Re-pasting the bytes the box already
      // holds is not a re-link.
      refusedBox();

      await configurePost(jsonRequest({ provider: "anthropic", apiKey: "sk-ant-test" }));

      expect(vi.mocked(configSet)).not.toHaveBeenCalledWith("clawai_credential_refused_at", undefined);
    });

    it("retires it and arms the image path again when the token really changes", async () => {
      refusedBox("claw_OLD");

      const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: "claw_NEW" }));

      expect(res.status).toBe(200);
      expect(vi.mocked(configSet)).toHaveBeenCalledWith("clawai_credential_refused_at", undefined);
      expect(callFor("agents.defaults.mediaModels.image")).toBeDefined();
    });
  });

  describe("failure containment", () => {
    it("still connects ClawBox AI when the image writes fail", async () => {
      // A chat provider that works is worth more than an image tool.
      failConfigSetsMatching(
        mockRunOpenclawConfigSet,
        mockRunOpenclawConfigSetBatch,
        (path) => path.startsWith(`models.providers.${CLAWBOX_AI_IMAGE_PROVIDER}`),
        () => new Error("config write conflict"),
      );

      const res = await configurePost(jsonRequest({ provider: "clawai", apiKey: CLAWAI_TOKEN }));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockSetMany).toHaveBeenCalledWith(
        expect.objectContaining({ ai_model_configured: true, clawai_token: CLAWAI_TOKEN }),
      );
    });
  });
});
