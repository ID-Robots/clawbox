const test = require("node:test");
const assert = require("node:assert");
const { request, make, seed } = require("./helpers");

test("pagination, search and sort", async () => {
  const app = make();
  await seed(app, 25);
  const a = await request(app).get("/items");
  assert.equal(a.status, 200);
  assert.equal(a.body.total, 25);
  assert.equal(a.body.limit, 10);
  assert.equal(a.body.page, 1);
  assert.equal(a.body.items.length, 10);
  const p3 = await request(app).get("/items?page=3&limit=10");
  assert.equal(p3.body.items.length, 5);
  const big = await request(app).get("/items?limit=500");
  assert.equal(big.body.limit, 50);
  const q = await request(app).get("/items?q=nut&limit=50");
  assert.equal(q.body.total, 12);
  assert.ok(q.body.items.every((i) => i.name.startsWith("Nut")));
  const sku = await request(app).get("/items?q=sku-02");
  assert.equal(sku.body.total, 6);
  const s = await request(app).get("/items?sort=-price&limit=3");
  assert.deepEqual(s.body.items.map((i) => i.price), [37.5, 36, 34.5]);
  const bad = await request(app).get("/items?sort=colour");
  assert.equal(bad.status, 400);
});
