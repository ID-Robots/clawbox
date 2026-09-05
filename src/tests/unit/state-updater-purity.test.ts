import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * A React state updater is a PURE function of the previous state.
 *
 * React is entitled to call it twice — Strict Mode does, and so does any render
 * it has to redo — so a side effect inside one happens twice. TASK-703 was that
 * defect on both chat surfaces: the interrupted turn was appended from inside
 * the `setStreaming` updater, and the owner's half-finished reply landed in the
 * transcript twice. `src/tests/components/chat-strict-mode-updater.test.tsx`
 * pins the two behaviours that were reported; this pins the RULE, for the sites
 * a component test cannot reach — the effort picker's "Switched effort to …"
 * line needs a header dropdown with a provider offering more than one level
 * before it renders at all.
 *
 * Read by the TypeScript compiler rather than by a regex over the text. The
 * first version of this guard hand-rolled a comment/string blanker and balanced
 * parentheses by hand; it had no notion of a regex literal, so one `/'/` in a
 * walked file inverted its idea of what was code from there on and it reported
 * NOTHING with a green tick — the false-success class, in the guard itself.
 * Four files under `src/app` were desyncing it that way already. `typescript`
 * is a devDependency this repo already drives (see build-typecheck.test.ts), it
 * knows what a regex literal is, and it hands back the updater's body as a node
 * instead of a slice of text.
 */

/** Directories whose React state this rule covers. */
const ROOTS = ["src/components", "src/hooks", "src/app", "src/lib"];

/**
 * `set` + capital is also `setTimeout`/`setInterval`/`setImmediate`, whose
 * callback is NOT a state updater — React does not re-run it — so they cannot
 * OPEN one. They stay in the nested set below, where scheduling a timer from
 * inside an updater is the same impurity.
 */
const NOT_UPDATERS = new Set(["setTimeout", "setInterval", "setImmediate"]);

/**
 * The project's own `apply*` wrappers count as well as `set*`.
 *
 * `setMessages(prev => { applyStreaming(""); return prev })` would pass a
 * setter-only rule while being strictly worse than the defect: React may run it
 * twice AND it writes a ref during the render phase, so the ref and the state
 * can disagree at commit time. Both directions are covered — an `apply*`
 * wrapper may neither take an updater nor be called from inside one.
 */
function isStateWriter(name: string): boolean {
  return /^(set|apply)[A-Z]/.test(name) && !NOT_UPDATERS.has(name);
}

/** The plain `foo(...)` callee name, or null for `a.foo(...)` and the rest. */
function calleeName(node: ts.CallExpression): string | null {
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every `setX(prev => …)` / `applyX(prev => …)` in a file whose body writes
 * state again, or mutates a ref.
 *
 * A ref write is included because the comment the fix leans on says so: a
 * `streamingRef.current = …` inside an updater is a render-phase mutation, and
 * the ref is exactly what the fix uses to read the buffer from outside.
 */
function impureUpdaters(relativePath: string): string[] {
  const text = fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8");
  // A file with no `set`/`apply` + capital anywhere in it cannot hold a state
  // write, so parsing it is wasted work — the walk is ~700 files. An OVER-
  // approximation on purpose: it can only include files that turn out clean,
  // never skip one that is not.
  if (!/(?:set|apply)[A-Z]/.test(text)) return [];
  const file = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    false,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];

  const impurities = (body: ts.Node): string[] => {
    const hits: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name && isStateWriter(name)) hits.push(`${name}()`);
      }
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left)
        && node.left.name.text === "current"
      ) {
        hits.push(`${node.left.getText(file)} =`);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
    return hits;
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const name = calleeName(node);
      const arg = node.arguments[0];
      // A function passed as the ONLY argument to a state writer is an updater:
      // an arrow, and `function (prev) { … }` too — the shape a regex opener
      // missed and the shape a refactor reaches for when the body grows.
      if (name && isStateWriter(name) && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
        const hits = impurities(arg.body);
        if (hits.length > 0) {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
          found.push(`${relativePath}:${line} ${name}(updater) -> ${[...new Set(hits)].join(", ")}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

describe("a state updater is a pure function of the previous state", () => {
  it("has no state write inside a state updater, anywhere in the UI", () => {
    // The four directories that hold this app's React state, not just the two
    // chat surfaces: after TASK-703 there are NO such sites left, so the rule
    // can be stated as a rule. `src/app/page.tsx` held two more — the wallpaper
    // upload and the delete, each writing localStorage and calling two sibling
    // setters from inside a `setCustomWallpapers` updater — and they were fixed
    // rather than excluded by the scope of the test that claims to cover them.
    // They were idempotent, which is exactly why they went unnoticed.
    //
    // `src/lib` is in the list because that is where the state BOTH surfaces
    // share lives: `useChatToolCalls` (chat-tool-events.tsx) is called from
    // ChatApp and ChatPopup alike, so the same defect there would reach both
    // through the same abort path.
    const offenders = ROOTS.flatMap((root) => sourceFiles(root)).flatMap(impureUpdaters);

    expect(offenders).toEqual([]);
  });

  it("catches the shapes the defect actually took", () => {
    // The guard's own guard. Each of these went undetected by the regex version
    // — a `function` expression instead of an arrow, an `apply*` wrapper taking
    // an updater, a ref mutation — and a file carrying a regex literal with a
    // quote in it turned the whole scan off silently. They are checked here on
    // a fixture rather than on the tree, so the rule above can assert an empty
    // list and still be known to be looking.
    const fixture = path.join(process.cwd(), "src/tests/fixtures/impure-updaters.tsx");
    const hits = impureUpdaters(path.relative(process.cwd(), fixture));

    expect(hits.map((h) => h.replace(/^.*?:/, "line "))).toEqual([
      expect.stringContaining("setStreaming(updater) -> setMessages()"),
      expect.stringContaining("setFromFunctionExpression(updater) -> setMessages()"),
      expect.stringContaining("applyWrapper(updater) -> applyStreaming()"),
      expect.stringContaining("setWithRefWrite(updater) -> streamingRef.current ="),
    ]);
  });
});
