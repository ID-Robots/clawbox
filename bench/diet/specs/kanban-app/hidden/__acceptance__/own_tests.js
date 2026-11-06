// Runs the project's own `npm test` and requires it to pass with at least MIN test cases.
// Counts come from the runner's summary (node:test spec/TAP, jest, vitest, mocha);
// if none is recognisable, falls back to counting test()/it() calls in test files.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MIN = Number(process.argv[2] || 20);
const root = process.env.PROJECT || process.cwd();
const r = spawnSync("npm", ["test"], { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" }, timeout: 280000 });
const out = `${r.stdout || ""}\n${r.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
if (r.status !== 0) {
  console.error(out.split("\n").slice(-40).join("\n"));
  console.error(`npm test failed (exit ${r.status})`);
  process.exit(1);
}
const patterns = [/^\s*ℹ pass (\d+)/m, /^# pass (\d+)/m, /Tests:\s+(?:\d+ \w+, )*(\d+) passed/m, /Tests\s+(\d+) passed/m, /^\s*(\d+) passing/m];
let passed = null;
for (const p of patterns) {
  const m = p.exec(out);
  if (m) { passed = Number(m[1]); break; }
}
if (passed === null) {
  let count = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "__acceptance__", "data", "public"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(c|m)?[jt]s$/.test(e.name) && (/test/i.test(e.name) || /(^|\/)tests?\//.test(path.relative(root, full)))) {
        count += (fs.readFileSync(full, "utf8").match(/\b(?:it|test)\s*\(/g) || []).length;
      }
    }
  };
  walk(root);
  passed = count;
  console.log(`no runner summary recognised; counted ${count} test()/it() calls`);
}
console.log(`own tests passed: ${passed} (need >= ${MIN})`);
process.exit(passed >= MIN ? 0 : 1);
