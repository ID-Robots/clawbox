import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_MODELS } from "@/lib/provider-models";
import { chatgptSurface } from "@/lib/chatgpt-surface";
import { resetCoreModelLifecycle } from "@/lib/core-model-lifecycle";
import { chatgptSupportedModelsSentence, isCodexSupportedModelId } from "@/lib/subscription-surface";
import { createManifestFixture, type ManifestFixture } from "@/tests/helpers/core-model-manifests";

/**
 * "I am on Codex but I don't see Astra" — the ChatGPT-account picker follows the
 * installed core's own ChatGPT route instead of a list kept in this repo.
 *
 * The row was left out deliberately, on a measurement that said `gpt-6-astra`
 * was "not on the ChatGPT route at all": a turn on it went to api.openai.com
 * rather than chatgpt.com. Re-measured on the same box on 2026-09-10, with the
 * Codex runtime armed on the model ref: a turn on the OWNER'S OWN
 * `openai/gpt-5.5` goes to api.openai.com too and 401s there, after which the
 * run fails over to the fallback provider. The route that measurement described
 * is the box's, not the model's — which is why this surface is no longer
 * decided here at all.
 *
 * What the core publishes, in a file that needs no credential and no network
 * call (`extensions/openai/openclaw.plugin.json`, the manifest
 * `core-model-lifecycle.ts` already reads for retirements):
 *
 *   * 2026.8.1 lists nine openai models and suppresses `gpt-5.3-codex-spark` on
 *     `api.openai.com` — reachable through the ChatGPT account and nowhere else.
 *   * 2026.9.3 lists `gpt-6-astra` FIRST (its route contract files it under
 *     `OPENAI_DUAL_ROUTE_MODEL_IDS`) and suppresses `gpt-5.4` and
 *     `gpt-5.4-mini` on `chatgpt.com`: "retired from the ChatGPT-account Codex
 *     route."
 *
 * So the curated list is wrong in BOTH directions on the next core, and the
 * cases below are written against the two real manifest shapes: what the picker
 * offers, what the write guard accepts and what the refusal sentence names, on
 * each of them.
 */

const bin = vi.hoisted(() => ({ override: null as string | null }));

vi.mock("@/lib/openclaw-config", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/openclaw-config")>();
  return { ...actual, findOpenclawBin: () => bin.override ?? actual.findOpenclawBin() };
});

const ASTRA = "gpt-6-astra";
const SPARK = "gpt-5.3-codex-spark";

/** The openai rows of the manifest shipped with core 2026.8.1, ids and names only. */
const MANIFEST_2026_8_1 = {
  modelCatalog: {
    providers: {
      openai: {
        models: [
          { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
          { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
          { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
          { id: "gpt-5.5", name: "GPT-5.5" },
          { id: "gpt-5.5-pro", name: "gpt-5.5-pro" },
          { id: "gpt-5.4", name: "GPT-5.4" },
          { id: "gpt-5.4-pro", name: "GPT-5.4 Pro" },
          { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
          { id: "gpt-5.4-nano", name: "GPT-5.4 Nano" },
        ],
      },
    },
    suppressions: [
      { provider: "openai", model: SPARK, when: { baseUrlHosts: ["api.openai.com"] } },
      // The azure alias carries its own unconditional row, which says nothing
      // about this provider's routes.
      { provider: "azure-openai-responses", model: SPARK },
    ],
  },
};

/** The same file from core 2026.9.3: Astra added, two rows retired from the route. */
const MANIFEST_2026_9_3 = {
  modelCatalog: {
    providers: {
      openai: {
        models: [
          { id: ASTRA, name: "GPT-6 Astra" },
          ...MANIFEST_2026_8_1.modelCatalog.providers.openai.models,
        ],
      },
    },
    suppressions: [
      {
        provider: "openai",
        model: "gpt-5.4",
        reason: "GPT-5.4 has retired from the ChatGPT-account Codex route.",
        retirement: { replacedBy: "gpt-5.6-terra" },
        when: { baseUrlHosts: ["chatgpt.com"] },
      },
      {
        provider: "openai",
        model: "gpt-5.4-mini",
        reason: "GPT-5.4 Mini has retired from the ChatGPT-account Codex route.",
        retirement: { replacedBy: "gpt-5.6-luna" },
        when: { baseUrlHosts: ["chatgpt.com"] },
      },
      ...MANIFEST_2026_8_1.modelCatalog.suppressions,
    ],
  },
};

describe("the ChatGPT-account surface follows the installed core", () => {
  let fixture: ManifestFixture | null = null;

  beforeEach(() => {
    fixture = createManifestFixture("codex-picker-astra");
    // The bundled candidate dropped, so the fixture's manifest is the only one
    // there is — a machine with a real core installed would otherwise answer
    // from it and these cases would test that box instead of these shapes.
    bin.override = "openclaw";
    resetCoreModelLifecycle();
  });

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
    bin.override = null;
    resetCoreModelLifecycle();
  });

  function write(manifest: unknown): void {
    fixture!.writeManifest("openai", manifest);
    resetCoreModelLifecycle();
  }

  it("offers GPT-6 Astra on the core that ships it, and accepts it on the write paths", () => {
    write(MANIFEST_2026_9_3);
    const surface = chatgptSurface();
    expect(surface.source).toBe("core");
    expect(surface.models.map((m) => m.id)).toContain(ASTRA);
    // First, because the manifest lists it first — the picker renders the
    // source's own order and the core's is newest-first.
    expect(surface.models[0]?.id).toBe(ASTRA);
    expect(surface.models[0]?.label).toBe("GPT-6 Astra");
    // A row the picker offers that the write guard refuses is a dead button.
    expect(isCodexSupportedModelId(ASTRA)).toBe(true);
    expect(chatgptSupportedModelsSentence()).toContain("GPT-6 Astra");
  });

  it("drops the models that core retired from the ChatGPT route", () => {
    write(MANIFEST_2026_9_3);
    const ids = chatgptSurface().models.map((m) => m.id);
    for (const id of ["gpt-5.4", "gpt-5.4-mini"]) {
      expect(ids, `${id} is suppressed on chatgpt.com and must not be offered`).not.toContain(id);
      expect(isCodexSupportedModelId(id)).toBe(false);
    }
    // …and keeps the one the core suppresses on the PLATFORM host, which the
    // manifest's model list does not carry at all.
    expect(ids).toContain(SPARK);
  });

  it("keeps the tiers the ChatGPT account cannot run off the surface", () => {
    write(MANIFEST_2026_9_3);
    const ids = chatgptSurface().models.map((m) => m.id);
    for (const id of ["gpt-5.5-pro", "gpt-5.4-pro", "gpt-5.4-nano"]) {
      expect(ids, `${id} must not be offered on the ChatGPT surface`).not.toContain(id);
      expect(isCodexSupportedModelId(id)).toBe(false);
    }
  });

  it("answers exactly today's curated list on the core the boxes run", () => {
    // The shipped core must see no change at all: this is what says the
    // derivation replaces the curated list rather than altering what a box in a
    // customer's hands offers.
    write(MANIFEST_2026_8_1);
    const surface = chatgptSurface();
    expect(surface.source).toBe("core");
    expect(surface.models.map((m) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
    // Labels too — ours, not the core's, for the one row whose name would
    // truncate in the chat header's model pill.
    expect(surface.models.map((m) => m.label)).toEqual(CODEX_MODELS.map((m) => m.label));
  });

  it("falls back to the curated list where there is no manifest to read", () => {
    const surface = chatgptSurface();
    expect(surface.source).toBe("curated");
    expect(surface.models).toEqual(CODEX_MODELS);
    expect(isCodexSupportedModelId("gpt-5.5")).toBe(true);
  });

  it("falls back rather than emptying the picker when the manifest offers nothing", () => {
    // A catalogue whose every row is off-surface is a shape this does not
    // understand; serving zero rows would refuse every model on a box whose
    // ChatGPT account works.
    write({ modelCatalog: { providers: { openai: { models: [{ id: "gpt-9-pro" }] } } } });
    const surface = chatgptSurface();
    expect(surface.source).toBe("curated");
    expect(surface.models).toEqual(CODEX_MODELS);
  });

  it("ignores a suppression that names another provider or no host", () => {
    write({
      modelCatalog: {
        providers: { openai: { models: [{ id: "gpt-5.5", name: "GPT-5.5" }] } },
        suppressions: [
          // Another provider's route.
          { provider: "azure-openai-responses", model: "gpt-5.5", when: { baseUrlHosts: ["chatgpt.com"] } },
          // Unconditional: not a claim about this route.
          { provider: "openai", model: "gpt-5.5" },
        ],
      },
    });
    expect(chatgptSurface().models.map((m) => m.id)).toEqual(["gpt-5.5"]);
  });
});
