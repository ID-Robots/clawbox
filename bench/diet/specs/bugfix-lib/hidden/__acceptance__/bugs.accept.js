// Hidden acceptance tests: the three reported bugs, with inputs the visible tests do not use.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const kit = require(path.join(__dirname, "..", "src"));

const ids = (n) => Array.from({ length: n }, (_, i) => i + 1);

test("paginate: 1-based pages, no skipped first page, no empty last page", () => {
  assert.deepEqual(kit.paginate(ids(7), 1, 3).items, [1, 2, 3]);
  assert.deepEqual(kit.paginate(ids(7), 2, 3).items, [4, 5, 6]);
  assert.deepEqual(kit.paginate(ids(7), 3, 3).items, [7]);
  assert.deepEqual(kit.paginate(ids(6), 2, 3).items, [4, 5, 6]);
  assert.deepEqual(kit.paginate(ids(4), 1, 1).items, [1]);
  assert.deepEqual(kit.paginate(ids(2), 1, 5).items, [1, 2]);
  const clamped = kit.paginate(ids(7), 50, 3);
  assert.equal(clamped.page, 3);
  assert.deepEqual(clamped.items, [7]);
  assert.deepEqual(kit.paginate([], 1, 10).items, []);
  // every item appears exactly once across all pages
  const all = [];
  const { totalPages } = kit.paginate(ids(23), 1, 4);
  for (let p = 1; p <= totalPages; p++) all.push(...kit.paginate(ids(23), p, 4).items);
  assert.deepEqual(all, ids(23));
});

test("money: amounts convert to the exact cent", () => {
  const cases = [["4.35", 435], [1.15, 115], ["0.29", 29], [8.2, 820], ["$2,049.10", 204910], [0.57, 57], ["10.00", 1000], [3, 300]];
  for (const [input, cents] of cases) assert.equal(kit.toCents(input), cents, `toCents(${JSON.stringify(input)})`);
  assert.equal(kit.lineTotal("4.35", 3), 1305);
  assert.equal(kit.invoiceTotal([{ price: "4.35", qty: 3 }, { price: 1.15, qty: 2 }, { price: "0.29", qty: 10 }]), 1825);
  assert.equal(kit.formatCents(kit.toCents("1.13")), "$1.13");
  assert.throws(() => kit.toCents("twelve"), TypeError);
});

test("report: latestOrders does not mutate or reorder its input", () => {
  const orders = [
    { id: "a", customer: "x", totalCents: 1, placedAt: "2026-01-05T10:00:00Z" },
    { id: "b", customer: "y", totalCents: 2, placedAt: "2026-01-07T10:00:00Z" },
    { id: "c", customer: "x", totalCents: 3, placedAt: "2026-01-06T10:00:00Z" },
  ];
  const snapshot = JSON.stringify(orders);
  assert.deepEqual(kit.latestOrders(orders, 2).map((o) => o.id), ["b", "c"]);
  assert.equal(JSON.stringify(orders), snapshot);
  const frozen = Object.freeze(orders.map((o) => Object.freeze({ ...o })));
  assert.deepEqual(kit.latestOrders(frozen, 3).map((o) => o.id), ["b", "c", "a"]);
  assert.deepEqual(kit.latestOrders(frozen).map((o) => o.id), ["b", "c", "a"]);
  assert.deepEqual(kit.topCustomers(frozen, 1), [{ customer: "x", totalCents: 4 }]);
});
