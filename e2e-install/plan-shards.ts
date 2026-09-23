/**
 * Prints the JSON array of shards an e2e-install run needs, for the matrix in
 * .github/workflows/e2e-install.yml. The decision itself is `planShards` in
 * ./shards.ts; this is only its input and output.
 *
 *   bun e2e-install/plan-shards.ts < changed-paths   one repo path per line
 *   bun e2e-install/plan-shards.ts --all             the changed files are not known
 *
 * The array goes to stdout, the reason to stderr for the job log.
 */
import { readFileSync } from "node:fs";
import { planShards } from "./shards";

const changed = process.argv.includes("--all")
  ? null
  : readFileSync(0, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
const plan = planShards(changed);

if (changed === null) {
  console.error("every shard: the changed files are not known for this run");
} else if (plan.because.length > 0) {
  const shown = plan.because.slice(0, 10).join(", ");
  const more = plan.because.length > 10 ? ` and ${plan.because.length - 10} more` : "";
  console.error(`every shard: ${shown}${more} can change the upgrade flow`);
} else {
  console.error(`core only: none of the ${changed.length} changed paths can change the upgrade flow`);
}
process.stdout.write(`${JSON.stringify(plan.shards)}\n`);
