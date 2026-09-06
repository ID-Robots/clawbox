import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-634 — /setup-api/chat/model names a model that is not serving.
 *
 * Two false successes, one root:
 *
 *   `options.find((o) => o.model === activeModel)` is asked with a NULL
 *   activeModel, and the Local-AI placeholder row carries `model: null`, so
 *   "nothing is pinned" resolves to "Local AI" — a row the same payload marks
 *   `available: false`.
 *
 *   On Hermes `agents.defaults.model.primary` is always absent, because the
 *   chat's provider and model live in ~/.hermes/config.yaml and are answered
 *   by /setup-api/hermes/models. So the route confidently described a store
 *   that does not own the answer: measured on the box, activeOptionId
 *   "__setup_local__" / activeLabel "Local AI" while the chat had just run
 *   turns on openai-codex and anthropic.
 *
 * Its sibling chat/history already refuses exactly this case; chat/model did
 * not ask the question at all.
 */

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("util", () => ({ promisify: vi.fn() }));
vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(),
  // A successful switch records the owner's explicit model pick (TASK-713).
  setMany: vi.fn(),
}));
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  notifyProviderSetChanged: vi.fn(),
  refreshInBackground: vi.fn(),
}));
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  // The REAL class. A factory replaces the whole module, and the configure
  // path narrows on `instanceof GatewayNotReadyError` — `instanceof undefined`
  // throws a TypeError the first time a mocked restart rejects, which is what
  // `openclaw-config-mock-completeness.test.ts` exists to stop shipping.
  GatewayNotReadyError: (await importOriginal<typeof import("@/lib/openclaw-config")>()).GatewayNotReadyError,
  inferConfiguredLocalModel: vi.fn(),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  readConfigStrict: vi.fn(async () => ({})),
  readConfig: vi.fn(),
  restartGateway: vi.fn(),
  runOpenclawConfigSet: vi.fn(),
  runOpenclawConfigSetBatch: vi.fn(),
  runOpenclawConfigUnset: vi.fn(),
  applyModelOverrideToAllAgentSessions: vi.fn(),
  parseFullyQualifiedModel: vi.fn(),
  setProviderPlugins: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/sqlite-store", () => ({ sqliteGet: vi.fn(), sqliteSet: vi.fn() }));

let harness: "openclaw" | "hermes" = "openclaw";
vi.mock("@/lib/harness", () => ({ getActiveHarness: async () => harness }));

import { getAll } from "@/lib/config-store";
import { inferConfiguredLocalModel, readConfig } from "@/lib/openclaw-config";
import { sqliteGet, sqliteSet } from "@/lib/sqlite-store";
import { promisify } from "util";

/** An OpenClaw config with a credential but NO `agents.defaults.model.primary`. */
const NO_PRIMARY = {
  auth: { profiles: { "deepseek:default": { provider: "deepseek", mode: "api_key" } } },
  models: {
    mode: "merge",
    providers: { deepseek: { models: [{ id: "deepseek-v4-flash", name: "ClawBox AI Flash" }] } },
  },
  agents: { defaults: {} },
};

describe("/setup-api/chat/model — who owns the answer", () => {
  let GET: () => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    harness = "openclaw";
    vi.mocked(promisify).mockReturnValue(vi.fn().mockResolvedValue({ stdout: "", stderr: "" }) as never);
    vi.mocked(getAll).mockResolvedValue({});
    vi.mocked(readConfig).mockResolvedValue(NO_PRIMARY as never);
    vi.mocked(inferConfiguredLocalModel).mockReturnValue(null);
    vi.mocked(sqliteGet).mockResolvedValue(null);
    vi.mocked(sqliteSet).mockResolvedValue();
    GET = (await import("@/app/setup-api/chat/model/route")).GET;
  });

  it("does not name Local AI as active when nothing is pinned", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activeModel).toBeNull();
    // The Local-AI placeholder carries `model: null`; it must not be matched by
    // a null activeModel and reported as what the chat is running.
    expect(body.activeOptionId).toBeNull();
    expect(body.activeLabel).toBeNull();
  });

  it("refuses on a harness whose gateway owns the chat model", async () => {
    harness = "hermes";
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(409);
    // The machine-readable half — the same code chat/history's refusal carries,
    // so one caller rule covers both. The sentence names no internal path: it
    // is rendered into a chat bubble on the way past.
    expect(body.code).toBe("wrong_store");
    expect(String(body.error)).not.toMatch(/setup-api/);
    expect(body.activeOptionId).toBeUndefined();
  });
});
