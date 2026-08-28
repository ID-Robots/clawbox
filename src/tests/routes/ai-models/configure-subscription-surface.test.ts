import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as childProcess from "child_process";
import fsp from "fs/promises";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// The route writes auth-profiles.json through `fs/promises`; the surface
// reader reads the catalog cache through `fs`.promises. Two module ids, two
// mocks — and the `fs` one keeps the real module except for that one read, so
// nothing else that touches the filesystem loses its implementation.
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

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: actual,
    promises: { ...actual.promises, readFile: vi.fn() },
  };
});

vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
  setMany: vi.fn(),
}));

vi.mock("@/lib/clawkeep", () => ({ unpairLocal: vi.fn() }));

// Out-of-band by design (see configure.test.ts) — stubbed so nothing logs
// after the test that triggered it has finished.
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  refreshInBackground: vi.fn(),
}));

const { parseFullyQualifiedModelImpl } = vi.hoisted(() => ({
  parseFullyQualifiedModelImpl(fq: string) {
    const idx = fq.indexOf("/");
    if (idx <= 0 || idx === fq.length - 1) return null;
    return { provider: fq.slice(0, idx), modelId: fq.slice(idx + 1) };
  },
}));

vi.mock("@/lib/openclaw-config", () => ({
  DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR: 24000,
  compactionReserveFloorForContext: () => 24000,
  restartGateway: vi.fn(),
  findOpenclawBin: vi.fn().mockReturnValue("/usr/local/bin/openclaw"),
  readConfig: vi.fn(),
  // The configure route imports this to remove a stale openai-compat override.
  // A factory mock replaces the whole module, so an export the route imports but
  // the factory omits fails module loading the moment a test reaches it.
  runOpenclawConfigUnset: vi.fn(),
  // The configure route reads the config STRICTLY before it removes an
  // openai-compat override, so the mock has to carry both readers.
  readConfigStrict: vi.fn().mockResolvedValue({}),
  inferConfiguredLocalModel: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  runOpenclawConfigSetBatch: vi.fn(),
  applyModelOverrideToAllAgentSessions: vi.fn(),
  parseFullyQualifiedModel: vi.fn(parseFullyQualifiedModelImpl),
  setProviderPlugins: vi.fn(),
  openclawIsAbsent: vi.fn().mockReturnValue(false),
  OpenclawUnavailableError: class OpenclawUnavailableError extends Error {},
}));

vi.mock("@/lib/llamacpp", () => ({
  getDefaultLlamaCppModel: vi.fn().mockReturnValue("gemma4-e2b-it-q4_0"),
  getLlamaCppContextWindow: vi.fn().mockReturnValue(131072),
  getLlamaCppMaxTokens: vi.fn().mockReturnValue(131072),
  getLlamaCppProxyBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1/llamacpp/v1"),
}));

vi.mock("@/lib/local-ai-runtime", () => ({
  getLocalAiProxyBaseUrl: vi.fn(() => "http://127.0.0.1/local-ai"),
  getOllamaBaseUrl: vi.fn(() => "http://127.0.0.1:11434"),
}));

vi.mock("@/lib/local-ai-token", () => ({
  getLocalAiToken: vi.fn().mockReturnValue("a".repeat(64)),
  verifyLocalAiBearer: vi.fn().mockReturnValue(true),
  markLocalAiTokenMigrated: vi.fn(),
}));

import { promises as nodeFsPromises } from "fs";
import { getAll, setMany } from "@/lib/config-store";
import {
  readConfig,
  readConfigStrict,
  restartGateway,
  runOpenclawConfigSet,
  runOpenclawConfigSetBatch,
  applyModelOverrideToAllAgentSessions,
  inferConfiguredLocalModel,
  setProviderPlugins,
} from "@/lib/openclaw-config";
import { unpairLocal } from "@/lib/clawkeep";
import { findConfigSet } from "./config-set-calls";

const mockFs = vi.mocked(fsp);
const mockSurfaceRead = vi.mocked(nodeFsPromises.readFile);
const mockSpawn = vi.mocked(childProcess.spawn);

/** Model ids the `claude-cli` (Claude-subscription) surface really carries. */
const SURFACE_IDS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
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

/** A spawned `openclaw` that exits 0 immediately — the happy-path stand-in. */
function successfulChild(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  emitter.stdin = { end: vi.fn() } as unknown as ChildProcess["stdin"];
  emitter.stdout = new EventEmitter() as unknown as ChildProcess["stdout"];
  emitter.stderr = new EventEmitter() as unknown as ChildProcess["stderr"];
  emitter.kill = vi.fn();
  queueMicrotask(() => emitter.emit("close", 0));
  return emitter;
}

/** A POST to the configure route carrying `body` as JSON. */
function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Every mock this route needs, back to its happy-path default, plus a freshly
 * imported handler. Module-level because BOTH subscription surfaces are tested
 * here and a second copy of this setup is a copy that can drift.
 */
async function primeConfigureRoute(): Promise<(request: Request) => Promise<Response>> {
  vi.resetModules();
  vi.clearAllMocks();

  mockFs.readFile.mockResolvedValue(JSON.stringify({ version: 1, profiles: {} }));
  mockFs.writeFile.mockResolvedValue();
  mockFs.rename.mockResolvedValue();
  mockFs.chown.mockResolvedValue();
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.rm.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);
  mockSurfaceRead.mockResolvedValue(surfaceCache(SURFACE_IDS) as never);

  vi.mocked(getAll).mockResolvedValue({});
  vi.mocked(setMany).mockResolvedValue();
  vi.mocked(readConfig).mockResolvedValue({} as never);
  vi.mocked(readConfigStrict).mockResolvedValue({} as never);
  vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
  vi.mocked(restartGateway).mockResolvedValue();
  vi.mocked(runOpenclawConfigSet).mockResolvedValue(undefined);
  vi.mocked(runOpenclawConfigSetBatch).mockResolvedValue(undefined);
  vi.mocked(applyModelOverrideToAllAgentSessions).mockResolvedValue({ filesUpdated: 0, sessionsUpdated: 0 });
  vi.mocked(setProviderPlugins).mockResolvedValue(undefined);
  vi.mocked(unpairLocal).mockResolvedValue(undefined);
  mockSpawn.mockImplementation(() => successfulChild());
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));

  return (await import("@/app/setup-api/ai-models/configure/route")).POST;
}

/** Nothing was written: not the credential file, not one config key. */
function expectNoSideEffects() {
  expect(mockFs.writeFile).not.toHaveBeenCalled();
  expect(runOpenclawConfigSet).not.toHaveBeenCalled();
  expect(runOpenclawConfigSetBatch).not.toHaveBeenCalled();
  expect(restartGateway).not.toHaveBeenCalled();
}

/**
 * The wizard/Settings save is the SECOND write path to
 * `agents.defaults.model.primary` — the chat header's switch is the first, and
 * the one #520 guarded "for ids that arrive some other way". This is that
 * other way: the custom-model field validates the typed id for SHAPE only
 * ("we don't check against the curated list"), the picker deliberately exempts
 * a typed id from its greying-out rule, and the OAuth save posts whatever is
 * in that field verbatim. So a Claude-subscription box could be pinned, from
 * the wizard, to exactly the model the chat header now refuses.
 */
describe("POST /setup-api/ai-models/configure and the Claude subscription surface", () => {
  let configurePost: (request: Request) => Promise<Response>;

  /** The wizard's Claude sign-in save, with `body` overriding its fields. */
  function subscribe(body: Record<string, unknown> = {}) {
    return jsonRequest({
      provider: "anthropic",
      apiKey: "oauth-access-token",
      authMode: "subscription",
      ...body,
    });
  }

  beforeEach(async () => {
    configurePost = await primeConfigureRoute();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("refuses a typed custom Claude id the subscription surface does not carry", async () => {
    const res = await configurePost(subscribe({ model: "claude-fable-5" }));

    expect(res.status).toBe(400);
    const { error } = await res.json();
    // Name the surface, exactly as the chat-header refusal does.
    expect(error).toContain("claude-cli");
    expect(error).toContain("claude-fable-5");
    // A rejection that has already persisted the credential is not a
    // rejection — it is a half-applied save the customer cannot see.
    expectNoSideEffects();
  });

  it("accepts a typed custom Claude id the subscription surface does carry", async () => {
    const res = await configurePost(subscribe({ model: "claude-opus-4-8" }));

    expect(res.status).toBe(200);
    expect(
      findConfigSet(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
        "agents.defaults.model.primary",
      )?.value,
    ).toBe("anthropic/claude-opus-4-8");
  });

  it("judges the provider DEFAULT too, not only a typed id", async () => {
    // The typed-id field is the way in that was reported, but the same write
    // carries the PROVIDERS-table default when nothing is typed. Guarding the
    // settled `config.defaultModel` covers both with one check.
    mockSurfaceRead.mockResolvedValue(
      surfaceCache(SURFACE_IDS.filter((id) => id !== "claude-sonnet-4-6")) as never,
    );

    const res = await configurePost(subscribe());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("claude-sonnet-4-6");
    expectNoSideEffects();
  });

  it("lets every Claude model through on an API-key save", async () => {
    // The save itself is what puts an anthropic key on the box, so this box is
    // not subscription-only once it lands — refusing here would block the very
    // switch the refusal message recommends.
    const res = await configurePost(jsonRequest({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-fable-5",
    }));

    expect(res.status).toBe(200);
  });

  it("lets a subscription save through when the box already holds an anthropic API key", async () => {
    // Both credentials means the API-only models still route.
    vi.mocked(readConfig).mockResolvedValue({
      auth: { profiles: { "anthropic:key": { provider: "anthropic", mode: "api_key" } } },
    } as never);

    const res = await configurePost(subscribe({ model: "claude-fable-5" }));

    expect(res.status).toBe(200);
  });

  it("lets the pick through when the surface could not be read at all", async () => {
    // UNKNOWN is not "no" — the same rule the pickers and the chat route obey.
    mockSurfaceRead.mockRejectedValue(new Error("ENOENT") as never);

    const res = await configurePost(subscribe({ model: "claude-fable-5" }));

    expect(res.status).toBe(200);
  });

  it("lets the pick through when the cached surface is empty", async () => {
    mockSurfaceRead.mockResolvedValue(surfaceCache([]) as never);

    const res = await configurePost(subscribe({ model: "claude-fable-5" }));

    expect(res.status).toBe(200);
  });

  it("does not read the Claude surface for a non-Claude provider", async () => {
    // The guard must cost nothing on a save it cannot apply to. On a Jetson a
    // stray cache read per save is not free.
    const res = await configurePost(jsonRequest({
      provider: "google",
      apiKey: "goog-key",
      model: "gemini-3-pro",
    }));

    expect(res.status).toBe(200);
    expect(mockSurfaceRead).not.toHaveBeenCalled();
  });
});

/**
 * The same gap, the other subscription.
 *
 * The Claude guard above was added here because the chat header refused an id
 * this route accepted. That is exactly true of ChatGPT as well: an OpenAI
 * subscription save swaps the namespace to `codex/`, whose catalogue is
 * narrower than the OpenAI one — the `-pro` tiers are API-key only and 400 on
 * the ChatGPT-account route. `/setup-api/chat/model` has refused that class
 * since it was written; this route validated the typed id for SHAPE only, so
 * the wizard and Settings would pin the box to precisely the id the chat
 * header rejects, and every turn afterwards fails upstream.
 *
 * It is also what ARMS the chat route's own second-site gap: an off-surface
 * `codex/*` id has to get into `agents.defaults.model.primary` before the
 * header can restore it, and this save is the only way in.
 */
describe("POST /setup-api/ai-models/configure and the ChatGPT subscription surface", () => {
  let configurePost: (request: Request) => Promise<Response>;

  /** An API-key-only model: the `-pro` tiers 400 on the ChatGPT-account route. */
  const OFF_SURFACE = "gpt-5.4-pro";
  /** Available on every ChatGPT tier including Free. */
  const ON_SURFACE = "gpt-5.5";

  /**
   * The wizard's ChatGPT sign-in save, with `body` overriding its fields.
   *
   * The access token has to be JWT-SHAPED: the route rejects a codex
   * subscription save whose credential is not three dot-separated segments,
   * long before either surface guard. Payload is `{"sub":"test"}` — a shape,
   * not a credential.
   */
  function chatgptSignIn(body: Record<string, unknown> = {}) {
    return jsonRequest({
      provider: "openai",
      apiKey: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.unsigned",
      authMode: "subscription",
      ...body,
    });
  }

  beforeEach(async () => {
    configurePost = await primeConfigureRoute();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("refuses a typed custom id the ChatGPT subscription cannot run", async () => {
    const res = await configurePost(chatgptSignIn({ model: OFF_SURFACE }));

    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain(OFF_SURFACE);
    // The same wording the chat header uses, so the two write paths cannot
    // disagree about what the customer is told.
    expect(error).toContain("ChatGPT subscription auth");
    // A refusal that has already persisted the OAuth token is not a refusal.
    expectNoSideEffects();
  });

  it("accepts a typed custom id the ChatGPT subscription can run", async () => {
    const res = await configurePost(chatgptSignIn({ model: ON_SURFACE }));

    expect(res.status).toBe(200);
    expect(
      findConfigSet(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
        "agents.defaults.model.primary",
      )?.value,
    ).toBe(`codex/${ON_SURFACE}`);
  });

  it("leaves an OpenAI API-key save alone", async () => {
    // API-key mode is the very thing the refusal message recommends, and it
    // writes the `openai/` namespace, where the -pro tiers route fine.
    const res = await configurePost(jsonRequest({
      provider: "openai",
      apiKey: "sk-test",
      model: OFF_SURFACE,
    }));

    expect(res.status).toBe(200);
    expect(
      findConfigSet(
        vi.mocked(runOpenclawConfigSet),
        vi.mocked(runOpenclawConfigSetBatch),
        "agents.defaults.model.primary",
      )?.value,
    ).toBe(`openai/${OFF_SURFACE}`);
  });

  it("does not forget the local model's claim on the primary slot when it refuses", async () => {
    // `local_ai_was_default` is what re-promotes the local model when it is
    // switched back on. Clearing it used to happen the moment the request was
    // parsed, so a save this route then REFUSED still changed how a later
    // local re-enable behaves — a rejection with a side effect, which is the
    // one thing the guards above exist to prevent.
    vi.mocked(getAll).mockResolvedValue({ local_ai_was_default: true });

    const res = await configurePost(chatgptSignIn({ model: OFF_SURFACE }));

    expect(res.status).toBe(400);
    expect(setMany).not.toHaveBeenCalled();
  });

  it("forgets it once the cloud save actually lands", async () => {
    vi.mocked(getAll).mockResolvedValue({ local_ai_was_default: true });

    const res = await configurePost(chatgptSignIn({ model: ON_SURFACE }));

    expect(res.status).toBe(200);
    expect(setMany).toHaveBeenCalledWith(
      expect.objectContaining({ local_ai_was_default: undefined }),
    );
  });

  it("lets the ChatGPT default through when nothing is typed", async () => {
    // The PROVIDERS-table subscription override is `codex/gpt-5.5`, which is
    // on-surface — the guard must not turn a plain sign-in into a 400.
    const res = await configurePost(chatgptSignIn());

    expect(res.status).toBe(200);
  });
});
