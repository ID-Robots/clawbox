import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CODEX_MODELS } from "@/lib/provider-models";
import { isCodexSupportedModelId } from "@/lib/subscription-surface";

/**
 * No installed core, whatever the machine has. `isCodexSupportedModelId` now
 * reads the ChatGPT route off the INSTALLED core's manifest and answers
 * `CODEX_MODELS` only as its fallback — so on a box running a core that has
 * retired one of these ids from the route (2026.9.3 retires `gpt-5.4` and
 * `gpt-5.4-mini`) the guard rightly refuses a row this curated list still
 * carries. That is the derivation working, not a drifted mirror, and it is not
 * what this file is about: `_CODEX_SUPPORTED` mirrors the FALLBACK, because its
 * only consumer is the OpenClaw 1 branch of a script that runs before node
 * exists. A bare binary name drops the bundled manifest candidate, which is
 * what makes "the fallback" the answer here on every machine.
 */
vi.mock("@/lib/openclaw-config", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/openclaw-config")>();
  return { ...actual, findOpenclawBin: () => "openclaw" };
});

// gateway-pre-start.sh rewrites `openai/<gpt>` -> `codex/<gpt>` on boxes with
// ChatGPT (Codex OAuth) auth and no OpenAI API key. Its `_CODEX_SUPPORTED`
// tuple is a hand-maintained MIRROR of CODEX_MODELS in
// src/lib/provider-models.ts — the script cannot import, so it copies. It is
// the only remaining copy: the route's own allowlist reads the surface directly
// (`isCodexSupportedModelId`), which since 2026-09-10 is derived from the
// installed core's manifest with CODEX_MODELS as its fallback. The mirror stays
// pinned to that fallback on purpose — see the mock above.
//
// The two drifted: the regex learned gpt-5.6-{sol,terra,luna} (PR #271) but
// the tuple did not, so a subscription box whose stored model was
// `openai/gpt-5.6-sol` never got migrated. It kept resolving to
// api.openai.com with no key and 401'd with "Missing bearer or basic
// authentication in header" — i.e. the newest models were unusable on exactly
// the auth mode they're sold with. These tests pin the mirror so it can't
// silently drift again.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");

/** The model ids listed in pre-start's `_CODEX_SUPPORTED` tuple. */
function readPreStartSupportedModels(): string[] {
  const src = readFileSync(SCRIPT, "utf-8");
  const match = src.match(/_CODEX_SUPPORTED = \(([\s\S]*?)\)/);
  if (!match) throw new Error("_CODEX_SUPPORTED not found in gateway-pre-start.sh");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("gateway-pre-start.sh codex model migration", () => {
  const preStartModels = readPreStartSupportedModels();
  it("mirrors the ChatGPT catalogue — every listed id is route-supported", () => {
    for (const id of preStartModels) {
      expect(isCodexSupportedModelId(id), `${id} is in _CODEX_SUPPORTED but not in CODEX_MODELS`).toBe(true);
    }
  });

  it("migrates every model the picker can offer on ChatGPT auth", () => {
    // CODEX_MODELS is what the setup UI actually lets a subscription user
    // choose. Anything selectable must also be migratable, or the box ends up
    // stuck on a keyless `openai/*` route.
    for (const model of CODEX_MODELS) {
      expect(preStartModels, `picker offers ${model.id} but pre-start won't migrate it`).toContain(model.id);
      expect(isCodexSupportedModelId(model.id), `picker offers ${model.id} but the route rejects it`).toBe(true);
    }
  });

  it("covers the gpt-5.6 family that regressed", () => {
    for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(preStartModels).toContain(id);
    }
  });

  it("does not migrate API-key-only models", () => {
    // -pro variants 400 on the ChatGPT-account path, so migrating them to
    // codex/* would swap a working keyed route for a broken one.
    for (const id of ["gpt-5.4-pro", "gpt-5.5-pro", "gpt-4o"]) {
      expect(preStartModels).not.toContain(id);
      expect(isCodexSupportedModelId(id)).toBe(false);
    }
  });
});
