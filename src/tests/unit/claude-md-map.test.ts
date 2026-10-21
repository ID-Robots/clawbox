import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_DOCS_DIR,
  MAP_MAX_BYTES,
  MAP_MAX_LINE,
  isLongForm,
  missingUnits,
  splitUnits,
} from "../../../scripts/check-claude-md-no-loss.mjs";

/**
 * CLAUDE.md loads into every Claude Code session and agent that starts in this
 * repository or one of its worktrees — the maintainers' and the teammates'
 * (the box's own Coding Agent runs with `--setting-sources user` and does not
 * read it). It grew to 380 KB in 54 days,
 * with single lines of 28 KB, because every change added its paragraph to it
 * and nothing ever took one out. It is a short MAP now, and the per-area notes
 * live in docs/agents/<area>.md (moved there verbatim — the proof is
 * scripts/check-claude-md-no-loss.mjs, which CI runs on every pull request
 * into beta).
 *
 * This file is the FORWARD guard: it fails the day a change grows the map back
 * into a notebook, and says where the note belongs instead.
 */

const REPO = process.cwd();
const MAP = fs.readFileSync(path.join(REPO, "CLAUDE.md"), "utf-8");
const AREA_DIR = path.join(REPO, AGENT_DOCS_DIR);
const AREA_FILES = fs.existsSync(AREA_DIR)
  ? fs.readdirSync(AREA_DIR).filter((name) => name.endsWith(".md")).sort()
  : [];

const WHERE_NOTES_GO =
  `New notes go to ${AGENT_DOCS_DIR}/<area>.md, not CLAUDE.md: the "Where to read more" list in CLAUDE.md ` +
  `names every area file. When no area fits, add ${AGENT_DOCS_DIR}/<new-area>.md and one line linking it there.`;

describe("CLAUDE.md stays a short map (the forward guard)", () => {
  it(`is at most ${MAP_MAX_BYTES} bytes`, () => {
    const bytes = Buffer.byteLength(MAP, "utf8");
    expect(bytes <= MAP_MAX_BYTES, `CLAUDE.md is ${bytes} bytes, over its ${MAP_MAX_BYTES}-byte cap. ${WHERE_NOTES_GO}`)
      .toBe(true);
  });

  it(`has no line over ${MAP_MAX_LINE} characters`, () => {
    const long = MAP.split("\n")
      .map((text, index) => ({ line: index + 1, length: text.length }))
      .filter(({ length }) => length > MAP_MAX_LINE);
    const where = long.map(({ line, length }) => `line ${line} (${length} chars)`).join(", ");
    expect(long, `CLAUDE.md has lines over ${MAP_MAX_LINE} characters: ${where}. ${WHERE_NOTES_GO}`).toEqual([]);
  });

  it("is not the long form the no-loss check verifies against", () => {
    // The same predicate the CI step uses to decide whether a base still needs
    // its move verified: once beta carries the map, that step goes quiet.
    expect(isLongForm(MAP)).toBe(false);
  });

  it("ends with the Next.js agent block `next dev` writes", () => {
    // `next dev` re-adds this block when it is missing; it stays last and once.
    expect(MAP.match(/<!-- BEGIN:nextjs-agent-rules -->/g)).toHaveLength(1);
    expect(MAP.trimEnd().endsWith("<!-- END:nextjs-agent-rules -->")).toBe(true);
    expect(MAP.indexOf("<!-- BEGIN:nextjs-agent-rules -->")).toBeGreaterThan(MAP.indexOf("## Where to read more"));
  });
});

describe(`${AGENT_DOCS_DIR}/ — the area files the map points at`, () => {
  it("exist", () => {
    expect(AREA_FILES.length).toBeGreaterThan(0);
  });

  it("are each linked from CLAUDE.md with a line saying when to read it, and every link resolves", () => {
    const linked = [...MAP.matchAll(/\]\(docs\/agents\/([^)#\s]+\.md)\)/g)].map((m) => m[1]);
    const unlinked = AREA_FILES.filter((name) => !linked.includes(name));
    expect(unlinked, `area files CLAUDE.md does not link: ${unlinked.join(", ")}`).toEqual([]);
    const dangling = [...new Set(linked)].filter((name) => !AREA_FILES.includes(name));
    expect(dangling, `CLAUDE.md links area files that do not exist: ${dangling.join(", ")}`).toEqual([]);
    for (const name of AREA_FILES) {
      expect(MAP, `CLAUDE.md has no "read this when you touch …" line for ${name}`).toMatch(
        new RegExp(`^- \\[${name.replace(/[.]/g, "\\.")}\\]\\(docs/agents/${name.replace(/[.]/g, "\\.")}\\) — read this when you touch .+$`, "m"),
      );
    }
  });

  it("each open with a title and ONE line saying what the file covers and when to read it", () => {
    for (const name of AREA_FILES) {
      const lines = fs.readFileSync(path.join(AREA_DIR, name), "utf-8").split("\n");
      expect(lines[0], `${name}: the first line is not a "# " title`).toMatch(/^# \S/);
      expect(lines[1], `${name}: no blank line after the title`).toBe("");
      expect(lines[2], `${name}: the third line should say what the file covers`).toMatch(/^[^#\s-].*\bRead it\b/);
      expect(lines[3], `${name}: the opening line should be one line`).toBe("");
    }
  });
});

describe("scripts/check-claude-md-no-loss.mjs", () => {
  const LONG = [
    "# CLAUDE.md",
    "",
    "## Area",
    "",
    "A paragraph that is",
    "hard-wrapped over two lines.",
    "",
    "- **one** — a bullet",
    "- **two** — a bullet with",
    "  an indented continuation",
    "  - and a nested item",
    "1. a numbered item",
    "",
  ].join("\n");

  it("splits paragraphs, top-level bullets with what is indented under them, and headings into units", () => {
    expect(splitUnits(LONG).map(({ line, heading }) => ({ line, heading }))).toEqual([
      { line: 1, heading: "CLAUDE.md" },
      { line: 3, heading: "Area" },
      { line: 5, heading: null },
      { line: 8, heading: null },
      { line: 9, heading: null },
      { line: 12, heading: null },
    ]);
    expect(splitUnits(LONG)[2].text).toBe("A paragraph that is\nhard-wrapped over two lines.");
    expect(splitUnits(LONG)[4].text).toBe("- **two** — a bullet with\n  an indented continuation\n  - and a nested item");
  });

  it("accepts every unit found verbatim, a heading at any level, in the map or an area file", () => {
    const map = "# CLAUDE.md\n\n- **one** — a bullet\n";
    const area = [
      "# Area file",
      "",
      "### Area",
      "",
      "A paragraph that is\nhard-wrapped over two lines.",
      "",
      "- **two** — a bullet with\n  an indented continuation\n  - and a nested item",
      "1. a numbered item",
      "",
    ].join("\n");
    expect(missingUnits(LONG, [map, area])).toEqual([]);
  });

  it("names every unit that is missing or changed, with the line it started on", () => {
    const map = "# CLAUDE.md\n\n- **one** — a bullet, edited\n";
    const area = "## Area renamed\n\nA paragraph that is\nhard-wrapped over two lines.\n";
    expect(missingUnits(LONG, [map, area]).map(({ line }) => line)).toEqual([3, 8, 9, 12]);
  });

  it("has work only while the base CLAUDE.md is the long form", () => {
    expect(isLongForm("# CLAUDE.md\n\nshort\n")).toBe(false);
    expect(isLongForm(`# CLAUDE.md\n\n${"x".repeat(MAP_MAX_LINE + 1)}\n`)).toBe(true);
    expect(isLongForm(`# CLAUDE.md\n\n${`${"y".repeat(100)}\n`.repeat(Math.ceil(MAP_MAX_BYTES / 100))}`)).toBe(true);
  });

  it("runs in CI on every pull request into beta against the PR's base, and nothing swallows its status", () => {
    // COMMENTS REMOVED before anything is searched: a comment that quotes the
    // command would otherwise keep every assertion here green with the step
    // itself deleted (the blind spot ci-workflows.test.ts records).
    const workflow = fs.readFileSync(path.join(REPO, ".github/workflows/pr-tests-coverage.yml"), "utf-8")
      .split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    const at = workflow.indexOf("node scripts/check-claude-md-no-loss.mjs");
    expect(at, "pr-tests-coverage.yml does not run the no-loss check").toBeGreaterThan(-1);
    const start = workflow.lastIndexOf("- name:", at);
    const next = workflow.indexOf("- name:", at);
    const step = workflow.slice(start, next === -1 ? undefined : next);
    // Into beta only: main keeps the long CLAUDE.md until a release carries the
    // map there, and a release PR checked against it reads beta's later edits
    // as lost paragraphs.
    expect(step).toMatch(/^\s+if: \$\{\{ github\.event_name == 'pull_request' && github\.base_ref == 'beta' \}\}\s*$/m);
    expect(step).toMatch(/^\s+BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\s*$/m);
    expect(step).toMatch(/^\s+node scripts\/check-claude-md-no-loss\.mjs "\$BASE_SHA"\s*$/m);
    expect(step).not.toMatch(/continue-on-error|\|\|/);
    // In `checks`, the job the required `test` verdict waits on.
    const checksJob = workflow.slice(workflow.indexOf("\n  checks:\n"), workflow.indexOf("\n  shard:\n"));
    expect(checksJob).toContain("node scripts/check-claude-md-no-loss.mjs");
  });
});
