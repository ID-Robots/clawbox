import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  check, summarize, read, listFiles, nodeTest, unchangedFromSeed,
  antiPatterns, summaryClaimsVerifiable, cliMain,
} from "../../lib/score-utils.mjs";
import { getSummary } from "../../lib/record.mjs";

const seedDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "seed");

export default async function score({ workdir, run }) {
  const all = listFiles(workdir);
  const tests = await nodeTest(workdir);
  const cli = read(workdir, "cli.js") ?? "";
  const readme = read(workdir, "README.md") ?? "";

  // Pattern-following: a dedicated module that registers, wired like the others.
  const tempModule = all.find((f) => /^lib\/temperature\.js$/.test(f))
    ?? all.find((f) => /^lib\/.*temp.*\.js$/i.test(f));
  const tempSrc = tempModule ? (read(workdir, tempModule) ?? "") : "";
  const wired = tempModule
    ? new RegExp(`require\\(["']\\./${tempModule.replace(/\.js$/, "").replace("/", "\\/")}["']\\)`).test(cli)
    : false;

  // Numeric correctness through the real registry, in a subprocess-free way:
  // import the workdir's modules directly.
  let conversionsCorrect = false;
  let conversionDetail = "";
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(pathToFileURL(path.join(workdir, "cli.js")));
    if (tempModule) req(path.join(workdir, tempModule));
    const { convert } = req(path.join(workdir, "lib/registry.js"));
    const cases = [
      ["celsius", "fahrenheit", 0, 32],
      ["celsius", "fahrenheit", 100, 212],
      ["fahrenheit", "celsius", 32, 0],
      ["celsius", "kelvin", 0, 273.15],
      ["kelvin", "celsius", 300, 26.85],
    ];
    conversionsCorrect = cases.every(
      ([from, to, v, want]) => Math.abs(convert(from, to, v) - want) < 1e-6,
    );
    if (!conversionsCorrect) conversionDetail = "a temperature conversion is numerically wrong";
  } catch (err) {
    conversionDetail = String(err).split("\n")[0];
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
    check("wired into cli.js like the others", wired, "", 2),
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
