import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * "Make this provider the default", on either harness, through one endpoint.
 *
 * The two harnesses write completely different things — Hermes sets
 * `model.provider` + `model.default` through its CLI, OpenClaw sets a
 * fully-qualified `agents.defaults.model.primary` and restarts the gateway — so
 * what these assert is that the RIGHT one happened, and that the caller never
 * had to know which.
 */

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(),
  HERMES_BIN: "/usr/bin/hermes-test",
}));
vi.mock("@/app/setup-api/hermes/models/route", () => ({ POST: vi.fn() }));
vi.mock("@/app/setup-api/chat/model/route", () => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock("@/lib/provider-enablement", () => ({ isProviderEnabled: vi.fn() }));

let POST: (request: Request) => Promise<Response>;
let getActiveHarness: Mock;
let hermesModelsPOST: Mock;
let chatModelGET: Mock;
let chatModelPOST: Mock;
let isProviderEnabled: Mock;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const call = (body: unknown) =>
  POST(new Request("http://localhost/setup-api/providers/default", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

/** The JSON body the delegate was handed. */
async function delegateBody(mock: Mock): Promise<unknown> {
  return JSON.parse(await (mock.mock.calls[0][0] as Request).text());
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ getActiveHarness } = (await import("@/lib/harness")) as unknown as { getActiveHarness: Mock });
  ({ POST: hermesModelsPOST } = (await import("@/app/setup-api/hermes/models/route")) as unknown as { POST: Mock });
  ({ GET: chatModelGET, POST: chatModelPOST } = (await import("@/app/setup-api/chat/model/route")) as unknown as { GET: Mock; POST: Mock });
  ({ isProviderEnabled } = (await import("@/lib/provider-enablement")) as unknown as { isProviderEnabled: Mock });
  isProviderEnabled.mockResolvedValue(true);
  ({ POST } = await import("@/app/setup-api/providers/default/route"));
});

describe("the owner's switch", () => {
  it.each(["hermes", "openclaw"])("on %s, refuses to promote a provider the owner switched off", async (harness) => {
    // The provider may well hold a working credential, so neither harness
    // delegate would refuse it on its own; this is the one place that asks.
    getActiveHarness.mockResolvedValue(harness);
    isProviderEnabled.mockResolvedValue(false);

    const res = await call({ provider: "openrouter" });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ kind: "provider_disabled", provider: "openrouter" });
    expect(hermesModelsPOST).not.toHaveBeenCalled();
    expect(chatModelGET).not.toHaveBeenCalled();
    expect(chatModelPOST).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/providers/default — Hermes", () => {
  beforeEach(() => getActiveHarness.mockResolvedValue("hermes"));

  it("writes the pairing through the harness route, provider only", async () => {
    hermesModelsPOST.mockResolvedValue(json({ ok: true, provider: "anthropic", model: "claude-sonnet-5" }));

    const res = await call({ provider: "anthropic" });

    expect(hermesModelsPOST).toHaveBeenCalledTimes(1);
    // No model. That is deliberate: the harness route then writes the
    // provider's OWN recommended default, which is the only model that cannot
    // be a foreign vendor's id.
    expect(await delegateBody(hermesModelsPOST)).toEqual({ provider: "anthropic" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, provider: "anthropic", model: "claude-sonnet-5" });
    expect(chatModelPOST).not.toHaveBeenCalled();
  });

  it("passes the harness's refusal straight back, status and all", async () => {
    // "You have no credentials for that provider" is the harness's verdict to
    // give; restating it here would be a second copy to keep true.
    hermesModelsPOST.mockResolvedValue(json({ error: "provider_unauthenticated", provider: "zai" }, 409));

    const res = await call({ provider: "zai" });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "provider_unauthenticated" });
  });
});

describe("POST /setup-api/providers/default — OpenClaw", () => {
  beforeEach(() => getActiveHarness.mockResolvedValue("openclaw"));

  it("resolves the provider to its configured model and sets that as primary", async () => {
    // OpenClaw has no "provider" key: the default IS a `<provider>/<model>`.
    chatModelGET.mockResolvedValue(json({
      options: [
        { id: "a", provider: "clawai", model: "deepseek/deepseek-v4-flash", available: true },
        { id: "b", provider: "anthropic", model: "anthropic/claude-sonnet-4-6", available: true },
      ],
    }));
    chatModelPOST.mockResolvedValue(json({ ok: true }));

    const res = await call({ provider: "anthropic" });

    expect(await delegateBody(chatModelPOST)).toEqual({ model: "anthropic/claude-sonnet-4-6" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, model: "anthropic/claude-sonnet-4-6" });
    expect(hermesModelsPOST).not.toHaveBeenCalled();
  });

  it("refuses a provider this box holds no credential for", async () => {
    chatModelGET.mockResolvedValue(json({
      options: [{ id: "a", provider: "clawai", model: "deepseek/deepseek-v4-flash", available: true }],
    }));

    const res = await call({ provider: "google" });

    expect(res.status).toBe(409);
    // Not "unknown provider": the provider is known, it just needs connecting,
    // and the fix is different.
    await expect(res.json()).resolves.toMatchObject({ error: "provider_unconfigured", provider: "google" });
    expect(chatModelPOST).not.toHaveBeenCalled();
  });

  /**
   * TASK-608. `/setup-api/chat/model` now answers 502 when the model IS written
   * but the gateway did not bind again inside its readiness budget: the body is
   * the new state plus a `warning`, and it carries NO `error` key. This route
   * forwarded that verbatim, so the panel that started the change read a saved
   * default as a failed one — the exact false failure the 502 exists to avoid,
   * one route further out.
   *
   * `warning` is required, not just the status, so a 502 from a proxy or from
   * cloudflared stays the error it is.
   */
  it("reports a default whose gateway is still coming back as saved, with the warning", async () => {
    chatModelGET.mockResolvedValue(json({
      options: [{ id: "b", provider: "anthropic", model: "anthropic/claude-sonnet-4-6", available: true }],
    }));
    chatModelPOST.mockResolvedValue(json(
      {
        selected: { provider: "anthropic", model: "anthropic/claude-sonnet-4-6" },
        warning: "Saved, but the gateway did not come back — the new model applies once it is serving again.",
      },
      502,
    ));

    const res = await call({ provider: "anthropic" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-6",
      warning: expect.stringContaining("gateway"),
    });
  });

  it("still forwards a 502 that carries no warning — that one is not a saved default", async () => {
    chatModelGET.mockResolvedValue(json({
      options: [{ id: "b", provider: "anthropic", model: "anthropic/claude-sonnet-4-6", available: true }],
    }));
    chatModelPOST.mockResolvedValue(json({ error: "Bad gateway" }, 502));

    const res = await call({ provider: "anthropic" });

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: "Bad gateway" });
  });

  it("will not promote a provider whose row is present but unavailable", async () => {
    chatModelGET.mockResolvedValue(json({
      options: [{ id: "x", provider: "ollama", model: null, available: false }],
    }));

    expect((await call({ provider: "ollama" })).status).toBe(409);
    expect(chatModelPOST).not.toHaveBeenCalled();
  });
});

describe("what it refuses before either harness is asked", () => {
  beforeEach(() => getActiveHarness.mockResolvedValue("hermes"));

  it.each([
    ["a missing provider", {}],
    ["an empty provider", { provider: "   " }],
    ["a non-string provider", { provider: 42 }],
    ["a value that could be read as a CLI flag", { provider: "--provider" }],
    ["a path separator", { provider: "../../etc" }],
    ["an over-long slug", { provider: "a".repeat(200) }],
  ])("rejects %s", async (_label, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(hermesModelsPOST).not.toHaveBeenCalled();
    expect(chatModelPOST).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON at all", async () => {
    const res = await POST(new Request("http://localhost/setup-api/providers/default", {
      method: "POST",
      body: "not json",
    }));
    expect(res.status).toBe(400);
  });
});
