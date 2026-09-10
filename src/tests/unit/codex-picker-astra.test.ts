import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_MODELS } from "@/lib/provider-models";
import { chatgptDefaultModelId, chatgptSurface, chatgptUpgradeCandidates } from "@/lib/chatgpt-surface";
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

  it("never narrows below the curated list — the manifest is a seed, not the catalogue", () => {
    // The core's manifest is its static seed (`modelCatalog.discovery` says the
    // openai catalogue is resolved at runtime), so a chatgpt-route model can
    // live outside it. If the derivation replaced the curated list, such a model
    // would lose its row AND be refused by the write guard — the false failure
    // this surface exists to remove, pointed the other way. It can only ADD.
    write({ modelCatalog: { providers: { openai: { models: [{ id: "gpt-6-astra", name: "GPT-6 Astra" }] } } } });
    const ids = chatgptSurface().models.map((m) => m.id);
    expect(ids).toContain("gpt-6-astra");
    for (const curated of CODEX_MODELS) {
      expect(ids, `${curated.id} fell out of the manifest's seed and must still be offered`)
        .toContain(curated.id);
    }
    // …and only the core's own retirement takes one away.
    expect(isCodexSupportedModelId("gpt-5.5")).toBe(true);
  });

  it("still offers a curated row the manifest lists nothing about", () => {
    // Not even a provider block for openai: that is "this manifest cannot say",
    // which is UNKNOWN and never "the route is empty".
    write({ modelCatalog: { providers: {} } });
    const surface = chatgptSurface();
    expect(surface.source).toBe("curated");
    expect(surface.models).toEqual(CODEX_MODELS);
  });

  it("never defaults a sign-in to a model its own write guard refuses", () => {
    // The invariant H-2 is about: `configure` computes the cold-start default
    // and then judges it with `offSurfaceCodexModelMessage` in the same request.
    // A core that retires gpt-5.5 from the ChatGPT route — the move 2026.9.3
    // made for gpt-5.4, on a model both manifests already mark deprecated —
    // would otherwise 400 a fresh ChatGPT sign-in on its own default, with no
    // other door out of setup.
    write({
      modelCatalog: {
        providers: {
          openai: {
            models: [
              { id: "gpt-6-astra", name: "GPT-6 Astra" },
              { id: "gpt-5.5", name: "GPT-5.5" },
            ],
          },
        },
        suppressions: [
          {
            provider: "openai",
            model: "gpt-5.5",
            reason: "GPT-5.5 has retired from the ChatGPT-account Codex route.",
            when: { baseUrlHosts: ["chatgpt.com"] },
          },
        ],
      },
    });
    const fallbackDefault = chatgptDefaultModelId();
    expect(fallbackDefault).not.toBe("gpt-5.5");
    expect(isCodexSupportedModelId(fallbackDefault)).toBe(true);
  });

  it("keeps gpt-5.5 as the floor while the core still routes it", () => {
    write(MANIFEST_2026_8_1);
    expect(chatgptDefaultModelId()).toBe("gpt-5.5");
    // …and the probe's candidates are the surface rows ABOVE that floor, which
    // on this core is exactly the hand-kept preference list it replaces.
    expect(chatgptUpgradeCandidates()).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("lets the probe reach a model the core added", () => {
    write(MANIFEST_2026_9_3);
    // The other half of the same defect: with a hand-kept preference list a
    // fresh sign-in on this core would land on gpt-5.5 while the picker offered
    // Astra first — the complaint this change exists to answer, surviving in the
    // one place that writes config.
    expect(chatgptUpgradeCandidates()[0]).toBe(ASTRA);
    expect(chatgptDefaultModelId()).toBe("gpt-5.5");
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
    // gpt-5.5 survives: neither suppression is a claim about THIS provider's
    // ChatGPT route. The rest of the curated list is there because the seed is
    // never allowed to narrow the surface.
    const ids = chatgptSurface().models.map((m) => m.id);
    expect(ids).toContain("gpt-5.5");
    expect(isCodexSupportedModelId("gpt-5.5")).toBe(true);
  });

  it("reads the api-shaped suppression the core's matcher also compiles", () => {
    // `when.providerConfigApiIn` is the core's OTHER condition, and the natural
    // spelling once the transport rather than the URL identifies the route.
    // Ignoring it would leave the row offered, the write guard accepting it, and
    // every turn dying on the core's own `Unknown model`.
    write({
      modelCatalog: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.5", name: "GPT-5.5" }, { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
          },
        },
        suppressions: [
          {
            provider: "openai",
            model: "gpt-5.6-sol",
            when: { providerConfigApiIn: ["openai-chatgpt-responses"] },
          },
        ],
      },
    });
    expect(chatgptSurface().models.map((m) => m.id)).not.toContain("gpt-5.6-sol");
    expect(isCodexSupportedModelId("gpt-5.6-sol")).toBe(false);
  });

  it("matches a suppression whose provider or model is spelled in another case", () => {
    // The core normalises both sides before comparing; a manifest that spelled
    // `"provider": "OpenAI"` would be honoured there and ignored here, leaving a
    // row the core refuses in the picker.
    write({
      modelCatalog: {
        providers: { openai: { models: [{ id: "gpt-5.5", name: "GPT-5.5" }, { id: "gpt-5.4", name: "GPT-5.4" }] } },
        suppressions: [
          { provider: "OpenAI", model: "gpt-5.4", when: { baseUrlHosts: ["ChatGPT.com"] } },
        ],
      },
    });
    expect(chatgptSurface().models.map((m) => m.id)).not.toContain("gpt-5.4");
  });

  it("keeps a subscription-only model whose name looks like an off-surface tier", () => {
    // An `api.openai.com` suppression is the core stating that the PLATFORM
    // route cannot reach the model — positive evidence that this surface is the
    // only way to it — so it outranks the `-pro`/`-nano` tier narrowing, which
    // is a guess made from the shape of a name.
    write({
      modelCatalog: {
        providers: { openai: { models: [{ id: "gpt-5.5", name: "GPT-5.5" }] } },
        suppressions: [
          { provider: "openai", model: "gpt-6-astra-pro", when: { baseUrlHosts: ["api.openai.com"] } },
        ],
      },
    });
    expect(chatgptSurface().models.map((m) => m.id)).toContain("gpt-6-astra-pro");
    expect(isCodexSupportedModelId("gpt-6-astra-pro")).toBe(true);
  });
});
