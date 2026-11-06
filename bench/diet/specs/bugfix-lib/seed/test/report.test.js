const test = require("node:test");
const assert = require("node:assert/strict");
const { latestOrders, topCustomers } = require("../src");

const orders = () => [
  { id: 1, customer: "ana", totalCents: 1200, placedAt: "2026-03-01T09:00:00Z" },
  { id: 2, customer: "bo", totalCents: 5000, placedAt: "2026-03-03T12:30:00Z" },
  { id: 3, customer: "ana", totalCents: 4100, placedAt: "2026-03-02T08:15:00Z" },
  { id: 4, customer: "cy", totalCents: 700, placedAt: "2026-03-04T17:45:00Z" },
];

test("latest orders, newest first", () => {
  assert.deepEqual(latestOrders(orders(), 2).map((o) => o.id), [4, 2]);
});

test("latest orders leaves the caller's list alone", () => {
  const list = orders();
  latestOrders(list, 2);
  assert.deepEqual(list.map((o) => o.id), [1, 2, 3, 4]);
});

test("top customers by spend", () => {
  assert.deepEqual(topCustomers(orders(), 2), [
    { customer: "ana", totalCents: 5300 },
    { customer: "bo", totalCents: 5000 },
  ]);
});
