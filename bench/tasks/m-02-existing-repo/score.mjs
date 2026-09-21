import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  check, summarize, read, listFiles, nodeTest, unchangedFromSeed,
  antiPatterns, summaryClaimsVerifiable, cliMain, run as exec,
} from "../../lib/score-utils.mjs";
import { getSummary } from "../../lib/record.mjs";

const seedDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "seed");

export default async function score({ workdir, run }) {
  const all = listFiles(workdir);
  const tests = await nodeTest(workdir);
  const readme = read(workdir, "README.md") ?? "";

  // Pattern-following: a dedicated module that registers like the others.
  const tempModule = all.find((f) => /^lib\/temperature\.js$/.test(f))
    ?? all.find((f) => /^lib\/.*temp.*\.js$/i.test(f));
  const tempSrc = tempModule ? (read(workdir, tempModule) ?? "") : "";

  // Wiring and correctness through the CLI ITSELF, in a subprocess — source
  // text can carry a require() in a comment, and a scorer-side import can
  // load a module cli.js never does. `node cli.js list` proves the wiring,
  // `node cli.js convert` proves the numbers, exactly as a user would.
  const list = await exec("node", ["cli.js", "list"], { cwd: workdir });
  const wired = list.ok && /celsius -> fahrenheit/.test(list.stdout) && /kelvin -> celsius/.test(list.stdout);
  const cases = [
    ["0", "celsius", "fahrenheit", 32],
    ["100", "celsius", "fahrenheit", 212],
    ["32", "fahrenheit", "celsius", 0],
    ["0", "celsius", "kelvin", 273.15],
    ["300", "kelvin", "celsius", 26.85],
  ];
  let conversionsCorrect = true;
  let conversionDetail = "";
  for (const [value, from, to, want] of cases) {
    const out = await exec("node", ["cli.js", "convert", value, from, to], { cwd: workdir });
    const got = Number((out.stdout ?? "").trim());
    if (!out.ok || !Number.isFinite(got) || Math.abs(got - want) > 1e-6) {
      conversionsCorrect = false;
      conversionDetail = `${value} ${from} -> ${to}: got ${out.ok ? out.stdout.trim() : out.stderr.split("\n")[0]}`;
      break;
    }
  }

  const newTests = all.filter(
    (f) => f.startsWith("test/") && f.endsWith(".test.js") && f !== "test/registry.test.js",
  );

  const checks = [
    tests.check,
    check("existing tests untouched",
      unchangedFromSeed(workdir, seedDir, "test/registry.test.js"), "", 2),
    check("temperature module follows the pattern",
      Boolean(tempModule) && /register\(/.test(tempSrc),
      tempModule ?? "no lib/*temp* module found", 2),
    check("wired into cli.js like the others", wired, wired ? "" : "cli.js list does not offer the temperature pairs", 2),
    check("conversions numerically correct", conversionsCorrect, conversionDetail, 3),
    check("README table updated",
      /fahrenheit/i.test(readme) && /kelvin/i.test(readme), "", 1),
    check("new tests added in test/", newTests.length >= 1, newTests.join("; "), 1),
    antiPatterns(workdir, all.filter((f) => f.endsWith(".js") || f.endsWith(".md"))),
    summaryClaimsVerifiable(workdir, getSummary(run)),
  ];
  return summarize(checks);
}
await cliMain(score, import.meta.url);
