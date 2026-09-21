import { relative } from "path";
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

export default class SlowFirstSequencer extends BaseSequencer {
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
      const rel = relative(this.ctx.config.root, spec.moduleId).split("\\").join("/");
      const i = SLOW_FIRST.indexOf(rel);
      return i === -1 ? SLOW_FIRST.length : i;
    };
    // Array.prototype.sort is stable: files of equal rank keep the base order.
    return [...sorted].sort(
      (a, b) =>
        groupOf.get(a.project.name)! - groupOf.get(b.project.name)! || rank(a) - rank(b),
    );
  }
}
