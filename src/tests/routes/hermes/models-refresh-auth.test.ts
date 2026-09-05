import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

/**
 * `?refresh=1` is not a read. It busts Hermes' per-provider disk cache and fans
 * out into a live /v1/models call per provider, so an unauthenticated caller
 * could drive real upstream traffic with it — and, paired with a slow
 * dashboard, use it to swap the live catalogue for the 2-provider disk
 * fallback. The plain GET stays open for the wizard; the cache bust needs a
 * session. TASK-446.
 */

const getModelOptionsMock = vi.fn();

vi.mock("@/lib/hermes-model-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hermes-model-options")>();
  return { ...actual, getModelOptions: getModelOptionsMock };
});

const reconcileLocalMock = vi.fn(async () => {});
const reconcileClawaiMock = vi.fn(async () => {});
vi.mock("@/lib/hermes-local-ai", () => ({
  reconcileLocalAiWithHermes: reconcileLocalMock,
}));
vi.mock("@/lib/hermes-clawai", () => ({
  reconcileClawaiModelsWithHermes: reconcileClawaiMock,
}));

const activeHarnessMock = vi.fn(async () => "hermes");
vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: activeHarnessMock,
}));

vi.mock("@/lib/hermes-cli", () => ({
  runHermesCli: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
}));

// TASK-583: `verified` is present on every row and null on all of them, so
// "connected" still means "a key is on disk". The marks a completed turn leaves
// behind are the one source that costs nothing to read.
const configGetMock = vi.hoisted(() => vi.fn(async () => undefined as unknown));
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGetMock,
  set: vi.fn(async () => {}),
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
  current: { provider: "anthropic", model: "anthropic/claude-opus-5" },
  reasoning: "medium",
  fetchedAt: Date.now(),
  source: "dashboard" as const,
  stale: false,
};

let session: SessionFixture;
let GET: (req: Request) => Promise<Response>;

function request(query: string, authed: boolean): Request {
  return new Request(`http://localhost/setup-api/hermes/models${query}`, {
    headers: authed ? { Cookie: session.cookie } : {},
  });
}

beforeEach(async () => {
  session = installSessionFixture();
  getModelOptionsMock.mockReset();
  getModelOptionsMock.mockResolvedValue(PAYLOAD);
  reconcileLocalMock.mockClear();
  reconcileClawaiMock.mockClear();
  activeHarnessMock.mockReset();
  activeHarnessMock.mockResolvedValue("hermes");
  configGetMock.mockReset();
  configGetMock.mockResolvedValue(undefined);
  vi.resetModules();
  ({ GET } = await import("@/app/setup-api/hermes/models/route"));
});

afterEach(() => {
  session.cleanup();
});

describe("GET /setup-api/hermes/models", () => {
  it("honours ?refresh=1 for an authenticated caller", async () => {
    const res = await GET(request("?refresh=1", true));

    expect(res.status).toBe(200);
    expect(getModelOptionsMock).toHaveBeenCalledWith({ refresh: true });
    expect(await res.json()).not.toHaveProperty("refreshDenied");
  });

  it("downgrades ?refresh=1 to a plain read for an anonymous caller", async () => {
    const res = await GET(request("?refresh=1", false));

    expect(res.status).toBe(200);
    // The cache bust did NOT happen...
    expect(getModelOptionsMock).toHaveBeenCalledWith({ refresh: false });
    // ...and the client is told, rather than silently getting a no-op refresh.
    expect((await res.json()).refreshDenied).toBe(true);
  });

  it("leaves the plain read reachable — the wizard needs it", async () => {
    const res = await GET(request("", false));

    expect(res.status).toBe(200);
    expect(getModelOptionsMock).toHaveBeenCalledWith({ refresh: false });
  });

  it("does not honour ?refresh=1 on the scoped provider read either", async () => {
    await GET(request("?provider=anthropic&refresh=1", false));
    expect(getModelOptionsMock).toHaveBeenCalledWith({ refresh: false });
  });

  it("repairs the Hermes `providers:` block on a Hermes box", async () => {
    await GET(request("", false));
    expect(reconcileLocalMock).toHaveBeenCalled();
    expect(reconcileClawaiMock).toHaveBeenCalled();
  });

  it("spawns no `hermes` repair on an OpenClaw box", async () => {
    // Both repairs open with a `hermes` spawn, and an OpenClaw device has no
    // binary to spawn and no `providers:` block to repair — the call would
    // reject, be caught, logged and retried on the next request, forever. One
    // gate at the call site, ahead of both, rather than two modules each
    // assuming their own edition.
    activeHarnessMock.mockResolvedValue("openclaw");
    const res = await GET(request("", false));
    expect(res.status).toBe(200);
    expect(reconcileLocalMock).not.toHaveBeenCalled();
    expect(reconcileClawaiMock).not.toHaveBeenCalled();
  });

  it("reports credential presence and verification as separate fields", async () => {
    const body = await (await GET(request("", true))).json();

    expect(body.providers[0]).toMatchObject({
      authenticated: true,
      credentialPresent: true,
      verified: null,
    });
  });
});

describe("the scoped reply and the device's reasoning level", () => {
  it("carries `reasoning` on ?provider= too, so a reader of the scoped form is not left guessing", async () => {
    // HERMES-05: ai_list_models reads this form before every model switch and
    // reports the device default's thinking level off it. The value was in
    // hand (`payload.reasoning`) and not on the scoped answer — a false
    // unknown.
    const body = await (await GET(request("?provider=anthropic", false))).json();
    expect(body.provider).toBe("anthropic");
    expect(body.reasoning).toBe("medium");
    // And the saved pairing itself, whichever provider it belongs to: `current`
    // is blank when the saved model is not in this provider's (possibly stale)
    // list, and `savedElsewhere` is null when it IS this provider — so
    // neither can name the default on the box's own provider.
    expect(body.savedPair).toEqual({ provider: "anthropic", model: "anthropic/claude-opus-5" });
  });

  it("reports a provider that has actually answered as verified, with when", async () => {
    configGetMock.mockResolvedValue({ anthropic: "2026-09-02T19:53:34.000Z" });

    const row = (await (await GET(request("", false))).json()).providers[0];

    expect(row.verified).toBe(true);
    expect(row.verifiedAt).toBe("2026-09-02T19:53:34.000Z");
    // Pinned by KEY: a reader looking up the wrong one would otherwise pass,
    // because the mock answers any key.
    expect(configGetMock).toHaveBeenCalledWith("provider_verified_at");
  });

  it("leaves a provider nothing has exercised at NOT CHECKED, never at not connected", async () => {
    // An offline box and a rate-limited subscription both land here. Null is
    // the honest answer; false would say the credential was tried and failed.
    configGetMock.mockResolvedValue({ openai: "2026-09-02T19:53:34.000Z" });

    const row = (await (await GET(request("", false))).json()).providers[0];

    expect(row.verified).toBeNull();
    expect(row).not.toHaveProperty("verifiedAt");
    // ...and presence is still reported separately, exactly as before.
    expect(row.credentialPresent).toBe(true);
  });
});
