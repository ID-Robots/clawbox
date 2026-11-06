// Hidden acceptance tests: `todo list --json`. Run with: node --test __acceptance__/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function cli(file, ...args) {
  return execFileSync(process.execPath, [path.join(root, "todo.js"), ...args], {
    cwd: path.dirname(file), env: { ...process.env, TODO_FILE: file }, encoding: "utf8",
  });
}
function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "todo-acc-")), "todos.json");
}

test("list --json prints a JSON array with the stored fields", () => {
  const file = tmpFile();
  cli(file, "add", "buy milk");
  cli(file, "add", "call mom");
  cli(file, "done", "2");
  const out = cli(file, "list", "--json");
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  const pick = (t) => ({ id: t.id, text: t.text, done: t.done });
  assert.deepEqual(parsed.map(pick), [
    { id: 1, text: "buy milk", done: false },
    { id: 2, text: "call mom", done: true },
  ]);
});

test("list --json on an empty store is an empty JSON array", () => {
  const file = tmpFile();
  assert.deepEqual(JSON.parse(cli(file, "list", "--json")), []);
});

test("plain list output is unchanged", () => {
  const file = tmpFile();
  assert.equal(cli(file, "list").trim(), "(no todos)");
  cli(file, "add", "a");
  cli(file, "add", "b c");
  cli(file, "done", "1");
  assert.equal(cli(file, "list").trim(), "[x] 1. a\n[ ] 2. b c");
});

test("module API still works for plain list", async () => {
  const { run } = await import(pathToFileURL(path.join(root, "todo.js")).href);
  const file = tmpFile();
  run(["add", "x"], file);
  assert.equal(run(["list"], file), "[ ] 1. x");
});
