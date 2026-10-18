#!/usr/bin/env node
// Before/after for two suite runs, with the keep/reject verdict.
//   node bench/diet/compare.mjs <results/<base>> <results/<candidate>>
import fs from "node:fs";
import path from "node:path";
import { compareTable, decide } from "./lib/report.mjs";

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error("usage: node bench/diet/compare.mjs <results/base> <results/candidate> [--json]"); process.exit(2); }
const load = (d) => fs.readdirSync(d).filter((f) => f.endsWith(".json") && !["meta.json", "summary.json"].includes(f))
  .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))).filter((r) => r.spec);
const base = load(a);
const cand = load(b);
if (process.argv.includes("--json")) console.log(JSON.stringify(decide(base, cand), null, 2));
else console.log(compareTable(base, cand, path.basename(a), path.basename(b)));
