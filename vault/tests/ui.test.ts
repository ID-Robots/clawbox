// The desktop app (src/ui) in a DOM: the real index.html and app.ts against a
// stub of the vault service. One app instance for the whole file, as in the
// browser; the tests run in order and the last one locks it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const UI = join(import.meta.dir, "../src/ui");
const ENTRY = { name: "a.example.com/ops", login: "ops", url: "https://a.example.com/login", updated: "2026-11-14T12:00:00Z" };

interface Call {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}
const calls: Call[] = [];
/** What the next POST ui/entries answers; null is a plain success. */
let saveAnswer: { status: number; body: unknown } | null = null;
let lockHangs = false;
let doc: Document;
// Every global this file adds or replaces, put back afterwards: bun runs the
// other test files in the same process.
const added: string[] = [];
const saved = new Map<string, PropertyDescriptor | undefined>();
let win: Window & typeof globalThis;

const $ = (id: string) => doc.getElementById(id) as HTMLElement;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const posts = () => calls.filter((c) => c.method === "POST" && c.path === "ui/entries");

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

async function openEditor(): Promise<void> {
  (doc.querySelector(".entry-item") as HTMLElement).click();
  await settle();
  const edit = Array.from($("detail").querySelectorAll("button")).find((b) => b.textContent === "Edit");
  expect(edit).toBeTruthy();
  edit!.click();
  await settle();
}

async function save(name: string): Promise<void> {
  ($("edit-name") as HTMLInputElement).value = name;
  $("edit-form").dispatchEvent(new win.Event("submit", { cancelable: true }));
  await settle(60);
}

beforeAll(async () => {
  const html = readFileSync(join(UI, "index.html"), "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { url: "http://127.0.0.1/apps/clawbox-vault/", pretendToBeVisual: true });
  win = dom.window as unknown as Window & typeof globalThis;
  doc = win.document;
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(win)) {
    if (!(key in globalThis)) {
      try {
        g[key] = (win as unknown as Record<string, unknown>)[key];
        added.push(key);
      } catch {
        // read-only on this side
      }
    }
  }
  for (const key of ["window", "document", "navigator", "fetch"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(g, { window: win, document: doc, navigator: win.navigator });
  const dialog = (win as unknown as { HTMLDialogElement: { prototype: { showModal?: () => void; close?: () => void; open: boolean } } }).HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: { open: boolean }) {
    this.open = true;
  };
  dialog.close ??= function (this: { open: boolean }) {
    this.open = false;
  };
  g.fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const path = String(url).replace("./api/", "");
    const method = init.method ?? "GET";
    calls.push({ method, path, auth: init.headers?.authorization ?? null, body: init.body ? JSON.parse(init.body) : null });
    if (path === "ui/status") return reply({ pinSet: true, unlocked: false, cards: false, store: { ready: true } });
    if (path === "ui/unlock") return reply({ token: "session-under-test", idleMs: 900_000 });
    if (path === "ui/lock") return lockHangs ? new Promise(() => {}) : reply({ ok: true });
    if (path.startsWith("ui/entries") && method === "GET") return reply({ entries: [ENTRY] });
    if (path.startsWith("ui/entry?")) return reply({ ...ENTRY, note: "", has2fa: false, extraLines: 0 });
    if (path === "ui/entries" && method === "POST") {
      const a = saveAnswer;
      return a ? reply(a.body, a.status) : reply({ name: (calls.at(-1)?.body?.name as string) ?? ENTRY.name, created: false });
    }
    return reply({});
  };
  await import("../src/ui/app");
  await settle();
  ($("gate-pin") as HTMLInputElement).value = "123456";
  $("gate-form").dispatchEvent(new win.Event("submit", { cancelable: true }));
  await settle(60);
  expect($("shell").hidden).toBe(false);
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const key of added) delete g[key];
  for (const [key, desc] of saved) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete g[key];
  }
});

describe("a renamed save that failed", () => {
  test("whereabouts unknown: no retry under the old name until the entry is opened again", async () => {
    await openEditor();
    saveAnswer = { status: 409, body: { error: "where it is now could not be confirmed", code: "renamed_not_updated" } };
    await save("b.example.com/ops");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toMatchObject({ originalName: ENTRY.name });
    // The same dialog: nothing is sent, and the owner is told why.
    await save("b.example.com/ops");
    expect(posts()).toHaveLength(1);
    expect($("edit-error").textContent).toContain("could not be confirmed");
    // Opened again from the list (which reloaded it), the entry can be saved.
    saveAnswer = null;
    await openEditor();
    await save("b.example.com/ops");
    expect(posts()).toHaveLength(2);
  });

  test("a known new name is where the retry goes, in that editor only", async () => {
    await openEditor();
    saveAnswer = { status: 409, body: { error: "the save failed after the entry was renamed", code: "renamed_not_updated", name: "c.example.com/ops" } };
    await save("c.example.com/ops");
    saveAnswer = null;
    await save("c.example.com/ops");
    expect(posts().at(-1)!.body).toMatchObject({ originalName: "c.example.com/ops" });
  });
});

describe("Lock", () => {
  test("conceals at once, with the lock request still unanswered and carrying the session", async () => {
    await openEditor();
    ($("edit-password") as HTMLInputElement).value = "typed-secret";
    lockHangs = true;
    $("btn-lock").click();
    expect($("gate").hidden).toBe(false);
    expect($("shell").hidden).toBe(true);
    expect(($("edit-password") as HTMLInputElement).value).toBe("");
    await settle();
    expect(calls.find((c) => c.path === "ui/lock")?.auth).toBe("Bearer session-under-test");
  });
});
