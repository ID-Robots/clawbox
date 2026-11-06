const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { request, make, KEY } = require("./helpers");

test("items survive a restart through the data file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-"));
  const dataFile = path.join(dir, "items.json");
  const a = make({ dataFile });
  const c = await request(a).post("/items").set("x-api-key", KEY).send({ sku: "P1", name: "Pin", price: 0.1, stock: 7 });
  assert.ok(fs.existsSync(dataFile));
  assert.deepEqual(fs.readdirSync(dir), ["items.json"], "no temp files left behind");
  const b = make({ dataFile });
  const g = await request(b).get(`/items/${c.body.id}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.sku, "P1");
  const n = await request(b).post("/items").set("x-api-key", KEY).send({ sku: "P2", name: "Pin 2", price: 0.1, stock: 1 });
  assert.notEqual(n.body.id, c.body.id, "ids continue after a reload");
});
