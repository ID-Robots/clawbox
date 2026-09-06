import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-713 — the Hermes picker is one of the two places an owner CHOOSES a
 * model, so it is one of the two places a choice is written down. The other
 * half matters as much: this route also serves callers that name a PROVIDER and
 * no model, and it then resolves that provider's own recommended default.
 *
 *   `POST /setup-api/providers/default` — "Provider only, no model. That is
 *   deliberate: the models route then writes that provider's OWN recommended
 *   default … the one thing a caller here cannot pick safely."
 *   the MCP tool `ai_set_provider` — "The default model resets to that
 *   provider's own default."
 *
 * Recording one of those as the owner's pick would mint a choice out of a
 * default — the exact confusion this marker exists to end — and would let the
 * AGENT pin the box's model on the owner's behalf.
 */

const runHermesCliMock = vi.hoisted(() => vi.fn());
const getModelOptionsMock = vi.hoisted(() => vi.fn());
const setManyMock = vi.hoisted(() => vi.fn());

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
  setMany: setManyMock,
  getKnown: vi.fn(async () => ({ value: undefined, known: true })),
}));

import { EXPLICIT_MODEL_PICKS_KEY } from "@/lib/explicit-model-pick";

/** A box on Anthropic, with two models to choose between. */
const PAYLOAD = {
  providers: [{
    id: "anthropic",
    name: "Anthropic",
    authenticated: true,
    verified: null,
    isUserDefined: false,
    source: "dashboard",
    total: 2,
    models: [
      { id: "anthropic/claude-opus-5", description: "" },
      { id: "anthropic/claude-fable-5", description: "" },
    ],
  }],
  current: { provider: "anthropic", model: "anthropic/claude-opus-5" },
  reasoning: "medium",
  fetchedAt: Date.now(),
  source: "dashboard" as const,
  stale: false,
};

async function save(body: Record<string, unknown>): Promise<number> {
  const { POST } = await import("@/app/setup-api/hermes/models/route");
  const res = await POST(new Request("http://localhost/setup-api/hermes/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return res.status;
}

/** The picks written to the store by this request, if any. */
function recordedPicks(): unknown {
  const call = setManyMock.mock.calls.find(
    ([values]) => values && Object.prototype.hasOwnProperty.call(values, EXPLICIT_MODEL_PICKS_KEY),
  );
  return call?.[0]?.[EXPLICIT_MODEL_PICKS_KEY];
}

beforeEach(() => {
  vi.resetModules();
  runHermesCliMock.mockReset();
  runHermesCliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  getModelOptionsMock.mockReset();
  getModelOptionsMock.mockResolvedValue(structuredClone(PAYLOAD));
  setManyMock.mockReset();
  setManyMock.mockResolvedValue(undefined);
});

describe("POST /setup-api/hermes/models and the owner's explicit pick", () => {
  it("records the model when the request named one", async () => {
    expect(await save({ provider: "anthropic", model: "anthropic/claude-fable-5" })).toBe(200);

    expect(recordedPicks()).toEqual({ anthropic: "anthropic/claude-fable-5" });
  });

  it("records nothing when only a PROVIDER was named", async () => {
    // The model that lands is that provider's own recommended default, which is
    // another default — not a choice.
    expect(await save({ provider: "anthropic" })).toBe(200);

    expect(recordedPicks()).toBeUndefined();
  });

  it("records a re-pick of the model the box already runs", async () => {
    // The write is skipped (already equal), the choice is not.
    expect(await save({ provider: "anthropic", model: "anthropic/claude-opus-5" })).toBe(200);

    expect(recordedPicks()).toEqual({ anthropic: "anthropic/claude-opus-5" });
  });
});
