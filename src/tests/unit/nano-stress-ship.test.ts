import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classify,
  importSpecifiers,
  moduleClosure,
  shipPlan,
} from "../../../scripts/nano-stress/board-modules.mjs";

// The stress run's board side is board-stress.mjs AND every local module it
// imports (TASK-2500). A run once died at start on the board with
// ERR_MODULE_NOT_FOUND because run.sh copied board-stress.mjs alone after the
// Hermes driver had moved into hermes-chat.mjs. run.sh now packs the whole
// import closure (scripts/nano-stress/board-modules.mjs) and opens it with ONE
// function, the same here (--unpack-to) as on the board. These tests hold that
// contract: what the board gets is complete, and a module added later ships
// without anyone listing it.

// Real bash, tar, base64 and node processes per case: a loaded CI runner
// needs more than vitest's 5 s (test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const STRESS = path.join(REPO, "scripts/nano-stress");
const RUN_SH = path.join(STRESS, "run.sh");
const ENTRY = path.join(STRESS, "board-stress.mjs");

const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const canRun = process.platform === "linux" && has("bash", ["--version"]) && has("tar", ["--version"]) && has("base64", ["--version"]);

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nano-stress-ship-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function runSh(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
}

/** Start an unpacked entry the way the board does, with no options: it must
 *  get as far as its own usage line, which needs every import resolved. */
function startWithoutOptions(entry: string) {
  return spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 30_000 });
}

/** A copy of scripts/nano-stress (and its sibling lib.sh) to change freely. */
function copyStress(): { root: string; stress: string } {
  const root = tmp();
  const stress = path.join(root, "scripts/nano-stress");
  fs.mkdirSync(stress, { recursive: true });
  for (const f of fs.readdirSync(STRESS)) fs.copyFileSync(path.join(STRESS, f), path.join(stress, f));
  fs.mkdirSync(path.join(root, "scripts/nano-tests"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "scripts/nano-tests/lib.sh"), path.join(root, "scripts/nano-tests/lib.sh"));
  return { root, stress };
}

function prepend(file: string, line: string) {
  fs.writeFileSync(file, `${line}\n${fs.readFileSync(file, "utf8")}`);
}

describe("importSpecifiers", () => {
  it("reads every static and literal dynamic import form", () => {
    const src = [
      'import a from "./a.mjs";',
      "import {",
      "  b,",
      "  c as d,",
      "} from './multi.mjs';",
      'import * as ns from "./ns.mjs";',
      'import "./side-effect.mjs";',
      'export { q } from "./q.mjs";',
      'export * from "../star.mjs";',
      'export * as all from "./all.mjs";',
      'import from from "./named-from.mjs";',
      'const lazy = await import("./lazy.mjs");',
      'import fs from "node:fs";',
      "export const k = 1;",
      "export { k as kk };",
    ].join("\n");
    const { specifiers, computed } = importSpecifiers(src);
    expect(specifiers.sort()).toEqual([
      "../star.mjs", "./a.mjs", "./all.mjs", "./lazy.mjs", "./multi.mjs", "./named-from.mjs", "./ns.mjs", "./q.mjs", "./side-effect.mjs", "node:fs",
    ]);
    expect(computed).toBe(0);
  });

  it("is not fooled by comments, strings, regular expressions or template literals", () => {
    const src = [
      '// import x from "./line-comment.mjs";',
      '/* import y from "./block-comment.mjs"; */',
      'const url = "http://127.0.0.1//x import z from \'./in-a-string.mjs\'";',
      "const re = /[\"'`]import w from \"\\.\\/in-a-regex\"/g;",
      'const t = `a ${cond ? `nested ${1}` : "x"} import v from "./in-a-template.mjs"`;',
      "const half = a / b / c;",
      "import.meta.url;",
      'obj.import("./a-method.mjs");',
      'import "./after-all-that.mjs";',
    ].join("\n");
    expect(importSpecifiers(src)).toEqual({ specifiers: ["./after-all-that.mjs"], computed: 0 });
  });

  it("counts an import() it cannot read", () => {
    expect(importSpecifiers("await import(name); await import(`./tpl.mjs`); await import('./ok.mjs');")).toEqual({ specifiers: ["./ok.mjs"], computed: 2 });
  });

  it("agrees with TypeScript's own scan on every stress module", () => {
    for (const f of fs.readdirSync(STRESS).filter((n) => n.endsWith(".mjs"))) {
      const src = fs.readFileSync(path.join(STRESS, f), "utf8");
      const theirs = ts.preProcessFile(src, true, true).importedFiles.map((x) => x.fileName).sort();
      expect([...new Set(importSpecifiers(src).specifiers)].sort(), f).toEqual([...new Set(theirs)].sort());
    }
  });
});

describe("classify", () => {
  it("ships local files, needs nothing for Node's own modules, refuses the rest", () => {
    expect(classify("node:fs")).toEqual({ kind: "builtin" });
    expect(classify("fs")).toEqual({ kind: "builtin" });
    expect(classify("./x.mjs")).toEqual({ kind: "local" });
    expect(classify("../x.mjs")).toEqual({ kind: "local" });
    expect(classify("ws")).toMatchObject({ kind: "refused", why: expect.stringMatching(/package.*no node_modules/) });
    expect(classify("/opt/x.mjs")).toMatchObject({ kind: "refused" });
    expect(classify("file:///opt/x.mjs")).toMatchObject({ kind: "refused" });
  });
});

describe("moduleClosure and shipPlan", () => {
  it("follows imports through the modules they reach, up and down the tree", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "stress/sub"), { recursive: true });
    fs.mkdirSync(path.join(root, "shared"), { recursive: true });
    fs.writeFileSync(path.join(root, "stress/entry.mjs"), 'import fs from "node:fs";\nimport { a } from "./sub/a.mjs";\n');
    fs.writeFileSync(path.join(root, "stress/sub/a.mjs"), 'import "../../shared/b.mjs";\nexport const a = () => import("./lazy.mjs");\n');
    fs.writeFileSync(path.join(root, "stress/sub/lazy.mjs"), "export default 1;\n");
    fs.writeFileSync(path.join(root, "shared/b.mjs"), 'import path from "node:path";\nimport { a } from "../stress/sub/a.mjs";\n');
    const plan = shipPlan(path.join(root, "stress/entry.mjs"));
    expect(fs.realpathSync(plan.root)).toBe(fs.realpathSync(root));
    expect(plan.entry).toBe(path.join("stress", "entry.mjs"));
    expect([...plan.files].sort()).toEqual([
      path.join("shared", "b.mjs"),
      path.join("stress", "entry.mjs"),
      path.join("stress", "sub", "a.mjs"),
      path.join("stress", "sub", "lazy.mjs"),
    ]);
  });

  it("refuses, naming the file, an import it cannot ship", () => {
    const root = tmp();
    const entry = path.join(root, "entry.mjs");
    fs.writeFileSync(entry, 'import WebSocket from "ws";\n');
    expect(() => moduleClosure(entry)).toThrow(/entry\.mjs: ws is a package/);
    fs.writeFileSync(entry, 'import "./missing.mjs";\n');
    expect(() => moduleClosure(entry)).toThrow(/entry\.mjs: imports \.\/missing\.mjs, which is not a file/);
    fs.writeFileSync(entry, "await import(which);\n");
    expect(() => moduleClosure(entry)).toThrow(/import\(\) of a computed value/);
  });

  it("names hermes-chat.mjs for the real board side", () => {
    const plan = shipPlan(ENTRY);
    expect(plan.entry).toBe("board-stress.mjs");
    expect(plan.files).toContain("hermes-chat.mjs");
  });
});

describe.skipIf(!canRun)("run.sh ships the board side whole", () => {
  it("unpacks exactly the import closure of board-stress.mjs, which then starts on its own", () => {
    const out = path.join(tmp(), "board");
    const r = runSh(RUN_SH, ["--unpack-to", out]);
    expect(r.status, r.stderr).toBe(0);
    const entry = r.stdout.trim();
    expect(entry).toBe("board-stress.mjs");
    expect(filesUnder(out)).toEqual([...shipPlan(ENTRY).files].sort());
    expect(filesUnder(out)).toContain("hermes-chat.mjs");
    const started = startWithoutOptions(path.join(out, entry));
    expect(started.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    expect(started.status, started.stderr).toBe(2);
    expect(started.stderr).toMatch(/usage: node board-stress\.mjs --out/);
  });

  it("ships a module added later, and one outside the folder, without touching run.sh", () => {
    const { root, stress } = copyStress();
    fs.mkdirSync(path.join(stress, "extra"));
    prepend(path.join(stress, "hermes-chat.mjs"), 'import { added } from "./extra/added.mjs";');
    fs.writeFileSync(path.join(stress, "extra/added.mjs"), 'import "../../shared-helper.mjs";\nexport const added = () => import("./lazy.mjs");\n');
    fs.writeFileSync(path.join(stress, "extra/lazy.mjs"), "export default 1;\n");
    fs.writeFileSync(path.join(root, "scripts/shared-helper.mjs"), "export const helper = 1;\n");
    const out = path.join(tmp(), "board");
    const r = runSh(path.join(stress, "run.sh"), ["--unpack-to", out]);
    expect(r.status, r.stderr).toBe(0);
    const entry = r.stdout.trim();
    expect(entry).toBe(path.join("nano-stress", "board-stress.mjs"));
    expect(filesUnder(out)).toEqual(expect.arrayContaining([
      path.join("nano-stress", "board-stress.mjs"),
      path.join("nano-stress", "hermes-chat.mjs"),
      path.join("nano-stress", "extra", "added.mjs"),
      path.join("nano-stress", "extra", "lazy.mjs"),
      "shared-helper.mjs",
    ]));
    const started = startWithoutOptions(path.join(out, entry));
    expect(started.status, started.stderr).toBe(2);
  });

  it("refuses an import it cannot ship before it touches a board", () => {
    const { root, stress } = copyStress();
    prepend(path.join(stress, "hermes-chat.mjs"), 'import WebSocket from "ws";');
    const unpack = runSh(path.join(stress, "run.sh"), ["--unpack-to", path.join(tmp(), "board")]);
    expect(unpack.status).toBe(1);
    expect(unpack.stderr).toMatch(/ws is a package/);
    // With a serial, the board helper is never called: NANO_CI would leave a mark.
    const mark = path.join(root, "nano-ci-called");
    const fake = path.join(root, "fake-nano-ci");
    fs.writeFileSync(fake, `#!/usr/bin/env bash\ntouch ${JSON.stringify(mark)}\nexit 1\n`, { mode: 0o755 });
    const run = runSh(path.join(stress, "run.sh"), ["--results", path.join(root, "results"), "000000000000"], { NANO_CI: fake });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/could not pack the board side/);
    expect(fs.existsSync(mark)).toBe(false);
  });

  it("refuses a board side that loads only with a file it did not pack", () => {
    const { stress } = copyStress();
    // A module that reaches its neighbour by a path the scan cannot see.
    prepend(path.join(stress, "hermes-chat.mjs"), 'import { createRequire } from "node:module";\nconst neighbour = createRequire(import.meta.url)("./not-shipped.cjs");');
    fs.writeFileSync(path.join(stress, "not-shipped.cjs"), "module.exports = 1;\n");
    const r = runSh(path.join(stress, "run.sh"), ["--unpack-to", path.join(tmp(), "board")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not load on its own/);
  });

  it("keeps the payload inside one ssh argument", () => {
    const r = runSh(RUN_SH, ["--unpack-to", path.join(tmp(), "board")], { NANO_STRESS_MAX_PAYLOAD: "100" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/over the 100 that fit one ssh argument/);
  });

  it("opens the payload on the board with the same function it tests here", () => {
    const text = fs.readFileSync(RUN_SH, "utf8");
    expect(text).toMatch(/board "\$\(declare -f unpack_payload\)"/);
    expect(text).toMatch(/setsid -f node "\$dir\/\$entry"/);
    // No module is copied by name any more.
    expect(text).not.toMatch(/base64 -d > "\$dir\/[\w-]+\.mjs"/);
  });
});
