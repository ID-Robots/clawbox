#!/usr/bin/env node
// Per-file test durations, for the shard planner in
// src/tests/helpers/slow-first-sequencer.ts: reads vitest's default reporter
// output — the logs of a CI run's vitest shards, e.g.
//
//   gh run view <run id> --log | node scripts/vitest-durations.mjs > src/tests/helpers/test-durations.json
//
// — and prints a JSON object of path → seconds (one decimal) for every file
// that took at least MIN_S, sorted by path. Files below it are left out: the
// planner gives an unlisted file UNMEASURED_S, which is about what those take.
import { readFileSync } from "node:fs";

const MIN_S = 1;
const text = process.argv.length > 2
  ? process.argv.slice(2).map((f) => readFileSync(f, "utf8")).join("\n")
  : readFileSync(0, "utf8");
// "✓  unit  src/tests/unit/x.test.ts (12 tests) 1234ms" — a file's own line.
const FILE_LINE = /[✓×❯↓]\s+(?:unit|components)\s+(src\/\S+\.test\.tsx?)\s+\([^)]*\)\s+(\d+(?:\.\d+)?)(ms|s)\s*$/;
const seconds = new Map();
for (const raw of text.split("\n")) {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
  const m = FILE_LINE.exec(line);
  if (!m) continue;
  const s = Number(m[2]) / (m[3] === "ms" ? 1000 : 1);
  seconds.set(m[1], Math.max(seconds.get(m[1]) ?? 0, s));
}
const out = {};
for (const file of [...seconds.keys()].sort()) {
  const s = seconds.get(file);
  if (s >= MIN_S) out[file] = Math.round(s * 10) / 10;
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
