import { describe, expect, it } from "vitest";
import fsSync from "fs";
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
 * silently moving the ChatGPT default. This is the assertion that would notice.
 */

/** Where the installed core keeps a provider's manifest, when there is one. */
function manifestFor(provider: string): unknown | null {
  const bases = [
    "/usr/lib/node_modules/openclaw/dist/extensions",
    path.join(process.env.HOME ?? "", ".openclaw", "extensions"),
  ];
  for (const base of bases) {
    try {
      return JSON.parse(fsSync.readFileSync(path.join(base, provider, "openclaw.plugin.json"), "utf-8"));
    } catch {
      // Next candidate; absent everywhere is the normal CI shape.
    }
  }
  return null;
}

function retiredIds(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) retiredIds(item, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const row = node as { id?: unknown; status?: unknown };
  if (typeof row.id === "string" && typeof row.status === "string"
    && ["deprecated", "disabled"].includes(row.status.toLowerCase())) {
    out.add(row.id);
    const slash = row.id.lastIndexOf("/");
    if (slash > 0) out.add(row.id.slice(slash + 1));
  }
  for (const value of Object.values(node as Record<string, unknown>)) retiredIds(value, out);
}

describe("every catalog provider's cold-start default is one the picker will show", () => {
  for (const provider of CATALOG_PROVIDERS) {
    const catalog = PROVIDER_CATALOGS[provider];
    const defaultId = catalog?.defaultModelId;
    if (!defaultId) continue;

    it(`${provider}: the default is in its own curated list`, () => {
      expect(catalog.models.map((m) => m.id)).toContain(defaultId);
    });

    it(`${provider}: the installed core has not retired the default`, () => {
      // Meaningful on a box and on this machine, inert in CI where no core is
      // installed — stated rather than skipped, so the absence is visible.
      const manifest = manifestFor(provider);
      if (!manifest) {
        expect(manifest).toBeNull();
        return;
      }
      const retired = new Set<string>();
      retiredIds(manifest, retired);
      expect(retired.has(defaultId)).toBe(false);
    });
  }
});
