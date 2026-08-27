import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  check, summarize, read, nodeCheck, unchangedFromSeed, antiPatterns,
  summaryClaimsVerifiable, cliMain,
} from "../../lib/score-utils.mjs";
import { getSummary } from "../../lib/record.mjs";

const seedDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "seed");

export default async function score({ workdir, run }) {
  const config = read(workdir, "config.js") ?? "";
  const checks = [
    check("config.js exists", config !== "", "", 1),
    await nodeCheck(workdir, "config.js"),
    check("DEFAULT_PORT is 8080", /DEFAULT_PORT\s*=\s*8080\b/.test(config), "", 3),
    check("typo fixed (receive)", /\breceive\b/.test(config) && !/recieve/.test(config), "", 2),
    check("ACK_RETRIES untouched", /ACK_RETRIES\s*=\s*5\b/.test(config), "", 1),
    check("SYNC_INTERVAL_MS untouched", /SYNC_INTERVAL_MS\s*=\s*30_000\b/.test(config), "", 1),
    check("watch.js untouched", unchangedFromSeed(workdir, seedDir, "watch.js"), "", 2),
    antiPatterns(workdir, ["config.js", "watch.js"]),
    summaryClaimsVerifiable(workdir, getSummary(run)),
  ];
  return summarize(checks);
}
await cliMain(score, import.meta.url);
