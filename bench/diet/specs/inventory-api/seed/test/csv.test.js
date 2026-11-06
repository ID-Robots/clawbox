const test = require("node:test");
const assert = require("node:assert");
const { request, make, KEY } = require("./helpers");

test("csv export quotes per RFC 4180", async () => {
  const app = make();
  await request(app).post("/items").set("x-api-key", KEY).send({ sku: "C1", name: 'Bolt, "hex" M6', price: 1.25, stock: 3 });
  await request(app).post("/items").set("x-api-key", KEY).send({ sku: "C2", name: "Plain", price: 2, stock: 0 });
  const r = await request(app).get("/items.csv");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/csv/);
  const lines = r.text.trim().split(/\r?\n/);
  assert.equal(lines[0], "id,sku,name,price,stock");
  assert.equal(lines[1], '1,C1,"Bolt, ""hex"" M6",1.25,3');
  assert.equal(lines[2], "2,C2,Plain,2,0");
});
