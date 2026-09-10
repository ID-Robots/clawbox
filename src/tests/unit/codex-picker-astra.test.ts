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

  it("keeps a last-resort list rather than emptying the picker", () => {
    // A core that has retired EVERY curated id from this route and lists nothing
    // else. Because the widening pass runs unconditionally, this is the only way
    // the derived list can come out empty — so filtering the fallback through the
    // same suppressions would return nothing at all, and an empty surface is the
    // one shape this module must not produce: the guard would refuse every model
    // while naming none, and the cold-start default would be a model that same
    // guard refuses, so a ChatGPT sign-in could not complete.
    write({
      modelCatalog: {
        providers: { openai: { models: [] } },
        suppressions: CODEX_MODELS.map((model) => ({
          provider: "openai",
          model: model.id,
          when: { baseUrlHosts: ["chatgpt.com"] },
        })),
      },
    });
    const surface = chatgptSurface();
    expect(surface.models).toEqual(CODEX_MODELS);
    expect(surface.source).toBe("curated");
    // The invariant the last resort exists to hold: setup can still finish.
    expect(isCodexSupportedModelId(chatgptDefaultModelId())).toBe(true);
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

  it("ignores the api-shaped condition, which never fires in the core on this box", () => {
    // `when.providerConfigApiIn` is the core's OTHER condition and is deliberately
    // NOT read — see the note above `lower` in core-model-lifecycle.ts. The core
    // ANDs its conditions and evaluates this one against the OWNER'S configured
    // `models.providers.openai.api`, which ClawBox never writes, so such a
    // suppression does not fire there. Honouring it would drop a row the box can
    // still run: a false failure.
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
    expect(chatgptSurface().models.map((m) => m.id)).toContain("gpt-5.6-sol");
    expect(isCodexSupportedModelId("gpt-5.6-sol")).toBe(true);
  });

  it("matches a suppression whose provider, model or host is spelled in another case", () => {
    // The core keys suppressions by
    // `normalizeProviderId(provider) + "::" + normalizeLowercaseStringOrEmpty(id)`
    // and normalises the looked-up id the same way, so all three sides are
    // case-folded there. A manifest that listed `GPT-5.4` while suppressing
    // `gpt-5.4` would be blocked by the core and still offered here — a dead
    // button whose every turn dies on `Unknown model`.
    write({
      modelCatalog: {
        providers: { openai: { models: [{ id: "gpt-5.5", name: "GPT-5.5" }, { id: "GPT-5.4", name: "GPT-5.4" }] } },
        suppressions: [
          { provider: "OpenAI", model: "gpt-5.4", when: { baseUrlHosts: ["ChatGPT.com"] } },
        ],
      },
    });
    const ids = chatgptSurface().models.map((m) => m.id);
    expect(ids).not.toContain("GPT-5.4");
    expect(ids).not.toContain("gpt-5.4");
    expect(isCodexSupportedModelId("GPT-5.4")).toBe(false);
    expect(isCodexSupportedModelId("gpt-5.4")).toBe(false);
  });

  it("never leaves a sign-in with nothing to probe when the floor is gone", () => {
    // H-1. The floor is the OLDEST row the core still routes, not the newest: the
    // first row would be the most likely plan-gated model AND would leave nothing
    // ahead of it, so the entitlement probe would be handed an empty list and a
    // Free account would be pinned to a model that 400s on every turn — with the
    // probe silently disabled in exactly the case this derivation exists for.
    write({
      modelCatalog: {
        providers: {
          openai: {
            models: [
              { id: ASTRA, name: "GPT-6 Astra" },
              { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
              { id: "gpt-5.5", name: "GPT-5.5" },
            ],
          },
        },
        suppressions: [
          { provider: "openai", model: "gpt-5.5", when: { baseUrlHosts: ["chatgpt.com"] } },
        ],
      },
    });
    const models = chatgptSurface().models.map((m) => m.id);
    const fallbackDefault = chatgptDefaultModelId();
    // Not the floor the core removed, and not the newest row either.
    expect(fallbackDefault).not.toBe("gpt-5.5");
    expect(fallbackDefault).not.toBe(models[0]);
    // A default its own write guard refuses is a sign-in that cannot complete.
    expect(isCodexSupportedModelId(fallbackDefault)).toBe(true);
    // And the thing this case exists for: the probe still has rows to try, newest
    // first, so a non-entitled account is not pinned to a plan-gated model.
    const candidates = chatgptUpgradeCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toBe(ASTRA);
    expect(candidates).not.toContain(fallbackDefault);
  });

  it("never lets a platform-only non-chat SKU reach the picker or the write guard", () => {
    // H-2. The block this derivation seeds from is the core's PLATFORM provider
    // config, and it is a ChatGPT-route list only because today's manifest
    // happens to carry nothing else. The first core that lists an image or
    // embedding SKU there would otherwise put it in the picker AND through
    // `isCodexSupportedModelId`, which is the only gate the two write paths to
    // `agents.defaults.model.primary` apply.
    write({
      modelCatalog: {
        providers: {
          openai: {
            models: [
              { id: "gpt-5.5", name: "GPT-5.5" },
              { id: "gpt-image-2", name: "GPT Image 2" },
              { id: "text-embedding-4-large", name: "Text Embedding 4 Large" },
              { id: "gpt-5.6-realtime-preview", name: "GPT-5.6 Realtime" },
            ],
          },
        },
        // Even stated as reachable on THIS route and no other, a SKU a chat
        // picker cannot talk to is still not a chat model.
        suppressions: [
          { provider: "openai", model: "gpt-audio-2", when: { baseUrlHosts: ["api.openai.com"] } },
        ],
      },
    });
    const ids = chatgptSurface().models.map((m) => m.id);
    for (const id of ["gpt-image-2", "text-embedding-4-large", "gpt-5.6-realtime-preview", "gpt-audio-2"]) {
      expect(ids, `${id} is not a chat model and must not be offered`).not.toContain(id);
      expect(isCodexSupportedModelId(id)).toBe(false);
    }
    expect(ids).toContain("gpt-5.5");
  });

  it("never asks the probe for more attempts than its budget affords", () => {
    // M-4. `codex-model-probe` allows 6s per probe inside a 15s total, so it runs
    // three and stops at the deadline. An unbounded list made that an invisible
    // truncation; the cap states it.
    write({
      modelCatalog: {
        providers: {
          openai: {
            models: [
              { id: ASTRA, name: "GPT-6 Astra" },
              { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
              { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
              { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
              { id: "gpt-5.5", name: "GPT-5.5" },
            ],
          },
        },
      },
    });
    expect(chatgptDefaultModelId()).toBe("gpt-5.5");
    expect(chatgptUpgradeCandidates()).toEqual([ASTRA, "gpt-5.6-sol", "gpt-5.6-terra"]);
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
