import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { skillsEn } from "@/lib/hermes-translations/en-skills";

/**
 * The contract HERMES-04 (#586) established, made checkable.
 *
 * The uninstall route names every refusal with a machine `code` AND composes an
 * English sentence for it. The store paints the sentence whenever the code has
 * no entry in `uninstallRefusalCopy` (HermesSkillsStore.tsx) — `refusalLine`
 * falls through to `data.error` on purpose, so a newer device's words beat
 * "HTTP 502". That fallback is right for a code this BUILD has never heard of
 * and wrong for one shipped in the same commit as the route: a Bulgarian owner
 * then reads an English sentence under a Bulgarian button, which is the defect
 * #586 fixed.
 *
 * Nothing enforced it. F-09 added `ambiguous_name` to the route and would have
 * re-opened it. So the route's own source is the list, read here rather than
 * copied: a code added to the route without copy fails this test, in the file
 * that added it.
 */

const ROOT = path.join(__dirname, "..", "..", "..");
const ROUTE = path.join(ROOT, "src/app/setup-api/hermes/skills/uninstall/route.ts");
const STORE = path.join(ROOT, "src/components/HermesSkillsStore.tsx");
const COPY = path.join(ROOT, "src/components/hermes-skills/copy.ts");

/**
 * Codes the store deliberately does NOT map, each with the reason its own
 * source gives. Listed here so dropping one is a decision someone writes down,
 * not a silent regression.
 */
const UNMAPPED: Record<string, string> = {
  // The edition gate, shared by every skills route. Off Hermes the store is not
  // rendered at all, so no card can receive it.
  not_hermes: "the edition gate — the Skills page does not exist off Hermes",
  // Its sentence is composed from device state (which half of the removal was
  // left behind), and the store keeps the route's words until it can describe
  // that state itself. HermesSkillsStore.tsx says so at its own branch.
  removal_incomplete: "sentence composed from device state; handled by its own branch",
};

const read = (file: string) => fs.readFileSync(file, "utf8");

/** Every `code: "x"` literal the route can answer with. */
function routeCodes(): string[] {
  return [...read(ROUTE).matchAll(/code:\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
}

/** Every `case 'x':` inside uninstallRefusalCopy(). */
function mappedCodes(): string[] {
  const source = read(STORE);
  const start = source.indexOf("function uninstallRefusalCopy");
  expect(start, "uninstallRefusalCopy has been renamed — update this test").toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n}", start));
  return [...body.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]).sort();
}

describe("every uninstall refusal the route names has copy in the store", () => {
  it("finds the codes it is asserting about", () => {
    // A regex that stopped matching would make every assertion below vacuous.
    const codes = routeCodes();
    expect(codes).toContain("not_installed");
    expect(codes).toContain("builtin_skill");
    expect(codes).toContain("ambiguous_name");
    expect(mappedCodes().length).toBeGreaterThan(3);
  });

  it("maps every code except the ones it documents as unmapped", () => {
    const mapped = new Set(mappedCodes());
    const missing = routeCodes().filter((c) => !mapped.has(c) && !(c in UNMAPPED));
    expect(
      missing,
      `uninstall/route.ts answers ${missing.join(", ")} with no case in uninstallRefusalCopy, `
        + "so the store would paint the route's English sentence on a localised card. "
        + "Add copy, or add the code to UNMAPPED with the reason.",
    ).toEqual([]);
  });

  it("does not carry an exemption for a code the route no longer answers", () => {
    const codes = new Set(routeCodes());
    // `not_hermes` comes from the shared guard, not from this route's own body.
    const stale = Object.keys(UNMAPPED).filter((c) => c !== "not_hermes" && !codes.has(c));
    expect(stale, `UNMAPPED still excuses ${stale.join(", ")}`).toEqual([]);
  });
});

describe("every skills copy key the store asks for exists", () => {
  it("resolves each t('skills.…') in copy.ts against en-skills", () => {
    // The locale OVERRIDES are covered by hermes-translations.test.ts, which
    // asserts every skills.* key of en-skills has a translation in all nine
    // locales. What that cannot see is a key copy.ts asks for that no table
    // has: `t()` returns the key itself, so the card renders `skills.foo`.
    const keys = [...read(COPY).matchAll(/t\('(skills\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    const table = skillsEn as Record<string, string>;
    // Template keys (`skills.trustBucket.${id}`) are interpolated, not literal,
    // so only the literal ones can be checked here.
    const missing = [...new Set(keys)].filter((k) => typeof table[k] !== "string");
    expect(missing, `en-skills.ts is missing ${missing.join(", ")}`).toEqual([]);
  });

  it("carries the ambiguous_name line F-09 added", () => {
    expect(typeof (skillsEn as Record<string, string>)["skills.ambiguousName"]).toBe("string");
    expect(skillsEn["skills.ambiguousName"]).toContain("{name}");
    expect(skillsEn["skills.ambiguousName"]).toContain("{names}");
  });
});
