"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../lib/length");
require("../lib/mass");
const { convert, list } = require("../lib/registry");

test("meters to feet", () => {
  assert.ok(Math.abs(convert("meters", "feet", 10) - 32.8084) < 1e-4);
});

test("round trips return the original value", () => {
  for (const [from, to] of [
    ["meters", "feet"],
    ["kilometers", "miles"],
    ["kilograms", "pounds"],
    ["grams", "ounces"],
  ]) {
    const back = convert(to, from, convert(from, to, 123.45));
    assert.ok(Math.abs(back - 123.45) < 1e-9, `${from} <-> ${to}`);
  }
});

test("unknown conversions throw", () => {
  assert.throws(() => convert("meters", "pounds", 1), /no conversion/);
});

test("list reports every registered pair", () => {
  const pairs = list().map(({ from, to }) => `${from}:${to}`);
  assert.ok(pairs.includes("meters:feet"));
  assert.ok(pairs.includes("ounces:grams"));
  assert.ok(pairs.length >= 8);
});
