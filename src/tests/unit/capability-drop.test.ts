// @vitest-environment node
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_SERVER_SOURCE,
  WEB_SERVER_SETTINGS,
  stubWebServerSettings,
  withoutThem,
} from "@/tests/helpers/capability-drop";

/**
 * The capability drop for the long-running programs the web server starts
 * (the local chat server, the model library's download, both kinds of quick
 * tunnel). On the Jetson the web server holds CAP_NET_BIND_SERVICE,
 * CAP_NET_ADMIN and CAP_NET_RAW as AMBIENT capabilities, which every child
 * keeps across execve; these programs need none of them.
 *
 * One implementation, scripts/capability-drop.js, which production-server.js's
 * CommonJS scripts require and src/lib/capability-drop.ts re-exports. Every
 * case runs through both entry points, so the TypeScript sites and the public
 * app links cannot judge the same host differently.
 *
 * The probes are injected, except in "the real probes" below, which run them
 * against files they create and this process's own status.
 */

const REPO = path.resolve(__dirname, "../../..");
const CJS_PATH = path.join(REPO, "scripts", "capability-drop.js");
const TS_PATH = path.join(REPO, "src", "lib", "capability-drop.ts");

const DROP = ["--ambient-caps=-all", "--inh-caps=-all", "--no-new-privs", "--"];
const SETPRIV = "/usr/bin/setpriv";
const HELD = "Name:\tnode\nCapInh:\t0000000000000000\nCapAmb:\t0000000000003400\nNoNewPrivs:\t0\n";
const NONE = "Name:\tnode\nCapInh:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t0\n";

interface Probes {
  readStatus: () => string;
  isExecutable: (p: string) => boolean;
}
type Env = Record<string, string | undefined>;
interface DropModule {
  CAPABILITY_DROP_COMMAND: string;
  CAPABILITY_DROP_ARGS: readonly string[];
  SETPRIV_PATH: string;
  WEB_SERVER_OWN_SETTINGS: readonly string[];
  withoutWebServerSettings: (env: Env) => Env;
  withCapabilityDrop: (
    bin: string,
    argv: readonly string[],
    opts: { label: string; env?: Env; probes?: Partial<Probes> },
  ) => { bin: string; argv: readonly string[]; env: Env | undefined; dropped: boolean };
}

const loadTs = async () => (await import("@/lib/capability-drop")) as unknown as DropModule;
const loadCjs = async () => createRequire(import.meta.url)("../../../scripts/capability-drop.js") as DropModule;

function probes(status: string | (() => string), executables: string[]): Probes {
  return {
    readStatus: typeof status === "function" ? status : () => status,
    isExecutable: (p: string) => executables.includes(p),
  };
}

function warns() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

afterEach(() => {
  vi.unstubAllEnvs();
});


describe.each([
  ["the TypeScript entry", loadTs],
  ["the CommonJS module", loadCjs],
])("withCapabilityDrop, through %s", (_name, load) => {
  const argv = ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4000"];

  it("spawns exactly as today on a host whose web server holds no ambient capabilities", async () => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const env = { PATH: "/usr/bin:/bin" };
    const r = withCapabilityDrop("cloudflared", argv, {
      label: "a public app link's tunnel",
      env,
      probes: probes(NONE, [SETPRIV, "/usr/bin/cloudflared"]),
    });
    expect(r).toStrictEqual({ bin: "cloudflared", argv, env, dropped: false });
    expect(r.env).toBe(env);
    expect(warn).not.toHaveBeenCalled();
  });

  it("starts the program through setpriv when the web server holds them", async () => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const r = withCapabilityDrop("bash", ["/x/start-llamacpp.sh", "a"], {
      label: "the local chat server",
      env: { PATH: "/usr/bin:/bin" },
      probes: probes(HELD, [SETPRIV, "/usr/bin/bash", "/bin/bash"]),
    });
    expect(r).toStrictEqual({
      bin: SETPRIV,
      argv: [...DROP, "/usr/bin/bash", "/x/start-llamacpp.sh", "a"],
      env: { PATH: "/usr/bin:/bin" },
      dropped: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes an executable absolute target as it is", async () => {
    const { withCapabilityDrop } = await load();
    const r = withCapabilityDrop("/opt/tools/cloudflared", argv, {
      label: "a public app link's tunnel",
      probes: probes(HELD, [SETPRIV, "/opt/tools/cloudflared"]),
    });
    expect([r.bin, r.argv, r.dropped]).toEqual([SETPRIV, [...DROP, "/opt/tools/cloudflared", ...argv], true]);
  });

  it("takes the first PATH entry that holds the program", async () => {
    const { withCapabilityDrop } = await load();
    const r = withCapabilityDrop("hf", ["download"], {
      label: "the model download",
      env: { PATH: "/first:/second" },
      probes: probes(HELD, [SETPRIV, "/first/hf", "/second/hf"]),
    });
    expect(r.argv).toEqual([...DROP, "/first/hf", "download"]);
  });

  it("starts unchanged, with one warning naming the program, when setpriv is missing", async () => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const env = { PATH: "/usr/bin" };
    const r = withCapabilityDrop("cloudflared", argv, {
      label: "the tunnel route's quick tunnel",
      env,
      probes: probes(HELD, ["/usr/bin/cloudflared"]),
    });
    expect(r).toStrictEqual({ bin: "cloudflared", argv, env, dropped: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "[capability-drop] setpriv not found: the tunnel route's quick tunnel starts with the web server's network capabilities",
    );
  });

  it("starts unchanged, with one warning, when a bare name is on no PATH entry", async () => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const env = { PATH: "/usr/bin:/bin" };
    const r = withCapabilityDrop("cloudflared", argv, {
      label: "the tunnel route's quick tunnel",
      env,
      probes: probes(HELD, [SETPRIV]),
    });
    expect(r).toStrictEqual({ bin: "cloudflared", argv, env, dropped: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "[capability-drop] the tunnel route's quick tunnel: cloudflared not found, started without the drop",
    );
  });

  it("starts unchanged, with one warning, when an absolute target is not executable", async () => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const r = withCapabilityDrop("/usr/local/bin/cloudflared", argv, {
      label: "a public app link's tunnel",
      probes: probes(HELD, [SETPRIV]),
    });
    // Unwrapped, so a missing program still fails with Node's own ENOENT
    // through the site's 'error' listener instead of setpriv's exit 127.
    expect(r).toStrictEqual({ bin: "/usr/local/bin/cloudflared", argv, env: undefined, dropped: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "[capability-drop] a public app link's tunnel: /usr/local/bin/cloudflared not found, started without the drop",
    );
  });

  // exec reads an empty or relative PATH entry against the CHILD's working
  // directory, which the site may set (the chat server's cwd is the home
  // folder). A path resolved here against the web server's own directory could
  // start a different file behind setpriv, so the gate stops at such an entry
  // and the program starts unwrapped, found by Node exactly as before. An empty
  // PATH is one empty entry; with PATH unset exec searches a default list of its
  // own, which the gate does not guess.
  it.each([
    ["a relative PATH entry comes before the program", "tools:/usr/bin", 'PATH has the relative entry "tools" before any bash'],
    ["an empty PATH entry comes before the program", ":/usr/bin", "PATH has an empty entry before any bash"],
    ["PATH is empty", "", "PATH has an empty entry before any bash"],
    ["PATH is unset", undefined, "PATH is not set"],
  ])("starts unchanged, with one warning, when %s", async (_kind, PATH, why) => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const env = { PATH };
    const r = withCapabilityDrop("bash", ["s"], {
      label: "the local chat server",
      env,
      probes: probes(HELD, [SETPRIV, "tools/bash", "/usr/bin/bash", "bash"]),
    });
    expect(r).toStrictEqual({ bin: "bash", argv: ["s"], env, dropped: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(`[capability-drop] the local chat server: ${why}, started without the drop`);
  });

  it("still drops when a relative PATH entry comes only after the program's absolute match", async () => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const r = withCapabilityDrop("bash", ["s"], {
      label: "the local chat server",
      env: { PATH: "/usr/bin:tools:" },
      probes: probes(HELD, [SETPRIV, "/usr/bin/bash", "tools/bash"]),
    });
    expect(r).toStrictEqual({ bin: SETPRIV, argv: [...DROP, "/usr/bin/bash", "s"], env: { PATH: "/usr/bin:tools:" }, dropped: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("starts unchanged, with one warning, when the program is a relative path", async () => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const env = { PATH: "/usr/bin" };
    const r = withCapabilityDrop("bin/hf", ["download"], {
      label: "the model download",
      env,
      probes: probes(HELD, [SETPRIV, "bin/hf"]),
    });
    expect(r).toStrictEqual({ bin: "bin/hf", argv: ["download"], env, dropped: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("[capability-drop] the model download: bin/hf is a relative path, started without the drop");
  });

  it.each([
    ["the status cannot be read", () => { throw new Error("EACCES"); }],
    ["the status has no CapAmb line", () => "Name:\tnode\nCapEff:\t0000000000003400\n"],
    ["the CapAmb value is not hex", () => "CapAmb:\tzzzz\n"],
  ])("starts unchanged and says nothing when %s", async (_why, readStatus) => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const env = { PATH: "/usr/bin" };
    const r = withCapabilityDrop("bash", ["s"], {
      label: "the local chat server",
      env,
      probes: { readStatus, isExecutable: () => true },
    });
    expect(r).toStrictEqual({ bin: "bash", argv: ["s"], env, dropped: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("asks afresh at every call: nothing is cached", async () => {
    const { withCapabilityDrop } = await load();
    warns();
    const exes = ["/usr/bin/bash"];
    const p = probes(HELD, exes);
    const call = () => withCapabilityDrop("bash", [], { label: "the local chat server", env: { PATH: "/usr/bin" }, probes: p }).dropped;
    expect(call()).toBe(false);
    exes.push(SETPRIV);
    expect(call()).toBe(true);

    let status = NONE;
    const q = probes(() => status, [SETPRIV, "/usr/bin/bash"]);
    const again = () => withCapabilityDrop("bash", [], { label: "the local chat server", env: { PATH: "/usr/bin" }, probes: q }).dropped;
    expect(again()).toBe(false);
    status = HELD;
    expect(again()).toBe(true);
  });

  it("looks a bare name up in opts.env's PATH when given, process.env's otherwise", async () => {
    const { withCapabilityDrop } = await load();
    warns();
    const p = probes(HELD, [SETPRIV, "/given/tool", "/inherited/tool"]);
    vi.stubEnv("PATH", "/inherited");
    expect(withCapabilityDrop("tool", [], { label: "x", env: { PATH: "/given" }, probes: p }).argv).toEqual([...DROP, "/given/tool"]);
    expect(withCapabilityDrop("tool", [], { label: "x", probes: p }).argv).toEqual([...DROP, "/inherited/tool"]);
  });

  it("gives a dropped start the child's environment without the web server's own settings", async () => {
    const { withCapabilityDrop } = await load();
    const rest = {
      PATH: "/usr/bin",
      HOME: "/home/clawbox",
      LLAMACPP_PID_PATH: "/data/llamacpp/server.pid",
      HF_HUB_DISABLE_PROGRESS_BARS: "1",
    };
    const env = { ...rest, ...Object.fromEntries(WEB_SERVER_SETTINGS.map((key) => [key, `value-of-${key}`])) };
    const before = { ...env };
    const r = withCapabilityDrop("bash", ["s"], {
      label: "the local chat server",
      env,
      probes: probes(HELD, [SETPRIV, "/usr/bin/bash"]),
    });
    expect(r.dropped).toBe(true);
    expect(r.env).toStrictEqual(rest);
    // A copy: the site's own object is left as it was.
    expect(env).toStrictEqual(before);
  });

  it("takes a dropped start's environment from process.env when the site passes none, and leaves process.env as it is", async () => {
    const { withCapabilityDrop } = await load();
    stubWebServerSettings();
    vi.stubEnv("PATH", "/usr/bin");
    const r = withCapabilityDrop("cloudflared", argv, {
      label: "the tunnel route's quick tunnel",
      probes: probes(HELD, [SETPRIV, "/usr/bin/cloudflared"]),
    });
    expect(r.dropped).toBe(true);
    expect(Object.keys(r.env ?? {}).filter((key) => WEB_SERVER_SETTINGS.includes(key))).toEqual([]);
    expect(r.env).toStrictEqual(withoutThem(process.env));
    expect(WEB_SERVER_SETTINGS.filter((key) => process.env[key] === undefined)).toEqual([]);
  });

  it.each([
    ["the web server holds no ambient capabilities", probes(NONE, [SETPRIV, "/usr/bin/bash"])],
    ["setpriv is missing", probes(HELD, ["/usr/bin/bash"])],
    ["the program is not found", probes(HELD, [SETPRIV])],
  ])("hands back the very env it was given, settings and all, when %s", async (_why, p) => {
    const { withCapabilityDrop } = await load();
    warns();
    const env = { PATH: "/usr/bin", ...Object.fromEntries(WEB_SERVER_SETTINGS.map((key) => [key, `value-of-${key}`])) };
    const given = withCapabilityDrop("bash", ["s"], { label: "the local chat server", env, probes: p });
    expect(given.dropped).toBe(false);
    expect(given.env).toBe(env);
    // And none when it was given none, so that site's spawn carries no env.
    const none = withCapabilityDrop("bash", ["s"], { label: "the local chat server", probes: p });
    expect(none.env).toBeUndefined();
  });

  it("drops with exactly the coding runner's four arguments", async () => {
    const mod = await load();
    expect(mod.CAPABILITY_DROP_ARGS).toEqual(DROP);
    expect(mod.CAPABILITY_DROP_COMMAND).toBe("setpriv");
    expect(mod.SETPRIV_PATH).toBe(SETPRIV);
  });

  it("names exactly the settings production-server.js puts into its own environment", async () => {
    const mod = await load();
    expect(WEB_SERVER_SETTINGS.length).toBeGreaterThan(0);
    // A bulk write would add settings the list above cannot see.
    expect(PRODUCTION_SERVER_SOURCE).not.toMatch(/Object\.assign\(\s*process\.env\b/);
    expect([...mod.WEB_SERVER_OWN_SETTINGS].sort()).toEqual([...WEB_SERVER_SETTINGS].sort());
    const env = { PATH: "/usr/bin", ...Object.fromEntries(WEB_SERVER_SETTINGS.map((key) => [key, "x"])) };
    expect(mod.withoutWebServerSettings(env)).toStrictEqual({ PATH: "/usr/bin" });
    expect(Object.keys(env)).toHaveLength(WEB_SERVER_SETTINGS.length + 1);
  });
});

describe.each([
  ["the TypeScript entry", loadTs],
  ["the CommonJS module", loadCjs],
])("the real probes, through %s", (_name, load) => {
  it.skipIf(process.platform !== "linux" || !fs.existsSync(SETPRIV))(
    "drops for an executable file or a link to one, and not for a mode-0644 file or a folder",
    async () => {
      const { withCapabilityDrop } = await load();
      const warn = warns();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capability-drop-"));
      try {
        const exe = path.join(dir, "tool");
        fs.writeFileSync(exe, "#!/bin/sh\n");
        fs.chmodSync(exe, 0o755);
        const plain = path.join(dir, "plain");
        fs.writeFileSync(plain, "#!/bin/sh\n");
        fs.chmodSync(plain, 0o644);
        const link = path.join(dir, "link");
        fs.symlinkSync(exe, link);
        const folder = path.join(dir, "folder");
        fs.mkdirSync(folder);
        fs.chmodSync(folder, 0o755);

        // Only the status is injected: the file checks are the module's own.
        const ask = (bin: string, env?: Env) =>
          withCapabilityDrop(bin, ["x"], { label: "a program", env, probes: { readStatus: () => HELD } });
        expect([ask(exe).bin, ask(exe).argv, ask(exe).dropped]).toEqual([SETPRIV, [...DROP, exe, "x"], true]);
        expect([ask(link).argv, ask(link).dropped]).toEqual([[...DROP, link, "x"], true]);
        expect(ask("tool", { PATH: dir }).argv).toEqual([...DROP, exe, "x"]);
        warn.mockClear();
        expect(ask(plain).dropped).toBe(false);
        expect(ask(folder).dropped).toBe(false);
        expect(ask("plain", { PATH: dir }).dropped).toBe(false);
        expect(warn.mock.calls.map((c) => c[0])).toEqual([
          `[capability-drop] a program: ${plain} not found, started without the drop`,
          `[capability-drop] a program: ${folder} not found, started without the drop`,
          "[capability-drop] a program: plain not found, started without the drop",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux" || !fs.existsSync(SETPRIV))(
    "reads this process's own status file, and drops exactly when its CapAmb line holds a capability",
    async () => {
      const { withCapabilityDrop } = await load();
      warns();
      // No probes at all: the module's own read, answered here for that one
      // file (every other read goes through), so a status path or read that
      // went wrong would show as no drop.
      let status = HELD;
      const realRead = fs.readFileSync;
      const read = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
        file === "/proc/self/status"
          ? status
          : (realRead as (...a: unknown[]) => unknown)(file, ...rest)) as typeof fs.readFileSync);
      const ask = () => withCapabilityDrop(process.execPath, ["--version"], { label: "node" });
      expect(ask()).toMatchObject({ bin: SETPRIV, argv: [...DROP, process.execPath, "--version"], dropped: true });
      expect(read).toHaveBeenCalledWith("/proc/self/status", "utf8");
      status = NONE;
      expect(ask().dropped).toBe(false);
    },
  );
});

describe("one implementation", () => {
  it("answers every case the same through both entry points", async () => {
    const ts = await loadTs();
    const cjs = await loadCjs();
    expect(ts.CAPABILITY_DROP_COMMAND).toBe(cjs.CAPABILITY_DROP_COMMAND);
    expect(ts.CAPABILITY_DROP_ARGS).toEqual(cjs.CAPABILITY_DROP_ARGS);
    expect(ts.SETPRIV_PATH).toBe(cjs.SETPRIV_PATH);
    expect(ts.WEB_SERVER_OWN_SETTINGS).toEqual(cjs.WEB_SERVER_OWN_SETTINGS);
    const settings = Object.fromEntries(WEB_SERVER_SETTINGS.map((key) => [key, "x"]));
    const cases: [string, string[], { label: string; env?: Env; probes: Probes }][] = [
      ["bash", ["s"], { label: "a", env: { PATH: "/usr/bin" }, probes: probes(NONE, [SETPRIV, "/usr/bin/bash"]) }],
      ["bash", ["s"], { label: "b", env: { PATH: "/usr/bin" }, probes: probes(HELD, [SETPRIV, "/usr/bin/bash"]) }],
      ["bash", ["s"], { label: "c", env: { PATH: "/usr/bin" }, probes: probes(HELD, ["/usr/bin/bash"]) }],
      ["bash", ["s"], { label: "d", env: { PATH: "/usr/bin" }, probes: probes(HELD, [SETPRIV]) }],
      ["/abs/hf", ["download"], { label: "e", probes: probes(HELD, [SETPRIV]) }],
      ["/abs/hf", ["download"], { label: "f", probes: probes(HELD, [SETPRIV, "/abs/hf"]) }],
      ["bash", ["s"], { label: "g", probes: probes(() => { throw new Error("x"); }, [SETPRIV]) }],
      ["bash", ["s"], { label: "h", env: { PATH: "tools:/usr/bin" }, probes: probes(HELD, [SETPRIV, "tools/bash", "/usr/bin/bash"]) }],
      ["bash", ["s"], { label: "i", env: { PATH: ":/usr/bin" }, probes: probes(HELD, [SETPRIV, "/usr/bin/bash"]) }],
      ["bin/hf", ["download"], { label: "j", env: { PATH: "/usr/bin" }, probes: probes(HELD, [SETPRIV, "bin/hf"]) }],
      ["bash", ["s"], { label: "k", env: { PATH: "/usr/bin", ...settings }, probes: probes(HELD, [SETPRIV, "/usr/bin/bash"]) }],
      ["bash", ["s"], { label: "l", env: { PATH: "/usr/bin", ...settings }, probes: probes(NONE, [SETPRIV, "/usr/bin/bash"]) }],
      ["bash", ["s"], { label: "m", env: {}, probes: probes(HELD, [SETPRIV, "/usr/bin/bash"]) }],
    ];
    for (const [bin, argv, opts] of cases) {
      const warn = warns();
      const a = ts.withCapabilityDrop(bin, argv, opts);
      const aWarns = warn.mock.calls.map((c) => c[0]);
      warn.mockClear();
      const b = cjs.withCapabilityDrop(bin, argv, opts);
      const bWarns = warn.mock.calls.map((c) => c[0]);
      warn.mockRestore();
      expect(a, opts.label).toStrictEqual(b);
      expect(aWarns, opts.label).toEqual(bWarns);
    }
  });

  it("keeps the TypeScript entry a bare re-export, so no second copy of the gate can grow there", () => {
    const code = fs
      .readFileSync(TS_PATH, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/export\s*\{[^}]*withCapabilityDrop[^}]*\}\s*from\s*"\.\.\/\.\.\/scripts\/capability-drop\.js"/);
    expect(code).not.toMatch(/\bfunction\b/);
    expect(code).not.toContain("=>");
  });

  it("gives every fs call in the CommonJS module a turbopackIgnore hint and no built path", () => {
    // The module joins the server build through the TypeScript entry, and
    // Turbopack turns an fs call it can partly resolve into a glob over the
    // project (src/lib/runtime-path.ts). runtime-path-imports.test.ts scans
    // src/ only, so this file is checked here; CI's check-build-isolation.sh
    // is the proof.
    const source = fs.readFileSync(CJS_PATH, "utf-8");
    const calls = [...source.matchAll(/\bfs\.(\w+)\(([^\n]*)/g)];
    expect(calls.map((m) => m[1]).sort()).toEqual(["accessSync", "readFileSync", "statSync"]);
    for (const [call, , args] of calls) {
      expect(args, call).toMatch(/^\/\* turbopackIgnore: true \*\/ /);
      expect(args.replace(/^\/\* turbopackIgnore: true \*\/ /, ""), call).not.toMatch(/^(path\.|`)/);
    }
  });
});
