/**
 * @vitest-environment node
 *
 * The app servers the agent runs as its own user units get the same memory
 * caps ClawBox gives the scopes it starts (src/lib/app-unit-limits.ts).
 * Everything systemd and /proc would say is faked: the module is judged on
 * which units it asks systemd to cap, and on which it leaves alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { appMemoryLimits } from "@/lib/box-memory-policy";
import { APP_CPU_WEIGHT, APP_IO_WEIGHT } from "@/lib/app-server-start";
import { capForeignAppServers, foreignUserServiceOf } from "@/lib/app-unit-limits";
import type { ChildResult } from "@/lib/child-run";

const ok = (stdout: string): ChildResult => ({ code: 0, stdout, stderr: "", signal: null, timedOut: false, startFailed: false });
const failed = (stderr = "no"): ChildResult => ({ code: 1, stdout: "", stderr, signal: null, timedOut: false, startFailed: false });

const USER_UNIT = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/audiobook-player-app.service\n";
const OWN_SCOPE = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/clawbox-app-todo-abc123.scope\n";
const SYSTEM_UNIT = "0::/system.slice/clawbox-setup.service\n";

/** One `ss -H -ltnp` row for a loopback listener held by `pid`. */
const ssRow = (port: number, pid: number) => `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:* users:(("bun",pid=${pid},fd=12))\n`;

let base: string;
let webapps: string;

function registerApp(id: string, port: number, directory: string): void {
  fs.mkdirSync(path.join(webapps, id), { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(webapps, id, "meta.json"), JSON.stringify({ name: id, port, directory }));
}

/** A fake box: what `ss` and `systemctl` answer, what /proc says per pid, and every systemctl call made. */
function fakeBox(input: { ss?: Record<number, ChildResult>; memoryMax?: Record<string, string>; proc: Record<number, { cwd: string; cgroup: string }>; setFails?: boolean }) {
  const calls: string[][] = [];
  const run = async (bin: string, args: string[]): Promise<ChildResult> => {
    if (bin === "ss") {
      const port = Number(/sport = :(\d+)/.exec(args[args.length - 1])?.[1]);
      return input.ss?.[port] ?? ok("");
    }
    calls.push([bin, ...args]);
    if (args[1] === "show") return ok((input.memoryMax?.[args[5]] ?? "infinity") + "\n");
    if (args[1] === "set-property") return input.setFails ? failed("Failed to set unit properties") : ok("");
    return failed();
  };
  const proc = {
    cwd: async (pid: number) => input.proc[pid]?.cwd ?? null,
    cgroup: async (pid: number) => input.proc[pid]?.cgroup ?? null,
  };
  return { run, proc, calls, setCalls: () => calls.filter((c) => c[2] === "set-property") };
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "app-caps-"));
  webapps = path.join(base, "webapps");
  fs.mkdirSync(webapps);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("foreignUserServiceOf", () => {
  it("names a user .service and nothing else", () => {
    expect(foreignUserServiceOf(USER_UNIT)).toBe("audiobook-player-app.service");
    expect(foreignUserServiceOf(OWN_SCOPE)).toBeNull();
    expect(foreignUserServiceOf(SYSTEM_UNIT)).toBeNull();
    expect(foreignUserServiceOf("0::/user.slice/user-1000.slice/user@1000.service/app.slice/clawbox-gateway.service\n")).toBeNull();
    expect(foreignUserServiceOf("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome\\x2dterminal.service\n")).toBeNull();
    expect(foreignUserServiceOf(null)).toBeNull();
    expect(foreignUserServiceOf("")).toBeNull();
  });
});

describe("capForeignAppServers", () => {
  it("caps a foreign user .service once, with the same limits a scope gets", async () => {
    const dir = path.join(base, "audiobook-player");
    registerApp("audiobook-player", 4240, dir);
    const box = fakeBox({ ss: { 4240: ok(ssRow(4240, 501)) }, proc: { 501: { cwd: dir, cgroup: USER_UNIT } } });

    const capped = await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, env: {} });

    const limits = appMemoryLimits();
    expect(capped).toEqual(["audiobook-player-app.service"]);
    expect(box.setCalls()).toEqual([[
      "systemctl", "--user", "set-property", "audiobook-player-app.service",
      `MemoryHigh=${limits.high}`, `MemoryMax=${limits.max}`, `CPUWeight=${APP_CPU_WEIGHT}`, `IOWeight=${APP_IO_WEIGHT}`,
    ]]);
  });

  it("leaves a unit that already has a MemoryMax alone", async () => {
    const dir = path.join(base, "audiobook-player");
    registerApp("audiobook-player", 4240, dir);
    const box = fakeBox({
      ss: { 4240: ok(ssRow(4240, 501)) },
      memoryMax: { "audiobook-player-app.service": "2147483648" },
      proc: { 501: { cwd: dir, cgroup: USER_UNIT } },
    });

    expect(await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, env: {} })).toEqual([]);
    expect(box.setCalls()).toEqual([]);
  });

  it("never touches a clawbox-app scope or a system unit", async () => {
    const todo = path.join(base, "todo");
    const quake = path.join(base, "quake2");
    registerApp("todo", 4232, todo);
    registerApp("quake2", 4231, quake);
    const box = fakeBox({
      ss: { 4232: ok(ssRow(4232, 601)), 4231: ok(ssRow(4231, 602)) },
      proc: { 601: { cwd: todo, cgroup: OWN_SCOPE }, 602: { cwd: quake, cgroup: SYSTEM_UNIT } },
    });

    expect(await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, env: {} })).toEqual([]);
    expect(box.calls).toEqual([]);
  });

  it("skips a listener that does not run from the app's folder", async () => {
    const dir = path.join(base, "audiobook-player");
    registerApp("audiobook-player", 4240, dir);
    const box = fakeBox({ ss: { 4240: ok(ssRow(4240, 501)) }, proc: { 501: { cwd: path.join(base, "elsewhere"), cgroup: USER_UNIT } } });

    expect(await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, env: {} })).toEqual([]);
    expect(box.calls).toEqual([]);
  });

  it("is off with CLAWBOX_APP_CAPS=0", async () => {
    const dir = path.join(base, "audiobook-player");
    registerApp("audiobook-player", 4240, dir);
    const box = fakeBox({ ss: { 4240: ok(ssRow(4240, 501)) }, proc: { 501: { cwd: dir, cgroup: USER_UNIT } } });

    expect(await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, env: { CLAWBOX_APP_CAPS: "0" } })).toEqual([]);
    expect(box.calls).toEqual([]);
  });

  it("survives ss failing, a port nobody listens on, a set-property that fails and a meta that is not JSON", async () => {
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    const c = path.join(base, "c");
    registerApp("a", 4301, a);
    registerApp("b", 4302, b);
    registerApp("c", 4303, c);
    fs.mkdirSync(path.join(webapps, "broken"));
    fs.writeFileSync(path.join(webapps, "broken", "meta.json"), "{not json");
    const box = fakeBox({
      ss: { 4301: failed("ss: no"), 4302: ok(""), 4303: ok(ssRow(4303, 701)) },
      proc: { 701: { cwd: c, cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/c-app.service\n" } },
      setFails: true,
    });

    expect(await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, env: {} })).toEqual([]);
    expect(box.setCalls()).toHaveLength(1);
  });

  it("answers nothing when there is no webapps folder", async () => {
    const box = fakeBox({ proc: {} });
    expect(await capForeignAppServers({ webappsDir: path.join(base, "missing"), run: box.run, proc: box.proc, env: {} })).toEqual([]);
  });
});
