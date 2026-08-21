import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * An animation name is a global ident: something declares it and every inline
 * `animation:` string spells it out again, with no compiler between the two. A
 * rename applied to only one side is silent, because a CSS animation with an
 * unknown name simply does not run — the recording dot would go from pulsing to
 * static with nothing failing. These two assertions are the linkage the type
 * system cannot provide.
 */
const css = fs.readFileSync(new URL("../../app/globals.css", import.meta.url), "utf-8");
const chatPopup = fs.readFileSync(new URL("../../components/ChatPopup.tsx", import.meta.url), "utf-8");

const namesIn = (source: string) =>
  [...source.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);

const globalKeyframes = namesIn(css);

describe("globals.css keyframes", () => {
  it("names every @keyframes in kebab-case", () => {
    // Guards against the regex silently matching nothing and the filter below
    // passing over an empty list.
    expect(globalKeyframes.length).toBeGreaterThan(20);
    const offenders = globalKeyframes.filter((n) => !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(n));
    expect(offenders).toEqual([]);
  });

  it("defines every animation name ChatPopup asks for inline", () => {
    // ChatPopup declares some of its own animations in a local <style> element,
    // so a name is legitimate if either source defines it. What is not
    // legitimate is a name defined by neither.
    const defined = new Set([...globalKeyframes, ...namesIn(chatPopup)]);
    const used = [...chatPopup.matchAll(/animation:\s*'([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    // The recording dot is the reason this test exists; if the selector above
    // ever stops finding it, the test has gone vacuous rather than green.
    expect(used).toContain("claw-pulse");
    expect(used.filter((n) => !defined.has(n))).toEqual([]);
  });
});
