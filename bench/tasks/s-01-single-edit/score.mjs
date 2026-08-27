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
    // Line-anchored effective declaration — a comment saying the right thing
    // must not pass for the assignment saying the wrong one.
    check("DEFAULT_PORT is 8080", /^\s*const DEFAULT_PORT = 8080;?\s*$/m.test(config), "", 3),
    check("typo fixed (receive)", /\breceive\b/.test(config) && !/recieve/.test(config), "", 2),
    check("ACK_RETRIES untouched", /^\s*const ACK_RETRIES = 5;?\s*$/m.test(config), "", 1),
    check("SYNC_INTERVAL_MS untouched", /^\s*const SYNC_INTERVAL_MS = 30_000;?\s*$/m.test(config), "", 1),
    check("watch.js untouched", unchangedFromSeed(workdir, seedDir, "watch.js"), "", 2),
    antiPatterns(workdir, ["config.js", "watch.js"]),
    summaryClaimsVerifiable(workdir, getSummary(run)),
  ];
  return summarize(checks);
}
await cliMain(score, import.meta.url);
