import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_MODELS } from "@/lib/provider-models";
import { resetCoreModelLifecycle } from "@/lib/core-model-lifecycle";
import { offSurfaceCodexModelMessage } from "@/lib/subscription-surface";
import { createManifestFixture, type ManifestFixture } from "@/tests/helpers/core-model-manifests";

// TASK-786 — the ChatGPT-account (OpenAI Codex) surface is ONE list.
//
// It used to be three: `CODEX_MODELS` (what the picker offers),
// `CODEX_SUPPORTED_MODEL_RE` (what the write paths accept) and
// `_CODEX_SUPPORTED` in scripts/gateway-pre-start.sh. The middle one was a
// GENERATION regex — `/^(?:gpt-5\.6-(?:sol|terra|luna)|gpt-5\.5|…)$/` — and a
// generation allowlist cannot know what the next generation is called. The
// same allowlist was removed from the `openai` provider for that reason after
// it hid the whole gpt-5.6 family; the codex copy survived and hid
// gpt-5.3-codex-spark, a model the installed core routes on this surface and
// on no other.
//
// It is still one list, and since 2026-09-10 that list is the INSTALLED CORE'S
// own: `chatgptSurface()` reads the ChatGPT route out of
// `extensions/openai/openclaw.plugin.json` — the models it ships, the ones it
// suppresses on `chatgpt.com` (off this route) and the ones it suppresses on
// `api.openai.com` (on this route alone) — and `CODEX_MODELS` is what it falls
// back to where no manifest can be read. A hand-kept mirror answered for one
// core version: against 2026.9.3 it is wrong in both directions at once.
//
// WHAT THESE CASES PIN. The write guard is derived from the surface, so "accepts
// exactly what the picker offers" cannot fail while that holds — it is the
// CHANGE DETECTOR for the derivation and goes red the moment somebody
// reintroduces a second spelling. The halves that pin something on their own are
// the manifest-driven ones: a model the core added reaches the guard, and one the
// core retired from the route stops reaching it, with no release here. The mirror
// itself is pinned against the installed core in
// `codex-surface-follows-core.test.ts` and against pre-start's copy in
// `gateway-pre-start-codex-models.test.ts`.

const bin = vi.hoisted(() => ({ override: null as string | null }));

vi.mock("@/lib/openclaw-config", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/openclaw-config")>();
  return { ...actual, findOpenclawBin: () => bin.override ?? actual.findOpenclawBin() };
});

const CURATED_IDS = CODEX_MODELS.map((m) => m.id);

/** The write guard's verdict: null means "this box may be switched to it". */
function accepted(modelId: string): boolean {
  return offSurfaceCodexModelMessage(null, modelId, true) === null;
}

describe("the ChatGPT-account model list", () => {
  let fixture: ManifestFixture | null = null;

  beforeEach(() => {
    // No manifest anywhere unless a case writes one: the curated fallback is
    // what the cases below judge, and a machine with a real core installed
    // would otherwise answer from whatever it has.
    fixture = createManifestFixture("codex-supported-models");
    bin.override = "openclaw";
    resetCoreModelLifecycle();
  });

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
    bin.override = null;
    resetCoreModelLifecycle();
  });

  it("carries gpt-5.3-codex-spark, which runs only on this surface", () => {
    // Measured 2026-09-09 on core 2026.8.1:
    //   `openclaw infer model run --local --model openai/gpt-5.3-codex-spark`
    //   went out on api=openclaw-openai-chatgpt-responses-transport to
    //   https://chatgpt.com/backend-api/codex/responses and answered 200,
    // while the same box's `models list --provider openai` reports it
    // `available: false` — the platform route excludes it. Both cores state the
    // same thing in the manifest, as a suppression on `api.openai.com`.
    expect(CURATED_IDS).toContain("gpt-5.3-codex-spark");
  });

  it("accepts exactly what the picker offers, by construction", () => {
    // A row the picker shows that the guard refuses is a dead button; a model
    // the guard accepts that the picker never shows is unreachable. One list
    // makes both impossible instead of pinning them against each other — so
    // this case is red only if the guard stops being derived from the list.
    for (const id of CURATED_IDS) {
      expect(accepted(id), `the picker offers ${id} but the write guard refuses it`).toBe(true);
    }
  });

  it("refuses the models this surface must not carry", () => {
    // The `-pro` tiers are the measured case and the reason this surface is
    // narrower than the core's dual-route set: the core lists them, and the
    // ChatGPT-account path answers "model not supported when using Codex with
    // a ChatGPT account" (developers.openai.com/codex/models).
    for (const id of ["gpt-5.4-pro", "gpt-5.5-pro", "gpt-4o"]) {
      expect(CURATED_IDS, `${id} must not be offered on the ChatGPT surface`).not.toContain(id);
      expect(accepted(id), `the write guard must refuse ${id}`).toBe(false);
    }
  });

  it("names the models it refuses in the refusal", () => {
    const message = offSurfaceCodexModelMessage(null, "gpt-4o", true);
    expect(message).toContain("gpt-4o is not supported with ChatGPT subscription auth");
    // Built from the one list, so a model added to it reaches the refusal too.
    expect(message).toContain(CODEX_MODELS[0].label);
  });

  it("accepts a model the installed core added to the route", () => {
    // core 2026.9.3: `gpt-6-astra` is in the openai manifest (and first in its
    // `OPENAI_DUAL_ROUTE_MODEL_IDS`). The curated list has never carried it —
    // it was excluded on a turn that went to api.openai.com, which is where
    // that box sends the owner's own gpt-5.5 as well.
    fixture!.writeManifest("openai", {
      modelCatalog: {
        providers: { openai: { models: [{ id: "gpt-6-astra", name: "GPT-6 Astra" }, { id: "gpt-5.5", name: "GPT-5.5" }] } },
      },
    });
    resetCoreModelLifecycle();
    expect(accepted("gpt-6-astra")).toBe(true);
  });

  it("refuses a model the installed core retired from the route", () => {
    // The same manifest's other direction: 2026.9.3 suppresses gpt-5.4 on
    // `chatgpt.com` — "retired from the ChatGPT-account Codex route" — while the
    // curated list still offers it.
    fixture!.writeManifest("openai", {
      modelCatalog: {
        providers: { openai: { models: [{ id: "gpt-5.5", name: "GPT-5.5" }, { id: "gpt-5.4", name: "GPT-5.4" }] } },
        suppressions: [
          {
            provider: "openai",
            model: "gpt-5.4",
            reason: "GPT-5.4 has retired from the ChatGPT-account Codex route.",
            when: { baseUrlHosts: ["chatgpt.com"] },
          },
        ],
      },
    });
    resetCoreModelLifecycle();
    expect(CURATED_IDS).toContain("gpt-5.4");
    expect(accepted("gpt-5.4")).toBe(false);
  });
});
