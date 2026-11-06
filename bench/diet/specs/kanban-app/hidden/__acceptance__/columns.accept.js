const test = require("node:test");
const assert = require("node:assert/strict");
const { world, card, expectError } = require("./helpers");

async function columnNames(api, boardId) {
  const res = await api.get(`/api/boards/${boardId}`);
  return res.body.columns.map((c) => [c.name, c.position]);
}

test("a new column goes to the end by default", async () => {
  const w = await world();
  const res = await w.member.api.post(`/api/boards/${w.board.id}/columns`, { name: " Review " });
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ["boardId", "id", "name", "position"]);
  assert.deepEqual([res.body.name, res.body.position, res.body.boardId], ["Review", 3, w.board.id]);
  assert.deepEqual(await columnNames(w.owner.api, w.board.id), [["To do", 0], ["Doing", 1], ["Done", 2], ["Review", 3]]);
});

test("inserting a column at a position shifts the others; past the end means the end", async () => {
  const w = await world();
  const first = await w.owner.api.post(`/api/boards/${w.board.id}/columns`, { name: "Backlog", position: 0 });
  assert.equal(first.body.position, 0);
  const mid = await w.owner.api.post(`/api/boards/${w.board.id}/columns`, { name: "QA", position: 3 });
  assert.equal(mid.body.position, 3);
  const far = await w.owner.api.post(`/api/boards/${w.board.id}/columns`, { name: "Archive", position: 99 });
  assert.equal(far.body.position, 5);
  assert.deepEqual(await columnNames(w.owner.api, w.board.id),
    [["Backlog", 0], ["To do", 1], ["Doing", 2], ["QA", 3], ["Done", 4], ["Archive", 5]]);
});

test("column validation", async () => {
  const w = await world();
  const url = `/api/boards/${w.board.id}/columns`;
  for (const body of [{}, { name: "" }, { name: "  " }, { name: "x".repeat(51) }, { name: 3 }]) {
    expectError(await w.owner.api.post(url, body), 400, "validation_error", "name");
  }
  for (const position of [-1, 1.5, "1"]) {
    expectError(await w.owner.api.post(url, { name: "ok", position }), 400, "validation_error", "position");
  }
  expectError(await w.owner.api.patch(`/api/columns/${w.todo.id}`, { name: "" }), 400, "validation_error", "name");
  expectError(await w.owner.api.patch(`/api/columns/${w.todo.id}`, { position: -2 }), 400, "validation_error", "position");
});

test("PATCH column renames and reorders, keeping positions contiguous", async () => {
  const w = await world();
  const res = await w.member.api.patch(`/api/columns/${w.done.id}`, { name: "Shipped", position: 0 });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.id, res.body.name, res.body.position], [w.done.id, "Shipped", 0]);
  assert.deepEqual(await columnNames(w.owner.api, w.board.id), [["Shipped", 0], ["To do", 1], ["Doing", 2]]);
  const back = await w.member.api.patch(`/api/columns/${w.done.id}`, { position: 50 });
  assert.equal(back.body.position, 2);
  assert.deepEqual(await columnNames(w.owner.api, w.board.id), [["To do", 0], ["Doing", 1], ["Shipped", 2]]);
});

test("DELETE column: 409 while it has cards, 204 when empty, positions closed up", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, "blocker");
  expectError(await w.owner.api.del(`/api/columns/${w.todo.id}`), 409, "conflict");
  assert.equal((await w.owner.api.del(`/api/cards/${c.id}`)).status, 204);
  assert.equal((await w.owner.api.del(`/api/columns/${w.todo.id}`)).status, 204);
  assert.deepEqual(await columnNames(w.owner.api, w.board.id), [["Doing", 0], ["Done", 1]]);
  expectError(await w.owner.api.patch(`/api/columns/${w.todo.id}`, { name: "x" }), 404, "not_found");
});

test("outsiders cannot touch columns", async () => {
  const w = await world();
  expectError(await w.outsider.api.patch(`/api/columns/${w.todo.id}`, { name: "hack" }), 403, "forbidden");
  expectError(await w.outsider.api.del(`/api/columns/${w.doing.id}`), 403, "forbidden");
  expectError(await w.outsider.api.post(`/api/columns/${w.todo.id}/cards`, { title: "x" }), 403, "forbidden");
});
