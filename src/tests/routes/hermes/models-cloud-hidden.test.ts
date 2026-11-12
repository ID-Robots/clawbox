import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * "Hide cloud AI providers" (TASK-2497) on Hermes: GET /setup-api/hermes/models
 * says whether the box hides them, so the chat header offers the box's own AI
 * alone (src/components/ChatPopup.tsx filters on it). A flag, not a filter:
 * the provider list stays whole for the panels and the sign-out code that read
 * it too. The flag comes from the real store rule (org mode + an external
 * engine, or the owner's own choice).
 */

const dashboardFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-dashboard-auth", () => ({ dashboardFetch: dashboardFetchMock, __esModule: true }));
const runHermesCliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: runHermesCliMock }));
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: vi.fn(async () => "hermes"),
}));
vi.mock("@/lib/hermes-local-ai", () => ({ reconcileLocalAiWithHermes: vi.fn(async () => {}) }));
vi.mock("@/lib/hermes-clawai", () => ({ reconcileClawaiModelsWithHermes: vi.fn(async () => {}) }));
vi.mock("@/lib/external-engine-hermes", () => ({ reconcileExternalEngineWithHermes: vi.fn(async () => {}) }));
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/internal-token", () => ({ isInternalRequest: vi.fn(() => true) }));

const ENGINE = {
  baseUrl: "http://127.0.0.1:18931/v1",
  modelId: "acme/echo-1",
  contextWindow: 131072,
  maxTokens: 4096,
  imageInput: false,
  harness: "hermes",
  savedAt: "2026-11-12T00:00:00.000Z",
  previous: { store: {} },
};

let root: string;
let restoreEnv: () => void;

beforeAll(() => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hermes-cloud-hidden-"));
  process.env.CLAWBOX_ROOT = root;
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetModules();
  fs.rmSync(path.join(root, "data", "config.json"), { force: true });
  runHermesCliMock.mockImplementation(async (args: string[]) => ({
    stdout: ({ "model.provider": "clawext", "model.default": "acme/echo-1" } as Record<string, string>)[args[2]] ?? "",
    stderr: "",
    code: 0,
  }));
  dashboardFetchMock.mockImplementation(async (p: string) => {
    if (!String(p).startsWith("/api/model/options")) return { ok: true, status: 200, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        providers: [
          { slug: "openrouter", name: "OpenRouter", authenticated: true, source: "dashboard", total_models: 1, models: ["x/y"] },
          { slug: "clawext", name: "echo-1", authenticated: true, source: "dashboard", total_models: 1, models: ["acme/echo-1"] },
        ],
        provider: "clawext",
        model: "acme/echo-1",
      }),
    };
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function models(state: Record<string, unknown>) {
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(state));
  const mod = await import("@/app/setup-api/hermes/models/route");
  const res = await mod.GET(new Request("http://127.0.0.1/setup-api/hermes/models"));
  expect(res.status).toBe(200);
  return res.json() as Promise<{ cloudProvidersHidden?: unknown; providers: { id: string }[] }>;
}

describe("GET /setup-api/hermes/models — cloudProvidersHidden", () => {
  it("false on a normal box, with the list whole", async () => {
    const body = await models({});
    expect(body.cloudProvidersHidden).toBe(false);
    expect(body.providers.map((p) => p.id)).toEqual(expect.arrayContaining(["openrouter", "clawext"]));
  });

  it("true on an organisation box whose AI is an external engine — the list still whole", async () => {
    const body = await models({ org_mode: true, external_engine: ENGINE });
    expect(body.cloudProvidersHidden).toBe(true);
    expect(body.providers.map((p) => p.id)).toEqual(expect.arrayContaining(["openrouter", "clawext"]));
  });

  it("follows the owner's own choice either way", async () => {
    expect((await models({ org_mode: true, external_engine: ENGINE, hide_cloud_providers: false })).cloudProvidersHidden).toBe(false);
    expect((await models({ hide_cloud_providers: true })).cloudProvidersHidden).toBe(true);
  });
});
