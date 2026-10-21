const test = require("node:test");
const assert = require("node:assert/strict");
const { paginate } = require("../src");

const ids = (n) => Array.from({ length: n }, (_, i) => i + 1);

test("counts pages", () => {
  assert.equal(paginate(ids(25), 1, 10).totalPages, 3);
  assert.equal(paginate(ids(20), 1, 10).totalPages, 2);
  assert.equal(paginate([], 1, 10).totalPages, 1);
});

test("first page holds the first items", () => {
  assert.deepEqual(paginate(ids(25), 1, 10).items, ids(10));
});

test("last page holds the remainder", () => {
  const last = paginate(ids(25), 3, 10);
  assert.equal(last.page, 3);
  assert.deepEqual(last.items, [21, 22, 23, 24, 25]);
});

test("clamps out-of-range pages", () => {
  assert.equal(paginate(ids(25), 0, 10).page, 1);
  assert.equal(paginate(ids(25), 99, 10).page, 3);
});

test("rejects a bad page size", () => {
  assert.throws(() => paginate(ids(3), 1, 0), RangeError);
});
