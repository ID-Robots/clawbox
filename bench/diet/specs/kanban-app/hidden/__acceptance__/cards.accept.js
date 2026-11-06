const test = require("node:test");
const assert = require("node:assert/strict");
const { world, card, titlesIn, expectError, ISO_RE, sleep } = require("./helpers");

const CARD_KEYS = ["assigneeId", "boardId", "columnId", "createdAt", "createdBy", "description", "dueDate", "id", "labels", "position", "title", "updatedAt"];

test("creating a card returns the full card with defaults", async () => {
  const w = await world();
  const res = await w.member.api.post(`/api/columns/${w.todo.id}/cards`, { title: "  Write docs  " });
  assert.equal(res.status, 201);
  const c = res.body;
  assert.deepEqual(Object.keys(c).sort(), CARD_KEYS);
  assert.deepEqual(
    [c.title, c.description, c.labels, c.dueDate, c.assigneeId, c.position, c.boardId, c.columnId, c.createdBy],
    ["Write docs", "", [], null, null, 0, w.board.id, w.todo.id, w.member.user.id]);
  assert.match(c.createdAt, ISO_RE);
  assert.match(c.updatedAt, ISO_RE);
  const got = await w.owner.api.get(`/api/cards/${c.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, c);
});

test("all card fields on create", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.doing.id, {
    title: "Ship", description: "  keep my spaces  ", labels: ["Backend"], dueDate: "2026-12-31", assigneeId: w.member.user.id,
  });
  assert.deepEqual([c.description, c.labels, c.dueDate, c.assigneeId], ["  keep my spaces  ", ["backend"], "2026-12-31", w.member.user.id]);
});

test("labels are trimmed, lower-cased and de-duplicated keeping the first", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, { title: "L", labels: [" Bug ", "ui", "BUG", "Ui ", "infra"] });
  assert.deepEqual(c.labels, ["bug", "ui", "infra"]);
  const twelve = Array.from({ length: 12 }, (_, i) => `L${i % 10}`);
  const ok = await card(w.owner.api, w.todo.id, { title: "ten", labels: twelve });
  assert.equal(ok.labels.length, 10, "duplicates are dropped before the limit is applied");
});

test("label validation", async () => {
  const w = await world();
  const url = `/api/columns/${w.todo.id}/cards`;
  const bad = ["bug", { a: 1 }, [1], ["  "], ["x".repeat(31)], Array.from({ length: 11 }, (_, i) => `l${i}`)];
  for (const labels of bad) expectError(await w.owner.api.post(url, { title: "t", labels }), 400, "validation_error", "labels");
  assert.equal((await w.owner.api.post(url, { title: "t", labels: ["x".repeat(30)] })).status, 201);
});

test("dueDate must be a real YYYY-MM-DD date or null", async () => {
  const w = await world();
  const url = `/api/columns/${w.todo.id}/cards`;
  for (const dueDate of ["2026-02-30", "2026-13-01", "2026-2-3", "26-02-03", "2026-02-03T00:00:00Z", 20260203, ""]) {
    expectError(await w.owner.api.post(url, { title: "t", dueDate }), 400, "validation_error", "dueDate");
  }
  assert.equal((await w.owner.api.post(url, { title: "leap", dueDate: "2028-02-29" })).body.dueDate, "2028-02-29");
  assert.equal((await w.owner.api.post(url, { title: "none", dueDate: null })).body.dueDate, null);
});

test("assigneeId must be a board member or null", async () => {
  const w = await world();
  const url = `/api/columns/${w.todo.id}/cards`;
  for (const assigneeId of [w.outsider.user.id, 999999, String(w.member.user.id), 1.5, true]) {
    expectError(await w.owner.api.post(url, { title: "t", assigneeId }), 400, "validation_error", "assigneeId");
  }
  assert.equal((await w.owner.api.post(url, { title: "t", assigneeId: null })).body.assigneeId, null);
});

test("title and description validation", async () => {
  const w = await world();
  const url = `/api/columns/${w.todo.id}/cards`;
  for (const body of [{}, { title: "" }, { title: "   " }, { title: "x".repeat(201) }, { title: 7 }]) {
    expectError(await w.owner.api.post(url, body), 400, "validation_error", "title");
  }
  expectError(await w.owner.api.post(url, { title: "t", description: "x".repeat(5001) }), 400, "validation_error", "description");
  expectError(await w.owner.api.post(url, { title: "t", description: 12 }), 400, "validation_error", "description");
  assert.equal((await w.owner.api.post(url, { title: "x".repeat(200), description: "y".repeat(5000) })).status, 201);
});

test("card position on create: default end, explicit index shifts, past the end appends", async () => {
  const w = await world();
  await card(w.owner.api, w.todo.id, "A");
  await card(w.owner.api, w.todo.id, "B");
  const top = await card(w.owner.api, w.todo.id, { title: "Top", position: 0 });
  assert.equal(top.position, 0);
  const mid = await card(w.owner.api, w.todo.id, { title: "Mid", position: 2 });
  assert.equal(mid.position, 2);
  const end = await card(w.owner.api, w.todo.id, { title: "End", position: 40 });
  assert.equal(end.position, 4);
  assert.deepEqual(await titlesIn(w.owner.api, w.board.id, w.todo.id), [["Top", 0], ["A", 1], ["Mid", 2], ["B", 3], ["End", 4]]);
  expectError(await w.owner.api.post(`/api/columns/${w.todo.id}/cards`, { title: "x", position: -1 }), 400, "validation_error", "position");
});

test("GET card: member 200, outsider 403, unknown 404; unknown column 404", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, "secret");
  assert.equal((await w.member.api.get(`/api/cards/${c.id}`)).status, 200);
  expectError(await w.outsider.api.get(`/api/cards/${c.id}`), 403, "forbidden");
  expectError(await w.owner.api.get(`/api/cards/${c.id + 1000}`), 404, "not_found");
  expectError(await w.owner.api.post("/api/columns/99999/cards", { title: "x" }), 404, "not_found");
});

test("PATCH card updates fields and updatedAt, keeps the rest", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, { title: "Old", labels: ["a"] });
  await sleep(10);
  const res = await w.member.api.patch(`/api/cards/${c.id}`, { title: " New ", dueDate: "2027-01-15", assigneeId: w.member.user.id });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.title, res.body.dueDate, res.body.assigneeId, res.body.labels], ["New", "2027-01-15", w.member.user.id, ["a"]]);
  assert.equal(res.body.createdAt, c.createdAt);
  assert.notEqual(res.body.updatedAt, c.updatedAt);
  assert.ok(Date.parse(res.body.updatedAt) > Date.parse(c.updatedAt));
  const cleared = await w.member.api.patch(`/api/cards/${c.id}`, { dueDate: null, assigneeId: null, labels: [] });
  assert.deepEqual([cleared.body.dueDate, cleared.body.assigneeId, cleared.body.labels], [null, null, []]);
  expectError(await w.member.api.patch(`/api/cards/${c.id}`, { title: "" }), 400, "validation_error", "title");
  expectError(await w.member.api.patch(`/api/cards/${c.id}`, { assigneeId: w.outsider.user.id }), 400, "validation_error", "assigneeId");
  expectError(await w.outsider.api.patch(`/api/cards/${c.id}`, { title: "x" }), 403, "forbidden");
});

test("PATCH card refuses columnId and position (use move)", async () => {
  const w = await world();
  const c = await card(w.owner.api, w.todo.id, "stay");
  expectError(await w.owner.api.patch(`/api/cards/${c.id}`, { columnId: w.done.id }), 400, "validation_error", "columnId");
  expectError(await w.owner.api.patch(`/api/cards/${c.id}`, { title: "t", position: 0 }), 400, "validation_error", "position");
  const still = await w.owner.api.get(`/api/cards/${c.id}`);
  assert.deepEqual([still.body.title, still.body.columnId], ["stay", w.todo.id]);
});

test("DELETE card closes the gap and removes its comments", async () => {
  const w = await world();
  await card(w.owner.api, w.todo.id, "A");
  const b = await card(w.owner.api, w.todo.id, "B");
  await card(w.owner.api, w.todo.id, "C");
  await w.owner.api.post(`/api/cards/${b.id}/comments`, { body: "note" });
  expectError(await w.outsider.api.del(`/api/cards/${b.id}`), 403, "forbidden");
  assert.equal((await w.member.api.del(`/api/cards/${b.id}`)).status, 204);
  assert.deepEqual(await titlesIn(w.owner.api, w.board.id, w.todo.id), [["A", 0], ["C", 1]]);
  expectError(await w.owner.api.get(`/api/cards/${b.id}`), 404, "not_found");
  expectError(await w.owner.api.get(`/api/cards/${b.id}/comments`), 404, "not_found");
});

test("ids are never reused after deletes", async () => {
  const w = await world();
  const a = await card(w.owner.api, w.todo.id, "A");
  await w.owner.api.del(`/api/cards/${a.id}`);
  const b = await card(w.owner.api, w.todo.id, "B");
  assert.ok(b.id > a.id);
  const col = await w.owner.api.post(`/api/boards/${w.board.id}/columns`, { name: "tmp" });
  await w.owner.api.del(`/api/columns/${col.body.id}`);
  const col2 = await w.owner.api.post(`/api/boards/${w.board.id}/columns`, { name: "tmp2" });
  assert.ok(col2.body.id > col.body.id);
});
