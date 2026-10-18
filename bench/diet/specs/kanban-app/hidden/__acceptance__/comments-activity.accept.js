const test = require("node:test");
const assert = require("node:assert/strict");
const { world, card, expectError, ISO_RE } = require("./helpers");

test("comments: create, trim, shape", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, "discuss");
  const res = await w.member.api.post(`/api/cards/${c.id}/comments`, { body: "  looks good  " });
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ["authorId", "body", "cardId", "createdAt", "id"]);
  assert.deepEqual([res.body.body, res.body.cardId, res.body.authorId], ["looks good", c.id, w.member.user.id]);
  assert.match(res.body.createdAt, ISO_RE);
  for (const body of [{}, { body: "" }, { body: "  " }, { body: "x".repeat(2001) }, { body: 1 }]) {
    expectError(await w.member.api.post(`/api/cards/${c.id}/comments`, body), 400, "validation_error", "body");
  }
  assert.equal((await w.member.api.post(`/api/cards/${c.id}/comments`, { body: "y".repeat(2000) })).status, 201);
});

test("comments list oldest first and paginate", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, "thread");
  for (const body of ["one", "two", "three"]) await w.owner.api.post(`/api/cards/${c.id}/comments`, { body });
  const all = await w.member.api.get(`/api/cards/${c.id}/comments`);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.items.map((x) => x.body), ["one", "two", "three"]);
  assert.equal(all.body.total, 3);
  const p = await w.member.api.get(`/api/cards/${c.id}/comments?limit=2&page=2`);
  assert.deepEqual(p.body.items.map((x) => x.body), ["three"]);
});

test("only the author deletes a comment; outsiders and unknown cards are refused", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, "x");
  const cm = (await w.member.api.post(`/api/cards/${c.id}/comments`, { body: "mine" })).body;
  expectError(await w.owner.api.del(`/api/comments/${cm.id}`), 403, "forbidden");
  expectError(await w.outsider.api.del(`/api/comments/${cm.id}`), 403, "forbidden");
  expectError(await w.outsider.api.post(`/api/cards/${c.id}/comments`, { body: "hi" }), 403, "forbidden");
  expectError(await w.outsider.api.get(`/api/cards/${c.id}/comments`), 403, "forbidden");
  expectError(await w.owner.api.post(`/api/cards/${c.id + 500}/comments`, { body: "hi" }), 404, "not_found");
  assert.equal((await w.member.api.del(`/api/comments/${cm.id}`)).status, 204);
  assert.equal((await w.owner.api.get(`/api/cards/${c.id}/comments`)).body.total, 0);
  expectError(await w.member.api.del(`/api/comments/${cm.id}`), 404, "not_found");
});

async function activity(w, qs = "") {
  const res = await w.owner.api.get(`/api/boards/${w.board.id}/activity${qs}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

test("activity: board.created and member.added first, newest first, exact shape", async () => {
  const w = await world();
  const log = await activity(w);
  assert.deepEqual(log.items.map((a) => a.type), ["member.added", "board.created"]);
  const [added, created] = log.items;
  assert.deepEqual(Object.keys(created).sort(), ["actorId", "boardId", "cardId", "createdAt", "data", "id", "type"]);
  assert.deepEqual([created.boardId, created.actorId, created.cardId, created.data], [w.board.id, w.owner.user.id, null, { name: "Roadmap" }]);
  assert.deepEqual(added.data, { userId: w.member.user.id });
  assert.ok(added.id > created.id);
  assert.match(created.createdAt, ISO_RE);
});

test("activity records card and comment events with cardId and the specified data", async () => {
  const w = await world();
  const c = await card(w.member.api, w.todo.id, { title: "Task" });
  await w.member.api.patch(`/api/cards/${c.id}`, { title: "Task 2", labels: ["x"], description: "d" });
  await card(w.owner.api, w.doing.id, "Other");
  await w.member.api.post(`/api/cards/${c.id}/move`, { columnId: w.doing.id, position: 0 });
  const cm = (await w.owner.api.post(`/api/cards/${c.id}/comments`, { body: "hi" })).body;
  await w.owner.api.del(`/api/comments/${cm.id}`);
  await w.owner.api.del(`/api/cards/${c.id}`);
  const log = (await activity(w, "?limit=100")).items;
  const mine = log.filter((a) => a.cardId === c.id);
  assert.deepEqual(mine.map((a) => a.type), ["card.deleted", "comment.deleted", "comment.created", "card.moved", "card.updated", "card.created"]);
  const by = Object.fromEntries(mine.map((a) => [a.type, a]));
  assert.deepEqual(by["card.created"].data, { title: "Task", columnId: w.todo.id });
  assert.equal(by["card.created"].actorId, w.member.user.id);
  assert.deepEqual(by["card.updated"].data, { fields: ["description", "labels", "title"] });
  assert.deepEqual(by["card.moved"].data, { fromColumnId: w.todo.id, toColumnId: w.doing.id, fromPosition: 0, toPosition: 0 });
  assert.deepEqual(by["comment.created"].data, { commentId: cm.id });
  assert.deepEqual(by["comment.deleted"].data, { commentId: cm.id });
  assert.deepEqual(by["card.deleted"].data, { title: "Task 2" });
  for (let i = 1; i < log.length; i++) assert.ok(log[i - 1].id > log[i].id, "newest first by id");
});

test("activity records column, board and member events", async () => {
  const w = await world();
  const col = (await w.owner.api.post(`/api/boards/${w.board.id}/columns`, { name: "Later" })).body;
  await w.owner.api.patch(`/api/columns/${col.id}`, { name: "Much later" });
  await w.owner.api.del(`/api/columns/${col.id}`);
  await w.owner.api.patch(`/api/boards/${w.board.id}`, { name: "Renamed" });
  await w.owner.api.del(`/api/boards/${w.board.id}/members/${w.member.user.id}`);
  const log = (await activity(w)).items;
  assert.deepEqual(log.map((a) => [a.type, a.data, a.cardId]), [
    ["member.removed", { userId: w.member.user.id }, null],
    ["board.updated", { name: "Renamed" }, null],
    ["column.deleted", { columnId: col.id }, null],
    ["column.updated", { columnId: col.id }, null],
    ["column.created", { columnId: col.id, name: "Later" }, null],
    ["member.added", { userId: w.member.user.id }, null],
    ["board.created", { name: "Roadmap" }, null],
  ]);
});

test("activity is paginated and members-only", async () => {
  const w = await world();
  for (let i = 0; i < 5; i++) await card(w.owner.api, w.todo.id, `c${i}`);
  const p = await activity(w, "?limit=3&page=1");
  assert.deepEqual([p.total, p.items.length, p.limit], [7, 3, 3]);
  assert.deepEqual(p.items.map((a) => a.data.title), ["c4", "c3", "c2"]);
  const last = await activity(w, "?limit=3&page=3");
  assert.deepEqual(last.items.map((a) => a.type), ["board.created"]);
  expectError(await w.outsider.api.get(`/api/boards/${w.board.id}/activity`), 403, "forbidden");
  expectError(await w.owner.api.get(`/api/boards/${w.board.id}/activity?page=0`), 400, "validation_error", "page");
});
