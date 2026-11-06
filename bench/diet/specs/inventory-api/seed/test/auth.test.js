const test = require("node:test");
const assert = require("node:assert");
const { request, make } = require("./helpers");

test("writes need a valid api key, reads do not", async () => {
  const app = make();
  const body = { sku: "Z", name: "z", price: 1, stock: 1 };
  assert.equal((await request(app).post("/items").send(body)).status, 401);
  assert.equal((await request(app).post("/items").set("x-api-key", "nope").send(body)).status, 401);
  const ok = await request(app).post("/items").set("x-api-key", "k2").send(body);
  assert.equal(ok.status, 201);
  assert.equal((await request(app).patch(`/items/${ok.body.id}`).send({ price: 2 })).status, 401);
  assert.equal((await request(app).delete(`/items/${ok.body.id}`)).status, 401);
  assert.equal((await request(app).get(`/items/${ok.body.id}`)).status, 200);
});
