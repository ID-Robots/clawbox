import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ClawBox AI seed in `normalizeRow` is a FALLBACK, never a top-up.
 *
 * Hermes reports a custom provider's models as whatever our own
 * `providers.clawai.models` declares merged with whatever `<base_url>/models`
 * answers, and the ClawBox AI proxy answers that probe in a shape Hermes cannot
 * read — so on a box whose block has not been written yet the row arrives
 * EMPTY, and our chat header would have no model pill at all. That is what the
 * seed is for, and `applyClawaiToHermes` / `reconcileClawaiModelsWithHermes`
 * are what make it unnecessary.
 *
 * The moment the row is NOT empty it must be left exactly as Hermes reported
 * it: a renamed tier id, an owner's hand-pinned single model, or the proxy
 * finally speaking the OpenAI envelope would each get our two ids appended to
 * the live ones, and the picker would offer models the provider does not serve
 * — the provider/model mismatch `hermes-model-options` exists to prevent.
 */

const dashboardFetchMock = vi.fn();
const runHermesCliMock = vi.fn();
const readFileMock = vi.fn();
const configGetMock = vi.fn();

vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardFetch: dashboardFetchMock,
  __esModule: true,
}));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: runHermesCliMock }));
vi.mock("@/lib/config-store", () => ({ get: configGetMock }));
vi.mock("fs/promises", () => ({
  default: { readFile: readFileMock },
  readFile: readFileMock,
}));

/** One clawai row, exactly as `/api/model/options` serves it. */
function dashboardRow(models: string[]) {
  dashboardFetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      providers: [{
        slug: "clawai",
        name: "ClawBox AI",
        authenticated: true,
        is_user_defined: true,
        source: "config",
        total_models: models.length,
        models,
      }],
      provider: "clawai",
      model: models[0] ?? "",
    }),
  });
}

describe("the ClawBox AI row our own picker builds", () => {
  let mod: typeof import("@/lib/hermes-model-options");

  beforeEach(async () => {
    vi.resetModules();
    dashboardFetchMock.mockReset();
    runHermesCliMock.mockReset();
    readFileMock.mockReset();
    configGetMock.mockReset();
    runHermesCliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    readFileMock.mockRejectedValue(new Error("no catalog on disk"));
    configGetMock.mockResolvedValue(undefined);
    mod = await import("@/lib/hermes-model-options");
  });

  it("seeds both tier models when Hermes reports the row empty", async () => {
    dashboardRow([]);
    const payload = await mod.getModelOptions();
    const row = payload.providers.find((p) => p.id === "clawai");
    expect(row?.models.map((m) => m.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("leaves a non-empty row exactly as Hermes reported it", async () => {
    // The box's owner pinned one id, so Hermes offers one id. Appending our
    // two would put a model the owner deliberately removed back in the picker
    // — and, on a box whose ids were renamed upstream, would offer two that no
    // longer route at all.
    dashboardRow(["deepseek-v4-flash"]);
    const payload = await mod.getModelOptions();
    const row = payload.providers.find((p) => p.id === "clawai");
    expect(row?.models.map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
  });

  it("does not invent our ids beside a live catalogue that renamed them", async () => {
    dashboardRow(["deepseek-v5-flash", "deepseek-v5-pro"]);
    const payload = await mod.getModelOptions();
    const row = payload.providers.find((p) => p.id === "clawai");
    expect(row?.models.map((m) => m.id)).toEqual(["deepseek-v5-flash", "deepseek-v5-pro"]);
  });
});
