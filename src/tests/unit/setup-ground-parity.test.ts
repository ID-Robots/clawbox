import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * ONE SETUP, ONE GROUND.
 *
 * The setup wizard is the same product on a Hermes box and on an OpenClaw box,
 * so it must be painted on the same ground. That used to be false: a
 * `[data-agent="hermes"]` layer re-pointed `--ground` and eight surface tokens
 * to a teal set, and the customer met two differently-coloured wizards.
 *
 * A `toContain` on the stylesheet text cannot express this. What matters is
 * what an element RESOLVES a property to, which is a cascade plus inheritance
 * plus `var()` substitution — so this file models exactly that much CSS and
 * asserts on resolved values. It is deliberately a small engine: it refuses
 * (loudly) to guess at a selector it does not understand, so a future selector
 * that would change these answers fails the suite rather than slipping past it.
 */

const css = fs.readFileSync(new URL("../../app/globals.css", import.meta.url), "utf-8");

// ── the tiny CSS engine ──────────────────────────────────────────────────────

type Rule = { selector: string; decls: Map<string, string> };

/** At-rules that wrap ordinary rules; anything else with a block is skipped. */
const CONDITIONAL_GROUPS = ["@media", "@supports", "@layer", "@container"];

function parseRules(input: string): { base: Rule[]; all: Rule[] } {
  const source = input.replace(/\/\*[\s\S]*?\*\//g, "");
  const base: Rule[] = [];
  const all: Rule[] = [];

  const walk = (text: string, conditional: boolean) => {
    let i = 0;
    while (i < text.length) {
      const brace = text.indexOf("{", i);
      if (brace === -1) return;
      const semi = text.indexOf(";", i);
      // A statement at-rule (`@import …;`) before the next block: skip it.
      if (semi !== -1 && semi < brace) {
        i = semi + 1;
        continue;
      }
      const prelude = text.slice(i, brace).trim();
      let depth = 1;
      let j = brace + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const body = text.slice(brace + 1, j - 1);
      if (prelude.startsWith("@")) {
        const name = prelude.split(/[\s(]/, 1)[0];
        if (CONDITIONAL_GROUPS.includes(name)) walk(body, true);
      } else {
        const decls = new Map<string, string>();
        for (const part of body.split(";")) {
          const colon = part.indexOf(":");
          if (colon === -1) continue;
          const prop = part.slice(0, colon).trim();
          const value = part.slice(colon + 1).trim();
          if (!prop || prop.includes("{")) continue;
          decls.set(prop, value);
        }
        const rule = { selector: prelude, decls };
        all.push(rule);
        if (!conditional) base.push(rule);
      }
      i = j;
    }
  };

  walk(source, false);
  return { base, all };
}

const { base: baseRules, all: allRules } = parseRules(css);

type El = {
  root?: boolean;
  tag?: string;
  classes?: string[];
  attrs?: Record<string, string>;
};
/** An element as its ancestor chain, document root first. */
type Path = El[];

class UnsupportedSelector extends Error {}

/**
 * Resting-state pseudo-classes only. Anything that describes an interaction
 * (`:hover`) or a generated box (`::before`) is not this element, so it does
 * not match — that is CSS, not a shortcut. A pseudo-class we have never seen
 * throws, so the engine can never quietly answer the wrong thing.
 */
const NON_MATCHING_PSEUDOS =
  /^::|^:(hover|active|focus|focus-visible|focus-within|disabled|checked|fullscreen|first-child|last-child|nth-child|placeholder|target|visited)\b/;

function matchesCompound(compound: string, el: El): boolean {
  let rest = compound;
  while (rest.length > 0) {
    if (rest.startsWith(":not(")) {
      const close = rest.indexOf(")");
      if (close === -1) throw new UnsupportedSelector(compound);
      const inner = rest.slice(5, close);
      if (inner.startsWith(".")) {
        if ((el.classes ?? []).includes(inner.slice(1))) return false;
      } else if (!NON_MATCHING_PSEUDOS.test(inner)) {
        // `:not(:disabled)` on a resting element is a no-op; anything else is
        // a construct this engine has not been taught, and must not be guessed.
        throw new UnsupportedSelector(compound);
      }
      rest = rest.slice(close + 1);
      continue;
    }
    if (rest.startsWith(":root")) {
      if (!el.root) return false;
      rest = rest.slice(5);
      continue;
    }
    if (NON_MATCHING_PSEUDOS.test(rest)) return false;
    if (rest.startsWith(":")) throw new UnsupportedSelector(compound);
    if (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      if (close === -1) throw new UnsupportedSelector(compound);
      const body = rest.slice(1, close);
      const eq = body.indexOf("=");
      const name = (eq === -1 ? body : body.slice(0, eq)).trim();
      const attrs = el.attrs ?? {};
      if (!(name in attrs)) return false;
      if (eq !== -1) {
        const want = body.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (attrs[name] !== want) return false;
      }
      rest = rest.slice(close + 1);
      continue;
    }
    const token = /^(\*|[.#]?[A-Za-z0-9_-]+)/.exec(rest);
    if (!token) throw new UnsupportedSelector(compound);
    const text = token[1];
    if (text.startsWith("#")) throw new UnsupportedSelector(compound);
    if (text.startsWith(".")) {
      if (!(el.classes ?? []).includes(text.slice(1))) return false;
    } else if (text !== "*") {
      if (el.tag !== text) return false;
    }
    rest = rest.slice(text.length);
  }
  return true;
}

/** Descendant combinators only; `>`, `+` and `~` are refused rather than guessed. */
function matchesComplexStrict(selector: string, path: Path): boolean {
  if (/[>+~]/.test(selector)) throw new UnsupportedSelector(selector);
  const compounds = selector.trim().split(/\s+/);
  const match = (ci: number, pi: number): boolean => {
    if (ci < 0) return true;
    for (let k = pi; k >= 0; k--) {
      if (matchesCompound(compounds[ci], path[k]) && match(ci - 1, k - 1)) return true;
      if (ci === compounds.length - 1) break; // the subject must be the element itself
    }
    return false;
  };
  return match(compounds.length - 1, path.length - 1);
}

/**
 * The forgiving wrapper the resolver uses. A selector the engine cannot parse
 * simply does not match — the stylesheet is 1000 rules wide and most of them
 * are irrelevant here — but it is remembered, and the last test in this file
 * fails if any selector that could change one of these answers was skipped.
 */
function matchesComplex(selector: string, path: Path): boolean {
  try {
    return matchesComplexStrict(selector, path);
  } catch (error) {
    if (error instanceof UnsupportedSelector) return false;
    throw error;
  }
}

function specificityOf(selector: string): number {
  const ids = (selector.match(/#[A-Za-z0-9_-]+/g) ?? []).length;
  // `:not()` contributes its argument's specificity, not its own — so the
  // negation is skipped here and the `.class` inside it is counted as normal.
  const classes = (selector.match(/\.[A-Za-z0-9_-]+|\[[^\]]*\]|:(?!:)(?!not\()[a-z-]+/g) ?? []).length;
  const tags = (selector.match(/(^|[\s>+~])[a-z][a-z0-9]*/g) ?? []).length;
  return ids * 10000 + classes * 100 + tags;
}

/** The declaration that wins on this element: highest specificity, then latest. */
function declaredOn(prop: string, path: Path, rules: Rule[]): string | undefined {
  let winner: string | undefined;
  let best = -1;
  rules.forEach((rule) => {
    if (!rule.decls.has(prop)) return;
    for (const selector of rule.selector.split(",")) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      if (!matchesComplex(trimmed, path)) continue;
      const score = specificityOf(trimmed);
      if (score >= best) {
        best = score;
        winner = rule.decls.get(prop);
      }
      break;
    }
  });
  return winner;
}

const INHERITED = new Set(["color", "visibility"]);
const isCustom = (prop: string) => prop.startsWith("--");

/** Resolve a property on the last element of `path`, following inheritance and var(). */
function resolve(prop: string, path: Path, rules: Rule[] = baseRules): string | undefined {
  const inherits = isCustom(prop) || INHERITED.has(prop);
  for (let i = path.length - 1; i >= 0; i--) {
    const declaringPath = path.slice(0, i + 1);
    const value = declaredOn(prop, declaringPath, rules);
    // var() is substituted on the element that DECLARES the property, not on
    // the one that inherits it — so the truncated path is the right context.
    if (value !== undefined) return substitute(value, declaringPath, rules);
    if (!inherits) return undefined;
  }
  return undefined;
}

function substitute(value: string, path: Path, rules: Rule[], depth = 0): string {
  if (depth > 10 || !value.includes("var(")) return value;
  const replaced = value.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([^)]*))?\)/g, (_m, name, fallback) => {
    const resolved = resolve(name, path, rules);
    return resolved ?? (fallback ?? "").trim();
  });
  return substitute(replaced, path, rules, depth + 1);
}

// ── the elements under test ──────────────────────────────────────────────────

const html: El = { root: true, tag: "html" };
const body: El = { tag: "body" };

/** src/app/setup/layout.tsx wraps the shell in a display:contents marker. */
const shellPath = (hermes: boolean): Path => [
  html,
  body,
  { tag: "div", attrs: hermes ? { "data-agent": "hermes" } : {} },
  { tag: "div", classes: ["setup-shell"] },
];

const cobrandPath = (hermes: boolean): Path => [
  ...shellPath(hermes),
  { tag: "span", classes: ["setup-cobrand"] },
];

/** ReconnectStage portals to <body> and carries the marker itself. */
const overlayPath = (hermes: boolean): Path => [
  html,
  body,
  {
    tag: "div",
    classes: ["reconnect-stage"],
    attrs: hermes ? { "data-agent": "hermes" } : {},
  },
];

/** The wizard's provider picker — the product's only `field` popover. */
const fieldPopoverPath = (hermes: boolean): Path => [
  html,
  body,
  {
    tag: "div",
    classes: ["header-dropdown-popover", "header-dropdown-popover--field"],
    attrs: hermes ? { "data-agent": "hermes" } : {},
  },
];

/** A chat header pill's popover — outside setup, where Hermes keeps its plate. */
const pillPopoverPath = (hermes: boolean): Path => [
  html,
  body,
  {
    tag: "div",
    classes: ["header-dropdown-popover"],
    attrs: hermes ? { "data-agent": "hermes" } : {},
  },
];

// The nine tokens the Hermes layer used to re-point: the ground, the two
// gradient stops mixed from it, and the six plates.
const GROUND_TOKENS = [
  "--ground",
  "--ground-fade",
  "--ground-0",
  "--surface-card",
  "--surface-card-strong",
  "--bg-surface",
  "--bg-elevated",
  "--bg-deep",
  "--bg-deep-veil",
];

// ── the assertions ───────────────────────────────────────────────────────────

describe("the setup wizard renders on one ground", () => {
  it("resolves --ground to the OpenClaw ground on the Hermes edition too", () => {
    expect(resolve("--ground", shellPath(true))).toBe("#0a0f1a");
    expect(resolve("--ground", shellPath(true))).toBe(resolve("--ground", shellPath(false)));
  });

  it.each(GROUND_TOKENS)("resolves %s identically on both editions", (token) => {
    const openclaw = resolve(token, shellPath(false));
    expect(openclaw, `${token} is not declared anywhere`).toBeDefined();
    expect(resolve(token, shellPath(true))).toBe(openclaw);
  });

  it("paints the reconnect/handoff overlay on that same ground", () => {
    // ReconnectStage sets `background: var(--ground)` inline on the portal root.
    expect(resolve("--ground", overlayPath(true))).toBe(resolve("--ground", overlayPath(false)));
    expect(resolve("--ground", overlayPath(true))).toBe("#0a0f1a");
  });

  it("opens the wizard's provider picker on the same plate on both editions", () => {
    // The popover portals to <body>, so no ancestor can scope it; it carries
    // data-agent itself and needs its own opt-out from the chat plate.
    const openclaw = resolve("background", fieldPopoverPath(false));
    expect(openclaw).toBe("#1e2939");
    expect(resolve("background", fieldPopoverPath(true))).toBe(openclaw);
  });
});

describe("no teal-derived value survives in the setup scope", () => {
  // The retired Hermes ground and the plates mixed from it.
  const TEAL = ["#041c1c", "#0e2423", "#132826", "#182c2a", "rgba(4, 28, 28", "rgba(14, 36, 35"];
  const setupElements: Array<[string, Path]> = [
    ["the wizard shell", shellPath(true)],
    ["the co-branding lockup", cobrandPath(true)],
    ["the reconnect overlay", overlayPath(true)],
    ["the provider picker popover", fieldPopoverPath(true)],
  ];

  it.each(setupElements)("%s resolves no teal literal", (_name, path) => {
    const props = new Set<string>();
    for (const rule of allRules) for (const prop of rule.decls.keys()) props.add(prop);
    for (const prop of props) {
      const value = resolve(prop, path);
      if (value === undefined) continue;
      for (const teal of TEAL) {
        expect(value.toLowerCase(), `${prop} resolved to ${value}`).not.toContain(teal.toLowerCase());
      }
    }
  });

  it("keeps every remaining teal literal out of reach of the setup scope", () => {
    const offenders: string[] = [];
    for (const rule of allRules) {
      const tealDecls = [...rule.decls.entries()].filter(([, v]) =>
        TEAL.some((t) => v.toLowerCase().includes(t.toLowerCase())),
      );
      if (tealDecls.length === 0) continue;
      for (const selector of rule.selector.split(",")) {
        const trimmed = selector.trim();
        if (!trimmed) continue;
        for (const [, path] of setupElements) {
          if (matchesComplex(trimmed, path)) offenders.push(`${trimmed} { ${tealDecls[0][0]} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("what Hermes keeps", () => {
  it("still lights the co-branding lockup — the owner asked to lose the green, not the brand", () => {
    expect(resolve("display", cobrandPath(true))).toBe("inline-flex");
    expect(resolve("display", cobrandPath(false))).toBe("none");
  });

  it("still delivers the agent's own ink to the wizard and the overlay", () => {
    // Additive, never a replacement: the ink exists on Hermes and nowhere else.
    expect(resolve("--agent-ink", shellPath(true))).toBe("#ffe6cb");
    expect(resolve("--agent-ink", shellPath(false))).toBeUndefined();
    // ReconnectStage's ring reads --agent-live off the portal root.
    expect(resolve("--agent-live", overlayPath(true))).toBe("#4ade80");
    expect(resolve("--agent-live", overlayPath(false))).toBeUndefined();
  });

  it("points the agent's plates at the shared surfaces, not at teal", () => {
    expect(resolve("--agent-card", shellPath(true))).toBe(resolve("--bg-surface", shellPath(true)));
    expect(resolve("--agent-muted", shellPath(true))).toBe(resolve("--bg-elevated", shellPath(true)));
    expect(resolve("--agent-on-ink", shellPath(true))).toBe(resolve("--ground", shellPath(true)));
  });

  it("leaves chat on the Hermes plate — this change is about SETUP", () => {
    expect(resolve("background", pillPopoverPath(true))).toBe("#182c2a");
    expect(resolve("background", pillPopoverPath(false))).toBe("#1a1f2e");
  });
});

describe("the engine understands the selectors that decide these answers", () => {
  it("parses every selector that could change a ground, a plate or the lockup", () => {
    // The resolver treats a selector it cannot parse as "does not match". That
    // is safe for the 900 rules this file has no opinion about and fatal for
    // the handful that decide the answers above, so those are checked strictly.
    const watched = new Set([...GROUND_TOKENS, "background", "display", "color"]);
    const unparseable: string[] = [];
    for (const rule of allRules) {
      const relevant = [...rule.decls.keys()].some(
        (prop) => watched.has(prop) || prop.startsWith("--agent-"),
      );
      if (!relevant) continue;
      for (const selector of rule.selector.split(",")) {
        const trimmed = selector.trim();
        if (!trimmed) continue;
        try {
          matchesComplexStrict(trimmed, [html]);
        } catch (error) {
          if (error instanceof UnsupportedSelector) unparseable.push(trimmed);
          else throw error;
        }
      }
    }
    expect(unparseable).toEqual([]);
  });
});
