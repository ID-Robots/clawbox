import { describe, expect, it } from "vitest";
import { CODEX_MODELS } from "@/lib/provider-models";
import { offSurfaceCodexModelMessage } from "@/lib/subscription-surface";

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
// Upstream truth is the core's own `extensions/openai/model-route-contract`
// (`OPENAI_CHATGPT_MODERN_MODEL_IDS` = the dual-route ids plus the
// subscription-only ones). Measured on the box: it has no CLI or RPC surface —
// `openclaw models list --provider codex` and `--provider openai-chatgpt` both
// answer `Unknown provider filter`, and the openai enumeration carries no
// plan- or auth-scoped field. So ClawBox mirrors it.
//
// WHAT THESE CASES ACTUALLY PIN, because two of them are true by construction
// once the surface is one list and would read as more protection than they are:
// `accepted()` reduces to a lookup in `CODEX_MODELS`, so "accepts exactly what
// the picker offers" cannot fail while the guard is derived from the catalogue
// — it is the CHANGE DETECTOR for that derivation, and it goes red the moment
// somebody reintroduces a second spelling. The half that pins something today
// is the `not.toContain` one: the ids this surface must NOT carry. The mirror
// itself is pinned against something external in
// `codex-surface-follows-core.test.ts` (the installed core's own manifest) and
// against pre-start's copy in `gateway-pre-start-codex-models.test.ts`.

const CURATED_IDS = CODEX_MODELS.map((m) => m.id);

/** The write guard's verdict: null means "this box may be switched to it". */
function accepted(modelId: string): boolean {
  return offSurfaceCodexModelMessage(null, modelId, true) === null;
}

describe("the ChatGPT-account model list", () => {
  it("carries gpt-5.3-codex-spark, which runs only on this surface", () => {
    // Measured 2026-09-09 on core 2026.8.1:
    //   `openclaw infer model run --local --model openai/gpt-5.3-codex-spark`
    //   went out on api=openclaw-openai-chatgpt-responses-transport to
    //   https://chatgpt.com/backend-api/codex/responses and answered 200,
    // while the same box's `models list --provider openai` reports it
    // `available: false` — the platform route excludes it.
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
    // a ChatGPT account" (developers.openai.com/codex/models). `gpt-6-astra`
    // is the newer case — the installed core does not carry it on the ChatGPT
    // route at all, so a turn on it silently falls back to the platform
    // endpoint and the API key (measured: 401 on a subscription-only box).
    for (const id of ["gpt-5.4-pro", "gpt-5.5-pro", "gpt-6-astra", "gpt-4o"]) {
      expect(CURATED_IDS, `${id} must not be offered on the ChatGPT surface`).not.toContain(id);
      expect(accepted(id), `the write guard must refuse ${id}`).toBe(false);
    }
  });

  it("names the models it refuses in the refusal", () => {
    const message = offSurfaceCodexModelMessage(null, "gpt-6-astra", true);
    expect(message).toContain("gpt-6-astra is not supported with ChatGPT subscription auth");
    // Built from the one list, so a model added to it reaches the refusal too.
    expect(message).toContain(CODEX_MODELS[0].label);
  });
});
