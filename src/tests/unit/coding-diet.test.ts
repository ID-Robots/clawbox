/**
 * The token diet's pure half (src/lib/coding-diet.ts, TASK-1749): the strict
 * reader every stored setting and run record goes through, the patch validator
 * behind POST /setup-api/coding-agent/enable { diet }, and `looksVisual`, the
 * heuristic that decides whether a run under `visualTools: "auto"` keeps the
 * browser and media tools.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIET,
  isDefaultDiet,
  looksVisual,
  mentionsPullRequest,
  mergeDiet,
  readDiet,
  validateDietPatch,
} from "@/lib/coding-diet";

describe("DEFAULT_DIET", () => {
  it("is today's behaviour on every knob", () => {
    expect(DEFAULT_DIET).toEqual({ brief: "full", helpers: "always", visualTools: "always" });
    expect(isDefaultDiet(DEFAULT_DIET)).toBe(true);
    expect(isDefaultDiet({ ...DEFAULT_DIET, brief: "lean" })).toBe(false);
  });
});

describe("readDiet", () => {
  it.each([undefined, null, "lean", 3, true, [], ["lean"]])("reads %j as the default", (raw) => {
    expect(readDiet(raw)).toEqual(DEFAULT_DIET);
  });

  it("keeps every value this build offers", () => {
    expect(readDiet({ brief: "lean", helpers: "lean", visualTools: "auto" })).toEqual({ brief: "lean", helpers: "lean", visualTools: "auto" });
  });

  it("puts each unknown or missing field back to ITS default alone, and drops unknown keys", () => {
    expect(readDiet({ brief: "lean" })).toEqual({ brief: "lean", helpers: "always", visualTools: "always" });
    expect(readDiet({ brief: "tiny", helpers: "lean", visualTools: 1, extra: "x" })).toEqual({ brief: "full", helpers: "lean", visualTools: "always" });
    expect(readDiet({ visualTools: "AUTO" })).toEqual(DEFAULT_DIET);
  });

  it("answers a fresh object, never the frozen default itself", () => {
    const read = readDiet(undefined);
    expect(read).not.toBe(DEFAULT_DIET);
    read.brief = "lean";
    expect(DEFAULT_DIET.brief).toBe("full");
  });
});

describe("validateDietPatch", () => {
  it("accepts a partial patch and an empty one", () => {
    expect(validateDietPatch({ brief: "lean" })).toEqual({ ok: true, patch: { brief: "lean" } });
    expect(validateDietPatch({ helpers: "lean", visualTools: "auto" })).toEqual({ ok: true, patch: { helpers: "lean", visualTools: "auto" } });
    expect(validateDietPatch({})).toEqual({ ok: true, patch: {} });
  });

  it.each([null, "lean", 1, [], [{ brief: "lean" }]])("refuses %j as not an object", (raw) => {
    expect(validateDietPatch(raw)).toMatchObject({ ok: false, code: "diet_not_object" });
  });

  it("refuses an unknown key, whole", () => {
    expect(validateDietPatch({ brief: "lean", tools: "none" })).toMatchObject({ ok: false, code: "diet_unknown_key" });
  });

  it.each([
    [{ brief: "short" }],
    [{ helpers: "never" }],
    [{ visualTools: "off" }],
    [{ brief: null }],
    [{ visualTools: true }],
  ])("refuses %j as a value this build does not offer", (raw) => {
    const result = validateDietPatch(raw);
    expect(result).toMatchObject({ ok: false, code: "diet_invalid_value" });
    expect(result.ok ? "" : result.error).toMatch(/must be one of/);
  });
});

describe("mergeDiet", () => {
  it("merges a patch over what is stored, the rest at their defaults", () => {
    expect(mergeDiet(undefined, { brief: "lean" })).toEqual({ brief: "lean", helpers: "always", visualTools: "always" });
    expect(mergeDiet({ brief: "lean", visualTools: "auto" }, { helpers: "lean" })).toEqual({ brief: "lean", helpers: "lean", visualTools: "auto" });
    expect(mergeDiet({ brief: "lean" }, { brief: "full" })).toEqual(DEFAULT_DIET);
  });

  it("repairs a stored junk value to its default rather than keeping it", () => {
    expect(mergeDiet({ brief: "tiny" }, { helpers: "lean" })).toEqual({ brief: "full", helpers: "lean", visualTools: "always" });
  });
});

describe("looksVisual", () => {
  it.each([
    "Build a landing page for the bakery",
    "Fix the CSS on the header",
    "make the UI darker",
    "A snake GAME in the terminal",
    "Add a logo",
    "refactor the React component",
    "Make it responsive",
  ])("is true for a task that names a visual surface: %s", (task) => {
    expect(looksVisual(task, [])).toBe(true);
  });

  it.each([
    "Add a CLI flag --verbose to the parser",
    "Fix the failing unit test in math.py",
    "Write a cron job that rotates the logs",
    // Whole words only: these merely contain one.
    "rebuild the database index (pages_count column), upgrade the website_id key",
    "the builder guide",
  ])("is false for a task with no visual surface: %s", (task) => {
    expect(looksVisual(task, ["main.py", "tests/", "README.md"])).toBe(false);
  });

  it.each([
    ["index.html"],
    ["styles.CSS"],
    ["App.tsx"],
    ["Widget.jsx"],
    ["Card.vue"],
    ["Main.svelte"],
    ["vite.config.ts"],
    ["next.config.mjs"],
    ["public/"],
    ["public"],
    ["src/components/"],
  ])("is true for a folder holding %s", (entry) => {
    expect(looksVisual("tidy up the code", ["package.json", entry])).toBe(true);
  });

  it("is false for a folder with nothing that renders", () => {
    expect(looksVisual("tidy up the code", ["package.json", "src/", "lib/", "index.ts", "tsconfig.json", "publicity.md"])).toBe(false);
  });
});

describe("mentionsPullRequest", () => {
  it.each(["open a pull request", "Pull-Requests welcome", "merge the PR", "open PRs", "run gh pr create"])("is true for %s", (task) => {
    expect(mentionsPullRequest(task)).toBe(true);
  });

  it.each(["fix the parser", "an approach to pr ose", "the PRINT statement", "express the idea"])("is false for %s", (task) => {
    expect(mentionsPullRequest(task)).toBe(false);
  });
});
