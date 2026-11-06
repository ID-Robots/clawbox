const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, signup, world, card, expectError, ISO_RE, sleep } = require("./helpers");

test("creating a board makes the caller owner and only member, with three default columns", async () => {
  const app = createApp();
  const { api, user } = await signup(app);
  const res = await api.post("/api/boards", { name: "  Launch  " });
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ["createdAt", "id", "memberIds", "name", "ownerId", "updatedAt"]);
  assert.equal(res.body.name, "Launch");
  assert.equal(res.body.ownerId, user.id);
  assert.deepEqual(res.body.memberIds, [user.id]);
  assert.match(res.body.createdAt, ISO_RE);
  const detail = await api.get(`/api/boards/${res.body.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.columns.map((c) => [c.name, c.position, c.boardId]),
    [["To do", 0, res.body.id], ["Doing", 1, res.body.id], ["Done", 2, res.body.id]]);
  for (const c of detail.body.columns) {
    assert.deepEqual(Object.keys(c).sort(), ["boardId", "cards", "id", "name", "position"]);
    assert.deepEqual(c.cards, []);
  }
});

test("board name validation", async () => {
  const app = createApp();
  const { api } = await signup(app);
  for (const body of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(101) }, { name: 5 }]) {
    expectError(await api.post("/api/boards", body), 400, "validation_error", "name");
  }
});

test("GET /api/boards lists only the caller's boards, by id, paginated", async () => {
  const app = createApp();
  const a = await signup(app, "A");
  const b = await signup(app, "B");
  const a1 = (await a.api.post("/api/boards", { name: "a1" })).body;
  await b.api.post("/api/boards", { name: "b1" });
  const a2 = (await a.api.post("/api/boards", { name: "a2" })).body;
  const list = await a.api.get("/api/boards");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map((x) => x.id), [a1.id, a2.id]);
  assert.equal(list.body.total, 2);
  const p2 = await a.api.get("/api/boards?limit=1&page=2");
  assert.deepEqual(p2.body.items.map((x) => x.name), ["a2"]);
  assert.equal(p2.body.total, 2);
});

test("non-members get 403 on a board; unknown board is 404", async () => {
  const w = await world();
  expectError(await w.outsider.api.get(`/api/boards/${w.board.id}`), 403, "forbidden");
  expectError(await w.outsider.api.get(`/api/boards/${w.board.id}/activity`), 403, "forbidden");
  expectError(await w.outsider.api.get(`/api/boards/${w.board.id}/cards`), 403, "forbidden");
  expectError(await w.outsider.api.post(`/api/boards/${w.board.id}/columns`, { name: "x" }), 403, "forbidden");
  expectError(await w.outsider.api.get(`/api/boards/${w.board.id + 1000}`), 404, "not_found");
  assert.equal((await w.member.api.get(`/api/boards/${w.board.id}`)).status, 200);
});

test("PATCH board renames (owner only) and moves updatedAt", async () => {
  const w = await world();
  await sleep(5);
  const res = await w.owner.api.patch(`/api/boards/${w.board.id}`, { name: " Q4 plan " });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, "Q4 plan");
  assert.notEqual(res.body.updatedAt, w.board.updatedAt);
  assert.equal(res.body.createdAt, w.board.createdAt);
  expectError(await w.member.api.patch(`/api/boards/${w.board.id}`, { name: "mine" }), 403, "forbidden");
  expectError(await w.outsider.api.patch(`/api/boards/${w.board.id}`, { name: "mine" }), 403, "forbidden");
  expectError(await w.owner.api.patch(`/api/boards/${w.board.id}`, { name: "" }), 400, "validation_error", "name");
});

test("DELETE board is owner-only and removes everything on it", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, "doomed");
  const cm = await w.owner.api.post(`/api/cards/${c.id}/comments`, { body: "bye" });
  expectError(await w.member.api.del(`/api/boards/${w.board.id}`), 403, "forbidden");
  const del = await w.owner.api.del(`/api/boards/${w.board.id}`);
  assert.equal(del.status, 204);
  expectError(await w.owner.api.get(`/api/boards/${w.board.id}`), 404, "not_found");
  expectError(await w.owner.api.get(`/api/cards/${c.id}`), 404, "not_found");
  expectError(await w.owner.api.patch(`/api/columns/${w.todo.id}`, { name: "x" }), 404, "not_found");
  expectError(await w.owner.api.del(`/api/comments/${cm.body.id}`), 404, "not_found");
  assert.equal((await w.owner.api.get("/api/boards")).body.total, 0);
});

test("adding a member", async () => {
  const w = await world();
  const extra = await signup(w.app, "Zed");
  const res = await w.owner.api.post(`/api/boards/${w.board.id}/members`, { userId: extra.user.id });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.memberIds, [w.owner.user.id, w.member.user.id, extra.user.id].sort((a, b) => a - b));
  assert.equal((await extra.api.get(`/api/boards/${w.board.id}`)).status, 200);
  assert.equal((await extra.api.get("/api/boards")).body.total, 1);
});

test("member errors: bad userId 400, unknown user 404, already member 409, non-owner 403", async () => {
  const w = await world();
  const extra = await signup(w.app, "Yan");
  const url = `/api/boards/${w.board.id}/members`;
  expectError(await w.owner.api.post(url, { userId: String(extra.user.id) }), 400, "validation_error", "userId");
  expectError(await w.owner.api.post(url, {}), 400, "validation_error", "userId");
  expectError(await w.owner.api.post(url, { userId: 987654 }), 404, "not_found");
  expectError(await w.owner.api.post(url, { userId: w.member.user.id }), 409, "conflict");
  expectError(await w.member.api.post(url, { userId: extra.user.id }), 403, "forbidden");
});

test("removing a member revokes access and unassigns their cards", async () => {
  const w = await world();
  const mine = await card(w.owner.api, w.todo.id, { title: "theirs", assigneeId: w.member.user.id });
  const other = await card(w.owner.api, w.todo.id, { title: "owner's", assigneeId: w.owner.user.id });
  const del = await w.owner.api.del(`/api/boards/${w.board.id}/members/${w.member.user.id}`);
  assert.equal(del.status, 204);
  expectError(await w.member.api.get(`/api/boards/${w.board.id}`), 403, "forbidden");
  assert.equal((await w.owner.api.get(`/api/cards/${mine.id}`)).body.assigneeId, null);
  assert.equal((await w.owner.api.get(`/api/cards/${other.id}`)).body.assigneeId, w.owner.user.id);
  const board = await w.owner.api.get(`/api/boards/${w.board.id}`);
  assert.deepEqual(board.body.memberIds, [w.owner.user.id]);
});

test("cannot remove the owner (409) or a non-member (404); non-owner cannot remove (403)", async () => {
  const w = await world();
  expectError(await w.owner.api.del(`/api/boards/${w.board.id}/members/${w.owner.user.id}`), 409, "conflict");
  expectError(await w.owner.api.del(`/api/boards/${w.board.id}/members/${w.outsider.user.id}`), 404, "not_found");
  expectError(await w.member.api.del(`/api/boards/${w.board.id}/members/${w.owner.user.id}`), 403, "forbidden");
});

test("board detail nests cards in position order inside their columns", async () => {
  const w = await world();
  await card(w.owner.api, w.todo.id, "t1");
  await card(w.owner.api, w.doing.id, "d1");
  await card(w.owner.api, w.todo.id, "t2");
  const res = await w.member.api.get(`/api/boards/${w.board.id}`);
  assert.deepEqual(res.body.memberIds, [w.owner.user.id, w.member.user.id].sort((a, b) => a - b));
  const [todo, doing, done] = res.body.columns;
  assert.deepEqual(todo.cards.map((c) => [c.title, c.position]), [["t1", 0], ["t2", 1]]);
  assert.deepEqual(doing.cards.map((c) => c.title), ["d1"]);
  assert.deepEqual(done.cards, []);
});
