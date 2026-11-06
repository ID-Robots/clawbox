/**
 * The bench's `node --test` check counts every test the code registers, as
 * node itself does: a failing test registered after an await is a failure,
 * never dropped into a pass by exiting early. A run that does not end — a
 * timer the code under test never stops — says it timed out instead of
 * "pass=-1 fail=-1". And it reads those counts whatever node's default
 * reporter is: spec, with no `# pass N` line, from node 23 on.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { nodeTest } from "../../../bench/lib/score-utils.mjs";

// Starts real processes (node): vitest's 5 s test default is not enough. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const roots: string[] = [];

/** A workdir with total.js (optionally starting a refresh loop at import) and one test file. */
function workdir({ ticker, testFile, testBody }: { ticker: boolean; testFile: string; testBody: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-node-test-"));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "total.js"), [
    ticker ? "setInterval(() => {}, 1000);" : "",
    "module.exports.total = (items) => items.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2);",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "test", testFile), testBody);
  return dir;
}

/**
 * A directory holding a `node` that runs the real one with the spec reporter
 * unless the caller names a reporter — node 23 and newer's own default, on
 * whichever node runs this suite.
 */
function specByDefaultNode(): string {
  const real = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-node-spec-"));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, "node"), [
    "#!/bin/sh",
    `case " $* " in *" --test-reporter"*) exec "${real}" "$@" ;; esac`,
    `exec "${real}" --test-reporter=spec "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe("nodeTest", () => {
  it("counts a failing test registered after an await, as node itself does", async () => {
    const dir = workdir({
      ticker: false,
      testFile: "total.test.mjs",
      testBody: [
        'import test from "node:test";',
        'import assert from "node:assert";',
        'import { createRequire } from "node:module";',
        'const { total } = createRequire(import.meta.url)("../total.js");',
        'test("total is to 2 dp", () => { assert.strictEqual(total([{ price: 1.25, qty: 3 }]), "3.75"); });',
        "await new Promise((r) => setTimeout(r, 300));",
        'test("registered after the await", () => { assert.strictEqual(total([]), "1.00"); });',
        "",
      ].join("\n"),
    });
    const res = await nodeTest(dir, { timeoutMs: 20_000 });
    expect(res).toMatchObject({ passCount: 1, failCount: 1 });
    expect(res.check).toMatchObject({ name: "node --test passes", pass: false, detail: "pass=1 fail=1" });
  }, 30_000);

  it("passes and fails on node's own counts when the run ends by itself", async () => {
    const pass = await nodeTest(workdir({
      ticker: false,
      testFile: "total.test.js",
      testBody: 'const test = require("node:test"); const assert = require("node:assert"); const { total } = require("../total.js");\n'
        + 'test("total", () => { assert.strictEqual(total([{ price: 1.25, qty: 3 }]), "3.75"); });\n',
    }), { timeoutMs: 20_000 });
    expect(pass.check).toMatchObject({ pass: true, detail: "pass=1 fail=0" });
    const fail = await nodeTest(workdir({
      ticker: false,
      testFile: "total.test.js",
      testBody: 'const test = require("node:test"); const assert = require("node:assert"); const { total } = require("../total.js");\n'
        + 'test("total", () => { assert.strictEqual(total([{ price: 1.25, qty: 3 }]), "3.70"); });\n',
    }), { timeoutMs: 20_000 });
    expect(fail.check).toMatchObject({ pass: false, detail: "pass=0 fail=1" });
  }, 30_000);

  it("reads node's counts when its default reporter is spec, as from node 23 on", async () => {
    const dir = workdir({
      ticker: false,
      testFile: "total.test.js",
      testBody: 'const test = require("node:test"); const assert = require("node:assert"); const { total } = require("../total.js");\n'
        + 'test("total", () => { assert.strictEqual(total([{ price: 1.25, qty: 3 }]), "3.75"); });\n'
        + 'test("empty cart", () => { assert.strictEqual(total([]), "1.00"); });\n',
    });
    vi.stubEnv("NODE_OPTIONS", undefined);
    vi.stubEnv("PATH", `${specByDefaultNode()}${path.delimiter}${process.env.PATH}`);
    // The `node` on PATH now prints spec when asked for nothing, with no `# pass N` line to count.
    const bare = spawnSync("node", ["--test"], { cwd: dir, encoding: "utf8" });
    expect(`${bare.stdout}${bare.stderr}`).not.toMatch(/^# pass \d+$/m);
    const res = await nodeTest(dir, { timeoutMs: 20_000 });
    expect(res).toMatchObject({ passCount: 1, failCount: 1 });
    expect(res.check).toMatchObject({ pass: false, detail: "pass=1 fail=1" });
  }, 30_000);

  it("names the limit when a timer the code never stops keeps the run from ending", async () => {
    const dir = workdir({
      ticker: true,
      testFile: "total.test.js",
      testBody: 'const test = require("node:test"); const assert = require("node:assert"); const { total } = require("../total.js");\n'
        + 'test("total", () => { assert.strictEqual(total([{ price: 1.25, qty: 3 }]), "3.75"); });\n',
    });
    const res = await nodeTest(dir, { timeoutMs: 2_000 });
    expect(res.check.pass).toBe(false);
    expect(res.check.detail).toMatch(/^timed out after 2 s \(pass=-?\d+ fail=-?\d+\)$/);
  }, 30_000);
});
