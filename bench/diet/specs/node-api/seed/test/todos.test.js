const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { app } = require("../index");

test("GET /todos lists every todo", async () => {
  const res = await request(app).get("/todos");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.length, 2);
});
