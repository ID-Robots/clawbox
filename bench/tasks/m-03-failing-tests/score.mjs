import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  check, summarize, listFiles, nodeTest, unchangedFromSeed, antiPatterns,
  summaryClaimsVerifiable, cliMain,
} from "../../lib/score-utils.mjs";
import { getSummary } from "../../lib/record.mjs";

const seedDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "seed");

export default async function score({ workdir, run }) {
  const tests = await nodeTest(workdir);
  const implChanged = !unchangedFromSeed(workdir, seedDir, "merge.js");
  const checks = [
    tests.check, // weight 3: the whole point of the task
    check("all 8 tests ran", tests.passCount + Math.max(tests.failCount, 0) >= 8,
      `pass=${tests.passCount} fail=${tests.failCount}`),
    // The WHOLE test/ tree is the specification: same file set, same bytes.
    // Comparing one known file would let a run add a test that weakens the
    // suite, or park helpers beside the spec.
    check("tests untouched", (() => {
      const now = listFiles(workdir).filter((f) => f.startsWith("test/"));
      const seed = listFiles(seedDir).filter((f) => f.startsWith("test/"));
      return now.length === seed.length
        && seed.every((f) => now.includes(f) && unchangedFromSeed(workdir, seedDir, f));
    })(), "", 3),
    check("fix lives in merge.js", implChanged, "merge.js identical to seed", 1),
    antiPatterns(workdir, ["merge.js"]),
    summaryClaimsVerifiable(workdir, getSummary(run)),
  ];
  return summarize(checks);
}
await cliMain(score, import.meta.url);
