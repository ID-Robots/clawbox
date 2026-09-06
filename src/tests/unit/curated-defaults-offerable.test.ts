import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { CATALOG_PROVIDERS, PROVIDER_CATALOGS } from "@/lib/provider-models";

/**
 * A cold-start default the picker would refuse to show is a picker with nothing
 * selected — and the box writes that default into `agents.defaults.model.primary`.
 *
 * This exists because the model-lifecycle filter created an asymmetry that
 * nothing else would notice: the openai picker loses `gpt-5.5` (the installed
 * core marks it `status: "deprecated", replacedBy: "gpt-5.6-sol"`) while the
 * codex picker keeps `gpt-5.5` AS ITS DEFAULT, hinted "Default. Every tier." —
 * the same upstream model, offered on one auth mode and hidden on the other,
 * purely because the core ships no `codex` extension directory. That asymmetry
 * is deliberate today (`gpt-5.6-sol` is plan-gated, and a Free account handed
 * it as the only row would 400 on every turn), but it is one manifest away from
 * silently moving the ChatGPT default.
 *
 * WHERE EACH CASE ACTUALLY BITES, because the first version of this file got it
 * wrong in the way that reports green: it carried its own copy of the lookup
 * with `/usr/lib/node_modules/openclaw/dist/extensions` hardcoded. That path
 * exists on this dev machine and on NO box — the openclaw and dual SKUs install
 * the core under `~/.npm-global`, and Hermes installs none at all — and on no
 * CI runner, so every case took the "no manifest, assert nothing" branch
 * everywhere the code actually runs.
 *
 *  - The installed-core cases ask `coreRetiredModels`, the same function the
 *    route serves through, so they read whatever `findOpenclawBin()` resolves.
 *    Real on a box and on a dev machine; vacuous on CI, which installs no core
 *    — stated here rather than claimed away.
 *  - The fixture cases below are the ones that assert EVERYWHERE. They pin the
 *    asymmetry, both places a manifest can live and the order they are tried
 *    in, and that the lookup can answer "retired" at all — against manifests
 *    written into a temporary home, so none of it depends on what the machine
 *    running the suite happens to have installed.
 */

/**
 * The binary the lifecycle module resolves from, steerable per case.
 *
 * A partial mock over the real module — every other export keeps its own value
 * — because the fixture cases must neutralise the core's bundled
 * `dist/extensions` candidate: on a machine that has a core installed it holds
 * a REAL openai manifest, and it is tried before the fixture's home. A bare
 * name is exactly what `findOpenclawBin` itself answers where no core is.
 */
const bin = vi.hoisted(() => ({ override: null as string | null }));

vi.mock("@/lib/openclaw-config", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/openclaw-config")>();
  return { ...actual, findOpenclawBin: () => bin.override ?? actual.findOpenclawBin() };
});

async function lifecycle() {
  const mod = await import("@/lib/core-model-lifecycle");
  mod.resetCoreModelLifecycle();
  return mod;
}

describe("every catalog provider's cold-start default is one the picker will show", () => {
  for (const provider of CATALOG_PROVIDERS) {
    const catalog = PROVIDER_CATALOGS[provider];
    const defaultId = catalog?.defaultModelId;
    if (!defaultId) continue;

    it(`${provider}: the default is in its own curated list`, () => {
      expect(catalog.models.map((m) => m.id)).toContain(defaultId);
    });

    it(`${provider}: the installed core has not retired the default`, async () => {
      const { coreRetiredModels } = await lifecycle();
      expect(coreRetiredModels(provider).has(defaultId)).toBe(false);
    });
  }
});

describe("against a manifest the module itself resolves", () => {
  let tmpHome: string;
  const ENV = ["HOME", "OPENCLAW_HOME", "CLAWBOX_OPENCLAW_HOME"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "curated-defaults-"));
    for (const key of ENV) saved[key] = process.env[key];
    process.env.HOME = tmpHome;
    // Both spellings, at the same fixture. `manifestPaths` reads
    // `CLAWBOX_OPENCLAW_HOME` FIRST, so pointing only `OPENCLAW_HOME` would
    // leave the lookup wherever the surrounding environment aimed it.
    process.env.OPENCLAW_HOME = path.join(tmpHome, ".openclaw");
    process.env.CLAWBOX_OPENCLAW_HOME = path.join(tmpHome, ".openclaw");
    bin.override = "openclaw";
  });

  afterEach(() => {
    bin.override = null;
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  /** Where OpenClaw 2 puts an unbundled provider's manifest: beside the config. */
  function writeManifest(provider: string, body: unknown): void {
    const dir = path.join(tmpHome, ".openclaw", "extensions", provider);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(body));
  }

  it("the codex default survives the openai manifest that retires the same id", async () => {
    const codexDefault = PROVIDER_CATALOGS.codex.defaultModelId;
    // The shape the pinned core actually ships: the ChatGPT picker's cold-start
    // default is the same upstream id the openai extension marks deprecated.
    writeManifest("openai", { models: [
      { id: codexDefault, status: "deprecated", replacedBy: "gpt-5.6-sol" },
      { id: "gpt-5.6-sol" },
    ] });
    const { coreRetiredModels } = await lifecycle();
    expect(coreRetiredModels("openai").has(codexDefault)).toBe(true);
    // Keyed on the CATALOGUE provider, and the core ships no `codex` extension
    // — so the ChatGPT picker keeps a default a Free account can actually run.
    // The day the core ships one, this flips and the case above it fails.
    expect(coreRetiredModels("codex").has(codexDefault)).toBe(false);
  });

  it("reads the core's bundled manifest, and prefers it to the one beside the config", async () => {
    // The `dist/extensions` candidate is the ONLY one that finds anything on a
    // real box — every manifest measured there is bundled with the core, and
    // the suite's own `OPENCLAW_HOME` floor puts the second candidate in an
    // empty tmp dir. Every other case here neutralises it deliberately, so
    // without this one the segments of that `path.join` could be reordered or
    // renamed and the whole suite would stay green while a box quietly stopped
    // filtering. Both candidates are written, with DIFFERENT answers, so the
    // order is pinned rather than assumed.
    const dist = path.join(
      tmpHome, "lib", "node_modules", "openclaw",
      "dist", "extensions", "anthropic", "openclaw.plugin.json",
    );
    fs.mkdirSync(path.dirname(dist), { recursive: true });
    fs.writeFileSync(dist, JSON.stringify({ models: [{ id: "claude-opus-4-8", status: "deprecated" }] }));
    writeManifest("anthropic", { models: [{ id: "claude-opus-4-7", status: "deprecated" }] });
    bin.override = path.join(tmpHome, "bin", "openclaw");

    const { coreRetiredModels } = await lifecycle();
    const retired = coreRetiredModels("anthropic");
    expect(retired.has("claude-opus-4-8")).toBe(true);
    expect(retired.has("claude-opus-4-7")).toBe(false);
  });

  it("would notice a core that retired a picker's own cold-start default", async () => {
    // The guard the file exists for, proven capable of failing — for every
    // catalogue provider, everywhere, and not only where a core happens to be
    // installed. Without this the cases above pass by reading nothing.
    const { coreRetiredModels, resetCoreModelLifecycle } = await lifecycle();
    for (const provider of CATALOG_PROVIDERS) {
      const defaultId = PROVIDER_CATALOGS[provider]?.defaultModelId;
      if (!defaultId) continue;
      writeManifest(provider, { models: [{ id: defaultId, status: "deprecated" }] });
      resetCoreModelLifecycle();
      expect(coreRetiredModels(provider).has(defaultId), provider).toBe(true);
    }
  });
});
