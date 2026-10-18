// Shared helpers for the hidden acceptance suite (SPEC.md is the contract).
const assert = require("node:assert/strict");
const path = require("node:path");
const request = require("supertest");

const ROOT = process.env.PROJECT || path.resolve(__dirname, "..");
const { createApp } = require(path.join(ROOT, "src", "app.js"));

let seq = 0;
const uniq = () => `${process.pid}-${Date.now()}-${++seq}`;

function client(app, key) {
  const withKey = (r) => (key ? r.set("X-API-Key", key) : r);
  return {
    get: (url) => withKey(request(app).get(url)),
    post: (url, body) => withKey(request(app).post(url)).send(body === undefined ? {} : body),
    patch: (url, body) => withKey(request(app).patch(url)).send(body === undefined ? {} : body),
    del: (url) => withKey(request(app).delete(url)),
  };
}

async function signup(app, name = "Ada") {
  const res = await request(app).post("/api/users").send({ name, email: `${name.toLowerCase().replace(/\W/g, "")}-${uniq()}@example.com` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { user: res.body.user, key: res.body.apiKey, api: client(app, res.body.apiKey) };
}

// A fresh app with an owner, a second member, an outsider, and one board.
async function world() {
  const app = createApp();
  const owner = await signup(app, "Olivia");
  const member = await signup(app, "Max");
  const outsider = await signup(app, "Eve");
  const b = await owner.api.post("/api/boards", { name: "Roadmap" });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const add = await owner.api.post(`/api/boards/${b.body.id}/members`, { userId: member.user.id });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const detail = await owner.api.get(`/api/boards/${b.body.id}`);
  const [todo, doing, done] = detail.body.columns;
  return { app, owner, member, outsider, board: b.body, todo, doing, done };
}

async function card(api, columnId, body) {
  const res = await api.post(`/api/columns/${columnId}/cards`, typeof body === "string" ? { title: body } : body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function titlesIn(api, boardId, columnId) {
  const res = await api.get(`/api/boards/${boardId}`);
  const col = res.body.columns.find((c) => c.id === columnId);
  return col.cards.map((c) => [c.title, c.position]);
}

function expectError(res, status, code, field) {
  assert.equal(res.status, status, `expected ${status} ${code}${field ? `/${field}` : ""}, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.deepEqual(Object.keys(res.body), ["error"], "error body has only the error key");
  assert.equal(res.body.error.code, code);
  assert.equal(typeof res.body.error.message, "string");
  if (code === "validation_error") assert.equal(res.body.error.field, field, `field for ${JSON.stringify(res.body)}`);
  else assert.equal(res.body.error.field, undefined, "field only on validation_error");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

module.exports = { ROOT, createApp, request, client, signup, world, card, titlesIn, expectError, sleep, uniq, ISO_RE };
