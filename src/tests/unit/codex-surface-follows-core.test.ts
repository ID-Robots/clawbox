import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { chatgptSurface } from "@/lib/chatgpt-surface";
import { coreManifestPaths, resetCoreModelLifecycle } from "@/lib/core-model-lifecycle";
import { createManifestFixture, type ManifestFixture } from "@/tests/helpers/core-model-manifests";

/**
 * The binary the path resolver resolves from, steerable per case — the mock
 * `curated-defaults-offerable.test.ts` uses, for the reason it documents and
 * this file reproduced on the first run: a machine WITH a core installed has a
 * real openai manifest at the bundled candidate, which is tried before the
 * fixture's home, so a fixture case that does not neutralise it reads the real
 * `gpt-5.3-codex-spark` suppression instead of what it just wrote. A bare name
 * is what `findOpenclawBin` answers where no core is installed, and it drops
 * the bundled candidate entirely.
 */
const bin = vi.hoisted(() => ({ override: null as string | null }));

vi.mock("@/lib/openclaw-config", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/openclaw-config")>();
  return { ...actual, findOpenclawBin: () => bin.override ?? actual.findOpenclawBin() };
});

/**
 * The drift detector for the ChatGPT (OpenAI Codex) list.
 *
 * The surface is DERIVED from this manifest now (`chatgptSurface()`), so the
 * case below is no longer a drift detector for a hand-kept mirror but the
 * end-to-end proof of the derivation on whatever core is installed: a model this
 * box's core says the ChatGPT account is the only way to reach must be a model
 * this box's picker offers. `CODEX_MODELS` is what the surface answers where
 * there is no manifest, and cannot be checked against one that is not there.
 *
 * The core DOES publish one half of it in a machine-readable file at a stable
 * path — the same `extensions/<provider>/openclaw.plugin.json` that
 * `core-model-lifecycle.ts` already reads for retirements. Measured on the box
 * (2026-09-09, core 2026.8.1):
 *
 *   "modelCatalog": { "suppressions": [
 *     { "provider": "openai", "model": "gpt-5.3-codex-spark",
 *       "when": { "baseUrlHosts": ["api.openai.com"] },
 *       "reason": "gpt-5.3-codex-spark is available only through ChatGPT/Codex
 *                  OAuth … OpenAI API-key auth cannot use this model." } ] }
 *
 * A model suppressed on the PLATFORM host is one the ChatGPT-account path is
 * the only way to reach — exactly the row `gpt-5.3-codex-spark` was, and the
 * kind this picker used to hide. So: every such model the installed core
 * declares must be on the ChatGPT surface.
 *
 * It only catches the SUBSCRIPTION-ONLY half. The dual-route set (gpt-5.6-*,
 * 5.5, 5.4…) is not declared anywhere the manifest exposes, and ClawBox is
 * deliberately narrower than it anyway (`-pro` 400s on the ChatGPT path). That
 * gap is stated rather than papered over — deriving the whole surface from the
 * manifest is a change of its own.
 *
 * WHERE EACH CASE BITES, in the shape `curated-defaults-offerable.test.ts`
 * established: the installed-core case is real on a box and on a dev machine
 * with a core, and VACUOUS on CI, which installs none. The fixture cases below
 * assert everywhere.
 */

const PLATFORM_HOST = "api.openai.com";

interface Suppression {
  provider?: unknown;
  model?: unknown;
  when?: { baseUrlHosts?: unknown } | null;
}

/**
 * Ids the manifest suppresses for `provider` on the platform host.
 *
 * A suppression with no `when` is unconditional — the manifest carries one for
 * `azure-openai-responses` — and says nothing about the ChatGPT route of the
 * provider we are asking about, so only a `baseUrlHosts` naming the platform
 * host counts.
 */
function subscriptionOnlyIds(manifest: unknown, provider: string): string[] {
  const list = (manifest as { modelCatalog?: { suppressions?: unknown } } | null)
    ?.modelCatalog?.suppressions;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list as Suppression[]) {
    if (entry?.provider !== provider) continue;
    const hosts = entry?.when?.baseUrlHosts;
    if (!Array.isArray(hosts) || !hosts.includes(PLATFORM_HOST)) continue;
    if (typeof entry.model === "string" && entry.model.trim()) out.push(entry.model.trim());
  }
  return out;
}

function readFirstManifest(paths: string[]): unknown {
  for (const file of paths) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      // Absent, unreadable or not JSON: try the next candidate, exactly as the
      // lifecycle reader does.
    }
  }
  return null;
}

describe("the ChatGPT surface follows the installed core", () => {
  it("carries every openai model the installed core says is ChatGPT-only", () => {
    resetCoreModelLifecycle();
    const manifest = readFirstManifest(coreManifestPaths("openai"));
    const ids = subscriptionOnlyIds(manifest, "openai");
    if (ids.length === 0) {
      // No core installed (CI), or a core that declares no such suppression.
      // Stated, not claimed away: this case proves nothing here.
      expect(ids).toEqual([]);
      return;
    }
    const offered = chatgptSurface().models.map((m) => m.id);
    for (const id of ids) {
      expect(offered, `the installed core routes ${id} on the ChatGPT account only, `
        + "but the picker does not offer it").toContain(id);
    }
  });
});

describe("the drift detector itself", () => {
  let fixture: ManifestFixture | null = null;

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
    bin.override = null;
  });

  it("reads a suppression out of a manifest beside the config", () => {
    fixture = createManifestFixture("codex-surface-follows-core");
    // The bundled candidate dropped, so the beside-config manifest is the only
    // one there is — see the note on `bin` above.
    bin.override = "openclaw";
    fixture.writeManifest("openai", {
      modelCatalog: {
        suppressions: [
          { provider: "openai", model: "gpt-7-nova", when: { baseUrlHosts: [PLATFORM_HOST] } },
        ],
      },
    });
    const manifest = readFirstManifest(coreManifestPaths("openai"));
    expect(subscriptionOnlyIds(manifest, "openai")).toEqual(["gpt-7-nova"]);
  });

  it("ignores a suppression that is not about the platform host", () => {
    const manifest = {
      modelCatalog: {
        suppressions: [
          // No `when` at all: the azure row's shape, unconditional and silent
          // about this provider's ChatGPT route.
          { provider: "azure-openai-responses", model: "gpt-5.3-codex-spark" },
          // A different host: not the platform route.
          { provider: "openai", model: "gpt-7-nova", when: { baseUrlHosts: ["example.invalid"] } },
        ],
      },
    };
    expect(subscriptionOnlyIds(manifest, "openai")).toEqual([]);
  });

  it("answers nothing for a manifest with no suppressions", () => {
    expect(subscriptionOnlyIds({ modelCatalog: { providers: {} } }, "openai")).toEqual([]);
    expect(subscriptionOnlyIds(null, "openai")).toEqual([]);
  });
});
