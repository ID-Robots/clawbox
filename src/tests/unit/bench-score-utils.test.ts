/**
 * The bench's `node --test` check scores the agent's tests, not the event
 * loop they leave behind: a timer the code under test never stops must not
 * hold the check to its limit and turn passing tests into a timeout, and a
 * check that does reach the limit says so instead of "pass=-1 fail=-1".
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { nodeTest } from "../../../bench/lib/score-utils.mjs";

const roots: string[] = [];

/** A workdir whose module starts a refresh loop at import and never stops it. */
function workdirWithTicker(testBody: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-node-test-"));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "total.js"), [
    "setInterval(() => {}, 1000);",
    "module.exports.total = (items) => items.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2);",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "test", "total.test.js"), [
    'const test = require("node:test");',
    'const assert = require("node:assert");',
    'const { total } = require("../total.js");',
    testBody,
    "",
  ].join("\n"));
  return dir;
}

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe("nodeTest", () => {
  it("returns as soon as the tests settle, though the code under test leaves a timer running", async () => {
    const dir = workdirWithTicker(
      'test("total is to 2 dp", () => { assert.strictEqual(total([{ price: 1.25, qty: 3 }]), "3.75"); });',
    );
    const started = Date.now();
    const res = await nodeTest(dir, { timeoutMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res).toMatchObject({ passCount: 1, failCount: 0 });
    expect(res.check).toMatchObject({ name: "node --test passes", pass: true, detail: "pass=1 fail=0" });
  }, 30_000);

  it("still reports a failing test as failed, promptly", async () => {
    const dir = workdirWithTicker(
      'test("total is to 2 dp", () => { assert.strictEqual(total([{ price: 1.25, qty: 3 }]), "3.70"); });',
    );
    const started = Date.now();
    const res = await nodeTest(dir, { timeoutMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(res).toMatchObject({ passCount: 0, failCount: 1 });
    expect(res.check).toMatchObject({ pass: false, detail: "pass=0 fail=1" });
  }, 30_000);

  it("names the limit when a test never settles, instead of bare -1 counts", async () => {
    const dir = workdirWithTicker('test("waits forever", () => new Promise(() => {}));');
    const res = await nodeTest(dir, { timeoutMs: 2_000 });
    expect(res.check.pass).toBe(false);
    expect(res.check.detail).toMatch(/^timed out after 2 s \(pass=-?\d+ fail=-?\d+\)$/);
  }, 30_000);
});
