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
  LEGACY_DIET,
  looksVisual,
  mentionsPullRequest,
  mergeDiet,
  readDiet,
  validateDietPatch,
} from "@/lib/coding-diet";

describe("DEFAULT_DIET and LEGACY_DIET", () => {
  it("defaults the owner's setting to lean / lean / auto since TASK-1749's measurement", () => {
    expect(DEFAULT_DIET).toEqual({ brief: "lean", helpers: "lean", visualTools: "auto", context: "full" });
    expect(isDefaultDiet(DEFAULT_DIET)).toBe(true);
    expect(isDefaultDiet({ ...DEFAULT_DIET, brief: "full" })).toBe(false);
  });

  it("keeps the pre-diet behaviour as LEGACY_DIET, which is not the default any more", () => {
    expect(LEGACY_DIET).toEqual({ brief: "full", helpers: "always", visualTools: "always", context: "full" });
    expect(isDefaultDiet(LEGACY_DIET)).toBe(false);
    expect(Object.isFrozen(LEGACY_DIET)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DIET)).toBe(true);
  });
});

describe("readDiet", () => {
  // A run RECORD is read with LEGACY_DIET as its fallback: a record written
  // before the field existed was started with the full prompt.
  it.each([undefined, null, "lean", 3, true, [], ["lean"]])("reads a record's %j as LEGACY_DIET", (raw) => {
    expect(readDiet(raw, LEGACY_DIET)).toEqual(LEGACY_DIET);
  });

  // The owner's stored SETTING is read with DEFAULT_DIET as its fallback.
  it.each([undefined, null, "lean", 3, true, [], ["lean"]])("reads a stored setting's %j as DEFAULT_DIET", (raw) => {
    expect(readDiet(raw, DEFAULT_DIET)).toEqual(DEFAULT_DIET);
  });

  it("keeps every value this build offers, whatever the fallback", () => {
    for (const fallback of [LEGACY_DIET, DEFAULT_DIET]) {
      expect(readDiet({ brief: "lean", helpers: "lean", visualTools: "auto", context: "full" }, fallback)).toEqual({ brief: "lean", helpers: "lean", visualTools: "auto", context: "full" });
      expect(readDiet({ brief: "full", helpers: "always", visualTools: "always", context: "full" }, fallback)).toEqual({ brief: "full", helpers: "always", visualTools: "always", context: "full" });
    }
  });

  it("puts each unknown or missing field back to the FALLBACK's value alone, and drops unknown keys", () => {
    expect(readDiet({ brief: "lean" }, LEGACY_DIET)).toEqual({ brief: "lean", helpers: "always", visualTools: "always", context: "full" });
    expect(readDiet({ brief: "tiny", helpers: "lean", visualTools: 1, extra: "x" }, LEGACY_DIET)).toEqual({ brief: "full", helpers: "lean", visualTools: "always", context: "full" });
    expect(readDiet({ visualTools: "AUTO" }, LEGACY_DIET)).toEqual(LEGACY_DIET);
    expect(readDiet({ brief: "full" }, DEFAULT_DIET)).toEqual({ brief: "full", helpers: "lean", visualTools: "auto", context: "full" });
    expect(readDiet({ brief: "tiny", helpers: "always", visualTools: 1 }, DEFAULT_DIET)).toEqual({ brief: "lean", helpers: "always", visualTools: "auto", context: "full" });
  });

  it("answers a fresh object, never the frozen fallback itself", () => {
    const legacy = readDiet(undefined, LEGACY_DIET);
    expect(legacy).not.toBe(LEGACY_DIET);
    legacy.brief = "lean";
    expect(LEGACY_DIET.brief).toBe("full");
    const lean = readDiet(undefined, DEFAULT_DIET);
    expect(lean).not.toBe(DEFAULT_DIET);
    lean.brief = "full";
    expect(DEFAULT_DIET.brief).toBe("lean");
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
  it("merges a patch over what is stored, or over DEFAULT_DIET when nothing is", () => {
    expect(mergeDiet(undefined, { brief: "full" })).toEqual({ brief: "full", helpers: "lean", visualTools: "auto", context: "full" });
    expect(mergeDiet(undefined, {})).toEqual(DEFAULT_DIET);
    expect(mergeDiet({ brief: "full", visualTools: "always" }, { helpers: "always" })).toEqual(LEGACY_DIET);
    expect(mergeDiet({ brief: "full", helpers: "always", visualTools: "always", context: "full" }, { brief: "lean" })).toEqual({ brief: "lean", helpers: "always", visualTools: "always", context: "full" });
  });

  it("repairs a stored junk value to the setting's default rather than keeping it", () => {
    expect(mergeDiet({ brief: "tiny" }, { helpers: "always" })).toEqual({ brief: "lean", helpers: "always", visualTools: "auto", context: "full" });
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

describe("context", () => {
  it("is offered as full or capped, defaults to full, and caps at 128k", async () => {
    const { CONTEXT_CAP_WINDOW, validateDietPatch } = await import("@/lib/coding-diet");
    expect(CONTEXT_CAP_WINDOW).toBe(128_000);
    expect(DEFAULT_DIET.context).toBe("full");
    expect(validateDietPatch({ context: "capped" })).toEqual({ ok: true, patch: { context: "capped" } });
    expect(validateDietPatch({ context: "small" })).toMatchObject({ ok: false, code: "diet_invalid_value" });
  });
});

