import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, load } from "../todo.js";

let file;
beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "todo-")), "todos.json"); });
afterEach(() => { fs.rmSync(path.dirname(file), { recursive: true, force: true }); });

describe("todo cli", () => {
  it("adds a todo", () => {
    expect(run(["add", "buy milk"], file)).toBe("added 1");
    expect(load(file)).toEqual([{ id: 1, text: "buy milk", done: false }]);
  });
  it("lists todos", () => {
    run(["add", "a"], file); run(["add", "b"], file);
    expect(run(["list"], file)).toBe("[ ] 1. a\n[ ] 2. b");
  });
  it("marks a todo done", () => {
    run(["add", "a"], file);
    expect(run(["done", "1"], file)).toBe("done 1");
    expect(run(["list"], file)).toBe("[x] 1. a");
  });
});
