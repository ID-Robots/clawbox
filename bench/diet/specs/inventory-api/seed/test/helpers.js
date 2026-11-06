const request = require("supertest");
const { createApp } = require("../src/app");
const KEY = "k1";
function make(opts = {}) { return createApp({ apiKeys: [KEY, "k2"], ...opts }); }
async function seed(app, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const r = await request(app).post("/items").set("x-api-key", KEY)
      .send({ sku: `SKU-${String(i).padStart(3, "0")}`, name: i % 2 ? `Bolt ${i}` : `Nut ${i}`, price: i * 1.5, stock: i });
    out.push(r.body);
  }
  return out;
}
module.exports = { request, make, seed, KEY };
