// Hidden acceptance tests for GET /todos/:id and POST /todos.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const request = require("supertest");
const { app } = require(path.join(__dirname, "..", "index"));

test("GET /todos/:id returns the todo", async () => {
  const res = await request(app).get("/todos/2");
  assert.strictEqual(res.status, 200);
  assert.match(res.headers["content-type"], /json/);
  assert.strictEqual(res.body.id, 2);
  assert.strictEqual(res.body.title, "Write report");
});

test("GET /todos/:id answers 404 {error:'not found'} for unknown ids", async () => {
  for (const id of ["9999", "0"]) {
    const res = await request(app).get(`/todos/${id}`);
    assert.strictEqual(res.status, 404, id);
    assert.deepStrictEqual(res.body, { error: "not found" });
  }
});

test("POST /todos creates a todo (201) that GET can read back", async () => {
  const res = await request(app).post("/todos").send({ title: "Water plants" });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.title, "Water plants");
  assert.notStrictEqual(res.body.id, undefined);
  assert.ok(![1, 2].includes(res.body.id), "new id must not clash with existing todos");
  const back = await request(app).get(`/todos/${res.body.id}`);
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.body.title, "Water plants");
  const list = await request(app).get("/todos");
  assert.ok(list.body.some((t) => t.id === res.body.id));
});

test("POST /todos rejects a missing, empty or non-string title with 400", async () => {
  const before = (await request(app).get("/todos")).body.length;
  for (const body of [{}, { title: "" }, { title: 42 }, { title: null }, { title: ["a"] }]) {
    const res = await request(app).post("/todos").send(body);
    assert.strictEqual(res.status, 400, JSON.stringify(body));
  }
  const after = (await request(app).get("/todos")).body.length;
  assert.strictEqual(after, before, "rejected requests must not create todos");
});
