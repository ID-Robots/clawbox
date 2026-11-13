import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-2148, on the Hermes edition's own provider panel: Settings asks
 * `POST /setup-api/hermes/models` with `background: true` and the provider's
 * whole save — its pasted key, then the pick — runs as ONE background task of
 * the box (src/lib/provider-auth-tasks.ts), which the panel and the desktop's
 * corner card follow and a Settings closed half-way does not lose.
 */

const runHermesCliMock = vi.hoisted(() => vi.fn());
const getModelOptionsMock = vi.hoisted(() => vi.fn());
const saveKeyMock = vi.hoisted(() => vi.fn());
/** The local-only AI lock (TASK-2501), as the device store holds it. */
const lockState = vi.hoisted(() => ({ on: false }));

vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: runHermesCliMock }));
vi.mock("@/lib/hermes-model-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-model-options")>();
  return { ...actual, getModelOptions: getModelOptionsMock, invalidateModelOptions: vi.fn() };
});
vi.mock("@/lib/hermes-local-ai", () => ({ reconcileLocalAiWithHermes: vi.fn(async () => {}) }));
vi.mock("@/lib/hermes-clawai", () => ({ reconcileClawaiModelsWithHermes: vi.fn(async () => {}) }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/provider-verified", () => ({ readProviderVerified: vi.fn(async () => null) }));
vi.mock("@/lib/config-store", () => ({
  setMany: vi.fn(async () => undefined),
  getKnown: vi.fn(async (key: string) => ({ value: key === "ai_cloud_lock" && lockState.on ? true : undefined, known: true })),
  get: vi.fn(async (key: string) => (key === "ai_cloud_lock" && lockState.on ? true : undefined)),
  set: vi.fn(),
  resolveConfigRoot: () => process.env.CLAWBOX_ROOT || "/tmp",
}));
vi.mock("@/app/setup-api/hermes/provider-key/route", () => ({ POST: saveKeyMock }));
vi.mock("@/lib/provider-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-status")>()),
  readProviderStatus: vi.fn(async () => ({
    harness: "hermes",
    providers: [{ id: "anthropic", label: "Anthropic", state: "connected", isDefault: true, enabled: true, section: "ai" }],
    defaultProvider: "anthropic",
    unrunnable: [],
    degraded: false,
  })),
}));

const PAYLOAD = {
  providers: [{
    id: "anthropic",
    name: "Anthropic",
    authenticated: true,
    verified: null,
    isUserDefined: false,
    source: "dashboard",
    total: 1,
    models: [{ id: "anthropic/claude-opus-5", description: "" }],
  }],
  current: { provider: "openrouter", model: "openrouter/auto" },
  reasoning: "medium",
  fetchedAt: Date.now(),
  source: "dashboard" as const,
  stale: false,
};

let root: string;
let savedRoot: string | undefined;

async function post(body: Record<string, unknown>) {
  const { POST } = await import("@/app/setup-api/hermes/models/route");
  return POST(new Request("http://localhost/setup-api/hermes/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function ended(id: string) {
  const { getBackgroundTask } = await import("@/lib/background-tasks");
  await vi.waitFor(() => expect(getBackgroundTask(id)?.state).not.toBe("running"));
  return getBackgroundTask(id)!;
}

beforeEach(async () => {
  savedRoot = process.env.CLAWBOX_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-models-background-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  (await import("@/lib/background-tasks")).resetBackgroundTasksForTests();
  runHermesCliMock.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  getModelOptionsMock.mockReset().mockImplementation(async () => structuredClone(PAYLOAD));
  saveKeyMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  lockState.on = false;
});

afterEach(async () => {
  (await import("@/lib/background-tasks")).resetBackgroundTasksForTests();
  if (savedRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /setup-api/hermes/models {background: true}", () => {
  it("saves the key, then the pick, as one task of the box", async () => {
    const res = await post({ provider: "anthropic", apiKey: "sk-ant-0123456789", model: "anthropic/claude-opus-5", background: true });
    expect(res.status).toBe(202);
    const { taskId, task } = await res.json();
    expect(task).toMatchObject({ kind: "provider-sign-in", meta: { subject: "anthropic", action: "sign-in" } });
    const done = await ended(taskId);
    expect(done.state).toBe("succeeded");
    expect(done.result).toMatchObject({ keySaved: true, verified: true });
    // The key's own route, with the key, before any config write.
    expect(saveKeyMock).toHaveBeenCalledTimes(1);
    const keyRequest = saveKeyMock.mock.calls[0][0] as Request;
    expect(await keyRequest.json()).toEqual({ provider: "anthropic", apiKey: "sk-ant-0123456789" });
    expect(runHermesCliMock).toHaveBeenCalled();
  });

  it("ends failed with the key's own refusal, and writes no pick over a key that did not land", async () => {
    saveKeyMock.mockResolvedValue(new Response(JSON.stringify({ error: "Hermes refused that key." }), { status: 400 }));
    const { taskId } = await (await post({ provider: "anthropic", apiKey: "sk-ant-0123456789", background: true })).json();
    const done = await ended(taskId);
    expect(done).toMatchObject({ state: "failed", error: "Hermes refused that key.", result: { httpStatus: 400 } });
    expect(runHermesCliMock).not.toHaveBeenCalled();
  });

  it("keeps the pick's code for the panel and says it in a sentence on the card", async () => {
    getModelOptionsMock.mockImplementation(async () => ({
      ...structuredClone(PAYLOAD),
      providers: [{ ...PAYLOAD.providers[0], authenticated: false, total: 0, models: [] }],
    }));
    const { taskId } = await (await post({ provider: "anthropic", apiKey: "sk-ant-0123456789", background: true })).json();
    const done = await ended(taskId);
    expect(done.state).toBe("failed");
    expect(done.result).toMatchObject({ error: "provider_unauthenticated", keySaved: true });
    expect(done.error).toMatch(/key was saved, but Hermes has not listed its models yet/);
  });

  it("answers a plain save in the request, as before", async () => {
    const res = await post({ provider: "anthropic", model: "anthropic/claude-opus-5" });
    expect(res.status).toBe(200);
    expect(saveKeyMock).not.toHaveBeenCalled();
  });
});


describe("POST /setup-api/hermes/models — the local-only AI lock (TASK-2501)", () => {
  /** The box's on-device model, offered beside the cloud provider. */
  const WITH_LOCAL = {
    ...PAYLOAD,
    providers: [
      ...PAYLOAD.providers,
      { id: "clawlocal", name: "Gemma 4 (on-device)", authenticated: true, verified: null, isUserDefined: true, source: "dashboard", total: 1, models: [{ id: "gemma-4-e2b", description: "" }] },
    ],
  };

  it("refuses a cloud provider's sign-in before any task starts or key is saved", async () => {
    lockState.on = true;
    const res = await post({ provider: "anthropic", apiKey: "sk-ant-0123456789", model: "anthropic/claude-opus-5", background: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "cloud_ai_locked" });
    expect(saveKeyMock).not.toHaveBeenCalled();
    expect(runHermesCliMock).not.toHaveBeenCalled();
    const { listBackgroundTasks } = await import("@/lib/background-tasks");
    expect(listBackgroundTasks()).toEqual([]);
  });

  it("refuses a plain save onto a cloud provider, and writes nothing", async () => {
    lockState.on = true;
    const res = await post({ provider: "anthropic", model: "anthropic/claude-opus-5" });
    expect(res.status).toBe(409);
    expect(runHermesCliMock).not.toHaveBeenCalled();
  });

  it("refuses a model pick on the cloud provider Hermes is already on", async () => {
    lockState.on = true;
    // PAYLOAD.current is OpenRouter: a model-only pick stays on it.
    const res = await post({ model: "openrouter/auto" });
    expect(res.status).toBe(409);
    expect(runHermesCliMock).not.toHaveBeenCalled();
  });

  it("still moves Hermes onto the on-device model", async () => {
    lockState.on = true;
    getModelOptionsMock.mockImplementation(async () => structuredClone(WITH_LOCAL));
    const res = await post({ provider: "clawlocal", model: "gemma-4-e2b" });
    expect(res.status).toBe(200);
    expect(runHermesCliMock).toHaveBeenCalled();
  });

  it("saves the same cloud provider once the lock is off", async () => {
    const res = await post({ provider: "anthropic", model: "anthropic/claude-opus-5" });
    expect(res.status).toBe(200);
  });
});
