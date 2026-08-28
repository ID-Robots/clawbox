/**
 * POST /setup-api/providers/enabled — the owner's per-provider switch.
 *
 * Two properties under test. The AGENT cannot flip it: middleware admits the
 * MCP bearer to every /setup-api/* path, so the route has to refuse it
 * in-handler with the real cookie verifier, the way coding-agent/enable does.
 * And the DEFAULT cannot be switched off: a box whose default is off has
 * nowhere to send the next message, so the refusal — with the fix in its
 * message — lands here rather than in every consumer.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/harness/credentials", () => ({ hasClawaiToken: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({ readConfig: vi.fn() }));
vi.mock("@/lib/hermes-model-options", () => ({ getModelOptions: vi.fn() }));
// An in-memory store behind the real module's constants, so the round trip is
// what a device would see: the write the route makes is the read the next
// status makes. (The cookie verifier reads `DATA_DIR` at import.)
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(),
  set: vi.fn(),
}));

const SESSION_SECRET = "a".repeat(64);

let POST: (req: Request) => Promise<Response>;
let restore: () => void;
let store: Map<string, unknown>;
let getActiveHarness: Mock;
let readConfig: Mock;
let getModelOptions: Mock;
let configSet: Mock;

function ownerCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET)}`;
}

function request(init: { cookie?: string; bearer?: string; body?: unknown; raw?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new Request("http://localhost/setup-api/providers/enabled", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(init.body ?? { provider: "openrouter", enabled: false }),
  });
}

/** The owner asking. */
const asOwner = (body: unknown) => POST(request({ cookie: ownerCookie(), body }));

interface Row { id: string; state: string; isDefault: boolean; enabled: boolean }
const rowFor = (body: { providers: Row[] }, id: string): Row | undefined =>
  body.providers.find((p) => p.id === id);

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET");
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  store = new Map();

  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as { getActiveHarness: Mock });
  ({ readConfig } = (await import("@/lib/openclaw-config")) as unknown as { readConfig: Mock });
  ({ getModelOptions } = (await import("@/lib/hermes-model-options")) as unknown as { getModelOptions: Mock });
  const configStore = (await import("@/lib/config-store")) as unknown as { get: Mock; set: Mock };
  configSet = configStore.set;
  configStore.get.mockImplementation(async (key: string) => store.get(key));
  configStore.set.mockImplementation(async (key: string, value: unknown) => { store.set(key, value); });
  (await import("@/lib/harness/credentials") as unknown as { hasClawaiToken: Mock }).hasClawaiToken.mockResolvedValue(false);

  // An OpenClaw box with Anthropic as its default and OpenRouter connected.
  getActiveHarness.mockResolvedValue("openclaw");
  readConfig.mockResolvedValue({
    auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "oauth" } } },
    models: { providers: { openrouter: { apiKey: "sk-or-secret" } } },
    agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
  });

  ({ POST } = await import("@/app/setup-api/providers/enabled/route"));
});

afterEach(() => restore());

describe("who may flip the switch", () => {
  it("refuses the MCP bearer, which is what the agent holds", async () => {
    const res = await POST(request({ bearer: "any-valid-looking-token-value" }));
    expect(res.status).toBe(403);
    expect((await res.json()).kind).toBe("owner_only");
    expect(configSet).not.toHaveBeenCalled();
  });

  it("refuses a request with no credential with the identical answer", async () => {
    const withBearer = await POST(request({ bearer: "any-valid-looking-token-value" }));
    const bare = await POST(request());
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual(await withBearer.json());
  });
});

describe("what it refuses before writing", () => {
  it.each([
    ["a missing provider", { enabled: false }],
    ["an empty provider", { provider: "  ", enabled: false }],
    ["a non-boolean switch", { provider: "openrouter", enabled: "off" }],
    ["a body that is a bare string", "openrouter"],
  ])("answers 400 to %s", async (_label, body) => {
    const res = await asOwner(body);
    expect(res.status).toBe(400);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is not JSON at all", async () => {
    const res = await POST(request({ cookie: ownerCookie(), raw: "not json" }));
    expect(res.status).toBe(400);
  });

  it("will not switch off the current default, and says what to do instead", async () => {
    const res = await asOwner({ provider: "anthropic", enabled: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Make another provider the default first.",
      kind: "is_default",
    });
    expect(configSet).not.toHaveBeenCalled();
  });

  it("answers 404 for a provider this box has no row for", async () => {
    const res = await asOwner({ provider: "fireworks", enabled: false });
    expect(res.status).toBe(404);
    expect((await res.json()).kind).toBe("unknown_provider");
    expect(configSet).not.toHaveBeenCalled();
  });
});

describe("the round trip", () => {
  it("switches a provider off, reports it in the fresh status, and back on again", async () => {
    const off = await asOwner({ provider: "openrouter", enabled: false });
    expect(off.status).toBe(200);
    const offBody = await off.json();
    // Off, yet still connected: the credential is kept, that is the point.
    expect(rowFor(offBody, "openrouter")).toMatchObject({ enabled: false, state: "connected" });
    expect(rowFor(offBody, "anthropic")!.enabled).toBe(true);
    expect(store.get("ai_disabled_providers")).toEqual(["openrouter"]);

    const on = await asOwner({ provider: "openrouter", enabled: true });
    expect(on.status).toBe(200);
    expect(rowFor(await on.json(), "openrouter")!.enabled).toBe(true);
    expect(store.get("ai_disabled_providers")).toEqual([]);
  });

  it("stores the canonical id whatever spelling the caller used", async () => {
    // `deepseek` is ClawBox AI's wire id in openclaw.json; the strip's row —
    // and so the switch — is `clawai`. A list keyed by the other spelling
    // would never be seen by the status that stamps `enabled`.
    const res = await asOwner({ provider: "deepseek", enabled: false });
    expect(res.status).toBe(200);
    expect(rowFor(await res.json(), "clawai")!.enabled).toBe(false);
    expect(store.get("ai_disabled_providers")).toEqual(["clawai"]);
  });

  it("switches the default back on even though it can never be switched off", async () => {
    // Re-enabling is always safe; only the off direction has the rule.
    const res = await asOwner({ provider: "anthropic", enabled: true });
    expect(res.status).toBe(200);
    expect(store.get("ai_disabled_providers")).toEqual([]);
  });

  it("keys a Hermes provider by its own id rather than a folded one", async () => {
    getActiveHarness.mockResolvedValue("hermes");
    getModelOptions.mockResolvedValue({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true, isUserDefined: false, source: "d", total: 3, models: [] },
        { id: "openai-codex", name: "OpenAI", authenticated: true, isUserDefined: false, source: "d", total: 1, models: [] },
      ],
      current: { provider: "anthropic", model: "claude-sonnet-5" },
      reasoning: "medium",
      fetchedAt: Date.now(),
      source: "dashboard",
      stale: false,
    });

    const res = await asOwner({ provider: "openai-codex", enabled: false });
    expect(res.status).toBe(200);
    expect(rowFor(await res.json(), "openai-codex")!.enabled).toBe(false);
    expect(store.get("ai_disabled_providers")).toEqual(["openai-codex"]);
  });
});
