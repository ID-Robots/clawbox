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

vi.mock("@/lib/hermes-local-ai", () => ({
  reconcileLocalAiWithHermes: vi.fn(async () => {}),
}));

vi.mock("@/lib/hermes-cli", () => ({
  runHermesCli: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
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
});
