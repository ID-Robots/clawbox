import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";
import fs from "fs";
import path from "path";
import SlowFirstSequencer, { SLOW_FIRST, UNMEASURED_S, planShards } from "@/tests/helpers/slow-first-sequencer";

/**
 * The sequencer vitest.config.ts installs: the files known to take longest
 * start first, so a four-worker run does not end on one of them while the
 * other three workers sit idle.
 */

const REPO = path.resolve(__dirname, "../../..");

/** The base sequencer with nothing cached — what every CI run looks like. */
function sequencer(shard?: { index: number; count: number }): SlowFirstSequencer {
  const ctx = {
    config: { root: REPO, shard },
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

// Forward slashes whatever the host separator: SLOW_FIRST and the expected
// values are written with `/`, and the sequencer normalises its own paths.
const rel = (s: TestSpecification) => path.relative(REPO, s.moduleId).split(path.sep).join("/");

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

describe("planShards: the shards, balanced by measured duration", () => {
  const files = Array.from({ length: 40 }, (_, i) => `src/tests/unit/f${String(i).padStart(2, "0")}.test.ts`);
  const table: Record<string, number> = Object.fromEntries(files.slice(0, 12).map((f, i) => [f, 60 - i * 4]));
  const load = (shard: string[]) => shard.reduce((sum, f) => sum + (table[f] ?? UNMEASURED_S), 0);

  it("puts every file in exactly one shard", () => {
    const plan = planShards(files, 4, table);
    expect(plan).toHaveLength(4);
    expect(plan.flat().sort()).toEqual([...files].sort());
    expect(new Set(plan.flat()).size).toBe(files.length);
    expect(planShards([...files, files[0]], 4, table).flat()).toHaveLength(files.length);
  });

  it("evens the load: no shard is ahead of another by more than one file's time", () => {
    const loads = planShards(files, 4, table).map(load);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(Math.max(...Object.values(table)));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThan(10);
  });

  it("is the same plan whatever order the files come in, so every runner agrees", () => {
    const shuffled = [...files].reverse();
    expect(planShards(shuffled, 4, table)).toEqual(planShards(files, 4, table));
  });

  it("counts a file the table does not list as UNMEASURED_S", () => {
    const plan = planShards(["a.test.ts", "b.test.ts", "c.test.ts"], 2, { "a.test.ts": 1 });
    expect(plan).toEqual([["a.test.ts"], ["b.test.ts", "c.test.ts"]]);
  });

  it("measures the repository's own table: every entry a test file, every value seconds", () => {
    const real = JSON.parse(fs.readFileSync(path.join(REPO, "src/tests/helpers/test-durations.json"), "utf8")) as Record<string, number>;
    expect(Object.keys(real).length).toBeGreaterThan(50);
    for (const [file, seconds] of Object.entries(real)) {
      expect(file).toMatch(/^src\/tests\/.+\.test\.tsx?$/);
      expect(seconds).toBeGreaterThan(0);
    }
  });

  it("hands each runner its own part of the same plan", async () => {
    const specs = files.map((f) => spec("unit", f));
    const parts = await Promise.all([1, 2, 3].map((index) => sequencer({ index, count: 3 }).shard(specs)));
    const names = parts.map((part) => part.map(rel));
    expect(names.flat().sort()).toEqual([...files].sort());
    expect(new Set(names.flat()).size).toBe(files.length);
    expect(names).toEqual(planShards(files, 3).map((shard) => files.filter((f) => shard.includes(f))));
  });
});
