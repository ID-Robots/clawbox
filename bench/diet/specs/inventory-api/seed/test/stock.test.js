const test = require("node:test");
const assert = require("node:assert");
const { request, make, KEY } = require("./helpers");

test("stock movements and history", async () => {
  const app = make();
  const c = await request(app).post("/items").set("x-api-key", KEY).send({ sku: "S1", name: "Spring", price: 0.5, stock: 10 });
  const id = c.body.id;
  const m1 = await request(app).post(`/items/${id}/stock`).set("x-api-key", KEY).send({ delta: -4, reason: "sale" });
  assert.equal(m1.status, 200);
  assert.equal(m1.body.stock, 6);
  const m2 = await request(app).post(`/items/${id}/stock`).set("x-api-key", KEY).send({ delta: 5, reason: "restock" });
  assert.equal(m2.body.stock, 11);
  const neg = await request(app).post(`/items/${id}/stock`).set("x-api-key", KEY).send({ delta: -12, reason: "sale" });
  assert.equal(neg.status, 409);
  const frac = await request(app).post(`/items/${id}/stock`).set("x-api-key", KEY).send({ delta: 0.5, reason: "x" });
  assert.equal(frac.status, 400);
  assert.equal((await request(app).post(`/items/${id}/stock`).send({ delta: 1, reason: "x" })).status, 401);
  const h = await request(app).get(`/items/${id}/history`);
  assert.equal(h.status, 200);
  assert.deepEqual(h.body.map((e) => [e.delta, e.reason, e.stockAfter]), [[-4, "sale", 6], [5, "restock", 11]]);
  assert.ok(h.body.every((e) => typeof e.at === "string" && !Number.isNaN(Date.parse(e.at))));
  assert.equal((await request(app).get("/items/999/history")).status, 404);
});
