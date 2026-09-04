import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

/**
 * The Local-only toggle's session round trip on an OpenClaw 2 box: the store
 * is read to learn the sessions, the gateway (`sessions.patchMany`) switches
 * them, and the backup records only what the gateway confirmed. The other
 * tests of this route cover the Hermes refusal and the primary/fallback
 * config writes; this one is about the sessions.
 */

const state = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => state.store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    state.store.set(key, value);
  }),
  setMany: vi.fn(async (entries: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) state.store.delete(key);
      else state.store.set(key, value);
    }
  }),
}));

const { configSetMock } = vi.hoisted(() => ({
  configSetMock: vi.fn<(op: string[]) => Promise<void>>(async () => {}),
}));

vi.mock("@/lib/openclaw-config", () => ({
  // A REAL class. The route narrows on `err instanceof GatewayNotReadyError` to
  // keep "the gateway has not finished binding" out of a sentence that says the
  // restart failed; `instanceof undefined` throws a TypeError, which the outer
  // catch turns into a 500, so the first case here that makes `restartGateway`
  // reject would lose the pending answer without saying why.
  GatewayNotReadyError: class GatewayNotReadyError extends Error {
    constructor(message = "gateway did not come back") {
      super(message);
      this.name = "GatewayNotReadyError";
    }
  },
  callGatewayRpc: vi.fn(),
  gatewayIsAbsent: () => false,
  readConfig: vi.fn(async () => ({
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-pro", fallbacks: [] } } },
  })),
  restartGateway: vi.fn(async () => {}),
  runOpenclawConfigSet: configSetMock,
  // The primary and the fallbacks travel in one `config set --batch-json` now
  // (atomic, and it carries the plugin enable an Anthropic reference needs).
  // Record each operation on `runOpenclawConfigSet` too, so `configWrites`
  // stays a list of the assignments made, not of the processes that made them.
  runOpenclawConfigSetBatch: vi.fn(async (ops: string[][]) => {
    for (const op of ops) await configSetMock(op);
  }),
}));

// The catalogue is told out-of-band when a provider plugin is switched back
// on; the real module forks `openclaw models list`.
vi.mock("@/app/setup-api/ai-models/catalog/route", () => ({
  notifyProviderSetChanged: vi.fn(),
  refreshInBackground: vi.fn(),
}));

vi.mock("@/lib/openclaw-session-store", () => ({
  listAgentIds: vi.fn(() => ["main", "legacy"]),
  // `main` is migrated (has a store); `legacy` is still on sessions.json.
  sessionStorePath: vi.fn((agentId: string) => (agentId === "main" ? `/store/${agentId}/agent/openclaw-agent.sqlite` : null)),
  readSessionEntries: vi.fn(),
}));

import { callGatewayRpc, runOpenclawConfigSet } from "@/lib/openclaw-config";
import { readSessionEntries } from "@/lib/openclaw-session-store";

type Params = { targets: Array<{ key: string; agentId: string }>; patch: { model: string | null } };
type Outcome = { ok: boolean; key: string; agentId?: string; error?: { code: string; message: string } };

const gateway = vi.mocked(callGatewayRpc);
const rows = vi.mocked(readSessionEntries);
const configWrites = () => vi.mocked(runOpenclawConfigSet).mock.calls.map(([args]) => args);

/** Answers every target `ok`, except the keys in `refuse`. */
function answering(refuse: Record<string, { code: string; message: string }> = {}) {
  gateway.mockImplementation(async (_method, params) => {
    const { targets } = params as Params;
    const outcomes: Outcome[] = targets.map((t) =>
      refuse[t.key] ? { ok: false, key: t.key, agentId: t.agentId, error: refuse[t.key] } : { ok: true, key: t.key, agentId: t.agentId },
    );
    return { outcomes };
  });
}

const DEEPSEEK_PIN = { providerOverride: "deepseek", modelOverride: "deepseek-v4-pro" };

let agentsDir: string;
let POST: (request: Request) => Promise<Response>;

const post = (enabled: boolean) =>
  POST(new Request("http://clawbox.local/setup-api/local-ai/exclusive", { method: "POST", body: JSON.stringify({ enabled }) }));

beforeEach(async () => {
  state.store.clear();
  agentsDir = mkdtempSync(path.join(os.tmpdir(), "clawbox-local-only-"));
  process.env.OPENCLAW_AGENTS_DIR = agentsDir;
  vi.resetModules();
  ({ POST } = await import("@/app/setup-api/local-ai/exclusive/route"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_AGENTS_DIR;
});

function writeSessionsJson(agentId: string, sessions: Record<string, unknown>): string {
  const dir = path.join(agentsDir, agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "sessions.json");
  writeFileSync(file, JSON.stringify(sessions));
  return file;
}

describe("Local-only on (sessions)", () => {
  beforeEach(() => {
    state.store.set("local_ai_model", "llamacpp/gemma4-e2b-it-q4_0");
    rows.mockReturnValue([
      { key: "agent:main:clawbox-1", entry: { sessionId: "s1" } },
      { key: "agent:main:main", entry: { sessionId: "s-main", ...DEEPSEEK_PIN } },
      { key: "agent:main:retained", entry: {} },
    ]);
  });

  it("switches the store's sessions through the gateway and records only what it confirmed", async () => {
    // A migrated agent's leftover sessions.json is an archive, not a store.
    const archive = writeSessionsJson("main", { "agent:main:main": { sessionId: "old", ...DEEPSEEK_PIN } });
    const legacy = writeSessionsJson("legacy", { "agent:legacy:main": { sessionId: "l1", ...DEEPSEEK_PIN } });
    answering({ "agent:main:clawbox-1": { code: "INVALID_REQUEST", message: "model selection is locked" } });

    const res = await post(true);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      warning: expect.stringMatching(/^1 open chat\(s\) could not be switched to the local model/),
    });
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(gateway).toHaveBeenCalledWith(
      "sessions.patchMany",
      {
        targets: [
          { key: "agent:main:clawbox-1", agentId: "main" },
          { key: "agent:main:main", agentId: "main" },
        ],
        patch: { model: "llamacpp/gemma4-e2b-it-q4_0" },
      },
      expect.anything(),
    );
    expect(state.store.get("local_only_mode")).toBe(true);
    expect(state.store.get("local_only_saved_primary")).toBe("deepseek/deepseek-v4-pro");
    // The refused session is not in the backup: nothing changed there, so
    // there is nothing to put back.
    expect(state.store.get("local_only_saved_session_overrides")).toEqual({
      "sqlite:main": { "agent:main:main": DEEPSEEK_PIN },
      [legacy]: { "agent:legacy:main": DEEPSEEK_PIN },
    });
    expect(JSON.parse(readFileSync(archive, "utf8"))["agent:main:main"].modelOverride).toBe("deepseek-v4-pro");
    expect(JSON.parse(readFileSync(legacy, "utf8"))["agent:legacy:main"].modelOverride).toBe("gemma4-e2b-it-q4_0");
  });

  it("says so when an agent's sessions could not be listed, instead of claiming every chat is local", async () => {
    rows.mockReturnValue(null);
    answering();

    const res = await post(true);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      warning: expect.stringMatching(/^The sessions of 1 agent\(s\) could not be listed/),
    });
    expect(gateway).not.toHaveBeenCalled();
    expect(state.store.get("local_only_mode")).toBe(true);
    expect(state.store.get("local_only_saved_session_overrides")).toEqual({});
  });
});

describe("Local-only off (sessions)", () => {
  beforeEach(() => {
    state.store.set("local_only_mode", true);
    state.store.set("local_ai_model", "llamacpp/gemma4-e2b-it-q4_0");
    state.store.set("local_only_saved_primary", "deepseek/deepseek-v4-pro");
    state.store.set("local_only_saved_session_overrides", {
      "sqlite:main": {
        "agent:main:main": DEEPSEEK_PIN,
        "agent:main:clawbox-1": {},
        "agent:main:closed": DEEPSEEK_PIN,
      },
    });
    // `closed` was deleted while Local-only was on: only a placeholder is left.
    rows.mockReturnValue([
      { key: "agent:main:clawbox-1", entry: { sessionId: "s1", providerOverride: "llamacpp", modelOverride: "gemma4-e2b-it-q4_0" } },
      { key: "agent:main:closed", entry: {} },
      { key: "agent:main:main", entry: { sessionId: "s-main", providerOverride: "llamacpp", modelOverride: "gemma4-e2b-it-q4_0" } },
    ]);
  });

  it("puts each live session back on its snapshot's model, or on the agent default, and skips deleted ones", async () => {
    answering();

    const res = await post(false);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    const calls = gateway.mock.calls.map(([method, params]) => [method, params]);
    expect(calls).toEqual([
      ["sessions.patchMany", { targets: [{ key: "agent:main:main", agentId: "main" }], patch: { model: "deepseek/deepseek-v4-pro" } }],
      ["sessions.patchMany", { targets: [{ key: "agent:main:clawbox-1", agentId: "main" }], patch: { model: null } }],
    ]);
    expect(state.store.has("local_only_mode")).toBe(false);
    expect(state.store.has("local_only_saved_session_overrides")).toBe(false);
  });

  it("routes a backup that names a since-migrated sessions.json through the gateway", async () => {
    // Local-only went on before the OpenClaw 2 migration: the backup names
    // the agent's sessions.json, which the doctor has since folded into the
    // store and removed. Same keys, same entries — restore them where the
    // gateway reads them now, for the sessions that still exist.
    const archive = path.join(agentsDir, "main", "sessions", "sessions.json");
    state.store.set("local_only_saved_session_overrides", {
      [archive]: { "agent:main:main": DEEPSEEK_PIN, "agent:main:closed": DEEPSEEK_PIN },
    });
    answering();

    const res = await post(false);

    expect(res.status).toBe(200);
    expect(gateway.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["sessions.patchMany", { targets: [{ key: "agent:main:main", agentId: "main" }], patch: { model: "deepseek/deepseek-v4-pro" } }],
    ]);
    expect(state.store.has("local_only_mode")).toBe(false);
    expect(state.store.has("local_only_saved_session_overrides")).toBe(false);
  });

  it("finishes the toggle when a refusal will not change, and says which chats stayed local", async () => {
    answering({ "agent:main:main": { code: "INVALID_REQUEST", message: "unknown model: deepseek/deepseek-v4-pro" } });

    const res = await post(false);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      warning: expect.stringMatching(/^1 chat\(s\) could not be switched back and stay on the local model/),
    });
    expect(state.store.has("local_only_mode")).toBe(false);
    expect(state.store.has("local_only_saved_session_overrides")).toBe(false);
  });

  it("keeps Local-only on, with the snapshot, and answers a failure status when the gateway refused for now", async () => {
    gateway.mockRejectedValue(new Error("gateway closed (1006)"));

    const res = await post(false);

    // The panel reads `res.ok` as "the switch moved"; a 2xx here would paint
    // the toggle OFF over a box still in Local-only.
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      enabled: true,
      restoreIncomplete: true,
      error: expect.stringMatching(/could not be switched back yet/),
    });
    expect(state.store.get("local_only_mode")).toBe(true);
    expect(state.store.get("local_only_saved_session_overrides")).toEqual({
      "sqlite:main": { "agent:main:main": DEEPSEEK_PIN, "agent:main:clawbox-1": {}, "agent:main:closed": DEEPSEEK_PIN },
    });
    // The box must be what the mode says it is: the cloud primary written
    // for the restore goes back to the local model, and the saved primary
    // survives so the next toggle-off starts over.
    expect(configWrites()).toEqual([
      ["agents.defaults.model.primary", JSON.stringify("deepseek/deepseek-v4-pro"), "--json"],
      ["agents.defaults.model.primary", JSON.stringify("llamacpp/gemma4-e2b-it-q4_0"), "--json"],
      ["agents.defaults.model.fallbacks", "[]", "--json"],
    ]);
    expect(state.store.get("local_only_saved_primary")).toBe("deepseek/deepseek-v4-pro");
  }, 10_000);
});
