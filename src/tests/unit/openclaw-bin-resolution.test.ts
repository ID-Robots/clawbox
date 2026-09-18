import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 2026-09-18 — "Credential migration failed. The subscription sign-in was
 * rolled back" on every ClawBox AI sign-in, on a box with TWO OpenClaw cores:
 *
 *   ~/.npm-global/bin/openclaw   2026.9.3    the managed one: install.sh's
 *                                            NPM_PREFIX, the gateway's ExecStart
 *   /usr/bin/openclaw            2026.7.1-2  root-owned, from a `sudo npm
 *                                            install -g openclaw` in July
 *
 * `findOpenclawBin` asked the directory of its own node FIRST, and on the
 * device node is the distro package — `/usr/bin/node`. So the web server ran
 * the July core for every CLI call while the gateway ran the managed one, which
 * had since migrated openclaw.json and the state database. The old CLI refused
 * both ("meta: Unrecognized key: migrations", "state database uses newer schema
 * version 16; this OpenClaw build supports 1"), `doctor --fix` threw, and the
 * configure route rolled the credential back. `installedOpenclawCoreGeneration`
 * derives the manifest from the same path, so that box was also judged `v1`.
 *
 * What is pinned: the managed core wins wherever it exists; a dev machine with
 * no managed prefix still finds its core; and a FALLBACK is never remembered,
 * so a web server that started before the managed core landed picks it up
 * without a restart.
 */

const fsState = vi.hoisted(() => ({
  present: new Set<string>(),
  nvmVersions: null as string[] | null,
}));

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const existsSync = (p: unknown) => fsState.present.has(String(p));
  const readdirSync = ((p: unknown, ...rest: unknown[]) => {
    if (String(p).endsWith(path.join(".nvm", "versions", "node"))) {
      if (!fsState.nvmVersions) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return fsState.nvmVersions;
    }
    return (real.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readdirSync;
  return { ...real, existsSync, readdirSync, default: { ...real, existsSync, readdirSync } };
});

const realExecPath = process.execPath;
const realHome = process.env.HOME;
const realOpenclawBin = process.env.OPENCLAW_BIN;
let home: string;

function setExecPath(value: string) {
  Object.defineProperty(process, "execPath", { value, configurable: true, writable: true });
}

async function load() {
  vi.resetModules();
  return import("@/lib/openclaw-config");
}

beforeEach(() => {
  fsState.present.clear();
  fsState.nvmVersions = null;
  home = mkdtempSync(path.join(tmpdir(), "clawbox-bin-resolution-"));
  process.env.HOME = home;
  delete process.env.OPENCLAW_BIN;
  setExecPath("/usr/bin/node");
});

afterEach(() => {
  setExecPath(realExecPath);
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realOpenclawBin === undefined) delete process.env.OPENCLAW_BIN; else process.env.OPENCLAW_BIN = realOpenclawBin;
  rmSync(home, { recursive: true, force: true });
});

const managed = () => path.join(home, ".npm-global", "bin", "openclaw");

describe("findOpenclawBin", () => {
  it("runs the managed core on a box that also has one beside its node — the 2026-09-18 box", async () => {
    fsState.present.add("/usr/bin/openclaw");
    fsState.present.add(managed());
    const { findOpenclawBin } = await load();
    expect(findOpenclawBin()).toBe(managed());
  });

  it("runs the managed core over every other place a core can sit", async () => {
    setExecPath("/opt/node/bin/node");
    fsState.nvmVersions = ["v24.1.0"];
    for (const p of [
      "/opt/node/bin/openclaw",
      "/usr/local/bin/openclaw",
      "/usr/bin/openclaw",
      path.join(home, ".nvm", "versions", "node", "v24.1.0", "bin", "openclaw"),
      managed(),
    ]) fsState.present.add(p);
    const { findOpenclawBin } = await load();
    expect(findOpenclawBin()).toBe(managed());
  });

  it("still finds a dev machine's core: beside node, then /usr/local, then /usr, then nvm newest first", async () => {
    setExecPath("/opt/node/bin/node");
    fsState.nvmVersions = ["v22.9.0", "v24.1.0"];
    const nvm = (v: string) => path.join(home, ".nvm", "versions", "node", v, "bin", "openclaw");
    const order = ["/opt/node/bin/openclaw", "/usr/local/bin/openclaw", "/usr/bin/openclaw", nvm("v24.1.0"), nvm("v22.9.0")];
    for (const p of order) fsState.present.add(p);
    const { findOpenclawBin } = await load();
    for (const expected of order) {
      expect(findOpenclawBin()).toBe(expected);
      fsState.present.delete(expected);
    }
    // …and with none of them, the bare name for PATH to answer.
    expect(findOpenclawBin()).toBe("openclaw");
  });

  it("never remembers a fallback: the managed core is used the moment it lands, with no restart", async () => {
    // A web server that asked while the install was still running, or while a
    // core promotion sat between its two renames.
    fsState.present.add("/usr/bin/openclaw");
    const { findOpenclawBin } = await load();
    expect(findOpenclawBin()).toBe("/usr/bin/openclaw");
    fsState.present.add(managed());
    expect(findOpenclawBin()).toBe(managed());
  });

  it("remembers the managed core once it has been found", async () => {
    fsState.present.add(managed());
    const { findOpenclawBin } = await load();
    expect(findOpenclawBin()).toBe(managed());
    // The promotion's window: the launcher is briefly absent. Falling back to
    // a second core for that moment is exactly the defect.
    fsState.present.delete(managed());
    fsState.present.add("/usr/bin/openclaw");
    expect(findOpenclawBin()).toBe(managed());
  });
});

describe("installedOpenclawCoreGeneration follows the same binary", () => {
  it("reads the MANAGED core's manifest, not the one beside node", async () => {
    // The managed prefix for real, because the manifest is read through
    // fs/promises: a 2026.9.3 tree under the tmp HOME.
    const tree = path.join(home, ".npm-global", "lib", "node_modules", "openclaw");
    mkdirSync(tree, { recursive: true });
    mkdirSync(path.join(home, ".npm-global", "bin"), { recursive: true });
    writeFileSync(path.join(tree, "package.json"), JSON.stringify({ name: "openclaw", version: "2026.9.3" }));
    fsState.present.add(managed());
    // The July core beside node would have answered `v1` — or, where /usr has
    // none, `unknown`. Either is the wrong generation for this box.
    fsState.present.add("/usr/bin/openclaw");
    vi.resetModules();
    const { installedOpenclawCoreGeneration, installedOpenclawCoreVersion } = await import("@/lib/openclaw-core-generation");
    expect(await installedOpenclawCoreVersion()).toBe("2026.9.3");
    expect(await installedOpenclawCoreGeneration()).toBe("v2");
  });
});

describe("nothing freezes the resolver's answer at import", () => {
  // "Only the managed path is cached" is a property of findOpenclawBin(), and a
  // module-level `const OPENCLAW_BIN = findOpenclawBin()` takes it away again:
  // updater.ts is loaded at web-server boot, so a fallback captured there — the
  // bare name on a box before its core lands, or the second core under /usr
  // that install.sh now REMOVES mid-update — was what doctor and `config
  // validate` were spawned with until the next restart.
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  // The one capture left, and why it may stay: it is a SENTINEL. Both of its
  // uses hand `config set` to runCommand, which recognises the constant and
  // reroutes to runOpenclawConfigSet — the live resolver.
  const ALLOWED = new Set([path.join("app", "setup-api", "ai-models", "configure", "route.ts")]);

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "tests" ? [] : sources(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("no module-scope capture outside the configure route's sentinel", () => {
    const captures = sources(SRC)
      .filter((file) => /^(?:export )?(?:const|let|var) \w+ = findOpenclawBin\(\);/m.test(readFileSync(file, "utf-8")))
      .map((file) => path.relative(SRC, file))
      .filter((file) => !ALLOWED.has(file));
    expect(captures).toEqual([]);
  });
});
