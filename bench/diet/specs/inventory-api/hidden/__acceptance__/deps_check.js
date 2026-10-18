// Fails if package.json dependencies/devDependencies differ from the starting commit ($BASE).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.PROJECT || process.cwd();
const before = JSON.parse(execFileSync("git", ["show", `${process.env.BASE}:package.json`], { cwd: root, encoding: "utf8" }));
const after = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
let bad = false;
for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  const a = JSON.stringify(Object.entries(before[key] || {}).sort());
  const b = JSON.stringify(Object.entries(after[key] || {}).sort());
  if (a !== b) {
    console.error(`${key} changed:\n  before ${a}\n  after  ${b}`);
    bad = true;
  }
}
process.exit(bad ? 1 : 0);
