import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/**
 * The desktop's on/off switches must be clickable AT THE SWITCH.
 *
 * Both were built as a `sr-only` input behind a styled track: a 1x1px,
 * absolutely positioned box with the visible switch drawn by two sibling
 * spans. A person clicking the track still toggled it, because the wrapping
 * <label> forwards the click — but the input itself was one pixel in a corner
 * with the wrapper painted over it, so `document.elementFromPoint` at the
 * switch's centre resolved to a DIV, never the control.
 *
 * That is what any pointer driven by COORDINATES hits: an automated check, an
 * assistive pointer, a stylus or head-tracker aiming at the control it was
 * told about. Found on 2026-09-09 while testing ClawKeep's auto-backup switch
 * from the browser — two clicks on the control did nothing and timed out.
 *
 * The fix is the ordinary accessible pattern: keep the input transparent, but
 * size it to the switch so it IS the hit target. Pinned at the source, because
 * the property is about layout that jsdom does not compute.
 */

const FILES = {
  "ClawKeep auto-backup": "src/components/ClawKeepApp.tsx",
  "Memory Shard automatic indexing": "src/components/MemoryShardApp.tsx",
} as const;

/**
 * The `<input type="checkbox">` tags that use the `peer` switch pattern.
 *
 * Scanned from `<input` to its closing `/>` rather than with one regex: an
 * `onChange={(e) => …}` handler puts a `>` inside the tag, so the obvious
 * `[^>]*` stops in the middle of the arrow and matches nothing.
 */
function switchInputs(source: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf("<input", from);
    if (start < 0) break;
    const end = source.indexOf("/>", start);
    if (end < 0) break;
    const tag = source.slice(start, end + 2);
    if (/type="checkbox"/.test(tag) && /\bpeer\b/.test(tag)) tags.push(tag);
    from = end + 2;
  }
  return tags;
}

describe("desktop switches are hit-testable at the switch", () => {
  for (const [name, file] of Object.entries(FILES)) {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    const inputs = switchInputs(source);

    it(`${name}: has a peer switch to check`, () => {
      expect(inputs.length).toBeGreaterThan(0);
    });

    it(`${name}: the input covers the switch instead of hiding in a corner`, () => {
      for (const tag of inputs) {
        // `sr-only` is the 1x1 clip that made the control unhittable.
        expect(tag, `${file}: switch input is still sr-only`).not.toMatch(/\bsr-only\b/);
        // Transparent, but a real box the size of the track it sits on.
        expect(tag, `${file}: switch input is not sized to the track`).toMatch(/\bh-full\b/);
        expect(tag, `${file}: switch input is not sized to the track`).toMatch(/\bw-full\b/);
        expect(tag, `${file}: switch input is not positioned over the track`).toMatch(/\binset-0\b/);
        // Invisible, NOT display:none — it must still take clicks and focus.
        expect(tag, `${file}: switch input must stay transparent, not hidden`).toMatch(/\bopacity-0\b/);
        expect(tag).not.toMatch(/\bhidden\b/);
      }
    });

    it(`${name}: is named for assistive tech`, () => {
      // ClawKeep's auto-backup shipped with no accessible name at all, so a
      // screen reader announced an unlabelled checkbox next to prose.
      for (const tag of inputs) {
        expect(tag, `${file}: switch input has no aria-label`).toMatch(/aria-label=\{/);
      }
    });
  }
});
