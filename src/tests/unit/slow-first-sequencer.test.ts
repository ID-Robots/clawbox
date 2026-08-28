import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";
import fs from "fs";
import path from "path";
import SlowFirstSequencer, { SLOW_FIRST } from "@/tests/helpers/slow-first-sequencer";

/**
 * The sequencer vitest.config.ts installs: the files known to take longest
 * start first, so a four-worker run does not end on one of them while the
 * other three workers sit idle.
 */

const REPO = path.resolve(__dirname, "../../..");

/** The base sequencer with nothing cached — what every CI run looks like. */
function sequencer(): SlowFirstSequencer {
  const ctx = {
    config: { root: REPO },
    cache: { getFileTestResults: () => undefined, getFileStats: () => undefined },
  };
  return new SlowFirstSequencer(ctx as unknown as Vitest);
}

function spec(project: string, rel: string): TestSpecification {
  return {
    moduleId: path.join(REPO, rel),
    project: { name: project, config: { sequence: { groupOrder: 0 }, isolate: true } },
  } as unknown as TestSpecification;
}

const rel = (s: TestSpecification) => path.relative(REPO, s.moduleId);

describe("SlowFirstSequencer", () => {
  it("names files that exist, so a rename cannot silently drop one out of the fast lane", () => {
    for (const file of SLOW_FIRST) {
      expect(fs.existsSync(path.join(REPO, file)), `${file} is listed but not in the tree`).toBe(true);
    }
  });

  it("starts the known-slow files first, in the listed order, ahead of files the base order put before them", async () => {
    const files = [
      spec("unit", "src/tests/unit/a.test.ts"),
      spec("unit", SLOW_FIRST[1]),
      spec("unit", "src/tests/unit/b.test.ts"),
      spec("unit", SLOW_FIRST[0]),
    ];
    const sorted = await sequencer().sort(files);
    expect(sorted.map(rel)).toEqual([SLOW_FIRST[0], SLOW_FIRST[1], "src/tests/unit/a.test.ts", "src/tests/unit/b.test.ts"]);
  });

  it("keeps the base order among the rest and never crosses a project boundary", async () => {
    // The base sequencer runs projects one after another (components before
    // unit, by name). A slow UNIT file must not be pulled ahead of the
    // component files, only ahead of its own project's files.
    const files = [
      spec("unit", "src/tests/unit/z.test.ts"),
      spec("unit", SLOW_FIRST[0]),
      spec("components", "src/tests/components/y.test.tsx"),
      spec("components", "src/tests/components/x.test.tsx"),
    ];
    const sorted = await sequencer().sort(files);
    expect(sorted.map((s) => `${s.project.name}:${rel(s)}`)).toEqual([
      "components:src/tests/components/y.test.tsx",
      "components:src/tests/components/x.test.tsx",
      `unit:${SLOW_FIRST[0]}`,
      "unit:src/tests/unit/z.test.ts",
    ]);
  });
});
