// Fails if runtime `dependencies` differ from the starting commit ($BASE). Dev dependencies may change.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.PROJECT || process.cwd();
const before = JSON.parse(execFileSync("git", ["show", `${process.env.BASE}:package.json`], { cwd: root, encoding: "utf8" }));
const after = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const names = (pkg) => Object.keys(pkg.dependencies || {}).sort();
const extra = names(after).filter((n) => !names(before).includes(n));
if (extra.length) {
  console.error(`new runtime dependencies: ${extra.join(", ")}`);
  process.exit(1);
}
const opt = Object.keys(after.optionalDependencies || {});
if (opt.length) {
  console.error(`optionalDependencies added: ${opt.join(", ")}`);
  process.exit(1);
}
console.log(`runtime dependencies: ${names(after).join(", ") || "(none)"}`);
