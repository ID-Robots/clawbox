import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CODEX_MODELS } from "@/lib/provider-models";
import { CODEX_SUPPORTED_MODEL_RE } from "@/lib/subscription-surface";

// gateway-pre-start.sh rewrites `openai/<gpt>` -> `codex/<gpt>` on boxes with
// ChatGPT (Codex OAuth) auth and no OpenAI API key. Its `_CODEX_SUPPORTED`
// tuple is a hand-maintained MIRROR of CODEX_SUPPORTED_MODEL_RE in
// src/lib/subscription-surface.ts — the script's own comment says so.
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
  // Imported, not scraped out of a route file: the allowlist is shared by both
  // write paths to the primary model now, so there is a real module to pin
  // against and no regex to go stale when the constant moves house again.
  const routeRe = CODEX_SUPPORTED_MODEL_RE;

  it("mirrors CODEX_SUPPORTED_MODEL_RE — every listed id is route-supported", () => {
    for (const id of preStartModels) {
      expect(routeRe.test(id), `${id} is in _CODEX_SUPPORTED but not CODEX_SUPPORTED_MODEL_RE`).toBe(true);
    }
  });

  it("migrates every model the picker can offer on ChatGPT auth", () => {
    // CODEX_MODELS is what the setup UI actually lets a subscription user
    // choose. Anything selectable must also be migratable, or the box ends up
    // stuck on a keyless `openai/*` route.
    for (const model of CODEX_MODELS) {
      expect(preStartModels, `picker offers ${model.id} but pre-start won't migrate it`).toContain(model.id);
      expect(routeRe.test(model.id), `picker offers ${model.id} but the route rejects it`).toBe(true);
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
      expect(routeRe.test(id)).toBe(false);
    }
  });
});
