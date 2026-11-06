const test = require("node:test");
const assert = require("node:assert/strict");
const { toCents, formatCents, lineTotal, invoiceTotal } = require("../src");

test("parses whole and half amounts", () => {
  assert.equal(toCents(12), 1200);
  assert.equal(toCents("0.50"), 50);
  assert.equal(toCents("$1,299.00"), 129900);
});

test("parses prices with cents", () => {
  assert.equal(toCents("19.99"), 1999);
  assert.equal(toCents(0.07), 7);
});

test("formats cents", () => {
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(129905), "$1,299.05");
  assert.equal(formatCents(-250), "-$2.50");
});

test("invoice total", () => {
  assert.equal(lineTotal("2.50", 4), 1000);
  assert.equal(invoiceTotal([{ price: "19.99", qty: 2 }, { price: 5, qty: 1 }]), 4498);
});

test("rejects garbage", () => {
  assert.throws(() => toCents("abc"), TypeError);
  assert.throws(() => lineTotal(1, -1), RangeError);
});
