import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-769, the Hermes half.
 *
 * `scopeFromPayload` answers "which model should this provider land on" and
 * only ever honoured the SAVED model while the save belonged to the provider
 * being asked about (`inScopeCurrent`). Ask for the ClawBox AI scope while the
 * device is saved on another provider and it fell through to the dashboard's
 * recommended default, then to `featured`, then to `models[0]` — and the
 * ClawBox AI list is ordered Flash first, so an owner who had chosen Max came
 * back to Flash.
 *
 * Same defect, same shape, same ruling as the OpenClaw chat picker: a default
 * fills a gap and never overwrites a choice (TASK-713). `/setup-api/hermes/
 * models` already RECORDS the pick on every save; this is the read back.
 */

const dashboardFetchMock = vi.fn();
const runHermesCliMock = vi.fn();
const readFileMock = vi.fn();
const getKnownMock = vi.fn();

vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardFetch: dashboardFetchMock,
  __esModule: true,
}));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: runHermesCliMock }));
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(),
  getKnown: getKnownMock,
  setMany: vi.fn(),
}));
vi.mock("fs/promises", () => ({
  default: { readFile: readFileMock },
  readFile: readFileMock,
}));

// Env-overridable ids (clawbox-ai-models.ts): imported, never retyped.
import { CLAWBOX_AI_FLASH_MODEL_ID, CLAWBOX_AI_PRO_MODEL_ID } from "@/lib/clawbox-ai-models";

/**
 * A device saved on Anthropic, with a ClawBox AI row offering both tiers in
 * the order the seed writes them — Flash first, which is what made the
 * downgrade silent.
 */
function payloadSavedOnAnthropic(): import("@/lib/hermes-model-options").ModelOptionsPayload {
  return {
    providers: [
      {
        id: "clawai",
        name: "ClawBox AI",
        authenticated: true,
        models: [
          { id: CLAWBOX_AI_FLASH_MODEL_ID, description: "" },
          { id: CLAWBOX_AI_PRO_MODEL_ID, description: "" },
        ],
      },
      {
        id: "anthropic",
        name: "Anthropic",
        authenticated: true,
        models: [{ id: "claude-opus-5", description: "" }],
      },
    ],
    current: { provider: "anthropic", model: "claude-opus-5" },
    reasoning: "",
    fetchedAt: Date.now(),
    source: "dashboard",
    stale: false,
  } as import("@/lib/hermes-model-options").ModelOptionsPayload;
}

describe("the ClawBox AI scope while the device is saved elsewhere", () => {
  let mod: typeof import("@/lib/hermes-model-options");

  beforeEach(async () => {
    vi.resetModules();
    dashboardFetchMock.mockReset();
    runHermesCliMock.mockReset();
    readFileMock.mockReset();
    getKnownMock.mockReset();
    runHermesCliMock.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    // No recommended default from the dashboard unless a test says otherwise;
    // `recommendedDefault` treats a non-ok answer as "none".
    dashboardFetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    getKnownMock.mockResolvedValue({ value: undefined, known: true });
    mod = await import("@/lib/hermes-model-options");
  });

  it("lands on the model the owner picked, not the first one listed", async () => {
    getKnownMock.mockResolvedValue({
      value: { clawai: CLAWBOX_AI_PRO_MODEL_ID },
      known: true,
    });

    const scope = await mod.scopeFromPayload(payloadSavedOnAnthropic(), "clawai");

    expect(scope.defaultModel).toBe(CLAWBOX_AI_PRO_MODEL_ID);
  });

  it("honours a pick recorded with the OpenClaw picker's prefixed spelling", async () => {
    // One map, two surfaces: the OpenClaw picker records
    // `deepseek/deepseek-v4-pro`, Hermes' own config takes the bare id.
    getKnownMock.mockResolvedValue({
      value: { clawai: `deepseek/${CLAWBOX_AI_PRO_MODEL_ID}` },
      known: true,
    });

    const scope = await mod.scopeFromPayload(payloadSavedOnAnthropic(), "clawai");

    expect(scope.defaultModel).toBe(CLAWBOX_AI_PRO_MODEL_ID);
  });

  it("still falls to the provider's own default when nothing was picked", async () => {
    const scope = await mod.scopeFromPayload(payloadSavedOnAnthropic(), "clawai");

    expect(scope.defaultModel).toBe(CLAWBOX_AI_FLASH_MODEL_ID);
  });

  it("ignores a pick the provider no longer offers", async () => {
    getKnownMock.mockResolvedValue({
      value: { clawai: "deepseek-v3-retired" },
      known: true,
    });

    const scope = await mod.scopeFromPayload(payloadSavedOnAnthropic(), "clawai");

    expect(scope.defaultModel).toBe(CLAWBOX_AI_FLASH_MODEL_ID);
  });

  it("leaves the saved model alone when the scope IS the saved provider", async () => {
    // `inScopeCurrent` still wins: the device's live selection is a fact, not
    // a default, and a stale pick must never move a provider off it.
    getKnownMock.mockResolvedValue({
      value: { anthropic: "claude-haiku-4.5" },
      known: true,
    });

    const scope = await mod.scopeFromPayload(payloadSavedOnAnthropic(), "anthropic");

    expect(scope.current).toBe("claude-opus-5");
    expect(scope.defaultModel).toBe("claude-opus-5");
  });
});
