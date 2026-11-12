// @vitest-environment node
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
 * No case reads the real /proc or the real file system: the probes are
 * injected.
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
interface DropModule {
  CAPABILITY_DROP_COMMAND: string;
  CAPABILITY_DROP_ARGS: readonly string[];
  SETPRIV_PATH: string;
  withCapabilityDrop: (
    bin: string,
    argv: readonly string[],
    opts: { label: string; env?: Record<string, string | undefined>; probes?: Partial<Probes> },
  ) => { bin: string; argv: readonly string[]; dropped: boolean };
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
    const r = withCapabilityDrop("cloudflared", argv, {
      label: "a public app link's tunnel",
      env: { PATH: "/usr/bin:/bin" },
      probes: probes(NONE, [SETPRIV, "/usr/bin/cloudflared"]),
    });
    expect(r).toEqual({ bin: "cloudflared", argv, dropped: false });
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
    expect(r).toEqual({
      bin: SETPRIV,
      argv: [...DROP, "/usr/bin/bash", "/x/start-llamacpp.sh", "a"],
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
    expect(r).toEqual({ bin: SETPRIV, argv: [...DROP, "/opt/tools/cloudflared", ...argv], dropped: true });
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
    const r = withCapabilityDrop("cloudflared", argv, {
      label: "the tunnel route's quick tunnel",
      env: { PATH: "/usr/bin" },
      probes: probes(HELD, ["/usr/bin/cloudflared"]),
    });
    expect(r).toEqual({ bin: "cloudflared", argv, dropped: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "[capability-drop] setpriv not found: the tunnel route's quick tunnel starts with the web server's network capabilities",
    );
  });

  it("starts unchanged, with one warning, when a bare name is on no PATH entry", async () => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const r = withCapabilityDrop("cloudflared", argv, {
      label: "the tunnel route's quick tunnel",
      env: { PATH: "/usr/bin:/bin" },
      probes: probes(HELD, [SETPRIV]),
    });
    expect(r).toEqual({ bin: "cloudflared", argv, dropped: false });
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
    expect(r).toEqual({ bin: "/usr/local/bin/cloudflared", argv, dropped: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "[capability-drop] a public app link's tunnel: /usr/local/bin/cloudflared not found, started without the drop",
    );
  });

  it.each([
    ["the status cannot be read", () => { throw new Error("EACCES"); }],
    ["the status has no CapAmb line", () => "Name:\tnode\nCapEff:\t0000000000003400\n"],
    ["the CapAmb value is not hex", () => "CapAmb:\tzzzz\n"],
  ])("starts unchanged and says nothing when %s", async (_why, readStatus) => {
    const { withCapabilityDrop } = await load();
    const warn = warns();
    const r = withCapabilityDrop("bash", ["s"], {
      label: "the local chat server",
      env: { PATH: "/usr/bin" },
      probes: { readStatus, isExecutable: () => true },
    });
    expect(r).toEqual({ bin: "bash", argv: ["s"], dropped: false });
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

  it("drops with exactly the coding runner's four arguments", async () => {
    const mod = await load();
    expect(mod.CAPABILITY_DROP_ARGS).toEqual(DROP);
    expect(mod.CAPABILITY_DROP_COMMAND).toBe("setpriv");
    expect(mod.SETPRIV_PATH).toBe(SETPRIV);
  });
});

describe("one implementation", () => {
  it("answers every case the same through both entry points", async () => {
    const ts = await loadTs();
    const cjs = await loadCjs();
    expect(ts.CAPABILITY_DROP_COMMAND).toBe(cjs.CAPABILITY_DROP_COMMAND);
    expect(ts.CAPABILITY_DROP_ARGS).toEqual(cjs.CAPABILITY_DROP_ARGS);
    expect(ts.SETPRIV_PATH).toBe(cjs.SETPRIV_PATH);
    const cases: [string, string[], { label: string; env?: Record<string, string | undefined>; probes: Probes }][] = [
      ["bash", ["s"], { label: "a", env: { PATH: "/usr/bin" }, probes: probes(NONE, [SETPRIV, "/usr/bin/bash"]) }],
      ["bash", ["s"], { label: "b", env: { PATH: "/usr/bin" }, probes: probes(HELD, [SETPRIV, "/usr/bin/bash"]) }],
      ["bash", ["s"], { label: "c", env: { PATH: "/usr/bin" }, probes: probes(HELD, ["/usr/bin/bash"]) }],
      ["bash", ["s"], { label: "d", env: { PATH: "/usr/bin" }, probes: probes(HELD, [SETPRIV]) }],
      ["/abs/hf", ["download"], { label: "e", probes: probes(HELD, [SETPRIV]) }],
      ["/abs/hf", ["download"], { label: "f", probes: probes(HELD, [SETPRIV, "/abs/hf"]) }],
      ["bash", ["s"], { label: "g", probes: probes(() => { throw new Error("x"); }, [SETPRIV]) }],
    ];
    for (const [bin, argv, opts] of cases) {
      const warn = warns();
      const a = ts.withCapabilityDrop(bin, argv, opts);
      const aWarns = warn.mock.calls.map((c) => c[0]);
      warn.mockClear();
      const b = cjs.withCapabilityDrop(bin, argv, opts);
      const bWarns = warn.mock.calls.map((c) => c[0]);
      warn.mockRestore();
      expect(a, opts.label).toEqual(b);
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
