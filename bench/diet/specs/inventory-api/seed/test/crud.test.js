const test = require("node:test");
const assert = require("node:assert");
const { request, make, KEY } = require("./helpers");

test("create, read, update, delete", async () => {
  const app = make();
  const c = await request(app).post("/items").set("x-api-key", KEY).send({ sku: "A1", name: "Washer", price: 0.2, stock: 100 });
  assert.equal(c.status, 201);
  assert.deepEqual(Object.keys(c.body).sort(), ["id", "name", "price", "sku", "stock"]);
  const g = await request(app).get(`/items/${c.body.id}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.name, "Washer");
  const p = await request(app).patch(`/items/${c.body.id}`).set("x-api-key", KEY).send({ price: 0.25 });
  assert.equal(p.status, 200);
  assert.equal(p.body.price, 0.25);
  assert.equal(p.body.name, "Washer");
  const d = await request(app).delete(`/items/${c.body.id}`).set("x-api-key", KEY);
  assert.equal(d.status, 204);
  const g2 = await request(app).get(`/items/${c.body.id}`);
  assert.equal(g2.status, 404);
  assert.equal(typeof g2.body.error, "string");
});

test("validation", async () => {
  const app = make();
  const bad = [{ sku: "B", name: "", price: 1, stock: 1 }, { sku: "B", name: "x", price: -1, stock: 1 },
    { sku: "B", name: "x", price: "1", stock: 1 }, { sku: "B", name: "x", price: 1, stock: 1.5 }, { name: "x", price: 1, stock: 1 }];
  for (const body of bad) {
    const r = await request(app).post("/items").set("x-api-key", KEY).send(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.body.error, "string");
  }
  await request(app).post("/items").set("x-api-key", KEY).send({ sku: "DUP", name: "x", price: 1, stock: 1 });
  const dup = await request(app).post("/items").set("x-api-key", KEY).send({ sku: "DUP", name: "y", price: 1, stock: 1 });
  assert.equal(dup.status, 409);
  const p = await request(app).patch("/items/999").set("x-api-key", KEY).send({ price: 1 });
  assert.equal(p.status, 404);
});
