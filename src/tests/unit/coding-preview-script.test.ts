/**
 * scripts/clawbox-preview.mjs — the review pass's answer to "where do I open
 * this?".
 *
 * Driven as the real process, like coding-local-preview.test.ts: what matters
 * about this script is what it does to the machine — which port it binds, what
 * it leaves listening, whether a build can hold it for ever — and none of that
 * survives being mocked.
 */
import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SCRIPT = path.resolve(__dirname, "../../../scripts/clawbox-preview.mjs");
const started: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of started.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-script-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

interface Preview { child: ChildProcess; stdout: () => string; stderr: () => string }

function start(dir: string, args: string[] = []): Preview {
  const child = spawn(process.execPath, [SCRIPT, "--dir", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  started.push(child);
  let out = "";
  let err = "";
  child.stdout!.on("data", (c) => { out += String(c); });
  child.stderr!.on("data", (c) => { err += String(c); });
  return { child, stdout: () => out, stderr: () => err };
}

async function waitFor(read: () => string, match: RegExp, budgetMs = 40_000): Promise<RegExpMatchArray> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = read().match(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`never printed ${match}: ${read()}`);
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

async function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once("close", resolve));
}

it("serves a plain folder on an ephemeral loopback port and stops itself at the TTL", async () => {
  const dir = project({ "index.html": "<h1>Hello from the worktree</h1>" });
  const preview = start(dir, ["--ttl", "3"]);
  const [, url] = await waitFor(preview.stdout, /PREVIEW_URL (\S+)/);
  expect(preview.stdout()).toContain("PREVIEW_MODE static");

  const parsed = new URL(url);
  expect(parsed.hostname).toBe("127.0.0.1");
  // The whole reason there is no --port flag: this can never be the box's own
  // web server, and never anything a LAN client could reach.
  expect(Number(parsed.port)).toBeGreaterThanOrEqual(1024);
  expect(await (await fetch(url)).text()).toContain("Hello from the worktree");

  // The pid it printed is the one the pass is told to kill.
  const pid = Number((await waitFor(preview.stdout, /PREVIEW_PID (\d+)/))[1]);
  expect(pid).toBe(preview.child.pid);

  expect(await exited(preview.child)).toBe(0);
  expect(preview.stdout()).toContain("PREVIEW_STOPPED ttl");
  await expect(fetch(url)).rejects.toThrow();
});

it("serves the build output when the project builds one", async () => {
  const dir = project({
    "package.json": JSON.stringify({ name: "p", private: true, scripts: { build: "mkdir -p dist && printf '<h1>built</h1>' > dist/index.html" } }),
    "index.html": "<h1>source, not the build</h1>",
  });
  const preview = start(dir, ["--ttl", "5"]);
  const [, url] = await waitFor(preview.stdout, /PREVIEW_URL (\S+)/);
  expect(await (await fetch(url)).text()).toContain("built");
  preview.child.kill("SIGTERM");
  await exited(preview.child);
});

it("refuses to serve anything outside the folder", async () => {
  const dir = project({ "index.html": "<h1>inside</h1>", "secret.txt": "not this either" });
  fs.writeFileSync(path.join(path.dirname(dir), "outside.txt"), "must not be served");
  const preview = start(dir, ["--ttl", "5"]);
  const [, url] = await waitFor(preview.stdout, /PREVIEW_URL (\S+)/);
  for (const attempt of ["../outside.txt", "../../etc/passwd", "%2e%2e%2foutside.txt"]) {
    expect((await fetch(`${url}${attempt}`)).status, attempt).toBe(404);
  }
  // Its own files are still served — the containment is not a blanket refusal.
  expect((await fetch(`${url}secret.txt`)).status).toBe(200);
  preview.child.kill("SIGTERM");
  await exited(preview.child);
});

it("starts the project's own server, finds the port it chose, and takes it down again", async () => {
  const dir = project({
    "package.json": JSON.stringify({ name: "p", private: true, scripts: { dev: "node server.js" } }),
    // Port 0: the point is that the script DISCOVERS whatever the dev server
    // picked, because no flag convention works across every dev server.
    "server.js": "require('http').createServer((q,r)=>r.end('<h1>dev server page</h1>')).listen(0,'127.0.0.1');",
  });
  const preview = start(dir, ["--ttl", "4", "--start-timeout", "25"]);
  const [, url] = await waitFor(preview.stdout, /PREVIEW_URL (\S+)/);
  expect(preview.stdout()).toContain("PREVIEW_MODE command");
  expect(await (await fetch(url)).text()).toContain("dev server page");

  expect(await exited(preview.child)).toBe(0);
  // The grandchild (`sh -c` → node) is reached too: a preview that leaked a
  // listener would be exactly the leak the TTL exists to prevent.
  await expect(fetch(url)).rejects.toThrow();
});

it("says plainly that the build ran out of time, and serves nothing", async () => {
  const dir = project({ "package.json": JSON.stringify({ name: "p", private: true, scripts: { build: "sleep 60" } }) });
  const preview = start(dir, ["--build-timeout", "2", "--ttl", "5"]);
  expect(await exited(preview.child)).toBe(1);
  expect(preview.stdout()).toMatch(/PREVIEW_FAILED build_timeout /);
  expect(preview.stdout()).not.toContain("PREVIEW_URL");
});

it("says plainly that the build failed, quoting nothing it did not see", async () => {
  const dir = project({ "package.json": JSON.stringify({ name: "p", private: true, scripts: { build: "exit 7" } }) });
  const preview = start(dir, ["--ttl", "5"]);
  expect(await exited(preview.child)).toBe(1);
  expect(preview.stdout()).toMatch(/PREVIEW_FAILED build_failed .*exit 7/);
});

it("says plainly that the project's server never listened", async () => {
  const dir = project({
    "package.json": JSON.stringify({ name: "p", private: true, scripts: { dev: "exit 3" } }),
  });
  const preview = start(dir, ["--start-timeout", "6", "--ttl", "5"]);
  expect(await exited(preview.child)).toBe(1);
  expect(preview.stdout()).toMatch(/PREVIEW_FAILED (start_failed|no_port) /);
});

it("refuses an argument it does not know rather than guessing", async () => {
  const dir = project({ "index.html": "<h1>x</h1>" });
  const preview = start(dir, ["--port", "80"]);
  expect(await exited(preview.child)).toBe(1);
  expect(preview.stdout()).toContain("PREVIEW_FAILED bad_argument");
});

it("has no way to ask for a particular port at all", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  expect(source).not.toMatch(/"--port"/);
  // listen(0, "127.0.0.1") is the only bind in the file.
  expect(source.match(/\.listen\(/g)).toHaveLength(1);
  expect(source).toContain('server.listen(0, "127.0.0.1"');
});
