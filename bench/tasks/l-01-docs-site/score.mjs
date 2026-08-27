import {
  check, summarize, read, exists, listFiles, nodeCheck, internalLinksResolve,
  noExternalRefs, antiPatterns, countOccurrences, summaryClaimsVerifiable, cliMain,
} from "../../lib/score-utils.mjs";
import { getSummary } from "../../lib/record.mjs";

const COMMANDS = ["init", "run", "stop", "status", "logs", "config", "backup", "restore", "update"];
// Verbatim from the brief — each synopsis must exist EXACTLY ONCE in the
// source tree, in js/commands.js. Duplication into page HTML is the
// centralisation failure this task exists to catch.
const SYNOPSES = [
  "crabctl init [--fleet <name>] [--force]",
  "crabctl run <task> [--detach] [--timeout <s>]",
  "crabctl stop <task-id> [--all]",
  "crabctl status [--json] [--watch]",
  "crabctl logs <task-id> [--follow] [--tail <n>]",
  "crabctl backup [--output <path>] [--exclude <glob>]",
  "crabctl restore <archive> [--dry-run]",
];
const REQUIRED = [
  "index.html", "getting-started.html", "changelog.html",
  ...COMMANDS.map((c) => `commands/${c}.html`),
  "css/docs.css", "js/commands.js", "js/nav.js",
];

export default async function score({ workdir, run }) {
  const missing = REQUIRED.filter((f) => !exists(workdir, f));
  if (missing.length === REQUIRED.length) {
    // Nothing delivered. The vacuous checks (no bad links in no files…) must
    // not hand an empty folder a third of the points.
    return summarize([check("all required files exist", false, "nothing delivered", 3)]);
  }
  const all = listFiles(workdir);
  const commandsJs = read(workdir, "js/commands.js") ?? "";
  const changelog = read(workdir, "changelog.html") ?? "";
  const pages = REQUIRED.filter((f) => f.endsWith(".html"));

  const synopsisChecks = SYNOPSES.map((syn) => {
    const total = countOccurrences(workdir, all, syn);
    const inData = commandsJs.includes(syn);
    return check(
      `single-sourced: ${syn.split(" ")[1]}`,
      total === 1 && inData,
      inData ? (total === 1 ? "" : `${total} copies in the tree`) : "not in js/commands.js",
    );
  });

  const sidebars = pages.filter((p) => {
    const html = read(workdir, p) ?? "";
    // A generated sidebar means the page pulls the command list from the data
    // layer: it must reference the script, not hand-write nine links.
    return /js\/(commands|nav)\.js|(commands|nav)\.js/.test(html);
  });

  const flagsInData = COMMANDS.filter((c) => {
    const re = new RegExp(`["'\`]${c}["'\`]`);
    return re.test(commandsJs);
  });

  const checks = [
    check("all 15 required files exist", missing.length === 0, missing.slice(0, 6).join("; "), 3),
    await nodeCheck(workdir, "js/commands.js"),
    await nodeCheck(workdir, "js/nav.js"),
    ...synopsisChecks,
    check("every command present in js/commands.js", flagsInData.length === COMMANDS.length,
      `${flagsInData.length}/${COMMANDS.length}`, 2),
    check("sidebar wired from the data layer on every page",
      sidebars.length === pages.length, `${sidebars.length}/${pages.length}`, 2),
    check("changelog has the three releases",
      ["2.4.0", "2.3.1", "2.3.0"].every((v) => changelog.includes(v)), "", 1),
    check("viewport meta on every page",
      pages.every((p) => /name\s*=\s*["']viewport["']/.test(read(workdir, p) ?? "")), "", 1),
    internalLinksResolve(workdir, pages),
    noExternalRefs(workdir, all),
    antiPatterns(workdir, all),
    summaryClaimsVerifiable(workdir, getSummary(run)),
  ];
  return summarize(checks);
}
await cliMain(score, import.meta.url);
