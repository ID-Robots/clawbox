const test = require("node:test");
const assert = require("node:assert/strict");
const { world, card, expectError } = require("./helpers");

async function fixture() {
  const w = await world();
  const api = w.owner.api;
  const cards = {
    login: await card(api, w.todo.id, { title: "Fix LOGIN bug", labels: ["bug", "auth"], dueDate: "2026-11-01", assigneeId: w.member.user.id }),
    docs: await card(api, w.todo.id, { title: "Docs", description: "Explain the login flow", labels: ["docs"] }),
    perf: await card(api, w.doing.id, { title: "Speed up search", labels: ["Perf", "bug"], dueDate: "2026-10-15", assigneeId: w.owner.user.id }),
    late: await card(api, w.done.id, { title: "Release", dueDate: "2026-12-24" }),
    first: await card(api, w.todo.id, { title: "Triage", position: 0, labels: ["bug"] }),
  };
  const ids = async (qs) => {
    const res = await w.member.api.get(`/api/boards/${w.board.id}/cards${qs}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.items.map((c) => c.id);
  };
  return { w, cards, ids };
}

test("no filter lists every card ordered by column position, then card position", async () => {
  const { w, cards, ids } = await fixture();
  assert.deepEqual(await ids(""), [cards.first.id, cards.login.id, cards.docs.id, cards.perf.id, cards.late.id]);
  await w.owner.api.patch(`/api/columns/${w.done.id}`, { position: 0 });
  assert.deepEqual(await ids(""), [cards.late.id, cards.first.id, cards.login.id, cards.docs.id, cards.perf.id]);
});

test("q matches title or description, case-insensitively", async () => {
  const { cards, ids } = await fixture();
  assert.deepEqual(await ids("?q=login"), [cards.login.id, cards.docs.id]);
  assert.deepEqual(await ids("?q=SEARCH"), [cards.perf.id]);
  assert.deepEqual(await ids("?q=nothing-here"), []);
});

test("label filter compares normalised labels", async () => {
  const { cards, ids } = await fixture();
  assert.deepEqual(await ids("?label=bug"), [cards.first.id, cards.login.id, cards.perf.id]);
  assert.deepEqual(await ids(`?label=${encodeURIComponent("  PERF ")}`), [cards.perf.id]);
});

test("assigneeId filter, including none", async () => {
  const { w, cards, ids } = await fixture();
  assert.deepEqual(await ids(`?assigneeId=${w.member.user.id}`), [cards.login.id]);
  assert.deepEqual(await ids("?assigneeId=none"), [cards.first.id, cards.docs.id, cards.late.id]);
  assert.deepEqual(await ids("?assigneeId=999999"), []);
});

test("dueBefore is inclusive and never matches cards without a due date", async () => {
  const { cards, ids } = await fixture();
  assert.deepEqual(await ids("?dueBefore=2026-11-01"), [cards.login.id, cards.perf.id]);
  assert.deepEqual(await ids("?dueBefore=2026-10-31"), [cards.perf.id]);
  assert.deepEqual(await ids("?dueBefore=2030-01-01"), [cards.login.id, cards.perf.id, cards.late.id]);
});

test("filters combine with AND, columnId narrows to one column", async () => {
  const { w, cards, ids } = await fixture();
  assert.deepEqual(await ids(`?columnId=${w.todo.id}`), [cards.first.id, cards.login.id, cards.docs.id]);
  assert.deepEqual(await ids(`?columnId=${w.todo.id}&label=bug&dueBefore=2026-12-31`), [cards.login.id]);
  assert.deepEqual(await ids(`?label=bug&assigneeId=${w.owner.user.id}`), [cards.perf.id]);
});

test("search results are paginated with total", async () => {
  const { w, cards } = await fixture();
  const res = await w.owner.api.get(`/api/boards/${w.board.id}/cards?label=bug&limit=2&page=2`);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.page, res.body.limit, res.body.total], [2, 2, 3]);
  assert.deepEqual(res.body.items.map((c) => c.id), [cards.perf.id]);
  assert.deepEqual(Object.keys(res.body.items[0]).sort(), Object.keys(cards.perf).sort());
});

test("invalid filter values are 400 naming the parameter", async () => {
  const { w } = await fixture();
  const base = `/api/boards/${w.board.id}/cards`;
  expectError(await w.owner.api.get(`${base}?assigneeId=abc`), 400, "validation_error", "assigneeId");
  expectError(await w.owner.api.get(`${base}?dueBefore=2026-13-01`), 400, "validation_error", "dueBefore");
  expectError(await w.owner.api.get(`${base}?dueBefore=tomorrow`), 400, "validation_error", "dueBefore");
  expectError(await w.owner.api.get(`${base}?columnId=x`), 400, "validation_error", "columnId");
  expectError(await w.owner.api.get(`${base}?limit=1000`), 400, "validation_error", "limit");
});
