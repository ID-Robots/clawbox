/**
 * The ClawBox MCP server must start from what the package DECLARES, not from
 * what an install happens to hoist (TASK-2496).
 *
 * The gateway runs the server as `bun run mcp/clawbox-mcp.ts` straight from the
 * checkout (scripts/gateway-pre-start.sh writes it into openclaw.json; Hermes'
 * twin is scripts/register-mcp.sh), so the server's dependencies are whatever
 * `bun install` leaves in the checkout's node_modules. Up to 4.3.0 six of its
 * files imported `zod` while package.json never named it: `zod` was there only
 * because @modelcontextprotocol/sdk (and a lint plugin) depend on it and the
 * hoisted linker happened to lift that copy to the top. On an install that does
 * not lift it — bun's isolated linker, an SDK that takes zod as a peer, a tree
 * a failed install left behind — the server dies on its first import:
 *
 *   error: Cannot find package 'zod' from '…/mcp/tools/memory.ts'
 *
 * and the gateway, which only sees a child that never answered `initialize`,
 * logs `bundle-mcp: failed to start server "clawbox"` and tries again after its
 * 60 s cooldown — the ~70 s retry loop the report described.
 *
 * Two checks, because each catches what the other cannot:
 *
 *   1. Every package the server's import graph loads at runtime is in
 *      package.json `dependencies`. Static and install-independent: it fails the
 *      day a new undeclared import lands, whatever the local tree looks like.
 *   2. The server, copied out with ONLY the declared dependencies visible to it,
 *      starts under bun and answers `tools/list`. A strict layout, built here:
 *      the graph's files in a temp dir and a node_modules holding one symlink
 *      per declared dependency. Each linked package still resolves its OWN
 *      dependencies from its real location, exactly as an isolated install
 *      lays them out; the server's files see nothing else. A control start
 *      with `zod` left out proves the layout really is strict — without it,
 *      a stray node_modules above the temp dir could pass case 2 on its own.
 */
import { spawn } from "node:child_process";
import { builtinModules } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real `bun` processes: a cold start is ~0.4 s on a dev machine and ~1-3 s on a
// loaded CI runner under coverage (see test-timeout-hygiene.test.ts).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const REPO = path.resolve(__dirname, "../../..");
const ENTRY = "mcp/clawbox-mcp.ts";
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const declared = Object.keys(pkg.dependencies ?? {});

const BUILTINS = new Set(builtinModules);
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || spec === "bun" || spec.startsWith("bun:") || BUILTINS.has(packageName(spec));
}

function resolveFile(base: string): string | null {
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => path.join(base, "index" + e))];
  // TS-style ESM specifiers name the emitted `.js` of a `.ts` source.
  if (/\.m?js$/.test(base)) candidates.push(base.replace(/\.m?js$/, ".ts"), base.replace(/\.m?js$/, ".mts"));
  for (const c of candidates) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

/**
 * The module specifiers a file loads AT RUNTIME. Read from the TypeScript AST,
 * so an import named in a comment or a string is not one, and the forms bun's
 * transpiler erases are left out: `import type`, `export type … from`, and an
 * import whose every named binding is `type`.
 */
function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        !!clause
        && (clause.isTypeOnly
          || (!clause.name
            && !!clause.namedBindings
            && ts.isNamedImports(clause.namedBindings)
            && clause.namedBindings.elements.length > 0
            && clause.namedBindings.elements.every((el) => el.isTypeOnly)));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)
    ) {
      // `import x = require("pkg")`
      out.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        out.push(node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

interface Graph {
  /** Repo-relative paths of every source file the entry loads. */
  files: string[];
  /** Package name → repo-relative files that import it. */
  packages: Map<string, string[]>;
  /** Specifiers that resolve to nothing — the walk must not silently drop them. */
  unresolved: string[];
}

function walk(entry: string): Graph {
  const seen = new Set<string>();
  const packages = new Map<string, string[]>();
  const unresolved: string[] = [];
  const queue = [path.join(REPO, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(REPO, file);
    for (const spec of runtimeSpecifiers(file)) {
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/")) {
        const base = spec.startsWith("@/") ? path.join(REPO, "src", spec.slice(2)) : path.resolve(path.dirname(file), spec);
        const target = resolveFile(base);
        if (target) queue.push(target);
        else unresolved.push(`${rel}: ${spec}`);
      } else if (!isBuiltin(spec)) {
        const name = packageName(spec);
        packages.set(name, [...(packages.get(name) ?? []), rel]);
      }
    }
  }
  return { files: [...seen].map((f) => path.relative(REPO, f)).sort(), packages, unresolved };
}

const graph = walk(ENTRY);

describe("the ClawBox MCP server's import graph", () => {
  it("is walked whole — every relative import resolves to a file", () => {
    expect(graph.unresolved).toEqual([]);
    // A walk that stopped at the entry would pass the next case vacuously.
    expect(graph.files).toContain("mcp/lib/schema.ts");
    expect(graph.files).toContain("mcp/tools/memory.ts");
    expect(graph.files.length).toBeGreaterThan(30);
  });

  it("finds the packages it is known to load, so the scan is not blind", () => {
    expect([...graph.packages.keys()]).toEqual(expect.arrayContaining(["@modelcontextprotocol/sdk", "zod"]));
  });

  it("loads no package that package.json does not declare in `dependencies`", () => {
    const undeclared = [...graph.packages.entries()]
      .filter(([name]) => !declared.includes(name))
      .map(([name, files]) => `${name} (imported by ${[...new Set(files)].join(", ")})`);
    expect(undeclared).toEqual([]);
  });
});

/** A `bun` to run the server with: $BUN_BIN, the PATH, then the installer's default. */
function findBun(): string | null {
  const candidates = [
    process.env.BUN_BIN,
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "bun")),
    path.join(os.homedir(), ".bun", "bin", "bun"),
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (!fs.statSync(c).isFile()) continue;
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      // next
    }
  }
  return null;
}

const BUN = findBun();
const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The graph's files, the manifests bun reads on the way (the `"type"` in
 * mcp/package.json, the tsconfig pair), and a node_modules of one symlink per
 * dependency in `deps`.
 */
function strictLayout(deps: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-mcp-strict-"));
  tmpRoots.push(root);
  for (const rel of [...graph.files, "package.json", "mcp/package.json", "tsconfig.json", "mcp/tsconfig.json"]) {
    const from = path.join(REPO, rel);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(root, rel));
  }
  for (const name of deps) {
    const real = path.join(REPO, "node_modules", name);
    // An optional or platform-specific dependency this tree did not install.
    if (!fs.existsSync(real)) continue;
    const link = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link, "dir");
  }
  fs.mkdirSync(path.join(root, "home"));
  return root;
}

interface Start {
  tools: string[] | null;
  stderr: string;
}

/**
 * Start the server the way the gateway does (`bun run <entry>` over stdio),
 * send `initialize` and `tools/list`, and return the tool names — or null with
 * the stderr when it never answered. Hermetic: the API base is a closed
 * loopback port, so the startup probes fail at once and nothing on this machine
 * is asked, and every root the server would otherwise default to a ClawBox's
 * live install for (the checkout, the home, the OpenClaw home, the edition
 * lock) points into the temp dir — this file can run on a device too.
 */
function startServer(root: string, deadlineMs = 30_000): Promise<Start> {
  const home = path.join(root, "home");
  return new Promise((resolve) => {
    const child = spawn(BUN!, ["run", "--no-install", path.join(root, ENTRY)], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        CLAWBOX_ROOT: root,
        OPENCLAW_HOME: path.join(home, ".openclaw"),
        CLAWBOX_OPENCLAW_HOME: path.join(home, ".openclaw"),
        CLAWBOX_API_BASE: "http://127.0.0.1:9",
        CLAWBOX_MCP_TOKEN: "0".repeat(64),
        CLAWBOX_EDITION_FILE: path.join(home, "edition.env"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A child that dies before reading its stdin turns the writes below into
    // EPIPE; the start has already failed by then, and `exit` reports it.
    child.stdin.on("error", () => {});
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (tools: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({ tools, stderr });
    };
    const timer = setTimeout(() => finish(null), deadlineMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, nl);
        stdout = stdout.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
          if (msg.id === 2) finish((msg.result?.tools ?? []).map((t) => t.name));
        } catch {
          // not a JSON-RPC frame
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      // bun prints an unresolvable import and can then sit on the open pipe
      // rather than exit, so the failure is read off stderr, not the exit.
      if (/Cannot find (package|module)/.test(stderr)) finish(null);
    });
    child.on("error", (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on("exit", () => setTimeout(() => finish(null), 50));
    const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "declared-deps-test", version: "0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

describe("a bun to start the server with", () => {
  // The cases below skip on a machine without bun. On CI that skip would turn
  // the one check that starts the server into a silent pass, so there it fails.
  it.runIf(!!process.env.CI)("is found when CI runs the suite (setup-bun in pr-tests-coverage.yml)", () => {
    expect(BUN, "no bun on $BUN_BIN, the PATH or ~/.bun/bin").not.toBeNull();
  });
});

describe.skipIf(!BUN)("the ClawBox MCP server from a strict, declared-dependencies-only layout", () => {
  it("starts under bun and answers tools/list", async () => {
    const { tools, stderr } = await startServer(strictLayout(declared));
    expect(tools, `the server never answered tools/list; its stderr:\n${stderr}`).not.toBeNull();
    expect(tools!.length).toBeGreaterThan(20);
    expect(tools).toContain("device_status");
  });

  it("does NOT start with zod left out — the layout hides what is not declared", async () => {
    const { tools, stderr } = await startServer(strictLayout(declared.filter((name) => name !== "zod")));
    expect(tools).toBeNull();
    expect(stderr).toMatch(/Cannot find (package|module) ['"]?zod/);
  });
});
