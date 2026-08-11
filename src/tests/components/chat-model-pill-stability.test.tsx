import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Switching provider on a Hermes box made the chat header visibly collapse to
 * "Provider + Thinking" for a second, then reflow when the model list landed.
 *
 * The cause is in useHermesModelOptions, and it is deliberate: `scope` is
 * dropped to null the moment the provider changes, because continuing to show
 * the OLD provider's models is the foreign-vendor mismatch that module exists
 * to prevent. The bug was the CONSEQUENCE — the pill unmounted rather than
 * holding its place, so the header shifted twice for one user action.
 *
 * These are source assertions rather than a render test: the pill's behaviour
 * depends on a fetch resolving, and the thing worth pinning is the rule — hold
 * the space, never show a stale model id. A render test of the loading frame
 * would need the whole chat's dependency tree stood up to assert one class.
 */
const CHAT = fs.readFileSync(
  path.join(process.cwd(), "src", "components", "ChatPopup.tsx"), "utf8");
const HOOK = fs.readFileSync(
  path.join(process.cwd(), "src", "hooks", "useHermesModelOptions.ts"), "utf8");

describe("the chat's model pill across a provider switch", () => {
  it("keeps its place while the new provider's models load", () => {
    // Not `models.length > 1` directly — that is false during the fetch and is
    // what made the pill vanish.
    expect(CHAT).toMatch(/\{showModelPill && \(/);
    expect(CHAT).toMatch(/showModelPill = hermesModelsLoading \? hadModelPill\.current : hermesModelCount > 1/);
  });

  it("shows a placeholder rather than the previous provider's model", () => {
    // The stale id would be wrong for a beat, and wrong is worse than blank.
    expect(CHAT).toMatch(/hermesModelsLoading \? '…' : shortModelPillLabel\(/);
    expect(CHAT).toMatch(/value=\{hermesModelsLoading \? '' : hermesModel\}/);
  });

  it("cannot be opened mid-load", () => {
    expect(CHAT).toMatch(/disabled=\{hermesModelsLoading\}/);
  });

  it("still hides the pill for a provider that really has one model", () => {
    // ClawBox AI serves exactly one model per tier; a one-entry picker is noise.
    // hadModelPill is only updated once loading settles, so a single-model
    // provider never inherits the previous provider's pill permanently.
    expect(CHAT).toMatch(/if \(!hermesModelsLoading\) hadModelPill\.current = hermesModelCount > 1/);
  });

  it("does not reintroduce a stale scope in the hook", () => {
    // The guarantee under all of this: the hook never serves another provider's
    // models. If this line goes, the pill fix becomes a correctness bug.
    expect(HOOK).toMatch(/const fresh = provider && loaded\?\.provider === provider \? loaded : null/);
  });
});
