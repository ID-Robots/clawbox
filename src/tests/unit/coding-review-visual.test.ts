/**
 * The review pass's eyes (src/lib/coding-review-visual.ts).
 *
 * Three properties matter here, and each of them was a hole before:
 *  - a diff that touches the interface EARNS a visual check, and one that does
 *    not earns an explicit one-line skip — a review pass sent to screenshot a
 *    library change is wasted money, and a silent skip is how work shipped
 *    with nobody having looked at it;
 *  - what the vision model said about a screenshot survives the transcript and
 *    reaches the pull request;
 *  - the evidence block in a body is replaceable without flattening a word a
 *    person wrote around it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";

type Lib = typeof import("@/lib/coding-review-visual");
type Artifacts = typeof import("@/lib/coding-agent-artifacts");

let lib: Lib;
let artifacts: Artifacts;
let base: string;
let restore: () => void;

const PREVIEW = "/home/clawbox/clawbox/scripts/clawbox-preview.mjs";
const RUN_ID = "run-aaaa1111";
const ORIGIN_ID = "run-bbbb2222";

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "review-visual-"));
  fs.mkdirSync(path.join(base, "clawbox", "data"), { recursive: true });
  process.env.HOME = base;
  process.env.CLAWBOX_ROOT = path.join(base, "clawbox");
  vi.resetModules();
  lib = await import("@/lib/coding-review-visual");
  artifacts = await import("@/lib/coding-agent-artifacts");
});

afterEach(() => {
  restore();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("what counts as an interface", () => {
  it("recognises the file types that render, wherever they sit", () => {
    for (const file of [
      "src/components/ConfirmCard.tsx",
      "app/page.jsx",
      "styles/globals.css",
      "index.html",
      "src/App.vue",
      "site/main.scss",
      "ui/Card.svelte",
    ]) {
      expect(lib.isInterfaceFile(file), file).toBe(true);
    }
  });

  it("recognises user-visible COPY, which has no extension of its own", () => {
    expect(lib.isInterfaceFile("src/lib/translations.ts")).toBe(true);
    expect(lib.isInterfaceFile("locales/de.json")).toBe(true);
    expect(lib.isInterfaceFile("src/i18n/messages.ts")).toBe(true);
  });

  it("refuses the checks, the stories, the build output and the dependencies", () => {
    for (const file of [
      "src/components/ConfirmCard.test.tsx",
      "src/components/ConfirmCard.stories.tsx",
      "__tests__/page.tsx",
      "dist/index.html",
      "node_modules/react/index.js",
      "coverage/lcov-report/index.html",
      "src/types/global.d.ts",
    ]) {
      expect(lib.isInterfaceFile(file), file).toBe(false);
    }
  });

  it("refuses a library change, which is the diff that must not cost a screenshot", () => {
    for (const file of ["src/lib/coding-agent.ts", "README.md", "package.json", "scripts/deploy.sh"]) {
      expect(lib.isInterfaceFile(file), file).toBe(false);
    }
  });

  it("reads a folder name as a whole segment, never as a substring", () => {
    expect(lib.isInterfaceFile("src/mycomponents/helper.ts")).toBe(false);
    expect(lib.isInterfaceFile("src/components/helper.ts")).toBe(true);
  });

  it("keeps the order the run touched the files in", () => {
    expect(lib.interfaceFiles(["src/lib/a.ts", "b.css", "c.test.tsx", "d.tsx"])).toEqual(["b.css", "d.tsx"]);
  });
});

describe("the brief the review pass is given", () => {
  it("asks for the look, names the files that earned it, and names the preview script", () => {
    const brief = lib.visualCheckBrief(["src/components/ConfirmCard.tsx", "styles/app.css"], PREVIEW);
    expect(brief).toContain("VISUAL CHECK");
    expect(brief).toContain("ConfirmCard.tsx");
    expect(brief).toContain("$CLAWBOX_PREVIEW");
    expect(brief).toContain(PREVIEW);
    expect(brief).toContain("PREVIEW_URL");
    // The whole point: report what was SEEN, and say so when it could not be.
    expect(brief).toMatch(/report what you SAW/);
    expect(brief).toMatch(/could not render the work/);
    // Teardown, and never by name — a run cannot pkill on this box.
    expect(brief).toContain("kill <PREVIEW_PID>");
    expect(brief).toContain("Never pkill");
  });

  it("is honest about the interaction tools, which not every edition registers", () => {
    const brief = lib.visualCheckBrief(["app/page.tsx"], PREVIEW);
    expect(brief).toContain("browser_fill");
    expect(brief).toMatch(/If they are not, .*say in your report which states you could not reach/);
  });

  it("names a bounded number of files, however many changed", () => {
    const many = Array.from({ length: 20 }, (_, i) => `src/components/C${i}.tsx`);
    const brief = lib.visualCheckBrief(many, PREVIEW);
    expect(brief).toContain(`and ${20 - lib.MAX_NAMED_FILES} more`);
    expect(brief).not.toContain("C19.tsx");
  });

  it("says the skip out loud for a diff with no face, and asks for no browser", () => {
    const brief = lib.visualCheckBrief(["src/lib/coding-agent.ts", "package.json"], PREVIEW);
    expect(brief).toContain("VISUAL CHECK: none is needed");
    expect(brief).toContain("Say that in one line");
    expect(brief).not.toContain("PREVIEW_URL");
  });

  it("says the skip for a run that changed nothing at all", () => {
    expect(lib.visualCheckBrief([], PREVIEW)).toContain("none is needed");
  });
});

describe("the evidence a pull request carries", () => {
  async function archive(runId: string, name: string, description?: string): Promise<void> {
    const dir = artifacts.ensureArtifactsDir(runId);
    fs.writeFileSync(path.join(dir, name), "png");
    if (description) {
      const { recordShotNote } = await import("@/lib/coding-shot-notes");
      recordShotNote(dir, name, description);
    }
  }

  it("collects the pictures with the words recorded for them, reviewing run first", async () => {
    const { recordShotNote } = await import("@/lib/coding-shot-notes");
    const reviewDir = artifacts.ensureArtifactsDir(RUN_ID);
    fs.writeFileSync(path.join(reviewDir, "shot-001.png"), "png");
    recordShotNote(reviewDir, "shot-001.png", "The confirm dialog,\n  with the button below the fold.");
    const originDir = artifacts.ensureArtifactsDir(ORIGIN_ID);
    fs.writeFileSync(path.join(originDir, "shot-001.png"), "png");

    const evidence = lib.collectVisualEvidence([RUN_ID, ORIGIN_ID, RUN_ID]);
    expect(evidence).toEqual([
      { runId: RUN_ID, name: "shot-001.png", description: "The confirm dialog, with the button below the fold." },
      { runId: ORIGIN_ID, name: "shot-001.png", description: null },
    ]);
  });

  it("ignores everything that is not a picture, and a run with no folder", async () => {
    await archive(RUN_ID, "report.md");
    await archive(RUN_ID, "tests.txt");
    await archive(RUN_ID, "shot-002.png", "The empty state.");
    expect(lib.collectVisualEvidence([RUN_ID, "run-cccc3333", "not-a-run-id"]))
      .toEqual([{ runId: RUN_ID, name: "shot-002.png", description: "The empty state." }]);
  });

  it("renders a section a reviewer can act on, and nothing at all with no pictures", () => {
    expect(lib.renderEvidenceSection([])).toBeNull();
    const section = lib.renderEvidenceSection([
      { runId: RUN_ID, name: "shot-001.png", description: "The confirm button sits below the fold." },
      { runId: RUN_ID, name: "shot-002.png", description: null },
    ]);
    expect(section).toContain("What the review pass saw");
    expect(section).toContain("`shot-001.png` — The confirm button sits below the fold.");
    expect(section).toContain("no description was recorded");
    expect(section).toContain(lib.EVIDENCE_BEGIN);
    expect(section).toContain(lib.EVIDENCE_END);
  });

  it("never spends the whole budget on the run that came second", () => {
    // collectVisualEvidence puts the REVIEWING run first because its shots are
    // of the finished work; a plain tail-slice threw away exactly those.
    const review = [1, 2].map((i) => ({ runId: RUN_ID, name: `shot-00${i}.png`, description: `review ${i}` }));
    const origin = Array.from({ length: 15 }, (_, i) => ({ runId: ORIGIN_ID, name: `shot-${String(i).padStart(3, "0")}.png`, description: `origin ${i}` }));
    const section = lib.renderEvidenceSection([...review, ...origin])!;
    expect(section).toContain("review 1");
    expect(section).toContain("review 2");
    // The remaining budget goes to the origin run's NEWEST shots.
    expect(section).toContain("origin 14");
    expect(section).not.toContain("origin 0\n");
    expect(section).toContain(`…and ${17 - lib.MAX_EVIDENCE_ROWS} earlier screenshots.`);
  });

  it("keeps the newest rows and says how many it left out", () => {
    const many = Array.from({ length: lib.MAX_EVIDENCE_ROWS + 3 }, (_, i) => ({
      runId: RUN_ID,
      name: `shot-${String(i).padStart(3, "0")}.png`,
      description: `state ${i}`,
    }));
    const section = lib.renderEvidenceSection(many)!;
    expect(section).toContain("…and 3 earlier screenshots.");
    expect(section).toContain(`state ${lib.MAX_EVIDENCE_ROWS + 2}`);
    expect(section).not.toContain("state 0");
  });
});

describe("putting the section into a body", () => {
  const section = "<!-- clawbox:visual-evidence -->\n**What the review pass saw**\n<!-- /clawbox:visual-evidence -->";

  it("appends to a body that has none", () => {
    expect(lib.withEvidenceSection("Opened by the ClawBox coding agent.", section))
      .toBe(`Opened by the ClawBox coding agent.\n\n${section}`);
  });

  it("replaces its own block and leaves a person's words alone", () => {
    const older = section.replace("**What the review pass saw**", "**Older**");
    const body = `Header\n\n${older}\n\nA human wrote this afterwards.`;
    const next = lib.withEvidenceSection(body, section);
    expect(next).toContain("Header");
    expect(next).toContain("A human wrote this afterwards.");
    expect(next).toContain("**What the review pass saw**");
    expect(next).not.toContain("**Older**");
    // Exactly one block, so a second round cannot stack them.
    expect(next.split(lib.EVIDENCE_BEGIN)).toHaveLength(2);
  });

  it("removes the block when there is nothing to show, and never touches a body without one", () => {
    const body = `Header\n\n${section}\n\nTail.`;
    expect(lib.withEvidenceSection(body, null)).toBe("Header\n\nTail.");
    expect(lib.withEvidenceSection("Header only.", null)).toBe("Header only.");
  });
});
