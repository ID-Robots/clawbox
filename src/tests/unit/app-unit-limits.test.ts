/**
 * @vitest-environment node
 *
 * The app servers the agent runs as its own user units get the same memory
 * caps ClawBox gives the scopes it starts (src/lib/app-unit-limits.ts).
 * Everything systemd and /proc would say is faked: the module is judged on
 * which units it asks systemd to cap, and on which it leaves alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveEnv } from "@/tests/helpers/env";
import fs from "fs";
import os from "os";
import path from "path";
import { appMemoryLimits } from "@/lib/box-memory-policy";
import { APP_CPU_WEIGHT, APP_IO_WEIGHT } from "@/lib/app-server-start";
import { capForeignAppServers, foreignUserServiceOf } from "@/lib/app-unit-limits";
import { resolveBin, type ChildResult } from "@/lib/child-run";

const ok = (stdout: string): ChildResult => ({ code: 0, stdout, stderr: "", signal: null, timedOut: false, startFailed: false });
const failed = (stderr = "no"): ChildResult => ({ code: 1, stdout: "", stderr, signal: null, timedOut: false, startFailed: false });

/** Where the box's systemctl is: the pass hands runChild this absolute path, never the bare name. */
const SYSTEMCTL = "/usr/bin/systemctl";
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
function fakeBox(input: { ss?: Record<number, ChildResult>; memoryMax?: Record<string, string>; restart?: Record<string, string>; proc: Record<number, { cwd: string; cgroup: string }>; setFails?: boolean }) {
  const calls: string[][] = [];
  const envs: Record<string, string>[] = [];
  const run = async (bin: string, args: string[], opts: { env: Record<string, string> }): Promise<ChildResult> => {
    if (bin === "ss") {
      const port = Number(/sport = :(\d+)/.exec(args[args.length - 1])?.[1]);
      return input.ss?.[port] ?? ok("");
    }
    calls.push([bin, ...args]);
    envs.push(opts.env);
    // `show -p MemoryMax -p Restart --value <unit>`: one line per property, in that order.
    if (args[1] === "show") return ok((input.memoryMax?.[args[7]] ?? "infinity") + "\n" + (input.restart?.[args[7]] ?? "on-failure") + "\n");
    if (args[1] === "set-property") return input.setFails ? failed("Failed to set unit properties") : ok("");
    return failed();
  };
  const proc = {
    cwd: async (pid: number) => input.proc[pid]?.cwd ?? null,
    cgroup: async (pid: number) => input.proc[pid]?.cgroup ?? null,
  };
  return { run, proc, calls, envs, setCalls: () => calls.filter((c) => c[2] === "set-property") };
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

    const capped = await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, systemctl: SYSTEMCTL, env: {} });

    const limits = appMemoryLimits();
    expect(capped).toEqual(["audiobook-player-app.service"]);
    expect(box.setCalls()).toEqual([[
      SYSTEMCTL, "--user", "set-property", "audiobook-player-app.service",
      `MemoryHigh=${limits.high}`, `MemoryMax=${limits.max}`, `CPUWeight=${APP_CPU_WEIGHT}`, `IOWeight=${APP_IO_WEIGHT}`,
    ]]);
  });

  it("starts systemctl by its absolute path, the only form runChild permits for it", async () => {
    // The first pass shipped the bare name: runChild's allowlist has no
    // "systemctl", every call came back "command not permitted", and the pass
    // read the refusal as "already capped" — nothing was ever capped.
    expect(resolveBin("systemctl")).toBeNull();
    expect(resolveBin(SYSTEMCTL)).toBe(SYSTEMCTL);
    const dir = path.join(base, "audiobook-player");
    registerApp("audiobook-player", 4240, dir);
    const box = fakeBox({ ss: { 4240: ok(ssRow(4240, 501)) }, proc: { 501: { cwd: dir, cgroup: USER_UNIT } } });

    await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, systemctl: SYSTEMCTL, env: {} });

    expect(box.calls.map((c) => c[0])).toEqual([SYSTEMCTL, SYSTEMCTL]);
  });

  it("resolves systemctl on the PATH itself when nothing is handed in, and gives the runner that path", async () => {
    const restore = saveEnv("PATH");
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "app-caps-bin-"));
    const shim = path.join(bin, "systemctl");
    fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = bin;
    try {
      const dir = path.join(base, "audiobook-player");
      registerApp("audiobook-player", 4240, dir);
      const box = fakeBox({ ss: { 4240: ok(ssRow(4240, 501)) }, proc: { 501: { cwd: dir, cgroup: USER_UNIT } } });

      const capped = await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, env: {} });

      expect(capped).toEqual(["audiobook-player-app.service"]);
      expect(box.calls.map((c) => c[0])).toEqual([shim, shim]);
    } finally {
      restore();
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("gives a unit with no Restart= MemoryHigh only, so the cap cannot leave it down", async () => {
    // systemd's default. A MemoryMax would OOM-kill a unit already past it,
    // and with nothing to bring it back the next pass finds no listener.
    const dir = path.join(base, "audiobook-player");
    registerApp("audiobook-player", 4240, dir);
    const box = fakeBox({ ss: { 4240: ok(ssRow(4240, 501)) }, restart: { "audiobook-player-app.service": "no" }, proc: { 501: { cwd: dir, cgroup: USER_UNIT } } });

    const capped = await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, systemctl: SYSTEMCTL, env: {} });

    const limits = appMemoryLimits();
    expect(capped).toEqual(["audiobook-player-app.service"]);
    expect(box.setCalls()).toEqual([[
      SYSTEMCTL, "--user", "set-property", "audiobook-player-app.service",
      `MemoryHigh=${limits.high}`, `CPUWeight=${APP_CPU_WEIGHT}`, `IOWeight=${APP_IO_WEIGHT}`,
    ]]);
  });

  it("caps nothing, and says so, when systemctl cannot be found", async () => {
    const dir = path.join(base, "audiobook-player");
    registerApp("audiobook-player", 4240, dir);
    const box = fakeBox({ ss: { 4240: ok(ssRow(4240, 501)) }, proc: { 501: { cwd: dir, cgroup: USER_UNIT } } });

    const capped = await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, systemctl: null, env: {} });

    expect(capped).toEqual([]);
    expect(box.calls).toEqual([]);
  });

  it("hands systemctl a runtime dir even when the web server's environment has none", async () => {
    // clawbox-setup.service is a SYSTEM service: its environment carries neither
    // XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS, and `systemctl --user`
    // without the runtime dir fails on every call.
    const restore = saveEnv("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS");
    delete process.env.XDG_RUNTIME_DIR;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      const dir = path.join(base, "audiobook-player");
      registerApp("audiobook-player", 4240, dir);
      const box = fakeBox({ ss: { 4240: ok(ssRow(4240, 501)) }, proc: { 501: { cwd: dir, cgroup: USER_UNIT } } });

      await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, systemctl: SYSTEMCTL, env: {} });

      expect(box.envs).toHaveLength(2);
      for (const env of box.envs) expect(env.XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
    } finally {
      restore();
    }
  });

  it("leaves a unit that already has a MemoryMax alone", async () => {
    const dir = path.join(base, "audiobook-player");
    registerApp("audiobook-player", 4240, dir);
    const box = fakeBox({
      ss: { 4240: ok(ssRow(4240, 501)) },
      memoryMax: { "audiobook-player-app.service": "2147483648" },
      proc: { 501: { cwd: dir, cgroup: USER_UNIT } },
    });

    expect(await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, systemctl: SYSTEMCTL, env: {} })).toEqual([]);
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

    expect(await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, systemctl: SYSTEMCTL, env: {} })).toEqual([]);
    expect(box.calls).toEqual([]);
  });

  it("skips a listener that does not run from the app's folder", async () => {
    const dir = path.join(base, "audiobook-player");
    registerApp("audiobook-player", 4240, dir);
    const box = fakeBox({ ss: { 4240: ok(ssRow(4240, 501)) }, proc: { 501: { cwd: path.join(base, "elsewhere"), cgroup: USER_UNIT } } });

    expect(await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, systemctl: SYSTEMCTL, env: {} })).toEqual([]);
    expect(box.calls).toEqual([]);
  });

  it("is off with CLAWBOX_APP_CAPS=0", async () => {
    const dir = path.join(base, "audiobook-player");
    registerApp("audiobook-player", 4240, dir);
    const box = fakeBox({ ss: { 4240: ok(ssRow(4240, 501)) }, proc: { 501: { cwd: dir, cgroup: USER_UNIT } } });

    expect(await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, systemctl: SYSTEMCTL, env: { CLAWBOX_APP_CAPS: "0" } })).toEqual([]);
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

    expect(await capForeignAppServers({ webappsDir: webapps, run: box.run, proc: box.proc, systemctl: SYSTEMCTL, env: {} })).toEqual([]);
    expect(box.setCalls()).toHaveLength(1);
  });

  it("answers nothing when there is no webapps folder", async () => {
    const box = fakeBox({ proc: {} });
    expect(await capForeignAppServers({ webappsDir: path.join(base, "missing"), run: box.run, proc: box.proc, systemctl: SYSTEMCTL, env: {} })).toEqual([]);
  });
});
