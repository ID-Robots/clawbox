const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp, request, signup, expectError, ISO_RE, uniq } = require("./helpers");

test("health answers without a key", async () => {
  const res = await request(createApp()).get("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
});

test("sign-up returns the user and a long API key; name trimmed, email lower-cased", async () => {
  const app = createApp();
  const email = `Mixed.Case-${uniq()}@Example.COM`;
  const res = await request(app).post("/api/users").send({ name: "  Grace Hopper  ", email: `  ${email} ` });
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ["apiKey", "user"]);
  assert.deepEqual(Object.keys(res.body.user).sort(), ["createdAt", "email", "id", "name"]);
  assert.equal(res.body.user.name, "Grace Hopper");
  assert.equal(res.body.user.email, email.toLowerCase());
  assert.ok(Number.isInteger(res.body.user.id) && res.body.user.id > 0);
  assert.match(res.body.user.createdAt, ISO_RE);
  assert.equal(typeof res.body.apiKey, "string");
  assert.ok(res.body.apiKey.length >= 32);
});

test("sign-up validation names the field", async () => {
  const app = createApp();
  const ok = `v-${uniq()}@example.com`;
  const cases = [
    [{ email: ok }, "name"], [{ name: "   ", email: ok }, "name"], [{ name: "x".repeat(101), email: ok }, "name"],
    [{ name: 42, email: ok }, "name"], [{ name: "A" }, "email"], [{ name: "A", email: "not-an-email" }, "email"],
    [{ name: "A", email: "a@b" }, "email"], [{ name: "A", email: ["a@b.co"] }, "email"],
  ];
  for (const [body, field] of cases) expectError(await request(app).post("/api/users").send(body), 400, "validation_error", field);
  const r = await request(app).post("/api/users").send({ name: "x".repeat(100), email: ok });
  assert.equal(r.status, 201, "100-char name is allowed");
});

test("duplicate email (case-insensitive) is a conflict", async () => {
  const app = createApp();
  const email = `dup-${uniq()}@example.com`;
  assert.equal((await request(app).post("/api/users").send({ name: "A", email })).status, 201);
  expectError(await request(app).post("/api/users").send({ name: "B", email: email.toUpperCase() }), 409, "conflict");
});

test("missing or unknown API key is 401 on protected routes", async () => {
  const app = createApp();
  const { key } = await signup(app);
  for (const url of ["/api/me", "/api/users", "/api/boards"]) {
    expectError(await request(app).get(url), 401, "unauthorized");
    expectError(await request(app).get(url).set("X-API-Key", key + "x"), 401, "unauthorized");
  }
  expectError(await request(app).post("/api/boards").send({ name: "x" }), 401, "unauthorized");
});

test("GET /api/me is the caller and never exposes the key", async () => {
  const app = createApp();
  const a = await signup(app, "Alan");
  await signup(app, "Barbara");
  const me = await a.api.get("/api/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.body, a.user);
  assert.ok(!JSON.stringify(me.body).includes(a.key));
});

test("user ids are distinct increasing integers", async () => {
  const app = createApp();
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await signup(app, `U${i}`)).user.id);
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1]);
});

test("GET /api/users is paginated and ordered by id", async () => {
  const app = createApp();
  const users = [];
  for (let i = 0; i < 5; i++) users.push(await signup(app, `P${i}`));
  const api = users[0].api;
  const all = await api.get("/api/users");
  assert.equal(all.status, 200);
  assert.deepEqual(Object.keys(all.body).sort(), ["items", "limit", "page", "total"]);
  assert.equal(all.body.page, 1);
  assert.equal(all.body.limit, 20);
  assert.equal(all.body.total, 5);
  assert.deepEqual(all.body.items.map((u) => u.id), users.map((u) => u.user.id));
  const p2 = await api.get("/api/users?page=2&limit=2");
  assert.deepEqual(p2.body.items.map((u) => u.id), users.slice(2, 4).map((u) => u.user.id));
  assert.equal(p2.body.total, 5);
  assert.equal(p2.body.limit, 2);
  const past = await api.get("/api/users?page=9&limit=2");
  assert.equal(past.status, 200);
  assert.deepEqual(past.body.items, []);
  assert.equal(past.body.total, 5);
});

test("invalid pagination parameters are 400 with the parameter name", async () => {
  const app = createApp();
  const { api } = await signup(app);
  for (const [qs, field] of [["page=0", "page"], ["page=-1", "page"], ["page=abc", "page"], ["page=1.5", "page"],
    ["limit=0", "limit"], ["limit=101", "limit"], ["limit=abc", "limit"]]) {
    expectError(await api.get(`/api/users?${qs}`), 400, "validation_error", field);
  }
  assert.equal((await api.get("/api/users?limit=100")).status, 200);
});

test("unknown /api route is 404 and malformed JSON is invalid_json", async () => {
  const app = createApp();
  const { key, api } = await signup(app);
  expectError(await api.get("/api/nope"), 404, "not_found");
  const bad = await request(app).post("/api/boards").set("X-API-Key", key).set("Content-Type", "application/json").send('{"name": ');
  expectError(bad, 400, "invalid_json");
  const bad2 = await request(app).post("/api/users").set("Content-Type", "application/json").send("{oops}");
  expectError(bad2, 400, "invalid_json");
});

test("a malformed or unknown path id is 404", async () => {
  const app = createApp();
  const { api } = await signup(app);
  for (const url of ["/api/boards/abc", "/api/boards/0", "/api/boards/1.5", "/api/boards/999999", "/api/cards/x", "/api/cards/424242"]) {
    expectError(await api.get(url), 404, "not_found");
  }
  expectError(await api.patch("/api/columns/77777", { name: "x" }), 404, "not_found");
  expectError(await api.del("/api/comments/88888"), 404, "not_found");
});
