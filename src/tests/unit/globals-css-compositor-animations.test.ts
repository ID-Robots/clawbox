import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Animations that run all day, or for minutes at a time, on a desktop that is on
 * screen 24/7 (and on one 5120x1440 page in monitor mode) must be ones the
 * COMPOSITOR runs: transform and opacity. Anything else — filter, box-shadow,
 * width, stroke-dashoffset — has the browser recalculate style and repaint on
 * the main thread every frame, and one such property in a keyframe set puts
 * the whole effect there, its opacity too. Measured in Chromium: each of the
 * effects below went from 60 style recalcs a second to none.
 *
 * Several of them reproduce what a non-compositable property used to draw with
 * pseudo-elements, so the CSS and the markup it decorates are held together
 * here too.
 */
const read = (rel: string) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf-8");
const css = read("app/globals.css");

/** The body of `@keyframes name { … }`, braces balanced. */
function keyframes(name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  expect(start, `@keyframes ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unterminated @keyframes ${name}`);
}

/** Every property a keyframe set declares (comments stripped). */
function animatedProperties(name: string): string[] {
  const body = keyframes(name).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]))].sort();
}

const COMPOSITED = new Set(["transform", "opacity", "animation-timing-function"]);

describe("globals.css — long-running animations stay on the compositor", () => {
  it.each([
    // The ClawKeep shield on the shelf: "alert" on every box not signed in.
    "clawkeep-shelf-glow",
    "clawkeep-shelf-glow-rest",
    // The ClawBox AI offer's shield.
    "clawbox-notification-shield-blink",
    "clawbox-notification-shield-ring",
    // The phone microphone while recording.
    "chat-voice-ring",
    // ClawKeep's backup/restore and the App Store's install.
    "indeterminate-lead",
    "indeterminate-tail",
  ])("%s animates transform and opacity only", (name) => {
    const props = animatedProperties(name);
    expect(props.length).toBeGreaterThan(0);
    expect(props.filter((p) => !COMPOSITED.has(p))).toEqual([]);
  });

  it("no longer defines the width-animating indeterminate bar, and nothing asks for it", () => {
    expect(css).not.toMatch(/@keyframes indeterminate\s*\{/);
    for (const file of ["components/ClawKeepApp.tsx", "components/AppStore.tsx"]) {
      const src = read(file);
      expect(src).not.toMatch(/animation:\s*["']indeterminate /);
      // The bar is two pieces: the lead carries its left end, the tail its right.
      expect(src).toMatch(/className="indeterminate-bar"[^>]*>\s*<div[^>]*\/>\s*<div className=\{?[`"]indeterminate-bar-tail [^>]*\/>\s*<\/div>/);
    }
  });

  it("keeps the team tree's dash flow paused for the component to step", () => {
    expect(css).toMatch(/\.ct-art-flow\s*\{\s*animation:\s*ct-art-flow\s[^;]*\bpaused;/);
  });
});

/** The body of the block whose `{` is the first one at or after `start`, braces balanced. */
function blockBodyAt(start: number): string {
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated block at ${start}`);
}

/** The body of the first `@supports <condition> { … }` block. */
function supportsBlock(condition: string): string {
  const head = `@supports ${condition} {`;
  const start = css.indexOf(head);
  expect(start, head).toBeGreaterThanOrEqual(0);
  return blockBodyAt(start);
}

describe("globals.css — the shelf shield's glow copies", () => {
  const COPIES = [
    ".clawkeep-shelf-glow::before", ".clawkeep-shelf-glow-red::before", ".clawkeep-shelf-glow-orange::before",
    ".clawkeep-shelf-glow::after", ".clawkeep-shelf-glow-red::after", ".clawkeep-shelf-glow-orange::after",
  ];

  it("copies the glyph the host names, as decoration only", () => {
    expect(css).toContain('content: var(--glow-glyph, "shield") / "";');
    // "shield" is the shelf's own glyph — ChromeShelf names none.
    expect(read("components/ChromeShelf.tsx")).toMatch(/clawkeep-shelf-glow[\s\S]*>\s*shield\s*</);
    // The System Update hero names its own.
    expect(read("components/SystemUpdateApp.tsx")).toMatch(/\["--glow-glyph" as string\]: JSON\.stringify\(hero\.icon\)/);
  });

  // A declaration holding var() that the browser cannot parse is invalid at
  // computed-value time: no pseudo-element at all, so no glow, on a browser
  // without alternative text for `content` (Safari before 17.4). The form is
  // chosen by @supports, and the plain one draws the same glow there.
  it("uses the alternative-text form only where the browser knows it, and the plain form everywhere else", () => {
    const withAlt = supportsBlock('(content: "x" / "")');
    const without = supportsBlock('not (content: "x" / "")');
    expect(withAlt).toContain('content: var(--glow-glyph, "shield") / "";');
    expect(without).toContain('content: var(--glow-glyph, "shield");');
    expect(without).not.toContain('/ ""');
    for (const sel of COPIES) {
      expect(withAlt).toContain(sel);
      expect(without).toContain(sel);
    }
    // Nowhere outside those two blocks does a copy get its content.
    const outside = css.replace(withAlt, "").replace(without, "");
    expect(outside).not.toMatch(/content:\s*var\(--glow-glyph/);
    // Both sit inside the reduced-motion gate, with the rest of the glow.
    const gate = css.lastIndexOf("@media (prefers-reduced-motion: no-preference) {", css.indexOf(".clawkeep-shelf-glow,"));
    expect(gate).toBeGreaterThanOrEqual(0);
    const gated = blockBodyAt(gate);
    expect(gated).toContain(".clawkeep-shelf-glow,");
    expect(gated).toContain('@supports (content: "x" / "") {');
    expect(gated).toContain('@supports not (content: "x" / "") {');
  });
});

describe("globals.css — the offer shield's face is page.tsx's", () => {
  // The ring is a disc scaled out from under the shield, and the shield's own
  // face is translucent, so `::after` repaints that face opaquely over the
  // disc. That copy is only right while the markup is what it copies.
  it("repaints exactly the face page.tsx gives the shield, on the card's colour", () => {
    const page = read("app/page.tsx");
    const shield = page.match(/className="clawbox-notification-shield-blink ([^"]*)"/);
    expect(shield, "the offer shield in page.tsx").not.toBeNull();
    const classes = shield![1].split(/\s+/);
    for (const c of ["w-9", "h-9", "rounded-full", "bg-green-500/15", "border", "border-green-400/30"]) {
      expect(classes).toContain(c);
    }
    // The card it sits on.
    const before = page.slice(0, page.indexOf("clawbox-notification-shield-blink"));
    const card = before.slice(before.lastIndexOf("showClawAiOfferNotification &&"));
    expect(card).toContain("bg-[var(--bg-elevated)]");

    // The rule of its own (the shared geometry is declared for both pseudos).
    const face = [...css.matchAll(/\.clawbox-notification-shield-blink::after \{([^}]*)\}/g)]
      .map((m) => m[1])
      .find((body) => body.includes("background"));
    expect(face, "the face's own ::after rule").toBeDefined();
    expect(face).toContain("var(--bg-elevated)");
    expect(face).toContain("color-mix(in oklab, var(--color-green-500) 15%, transparent)");
    expect(face).toContain("1px solid color-mix(in oklab, var(--color-green-400) 30%, transparent)");
    // w-9 is 36px with its 1px border: the ring grows 8px from an 18px radius.
    expect(css).toMatch(/inset: -1px;/);
    expect(keyframes("clawbox-notification-shield-ring")).toContain("scale(1.4444)");
  });
});

describe("modal scrims — no backdrop blur over the whole desktop", () => {
  // A full-screen backdrop-filter is redone over the whole viewport on every
  // frame anything beneath it moves, and the mascot always moves. These dim
  // the desktop one step darker instead.
  it.each([
    "components/HarnessPicker.tsx",
    "components/SystemUpdateApp.tsx",
    "components/SettingsApp.tsx",
    "components/ClawKeepApp.tsx",
    "components/ClawBoxLoginModal.tsx",
    "components/TierUpgradeCelebration.tsx",
    "components/clawkeep-ui.tsx",
    "components/AppStore.tsx",
    "components/hermes-skills/ConfirmDialog.tsx",
    "components/hermes-skills/DangerConfirmDialog.tsx",
    "components/hermes-skills/FacetRail.tsx",
  ])("%s", (file) => {
    const scrims = [...read(file).matchAll(/className="([^"]*\bfixed inset-0\b[^"]*)"/g)].map((m) => m[1]);
    expect(scrims.length).toBeGreaterThan(0);
    for (const scrim of scrims) expect(scrim).not.toMatch(/backdrop-blur/);
  });

  it.each([
    "components/CodingProjectDeleteDialog.tsx",
    "components/CredentialsWriteDownDialog.tsx",
    "components/VoiceTunnelDialog.tsx",
  ])("%s", (file) => {
    expect(read(file)).not.toMatch(/backdropFilter/);
  });
});
