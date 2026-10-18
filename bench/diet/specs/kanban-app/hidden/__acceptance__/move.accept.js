const test = require("node:test");
const assert = require("node:assert/strict");
const { world, card, titlesIn, expectError } = require("./helpers");

async function seedTodo(w, titles) {
  const out = {};
  for (const t of titles) out[t] = await card(w.owner.api, w.todo.id, t);
  return out;
}

test("move to another column at an index closes and opens gaps", async () => {
  const w = await world();
  const c = await seedTodo(w, ["A", "B", "C"]);
  await card(w.owner.api, w.doing.id, "X");
  await card(w.owner.api, w.doing.id, "Y");
  const res = await w.member.api.post(`/api/cards/${c.B.id}/move`, { columnId: w.doing.id, position: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.id, res.body.columnId, res.body.position, res.body.boardId], [c.B.id, w.doing.id, 1, w.board.id]);
  assert.deepEqual(await titlesIn(w.owner.api, w.board.id, w.todo.id), [["A", 0], ["C", 1]]);
  assert.deepEqual(await titlesIn(w.owner.api, w.board.id, w.doing.id), [["X", 0], ["B", 1], ["Y", 2]]);
});

test("move without a position goes to the end; past the end is the end", async () => {
  const w = await world();
  const c = await seedTodo(w, ["A", "B"]);
  await card(w.owner.api, w.done.id, "Z");
  const r1 = await w.owner.api.post(`/api/cards/${c.A.id}/move`, { columnId: w.done.id });
  assert.equal(r1.body.position, 1);
  const r2 = await w.owner.api.post(`/api/cards/${c.B.id}/move`, { columnId: w.done.id, position: 77 });
  assert.equal(r2.body.position, 2);
  assert.deepEqual(await titlesIn(w.owner.api, w.board.id, w.done.id), [["Z", 0], ["A", 1], ["B", 2]]);
  assert.deepEqual(await titlesIn(w.owner.api, w.board.id, w.todo.id), []);
});

test("moves within one column follow the spec examples", async () => {
  const w = await world();
  const c = await seedTodo(w, ["A", "B", "C"]);
  const r = await w.owner.api.post(`/api/cards/${c.A.id}/move`, { columnId: w.todo.id, position: 2 });
  assert.equal(r.body.position, 2);
  assert.deepEqual(await titlesIn(w.owner.api, w.board.id, w.todo.id), [["B", 0], ["C", 1], ["A", 2]]);
  const w2 = await world();
  const d = await seedTodo(w2, ["A", "B", "C"]);
  await w2.owner.api.post(`/api/cards/${d.C.id}/move`, { columnId: w2.todo.id, position: 0 });
  assert.deepEqual(await titlesIn(w2.owner.api, w2.board.id, w2.todo.id), [["C", 0], ["A", 1], ["B", 2]]);
  await w2.owner.api.post(`/api/cards/${d.A.id}/move`, { columnId: w2.todo.id, position: 9 });
  assert.deepEqual(await titlesIn(w2.owner.api, w2.board.id, w2.todo.id), [["C", 0], ["B", 1], ["A", 2]]);
});

test("a card cannot move to a column of another board or a missing column", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, "pinned");
  const other = await w.owner.api.post("/api/boards", { name: "Other" });
  const otherCol = (await w.owner.api.get(`/api/boards/${other.body.id}`)).body.columns[0];
  expectError(await w.owner.api.post(`/api/cards/${c.id}/move`, { columnId: otherCol.id }), 400, "validation_error", "columnId");
  expectError(await w.owner.api.post(`/api/cards/${c.id}/move`, { columnId: 999999 }), 400, "validation_error", "columnId");
  expectError(await w.owner.api.post(`/api/cards/${c.id}/move`, {}), 400, "validation_error", "columnId");
  expectError(await w.owner.api.post(`/api/cards/${c.id}/move`, { columnId: String(w.done.id) }), 400, "validation_error", "columnId");
  const still = await w.owner.api.get(`/api/cards/${c.id}`);
  assert.deepEqual([still.body.columnId, still.body.position], [w.todo.id, 0]);
});

test("move position must be an integer >= 0; outsiders get 403", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, "m");
  for (const position of [-1, 0.5, "0"]) {
    expectError(await w.owner.api.post(`/api/cards/${c.id}/move`, { columnId: w.doing.id, position }), 400, "validation_error", "position");
  }
  expectError(await w.outsider.api.post(`/api/cards/${c.id}/move`, { columnId: w.doing.id }), 403, "forbidden");
  expectError(await w.owner.api.post(`/api/cards/${c.id + 999}/move`, { columnId: w.doing.id }), 404, "not_found");
});

test("positions stay contiguous through a long sequence of moves", async () => {
  const w = await world();
  const titles = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const c = await seedTodo(w, titles);
  const cols = [w.todo.id, w.doing.id, w.done.id];
  let k = 7;
  for (let i = 0; i < 30; i++) {
    k = (k * 31 + 11) % 97;
    const t = titles[k % titles.length];
    await w.owner.api.post(`/api/cards/${c[t].id}/move`, { columnId: cols[k % 3], position: k % 4 });
  }
  const board = await w.owner.api.get(`/api/boards/${w.board.id}`);
  let total = 0;
  for (const col of board.body.columns) {
    assert.deepEqual(col.cards.map((x) => x.position), col.cards.map((_, i) => i), `column ${col.name}`);
    for (const x of col.cards) assert.equal(x.columnId, col.id);
    total += col.cards.length;
  }
  assert.equal(total, titles.length);
});
