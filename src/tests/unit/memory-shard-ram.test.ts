/**
 * "Keep the Memory Shard index in RAM" (src/lib/memory-shard-ram.ts): off by
 * default and inert; on reads the index files through in a low-priority child
 * and off stops it; refused over half of MemAvailable, and switched off by
 * itself when that becomes true later; the files are only ever read.
 */
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn as realSpawn, type ChildProcess } from "child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock("@/lib/config-store", () => ({
  get: async (key: string) => config.values.get(key),
  set: async (key: string, value: unknown) => void config.values.set(key, value),
}));
const edition = vi.hoisted(() => ({ openclawAbsent: false, localIndex: "" }));
vi.mock("@/lib/openclaw-config", () => ({ openclawIsAbsent: () => edition.openclawAbsent }));
vi.mock("@/lib/memory-index-local", () => ({
  get LOCAL_INDEX_PATH() {
    return edition.localIndex;
  },
}));
const writer = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/memory-shard-writer", () => ({
  memoryShardWriter: async () => (writer.ok ? { ok: true, by: "owner" } : { ok: false, response: new Response("{}", { status: 403 }) }),
}));

import {
  INDEX_IN_RAM_KEY,
  INDEX_IN_RAM_STOPPED_KEY,
  WARM_INTERVAL_MS,
  _setWarmDepsForTests,
  indexFiles,
  memAvailableBytes,
  readIndexInRam,
  setIndexInRam,
  startIndexInRamIfOn,
  warmCommand,
  warmOnce,
  warming,
} from "@/lib/memory-shard-ram";
import { GET as ramGET, POST as ramPOST } from "@/app/setup-api/clawkeep/memory/ram/route";

const GB = 1024 ** 3;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-shard-ram-"));
const prevState = process.env.OPENCLAW_STATE_DIR;
let n = 0;
let dir = "";

/** A child that never runs anything: what a cycle spawned, and whether it was ended. */
function fakeChild(): ChildProcess & { killed: boolean } {
  const child = new EventEmitter() as ChildProcess & { killed: boolean; exitCode: number | null };
  child.exitCode = null;
  child.killed = false;
  child.kill = (() => {
    child.killed = true;
    child.exitCode = 143;
    child.emit("exit", 143);
    return true;
  }) as ChildProcess["kill"];
  return child;
}

function file(rel: string, bytes: number): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(bytes, 1));
  return abs;
}

beforeEach(() => {
  config.values.clear();
  edition.openclawAbsent = false;
  writer.ok = true;
  dir = path.join(base, `case-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = path.join(dir, "openclaw");
  edition.localIndex = path.join(dir, "data", "memory-index", "index.sqlite");
});

afterEach(() => {
  _setWarmDepsForTests(null);
  vi.useRealTimers();
});

afterAll(() => {
  if (prevState === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = prevState;
  fs.chmodSync(base, 0o755);
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the index files", () => {
  it("are every agent's database and its WAL on the OpenClaw edition, ClawBox's own store without it; never a symlink", () => {
    const a = file("openclaw/agents/main/agent/openclaw-agent.sqlite", 10);
    const aw = file("openclaw/agents/main/agent/openclaw-agent.sqlite-wal", 5);
    const b = file("openclaw/agents/work/agent/openclaw-agent.sqlite", 7);
    file("openclaw/agents/work/agent/sessions.json", 3);
    const elsewhere = file("elsewhere.sqlite", 4);
    fs.mkdirSync(path.join(dir, "openclaw/agents/linked/agent"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(dir, "openclaw/agents/linked/agent/openclaw-agent.sqlite"));
    expect(indexFiles()).toEqual([a, aw, b]);
    edition.openclawAbsent = true;
    expect(indexFiles()).toEqual([]);
    const own = file("data/memory-index/index.sqlite", 9);
    expect(indexFiles()).toEqual([own]);
  });

  it("are read with plain cat, each twice in a row, at the lowest CPU and I/O priority", () => {
    expect(warmCommand(["/a.sqlite", "/a.sqlite-wal"])).toEqual({
      command: "nice",
      args: ["-n", "19", "ionice", "-c", "3", "cat", "--", "/a.sqlite", "/a.sqlite", "/a.sqlite-wal", "/a.sqlite-wal"],
    });
    expect(memAvailableBytes("MemTotal:  7789568 kB\nMemAvailable:    5319992 kB\n")).toBe(5319992 * 1024);
    expect(memAvailableBytes(null)).toBeNull();
  });
});

describe("keep the index in RAM", () => {
  it("is off by default and does nothing: no reading at boot, nothing spawned", async () => {
    const spawn = vi.fn(() => fakeChild());
    _setWarmDepsForTests({ files: () => [file("a.sqlite", 10)], memAvailable: () => 4 * GB, spawn });
    expect((await readIndexInRam()).on).toBe(false);
    await startIndexInRamIfOn();
    expect(warming()).toBe(false);
    await warmOnce();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("on, reads the files now and every two minutes; off stops the reading and ends one in progress", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const children: Array<ReturnType<typeof fakeChild>> = [];
    const spawn = vi.fn(() => {
      const c = fakeChild();
      children.push(c);
      return c;
    });
    const f = file("a.sqlite", 10);
    _setWarmDepsForTests({ files: () => [f], memAvailable: () => 4 * GB, spawn });
    const on = await setIndexInRam(true);
    expect(on).toMatchObject({ ok: true, state: { on: true, bytes: 10, files: 1, stopped: null } });
    expect(config.values.get(INDEX_IN_RAM_KEY)).toBe(true);
    expect(warming()).toBe(true);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(spawn).toHaveBeenCalledWith("nice", ["-n", "19", "ionice", "-c", "3", "cat", "--", f, f]);
    // The last read still running: the next cycle starts none beside it.
    await vi.advanceTimersByTimeAsync(WARM_INTERVAL_MS);
    expect(spawn).toHaveBeenCalledTimes(1);
    (children[0] as { exitCode: number | null }).exitCode = 0;
    children[0].emit("exit", 0);
    await vi.advanceTimersByTimeAsync(WARM_INTERVAL_MS);
    expect(spawn).toHaveBeenCalledTimes(2);
    const off = await setIndexInRam(false);
    expect(off).toMatchObject({ ok: true, state: { on: false } });
    expect(warming()).toBe(false);
    expect(children[1].killed).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * WARM_INTERVAL_MS);
    expect(spawn).toHaveBeenCalledTimes(2);
    // Left on at a restart: the boot layer starts it again.
    config.values.set(INDEX_IN_RAM_KEY, true);
    await startIndexInRamIfOn();
    expect(warming()).toBe(true);
  });

  it("is refused, and nothing written, while the files are more than half of MemAvailable or MemAvailable is unknown", async () => {
    const spawn = vi.fn(() => fakeChild());
    const f = file("a.sqlite", 600);
    _setWarmDepsForTests({ files: () => [f], memAvailable: () => 1000, spawn });
    expect(await setIndexInRam(true)).toMatchObject({ ok: false, refusal: "too_big", state: { on: false, bytes: 600, availableBytes: 1000 } });
    _setWarmDepsForTests({ files: () => [f], memAvailable: () => null, spawn });
    expect(await setIndexInRam(true)).toMatchObject({ ok: false, refusal: "memory_unknown" });
    expect(config.values.has(INDEX_IN_RAM_KEY)).toBe(false);
    expect(warming()).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    // Exactly half still fits.
    _setWarmDepsForTests({ files: () => [f], memAvailable: () => 1200, spawn });
    expect(await setIndexInRam(true)).toMatchObject({ ok: true });
  });

  it("switches itself off, with the reason recorded, once the files no longer fit; on again clears the reason", async () => {
    let available = 4 * GB;
    const spawn = vi.fn(() => fakeChild());
    const f = file("a.sqlite", 600);
    _setWarmDepsForTests({ files: () => [f], memAvailable: () => available, spawn, now: () => new Date("2026-11-28T12:00:00Z") });
    await setIndexInRam(true);
    available = 1000;
    await warmOnce();
    expect(warming()).toBe(false);
    expect(config.values.get(INDEX_IN_RAM_KEY)).toBe(false);
    expect((await readIndexInRam()).stopped).toEqual({ reason: "too_big", bytes: 600, availableBytes: 1000, at: "2026-11-28T12:00:00.000Z" });
    available = 4 * GB;
    expect((await setIndexInRam(true)).state.stopped).toBeNull();
    expect(config.values.get(INDEX_IN_RAM_STOPPED_KEY)).toBeNull();
  });

  it("stops when switched off by any other way than the route", async () => {
    const spawn = vi.fn(() => fakeChild());
    _setWarmDepsForTests({ files: () => [file("a.sqlite", 10)], memAvailable: () => 4 * GB, spawn });
    await setIndexInRam(true);
    config.values.set(INDEX_IN_RAM_KEY, false);
    await warmOnce();
    expect(warming()).toBe(false);
  });

  it("only ever reads the files: a real cycle over a read-only file in a read-only folder leaves both as they were", async () => {
    const f = file("ro/openclaw-agent.sqlite", 64 * 1024);
    const before = fs.statSync(f);
    const bytes = fs.readFileSync(f);
    fs.chmodSync(f, 0o444);
    fs.chmodSync(path.dirname(f), 0o555);
    try {
      const exits: Array<number | null> = [];
      // The box's own command, run for real; only its exit is watched.
      const spawn = (command: string, args: string[]) => {
        const child = realSpawn(command, args, { stdio: "ignore" });
        child.on("exit", (code) => exits.push(code));
        return child;
      };
      _setWarmDepsForTests({ files: () => [f], memAvailable: () => 4 * GB, spawn });
      await setIndexInRam(true);
      await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 10_000 });
      const after = fs.statSync(f);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).toBe(before.size);
      expect(after.mode & 0o777).toBe(0o444);
      expect(fs.readdirSync(path.dirname(f))).toEqual(["openclaw-agent.sqlite"]);
      expect(fs.readFileSync(f).equals(bytes)).toBe(true);
    } finally {
      await setIndexInRam(false);
      fs.chmodSync(path.dirname(f), 0o755);
      fs.chmodSync(f, 0o644);
    }
  });
});

describe("clawkeep/memory/ram", () => {
  it("answers the state, refuses an over-limit switch 409 too_big with nothing written, and refuses a stranger", async () => {
    const f = file("a.sqlite", 600);
    _setWarmDepsForTests({ files: () => [f], memAvailable: () => 1000, spawn: vi.fn(() => fakeChild()) });
    expect(await (await ramGET()).json()).toMatchObject({ on: false, bytes: 600, files: 1, availableBytes: 1000, stopped: null });
    const post = (body: unknown) => ramPOST(new Request("http://127.0.0.1/setup-api/clawkeep/memory/ram", { method: "POST", body: JSON.stringify(body) }));
    const refused = await post({ on: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "too_big", on: false, bytes: 600 });
    expect((await post({ on: "yes" })).status).toBe(400);
    _setWarmDepsForTests({ files: () => [f], memAvailable: () => 4 * GB, spawn: vi.fn(() => fakeChild()) });
    expect(await (await post({ on: true })).json()).toMatchObject({ on: true });
    expect(await (await post({ on: false })).json()).toMatchObject({ on: false });
    writer.ok = false;
    expect((await post({ on: true })).status).toBe(403);
  });
});
