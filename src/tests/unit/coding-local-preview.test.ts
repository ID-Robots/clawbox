import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { once } from "events";
import { cgroupNamesUnit, ownsLocalPreview } from "@/lib/coding-local-preview";
// Real listener/process ownership, not a mock of the access decision.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const started: ChildProcess[] = [];
// Servers a root started in groups of their own: killing the root leaves them.
const servers: number[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const child of started.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  for (const pid of servers.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A node process with `code`, tracked for teardown; detached = its own process group, like the harness. */
function node(code: string, cwd: string, detached = true): ChildProcess {
  const child = spawn(process.execPath, ["-e", code], { cwd, detached, stdio: ["ignore", "pipe", "pipe"] });
  started.push(child);
  return child;
}

/** A process that is alive and has nothing to do with any listener here. */
function bystander(cwd: string): ChildProcess {
  return node("setInterval(() => {}, 1000)", cwd);
}

/** An http server that prints "<pid> <port>" once it listens. */
const SERVER = (host: string, port = 0, reusePort = false) =>
  `const s=require('http').createServer((q,r)=>r.end('preview'));` +
  `s.on('error',(e)=>{console.log('ERR '+e.code);process.exit(1)});` +
  `s.listen({port:${port},host:'${host}'${reusePort ? ",reusePort:true" : ""}},()=>console.log(process.pid+' '+s.address().port));`;

/**
 * The shape a run's shell actually produces: a group leader (the harness)
 * whose command starts the server in a NEW process group of its own (the
 * shell tool's setsid), with whatever cwd the command chose.
 */
const ROOT = (serverCwd: string, host = "127.0.0.1") =>
  `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(SERVER(host))}],{cwd:${JSON.stringify(serverCwd)},detached:true,stdio:['ignore','pipe','inherit']});` +
  `c.stdout.pipe(process.stdout);process.on('SIGTERM',()=>{c.kill('SIGKILL');process.exit(0)});setInterval(()=>{},1000);`;

async function listening(child: ChildProcess): Promise<{ pid: number; port: number }> {
  const [chunk] = await once(child.stdout!, "data");
  const [pid, port] = String(chunk).trim().split(" ");
  if (pid === "ERR") throw new Error(`listen failed: ${port}`);
  servers.push(Number(pid));
  return { pid: Number(pid), port: Number(port) };
}

function pgrpOf(pid: number): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[2]);
}

it.each(["127.0.0.1", "::1"])("allows only a live run's own %s listener in its project and process group", async (host) => {
  const cwd = tempDir("preview-owner-");
  const otherProject = tempDir("preview-other-");
  const child = node(SERVER(host), cwd);
  const { port } = await listening(child);
  const url = new URL(`http://${host === "::1" ? "[::1]" : host}:${port}/`);
  const run = { directory: cwd, pgid: child.pid!, status: "running" };
  expect(await ownsLocalPreview(url, run)).toBe(true);
  expect(await ownsLocalPreview(url, { ...run, pgid: bystander(cwd).pid! })).toBe(false);
  expect(await ownsLocalPreview(url, { ...run, pgid: null })).toBe(false);
  expect(await ownsLocalPreview(url, { ...run, directory: otherProject })).toBe(false);
  expect(await ownsLocalPreview(url, { ...run, directory: cwd + '-other' })).toBe(false);
  expect(await ownsLocalPreview(url, { ...run, status: "completed" })).toBe(false);
  for (const target of ["http://127.0.0.1:80/", "http://192.0.2.1:3000/", "http://169.254.169.254/", `http://name.localhost:${port}/`, `http://user:pass@127.0.0.1:${port}/`, `https://127.0.0.1:${port}/`]) {
    expect(await ownsLocalPreview(new URL(target), run)).toBe(false);
  }
  child.kill();
  await once(child, "exit");
  expect(await ownsLocalPreview(url, run)).toBe(false);
});

it("allows a server the run started in a NEW process group, by its parent chain", async () => {
  const project = tempDir("preview-run-");
  const app = path.join(project, "app");
  fs.mkdirSync(app);
  const root = node(ROOT(app), project);
  const server = await listening(root);
  // The premise: the shell tool's setsid put the server outside the run's group.
  expect(pgrpOf(server.pid)).not.toBe(root.pid);
  const url = new URL(`http://127.0.0.1:${server.port}/`);
  const run = { directory: project, pgid: root.pid!, status: "running" };
  expect(await ownsLocalPreview(url, run)).toBe(true);
  expect(await ownsLocalPreview(new URL(`http://localhost:${server.port}/`), run)).toBe(true);
  // The same server, asked about by a run it does not descend from.
  expect(await ownsLocalPreview(url, { ...run, pgid: bystander(project).pid! })).toBe(false);
  // A scope name the server is not in proves nothing on its own.
  expect(await ownsLocalPreview(url, { ...run, pgid: null, unit: "clawbox-run-run-zzzzzzzz-0.scope" })).toBe(false);
});

it("refuses an unrelated server even when its cwd is inside the run's project", async () => {
  const project = tempDir("preview-run-");
  const root = node(ROOT(project), project);
  await listening(root);
  // Started by somebody else (the test), not by the run, in the run's folder.
  const stranger = await listening(node(SERVER("127.0.0.1"), project));
  const run = { directory: project, pgid: root.pid!, status: "running" };
  expect(await ownsLocalPreview(new URL(`http://127.0.0.1:${stranger.port}/`), run)).toBe(false);
});

it("refuses the run's own server when its cwd is outside the run's project", async () => {
  const project = tempDir("preview-run-");
  const elsewhere = tempDir("preview-elsewhere-");
  const root = node(ROOT(elsewhere), project);
  const server = await listening(root);
  const run = { directory: project, pgid: root.pid!, status: "running" };
  expect(await ownsLocalPreview(new URL(`http://127.0.0.1:${server.port}/`), run)).toBe(false);
});

it("refuses a port the run shares with a listener that is not its own", async (ctx) => {
  const project = tempDir("preview-run-");
  const mine = node(SERVER("127.0.0.1", 0, true), project);
  const { port } = await listening(mine);
  const theirs = node(SERVER("127.0.0.1", port, true), project);
  const [chunk] = await once(theirs.stdout!, "data");
  if (String(chunk).startsWith("ERR")) ctx.skip(); // no SO_REUSEPORT on this Node
  const run = { directory: project, pgid: mine.pid!, status: "running" };
  expect(await ownsLocalPreview(new URL(`http://127.0.0.1:${port}/`), run)).toBe(false);
  theirs.kill();
  await once(theirs, "exit");
  expect(await ownsLocalPreview(new URL(`http://127.0.0.1:${port}/`), run)).toBe(true);
});

it("reads the run's scope from a cgroup path segment, never a substring", () => {
  const unit = "clawbox-run-run-abcdefgh-x1.scope";
  const v2 = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`;
  expect(cgroupNamesUnit(v2, unit)).toBe(true);
  expect(cgroupNamesUnit(v2, "clawbox-run-run-abcdefgh-x.scope")).toBe(false);
  expect(cgroupNamesUnit(v2.replace(unit, `evil-${unit}`), unit)).toBe(false);
  expect(cgroupNamesUnit(v2.replace(unit, `${unit}.d`), unit)).toBe(false);
  expect(cgroupNamesUnit(`12:pids:/user.slice\n1:name=systemd:/user.slice/${unit}\n`, unit)).toBe(true);
  expect(cgroupNamesUnit("", unit)).toBe(false);
});

// Only where this test itself runs inside a run's scope (on a ClawBox): there
// the scope is the one thing a server reparented away from the run still has.
const ownScope = (() => {
  try {
    const segment = fs.readFileSync("/proc/self/cgroup", "utf8").split("/").at(-1)?.trim();
    return segment && /^clawbox-run-[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.scope$/.test(segment) ? segment : null;
  } catch { return null; }
})();
it.skipIf(!ownScope)("allows a listener inside the run's scope with no process-group link", async () => {
  const project = tempDir("preview-scope-");
  const server = await listening(node(SERVER("127.0.0.1"), project));
  const url = new URL(`http://127.0.0.1:${server.port}/`);
  const run = { directory: project, pgid: null, unit: ownScope, status: "running" };
  expect(await ownsLocalPreview(url, run)).toBe(true);
  expect(await ownsLocalPreview(url, { ...run, unit: "clawbox-run-run-zzzzzzzz-0.scope" })).toBe(false);
  expect(await ownsLocalPreview(url, { ...run, unit: "not-a-run.scope" })).toBe(false);
});
