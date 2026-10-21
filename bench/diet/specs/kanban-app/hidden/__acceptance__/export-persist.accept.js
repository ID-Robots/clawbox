const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp, request, client, signup, world, card, expectError } = require("./helpers");

test("CSV export: headers, content type, file name", async () => {
  const w = await world();
  const res = await w.member.api.get(`/api/boards/${w.board.id}/export.csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /^text\/csv/);
  assert.match(res.headers["content-disposition"], new RegExp(`attachment;\\s*filename="board-${w.board.id}\\.csv"`));
  assert.equal(res.text, "id,column,title,description,labels,dueDate,assignee,position\r\n");
});

test("CSV export rows: order, RFC 4180 quoting, labels, assignee name, empty due date", async () => {
  const w = await world();
  const a = await card(w.owner.api, w.doing.id, { title: 'Say "hi", world', description: "line1\nline2", labels: ["ui", "bug"], dueDate: "2026-11-30", assigneeId: w.member.user.id });
  const b = await card(w.owner.api, w.todo.id, { title: "Plain" });
  const c = await card(w.owner.api, w.todo.id, { title: "Second, todo" });
  const res = await w.owner.api.get(`/api/boards/${w.board.id}/export.csv`);
  assert.equal(res.status, 200);
  assert.ok(res.text.endsWith("\r\n"));
  assert.equal(res.text,
    "id,column,title,description,labels,dueDate,assignee,position\r\n" +
    `${b.id},To do,Plain,,,,,0\r\n` +
    `${c.id},To do,"Second, todo",,,,,1\r\n` +
    `${a.id},Doing,"Say ""hi"", world","line1\nline2",ui;bug,2026-11-30,Max,0\r\n`);
  expectError(await w.outsider.api.get(`/api/boards/${w.board.id}/export.csv`), 403, "forbidden");
});

function tmpDataFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kanban-accept-"));
  return { dir, file: path.join(dir, "kanban.json") };
}

test("state survives a restart; keys keep working; id sequences continue", async () => {
  const { dir, file } = tmpDataFile();
  const app1 = createApp({ dataFile: file });
  const ann = await signup(app1, "Ann");
  const bob = await signup(app1, "Bob");
  const board = (await ann.api.post("/api/boards", { name: "Persist" })).body;
  await ann.api.post(`/api/boards/${board.id}/members`, { userId: bob.user.id });
  const cols = (await ann.api.get(`/api/boards/${board.id}`)).body.columns;
  const c1 = await card(ann.api, cols[0].id, { title: "keep me", labels: ["x"], dueDate: "2026-10-10", assigneeId: bob.user.id });
  const gone = await card(ann.api, cols[0].id, "delete me");
  await ann.api.del(`/api/cards/${gone.id}`);
  await bob.api.post(`/api/cards/${c1.id}/move`, { columnId: cols[1].id });
  const cm = (await bob.api.post(`/api/cards/${c1.id}/comments`, { body: "persisted" })).body;
  const before = (await ann.api.get(`/api/boards/${board.id}/activity?limit=100`)).body;

  const app2 = createApp({ dataFile: file });
  const ann2 = client(app2, ann.key);
  const bob2 = client(app2, bob.key);
  assert.deepEqual((await ann2.get("/api/me")).body, ann.user);
  assert.deepEqual((await bob2.get(`/api/cards/${c1.id}`)).body, (await ann.api.get(`/api/cards/${c1.id}`)).body);
  assert.deepEqual((await ann2.get(`/api/boards/${board.id}`)).body, (await ann.api.get(`/api/boards/${board.id}`)).body);
  assert.deepEqual((await bob2.get(`/api/cards/${c1.id}/comments`)).body.items, [cm]);
  assert.deepEqual((await ann2.get(`/api/boards/${board.id}/activity?limit=100`)).body, before);
  const c3 = await card(ann2, cols[0].id, "after restart");
  assert.ok(c3.id > gone.id, "card ids continue past deleted ones");
  const u3 = await signup(app2, "Cy");
  assert.ok(u3.user.id > bob.user.id);
  const after = (await ann2.get(`/api/boards/${board.id}/activity?limit=1`)).body.items[0];
  assert.ok(after.id > before.items[0].id, "activity ids continue");
  expectError(await request(app2).get("/api/me").set("X-API-Key", "kb_wrong"), 401, "unauthorized");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writes are atomic, immediate, leave no temp files, and never store the raw key", async () => {
  const { dir, file } = tmpDataFile();
  const app = createApp({ dataFile: file });
  assert.equal((await request(app).get("/api/health")).status, 200);
  const u = await signup(app, "Kim");
  assert.ok(fs.existsSync(file), "data file written after the first change");
  const board = (await u.api.post("/api/boards", { name: "Now" })).body;
  // a second app created right after the response must already see the change
  const seen = await client(createApp({ dataFile: file }), u.key).get(`/api/boards/${board.id}`);
  assert.equal(seen.status, 200);
  const cols = seen.body.columns;
  for (let i = 0; i < 10; i++) await card(u.api, cols[i % 3].id, `c${i}`);
  assert.deepEqual(fs.readdirSync(dir), ["kanban.json"], "no temp or lock files left");
  const raw = fs.readFileSync(file, "utf8");
  JSON.parse(raw);
  assert.ok(!raw.includes(u.key), "raw API key must not be stored");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing data file starts empty; in-memory apps are independent", async () => {
  const { dir, file } = tmpDataFile();
  const app = createApp({ dataFile: file });
  const u = await signup(app, "Lee");
  assert.equal((await u.api.get("/api/users")).body.total, 1);
  const other = createApp();
  expectError(await request(other).get("/api/me").set("X-API-Key", u.key), 401, "unauthorized");
  fs.rmSync(dir, { recursive: true, force: true });
});
