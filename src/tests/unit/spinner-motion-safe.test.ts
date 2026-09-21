/**
 * Spinners hold still for an owner who asked for reduced motion.
 *
 * `animate-spin` is unconditional: it keeps turning whatever the OS setting
 * says. The blanket `prefers-reduced-motion: reduce` rule in globals.css does
 * collapse it today, which is why nobody saw it — but that rule is a safety net
 * for decorative animation, not the contract, and every spinner written since
 * DeviceCodeCard has carried `motion-safe:` in the class itself so the
 * component says what it does without a stylesheet having to rescue it.
 *
 * The list is the set of surfaces swept in one pass, not the whole app: other
 * components still carry bare `animate-spin` and are somebody else's to change.
 * A file added here is a promise about that file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");

const SWEPT = [
  "src/components/AppStore.tsx",
  "src/components/FilesApp.tsx",
  "src/components/SettingsApp.tsx",
  "src/components/SystemUpdateApp.tsx",
  "src/components/TerminalApp.tsx",
];

describe("swept spinners", () => {
  it.each(SWEPT)("%s animates only under motion-safe", (relative) => {
    const source = readFileSync(join(ROOT, relative), "utf8");
    // Every occurrence, including the ones inside a template literal's
    // ternary — `${busy ? "animate-spin" : ""}` spins just as hard.
    const bare = [...source.matchAll(/animate-spin/g)].filter(
      (match) => source.slice(Math.max(0, match.index - "motion-safe:".length), match.index) !== "motion-safe:",
    );
    expect(bare).toHaveLength(0);
    // And the sweep did not simply delete them: each of these files still has
    // a spinner to show while it waits.
    expect(source).toContain("motion-safe:animate-spin");
  });
});
