// "Turn off Local AI" set `agents.defaults.model.fallbacks` to `[]`, whatever
// the list held. Turning Local AI on had already put the local model in place
// of the ClawBox AI fallback, and nothing put that back on the way out — so
// after the click the box had no backup model at all: a primary that failed
// (a limit, an outage) failed the chat instead of falling back to ClawBox AI,
// and the route said success. A list that held no local model was emptied too.
//
// Held here, against an openclaw.json the CLI writes into: only local models
// leave the list; when that leaves it empty, the ClawBox AI fallback that
// enabling replaced comes back — but only on a box where ClawBox AI is set up
// and not switched off, the same rule the configure route's fallback writer
// keeps.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLAWBOX_AI_DEFAULT_TIER, CLAWBOX_AI_MODEL_BY_TIER } from "@/lib/clawbox-ai-models";

const disk = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  store: {} as Record<string, unknown>,
}));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => disk.store[key]),
  setMany: vi.fn(async () => undefined),
}));
vi.mock("@/lib/gateway-hot-apply", async (importOriginal) =>
  (await import("@/tests/helpers/gateway-hot-apply")).gatewayHotApplyMock(importOriginal));
vi.mock("@/lib/openclaw-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-config")>();
  return {
    inferConfiguredLocalModel: actual.inferConfiguredLocalModel,
    readConfig: vi.fn(async () => structuredClone(disk.config)),
    restartGateway: vi.fn(async () => undefined),
    // `openclaw config set <path> <json> --json`, into the file above.
    runOpenclawConfigSet: vi.fn(async ([key, value]: string[]) => {
      const parts = key.split(".");
      let node = disk.config as Record<string, unknown>;
      for (const part of parts.slice(0, -1)) {
        node[part] ??= {};
        node = node[part] as Record<string, unknown>;
      }
      node[parts[parts.length - 1]] = JSON.parse(value);
    }),
    openclawIsAbsent: vi.fn(() => false),
  };
});
vi.mock("@/lib/local-ai-runtime", () => ({ stopLocalAiProvider: vi.fn(async () => undefined) }));
// A local PRIMARY is moved back through chat/model (TASK-2127); nothing here has one.
vi.mock("@/app/setup-api/chat/model/route", () => ({ readChatModelStateUnfiltered: vi.fn(), POST: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/hermes-local-ai", () => ({
  removeLocalAiFromHermes: vi.fn(),
  HermesLocalRemovalError: class HermesLocalRemovalError extends Error {},
}));

const LOCAL = "llamacpp/gemma4-e2b-it-q4_0";
const CLAWBOX_AI = CLAWBOX_AI_MODEL_BY_TIER[CLAWBOX_AI_DEFAULT_TIER];
const PRIMARY = "anthropic/claude-sonnet-4-6";
// What a ClawBox AI sign-in leaves in openclaw.json: its provider, keyed with
// the portal token.
const CLAWBOX_AI_PROVIDER_BLOCK = { deepseek: { apiKey: "claw_placeholder_token", baseUrl: "http://127.0.0.1/v1" } };

function openclawJson(fallbacks: string[], providers: Record<string, unknown> = {}) {
  return { agents: { defaults: { model: { primary: PRIMARY, fallbacks } } }, models: { providers } };
}

async function turnOffLocalAi() {
  const { POST } = await import("@/app/setup-api/local-ai/route");
  const res = await POST(new Request("http://box.local/setup-api/local-ai", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "disable" }),
  }));
  expect(res.status).toBe(200);
  const fallbacks = (disk.config as ReturnType<typeof openclawJson>).agents.defaults.model.fallbacks;
  return fallbacks;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  disk.store = {};
});

describe("turning Local AI off", () => {
  it("keeps a fallback list that holds no local model", async () => {
    disk.config = openclawJson([CLAWBOX_AI], CLAWBOX_AI_PROVIDER_BLOCK);
    expect(await turnOffLocalAi()).toEqual([CLAWBOX_AI]);
  });

  it("takes only the local model out of a mixed list", async () => {
    disk.config = openclawJson([LOCAL, "openrouter/qwen/qwen3-coder"]);
    expect(await turnOffLocalAi()).toEqual(["openrouter/qwen/qwen3-coder"]);
  });

  it("puts back the ClawBox AI fallback the local model replaced", async () => {
    disk.config = openclawJson([LOCAL], CLAWBOX_AI_PROVIDER_BLOCK);
    expect(await turnOffLocalAi()).toEqual([CLAWBOX_AI]);
  });

  it("does not put ClawBox AI back when the owner switched it off", async () => {
    disk.config = openclawJson([LOCAL], CLAWBOX_AI_PROVIDER_BLOCK);
    disk.store = { ai_disabled_providers: ["clawai"] };
    expect(await turnOffLocalAi()).toEqual([]);
  });

  it("leaves the list empty on a box with no ClawBox AI account", async () => {
    disk.config = openclawJson([LOCAL]);
    expect(await turnOffLocalAi()).toEqual([]);
  });
});
