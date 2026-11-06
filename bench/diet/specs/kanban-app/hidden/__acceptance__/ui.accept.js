// The browser UI: GET / serves HTML that loads a JS file from the same server.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, createApp, request } = require("./helpers");

function localScripts(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const src = m[1];
    if (/^(https?:)?\/\//i.test(src)) continue;
    out.push(new URL(src, "http://local/").pathname);
  }
  return out;
}

function findOnDisk(urlPath) {
  const base = path.basename(urlPath);
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "__acceptance__", "data"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name === base) hits.push(full);
    }
  };
  walk(ROOT, 0);
  return hits;
}

test("GET / serves an HTML page that loads a same-origin script which exists", async () => {
  const app = createApp();
  const res = await request(app).get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.text, /<html[\s>]/i);
  const scripts = localScripts(res.text);
  assert.ok(scripts.length >= 1, "the page loads at least one local script");
  for (const src of scripts) {
    const js = await request(app).get(src);
    assert.equal(js.status, 200, `${src} is served`);
    assert.match(js.headers["content-type"], /javascript/);
    assert.ok(js.text.trim().length > 200, `${src} is a real script`);
    assert.ok(findOnDisk(src).length >= 1, `${src} exists in the project`);
  }
});

test("the UI script talks to the board, card and move endpoints with the API key header", async () => {
  const app = createApp();
  const res = await request(app).get("/");
  const texts = [res.text];
  const seen = new Set();
  const queue = localScripts(res.text);
  while (queue.length) {
    const src = queue.shift();
    if (seen.has(src)) continue;
    seen.add(src);
    const js = (await request(app).get(src)).text;
    texts.push(js);
    for (const m of js.matchAll(/(?:import|from)\s*\(?\s*["']([^"']+\.m?js)["']/g)) queue.push(new URL(m[1], `http://local${src}`).pathname);
  }
  const all = texts.join("\n");
  assert.match(all, /x-api-key/i);
  assert.match(all, /\/boards/);
  assert.match(all, /\/cards/);
  assert.match(all, /\/move/);
  assert.match(all, /localStorage/);
});
