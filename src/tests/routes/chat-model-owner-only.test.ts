import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /setup-api/chat/model changes the model the WHOLE box chats on, so it is the
 * owner's to change. A second user's first desktop load moved the owner's
 * chat from Pro to Flash: the chat's own model migration posted here for them.
 * Middleware refuses that write (src/lib/non-owner-scope.ts); the route asks
 * too, and only of a person's cookie — the box's own in-process switches
 * (src/lib/automatic-model-switch.ts) carry none and must still land.
 */

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("util", () => ({ promisify: vi.fn() }));
vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/home/clawbox/clawbox/data",
  getAll: vi.fn(async () => ({})),
  getKnown: vi.fn(async () => ({ value: undefined, known: true })),
  setMany: vi.fn(),
}));
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  notifyProviderSetChanged: vi.fn(),
  refreshInBackground: vi.fn(),
}));
vi.mock("@/lib/openclaw-config", async (importOriginal) => ({
  GatewayNotReadyError: (await importOriginal<typeof import("@/lib/openclaw-config")>()).GatewayNotReadyError,
  inferConfiguredLocalModel: vi.fn(),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
  readConfigStrict: vi.fn(async () => ({})),
  readConfig: vi.fn(async () => ({})),
  restartGateway: vi.fn(),
  repairClawboxAiFlashModelPolicy: vi.fn(async () => false),
  runOpenclawConfigSet: vi.fn(),
  runOpenclawConfigSetBatch: vi.fn(),
  runOpenclawConfigUnset: vi.fn(),
  applyModelOverrideToAllAgentSessions: vi.fn(),
  parseFullyQualifiedModel: vi.fn(),
  setProviderPlugins: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/sqlite-store", () => ({ sqliteGet: vi.fn(), sqliteSet: vi.fn() }));

// Hermes answers 409 `wrong_store` right after the owner gate, which is all
// these tests need to tell "refused as a user" from "let through".
let harness: "openclaw" | "hermes" = "hermes";
vi.mock("@/lib/harness", () => ({ getActiveHarness: async () => harness }));

const who = vi.hoisted(() => ({ current: null as { username: string; isOwner: boolean } | null }));
vi.mock("@/lib/route-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-auth")>()),
  sessionIdentity: vi.fn(async () => who.current),
}));

import { runOpenclawConfigSet, runOpenclawConfigSetBatch } from "@/lib/openclaw-config";

function post(body: unknown): Request {
  return new Request("http://localhost/setup-api/chat/model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /setup-api/chat/model — the owner's to change", () => {
  let POST: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    harness = "hermes";
    who.current = null;
    POST = (await import("@/app/setup-api/chat/model/route")).POST;
  });

  it("refuses a signed-in user who is not the owner with 403 owner_only, and writes nothing", async () => {
    who.current = { username: "alice", isOwner: false };
    harness = "openclaw";
    const res = await POST(post({ model: "deepseek/deepseek-v4-flash", automatic: true }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "owner_only" });
    expect(runOpenclawConfigSet).not.toHaveBeenCalled();
    expect(runOpenclawConfigSetBatch).not.toHaveBeenCalled();
  });

  it("lets the owner through", async () => {
    who.current = { username: "clawbox", isOwner: true };
    const res = await POST(post({ model: "deepseek/deepseek-v4-pro" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("wrong_store");
  });

  it("lets the box's own switch through: an in-process request carries no cookie", async () => {
    const res = await POST(post({ model: "deepseek/deepseek-v4-flash", automatic: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("wrong_store");
  });
});
