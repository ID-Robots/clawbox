/**
 * The two pure judgements in src/lib/coding-diet.ts: `looksVisual`, which
 * decides whether a run keeps the browser and media tools, and
 * `mentionsPullRequest`, which decides whether its brief carries the
 * auto-merge sentence.
 */
import { describe, expect, it } from "vitest";
import { looksVisual, mentionsPullRequest } from "@/lib/coding-diet";

describe("looksVisual", () => {
  it.each([
    "Build a landing page for the bakery",
    "Fix the CSS on the header",
    "make the UI darker",
    "A snake GAME in the terminal",
    "Add a logo",
    "refactor the React component",
    "Make it responsive",
    "build a website",
    "Create a portfolio with a dashboard and a navbar",
    "add a loading animation",
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

  it("keeps visual tools for a website task in an empty folder", () => {
    expect(looksVisual("build a website", [])).toBe(true);
    expect(looksVisual("build a website for my bakery", [])).toBe(true);
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
