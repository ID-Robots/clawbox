#!/usr/bin/env node
// Tiny todo CLI with a JSON file store.
// Usage: todo add <text> | todo list | todo done <id>
import fs from "node:fs";
import path from "node:path";

export const STORE = process.env.TODO_FILE || path.join(process.cwd(), "todos.json");

export function load(file = STORE) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function save(todos, file = STORE) {
  fs.writeFileSync(file, JSON.stringify(todos, null, 2) + "\n");
}

export function add(text, file = STORE) {
  const todos = load(file);
  const id = todos.length ? Math.max(...todos.map((t) => t.id)) + 1 : 1;
  const item = { id, text, done: false };
  todos.push(item);
  save(todos, file);
  return item;
}

export function complete(id, file = STORE) {
  const todos = load(file);
  const item = todos.find((t) => t.id === id);
  if (!item) throw new Error(`no todo with id ${id}`);
  item.done = true;
  save(todos, file);
  return item;
}

export function formatList(todos) {
  if (!todos.length) return "(no todos)";
  return todos.map((t) => `${t.done ? "[x]" : "[ ]"} ${t.id}. ${t.text}`).join("\n");
}

export function run(argv, file = STORE) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "add": {
      const item = add(rest.join(" "), file);
      return `added ${item.id}`;
    }
    case "list":
      return formatList(load(file));
    case "done": {
      const item = complete(Number(rest[0]), file);
      return `done ${item.id}`;
    }
    default:
      return "usage: todo add <text> | todo list | todo done <id>";
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
