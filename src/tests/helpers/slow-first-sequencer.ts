import { readFileSync } from "fs";
import { join, relative } from "path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * The files that dominate a run, longest first.
 *
 * Measured in CI (ubuntu-latest, 4 workers, 2026-08): the sudoers file scans
 * the whole repo with bash+perl once per case (~50 s) and the type-check gate
 * runs a full `tsc --noEmit` (~28 s). Nothing else comes close once the
 * suites that slept on real timers were fixed.
 *
 * WHY THE ORDER MATTERS. With no timing cache — which is every CI run —
 * vitest orders files by SIZE, and these two are mid-sized, so they started
 * late; whichever started last was the run's tail, three workers idle while
 * the fourth finished it. A parallel run can never be shorter than the file
 * that starts last; started first, the same files hide behind everything
 * else. Paths are relative to the repo root, forward slashes.
 */
export const SLOW_FIRST: readonly string[] = [
  "src/tests/unit/sudoers-coverage.test.ts",
  "src/tests/unit/build-typecheck.test.ts",
];

/**
 * Seconds per test file, measured on a CI run of the shards (4 workers each):
 * src/tests/helpers/test-durations.json, every file that took a second or
 * more. Regenerate it from a run's logs when the suite has moved on:
 *
 *   gh run view <run id> --log | node scripts/vitest-durations.mjs > src/tests/helpers/test-durations.json
 *
 * A file it does not list (new, or quick) counts as UNMEASURED_S — about what
 * the unlisted files take. A stale table only balances worse; it never drops
 * or repeats a file.
 */
export const UNMEASURED_S = 0.2;
const DURATIONS: Readonly<Record<string, number>> = JSON.parse(
  readFileSync(join(__dirname, "test-durations.json"), "utf8"),
) as Record<string, number>;

/**
 * `count` shards of the files, balanced by measured duration: longest first,
 * each into the shard with the least time so far (ties: the lower shard).
 * The result depends only on the files, the count and the table, so every
 * shard's runner computes the same plan and takes its own part of it — each
 * file in exactly one shard. vitest's own split is by a hash of each path,
 * which measured 157 to 458 file-seconds across eight shards of one run.
 */
export function planShards(paths: readonly string[], count: number, durations: Readonly<Record<string, number>> = DURATIONS): string[][] {
  const weighted = [...new Set(paths)]
    .map((path) => ({ path, s: durations[path] ?? UNMEASURED_S }))
    .sort((a, b) => b.s - a.s || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  for (const { path, s } of weighted) {
    let best = 0;
    for (let i = 1; i < count; i++) if (shards[i].load < shards[best].load) best = i;
    shards[best].load += s;
    shards[best].files.push(path);
  }
  return shards.map((shard) => shard.files);
}

export default class SlowFirstSequencer extends BaseSequencer {
  private rel(spec: TestSpecification): string {
    return relative(this.ctx.config.root, spec.moduleId).split("\\").join("/");
  }

  /** This runner's part of the plan (`--shard=<index>/<count>`); see planShards. */
  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const mine = new Set(planShards(files.map((f) => this.rel(f)), shard.count)[shard.index - 1] ?? []);
    return files.filter((f) => mine.has(this.rel(f)));
  }

  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    // The base order groups files by project and the groups run in turn; only
    // the order WITHIN a group is changed here, or a slow unit file would be
    // pulled ahead of a project it does not belong to.
    const groupOf = new Map<string, number>();
    for (const spec of sorted) {
      if (!groupOf.has(spec.project.name)) groupOf.set(spec.project.name, groupOf.size);
    }
    const rank = (spec: TestSpecification): number => {
      const i = SLOW_FIRST.indexOf(this.rel(spec));
      return i === -1 ? SLOW_FIRST.length : i;
    };
    // Array.prototype.sort is stable: files of equal rank keep the base order.
    return [...sorted].sort(
      (a, b) =>
        groupOf.get(a.project.name)! - groupOf.get(b.project.name)! || rank(a) - rank(b),
    );
  }
}
