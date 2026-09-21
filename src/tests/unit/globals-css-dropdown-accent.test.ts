import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * HeaderDropdown's accent lives in CSS, keyed off the `data-agent` marker the
 * component stamps — on the container AND on the popover, which portals to
 * <body> and shares no ancestor with it.
 *
 * Both halves of that arrangement fail SILENTLY when they drift. A selector
 * that only matches descendants (`[data-agent="hermes"] .header-dropdown`)
 * does not match the element carrying the attribute, so the trigger keeps the
 * ClawBox coral under a Hermes-green list and nothing errors. A `var(--dd-*)`
 * whose declaration was renamed simply resolves to nothing, and the row loses
 * its accent rather than failing. These assertions are the linkage neither the
 * type system nor the browser will provide.
 */
const css = fs.readFileSync(new URL("../../app/globals.css", import.meta.url), "utf-8");
const component = fs.readFileSync(
  new URL("../../components/HeaderDropdown.tsx", import.meta.url),
  "utf-8",
);

describe("HeaderDropdown accent tokens", () => {
  it("declares every --dd-accent* custom property it consumes", () => {
    const declared = new Set(
      [...css.matchAll(/(--dd-accent[a-z-]*)\s*:/g)].map((m) => m[1]),
    );
    const consumed = new Set(
      [...css.matchAll(/var\((--dd-accent[a-z-]*)/g)].map((m) => m[1]),
    );
    expect(consumed.size).toBeGreaterThan(0);
    for (const name of consumed) {
      expect(declared, `${name} is used but never declared`).toContain(name);
    }
  });

  it("targets the element that carries data-agent, not only its descendants", () => {
    // The component stamps the marker on the container itself.
    expect(component).toContain('data-agent={agent}');
    expect(css).toContain('.header-dropdown[data-agent="hermes"]');
  });

  it("also targets the portaled popover, which has no Hermes ancestor", () => {
    expect(css).toContain('.header-dropdown-popover[data-agent="hermes"]');
  });

  it("reuses the palette's coral tokens rather than re-typing them", () => {
    const block = css.slice(
      css.indexOf(".header-dropdown,\n.header-dropdown-popover {"),
    );
    expect(block).toContain("--dd-accent: var(--coral-bright)");
    expect(block).toContain("--dd-accent-ring: var(--coral-ring)");
  });
});
