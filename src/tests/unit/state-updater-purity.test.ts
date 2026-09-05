import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// The sweep parses ~270 files with the TypeScript compiler, and v8 coverage
// instrumentation multiplies that by about seven: 426 ms of parse
// uninstrumented, 2 874 ms under `test:coverage:ci` on an idle machine, and
// 5 318 ms on a four-worker CI runner — where it failed the whole job with
// vitest's "Test timed out in 5000ms" over a tree the rule found CLEAN, which
// is the false-failure class in the guard itself.
//
// The ceiling is declared rather than the walk narrowed, because the walk IS
// the sibling sweep this rule exists to be: it is what says the four
// state-holding directories carry no second offender. Cutting it to the files
// that import the streaming state, or tightening the text pre-filter into
// something that tries to predict which files the AST rule can fire on, buys
// ~1.7 s and pays for it in exactly the currency the docblock below warns
// about — a guard that silently stops looking.
//
// A ceiling alone was not enough, and this is why the sweep is split into one
// case PER ROOT below: measured at load ~52 on a 12-core machine, the combined
// walk failed at 34 107 ms against a 30 000 ms budget. The cost is O(files) and
// grows with the tree, so a single case holding the whole walk is the 5 000 ms
// failure again, one doubling later. `testTimeout` is per CASE, so four cases
// parsing 76 / 10 / 59 / 128 files have a quarter of the exposure over exactly
// the same files. 30 s rather than 60 s because the split is the structural
// fix and the budget is only the backstop — a case that has genuinely hung
// should still be caught. Both ceilings, per the house form; see
// src/tests/unit/test-timeout-hygiene.test.ts, which pins this file by name.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
 * open one.
 *
 * Excluded in BOTH positions, so scheduling a timer from inside an updater is
 * not itself reported — a real but far less damaging impurity than a second
 * state write. What IS reported is a state write **inside** that timer, because
 * the walk recurses into the callback: React re-running the updater schedules
 * the timer twice, so the write really does happen twice. Both directions are
 * pinned in the fixture rather than left to this paragraph.
 *
 * This set is also the ESCAPE HATCH, and it works in both positions. A built-in
 * mutator that matches the name rule but is pure with respect to anything
 * outside the updater — `d.setHours(0, 0, 0, 0)` on a `Date` created inside it —
 * belongs here. There is none in the tree today; the alternative when one
 * arrives must not be to weaken the rule, because `Date.prototype.setHours`
 * cannot be renamed and a `prev`-dependent normalisation cannot be hoisted out.
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

/** `someRef.current`, however it is spelled. */
function isCurrentAccess(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "current";
  return ts.isElementAccessExpression(node)
    && ts.isStringLiteralLike(node.argumentExpression)
    && node.argumentExpression.text === "current";
}

/** The plain `foo(...)` callee name, or null for `a.foo(...)` and the rest. */
function calleeName(node: ts.CallExpression): string | null {
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}

/**
 * The same, plus the property form `a.foo(...)` — for the NESTED position only.
 *
 * The two positions are deliberately not symmetric. Opening an updater on
 * `a.setX(fn)` would treat every `foo.setSomething(callback)` in the tree as a
 * React updater, which is a wide guess; but the nested position is where the
 * defect lives, and a setter reached through a property is live style here —
 * `HermesSkillsStore.tsx` calls `catalog.setSort(...)` and `catalog.setQuery(...)`,
 * state writers returned on a hook's object. Reporting `ctx.setSort()` inside
 * an updater is the same finding as reporting `setSort()`, and inside an
 * updater a `localStorage.setItem` or an `el.setAttribute` is an impurity too,
 * so the wider net costs nothing here.
 *
 * `obj["setX"](...)` is still not followed: it is not written in this tree and
 * the string form would need the same care `isCurrentAccess` takes.
 */
function nestedWriterName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

/**
 * Calls that are a side effect whatever they are called.
 *
 * `^(set|apply)[A-Z]` is a NAME rule, and the two defects it could not name
 * were both real: a `fetch` POST inside `setUpdateAvailable` (page.tsx) and
 * `kv.set` / `kv.remove` inside `setHidden` (Mascot.tsx) — the second one
 * screen from the same file's correct pattern, missed only because `kv.set`
 * has no capital after `set`. A rule that finds two of three instances of a
 * defect and calls the sweep done is the shape this repo keeps producing.
 *
 * So persistence and network are named directly, by RECEIVER rather than by
 * method name: every member of `kv`, `localStorage` and `sessionStorage`
 * counts, and so does a bare `fetch`. Naming the receiver is what makes
 * `kv.remove` and a future `kv.whatever` covered without listing methods.
 */
const SIDE_EFFECT_RECEIVERS = new Set([
  "kv", "localStorage", "sessionStorage",
  "window.localStorage", "window.sessionStorage",
  "globalThis.localStorage", "globalThis.sessionStorage",
]);
const SIDE_EFFECT_CALLS = new Set(["fetch"]);

function isSideEffectCall(node: ts.CallExpression, file: ts.SourceFile): boolean {
  if (ts.isIdentifier(node.expression)) return SIDE_EFFECT_CALLS.has(node.expression.text);
  if (ts.isPropertyAccessExpression(node.expression)) {
    return SIDE_EFFECT_RECEIVERS.has(node.expression.expression.getText(file));
  }
  return false;
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
function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8");
}

/**
 * The cheap text pre-filter: a file with no `set`/`apply` + capital anywhere in
 * it cannot hold a hit, because every hit needs an OPENER of that shape — so
 * parsing it is wasted work, and the walk is ~640 files.
 *
 * An OVER-approximation on purpose: it can only include files that turn out
 * clean, never skip one that is not. Named rather than inlined so the walk case
 * can put a FLOOR under it: nothing else does, and a future narrowing that
 * still matched the fixture would leave every case green while the real tree
 * went unread — the guard silently stopping to look, which is the one failure
 * this file refuses to accept anywhere else.
 */
function mayHoldStateWrite(text: string): boolean {
  return /(?:set|apply)[A-Z]/.test(text);
}

function impureUpdaters(relativePath: string): string[] {
  const text = readSource(relativePath);
  if (!mayHoldStateWrite(text)) return [];
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
        const name = nestedWriterName(node);
        // Reported as WRITTEN — `catalog.setSort()`, not `setSort()` — so the
        // message names the call the reader has to go and find.
        if ((name && isStateWriter(name)) || isSideEffectCall(node, file)) {
          hits.push(`${node.expression.getText(file)}()`);
        }
      }
      // EVERY assignment operator, not just `=`. `someRef.current += 1` is the
      // generation-counter idiom this codebase uses in thirteen places,
      // `ChatPopup.tsx` among them, and accumulating a streaming buffer with
      // `+=` inside an updater is the most natural wrong way to write TASK-703's
      // own code. `ref["current"]` counts too.
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && isCurrentAccess(node.left)
      ) {
        hits.push(`${node.left.getText(file)} ${node.operatorToken.getText(file)}`);
      }
      ts.forEachChild(node, visit);
    };
    // The body NODE, not its children. A concise arrow body IS the expression,
    // so `setStreamingState(prev => streamingRef.current = prev)` — which
    // type-checks and lints clean, and is a render-phase write to the very ref
    // this fix leans on — went unseen while the same code in braces was caught.
    // A rule whose answer depends on a pair of brackets is not a rule. `visit`
    // handles the node and then recurses, so a block body is unchanged.
    visit(body);
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

describe("no state write inside a state updater", () => {
  it("walks the whole state-holding tree, and parses the part of it that can hold a write", () => {
    // The WALK and the PRE-FILTER, not only the rule. Rename a directory, add
    // an exclude, change the extension test, and the file list goes short or
    // empty while every case below stays green — an empty-list assertion over
    // an empty tree proves nothing. The same is true one layer in: narrow
    // `mayHoldStateWrite` and the real tree stops being parsed while the
    // fixture, which contains `setStreaming` and `applyWrapper`, keeps passing.
    //
    // Two anchors, and a floor under each layer: the surface the defect was on,
    // and the shared state both surfaces consume.
    const files = ROOTS.flatMap((root) => sourceFiles(root));
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain("src/components/ChatApp.tsx");
    expect(files).toContain("src/lib/chat-tool-events.tsx");
    expect(files.filter((f) => mayHoldStateWrite(readSource(f))).length).toBeGreaterThan(200);
  });

  // ONE CASE PER ROOT, and the reason is a budget rather than a taxonomy:
  // `testTimeout` is per case, and the combined walk has already failed twice
  // on its own cost (5 000 ms in CI, 34 107 ms against a 30 s ceiling on a
  // saturated machine). Four cases parse the same files with a quarter of the
  // exposure each. The roots are separate directories, so a failure also names
  // the half of the tree to look in.
  it.each(ROOTS)("has no state write inside a state updater in %s", (root) => {
    // The four directories that hold this app's React state, not just the two
    // chat surfaces. `src/app/page.tsx` held two more than the bug report named
    // — the wallpaper upload and the delete, each writing localStorage and
    // calling two sibling setters from inside a `setCustomWallpapers` updater —
    // and they were fixed rather than excluded by the scope of the test that
    // claims to cover them. They were idempotent, which is exactly why they
    // went unnoticed, and so were the four found since: FilesApp's localStorage
    // write, InstalledAppSettings' `kv.setJSON`, page.tsx's dismissal `fetch`
    // and Mascot's `kv.set`/`kv.remove`.
    //
    // `src/lib` is in the list because that is where the state BOTH surfaces
    // share lives: `useChatToolCalls` (chat-tool-events.tsx) is called from
    // ChatApp and ChatPopup alike, so the same defect there would reach both
    // through the same abort path.
    //
    // WHAT A GREEN TICK HERE DOES NOT PROVE, so the next reader does not read
    // it as absence — this says "no site the rule can SEE", which is a smaller
    // claim than "no site". The rule is syntactic and cannot follow a name: a
    // setter reached through an alias (`const append = setMessages`), or an
    // updater declared as a variable and passed in by name, is invisible. A
    // setter reached through a property (`ctx.setSort(…)`) IS seen in the
    // nested position — where the defect lives — but does not open an updater.
    // Side effects are covered where they are NAMED: state writes, ref writes,
    // `fetch`, and every member of `kv`/`localStorage`/`sessionStorage`. An
    // updater whose one side effect is something else — an `audio.play()`, a
    // `postMessage`, a write through a persistence module imported under
    // another name — is impure and is not reported. When one of those turns up,
    // the answer is to name its receiver in SIDE_EFFECT_RECEIVERS, which is why
    // that set is keyed on the receiver rather than on method names.
    //
    // In the other direction it is deliberately over-eager: any single-argument
    // call to a `set*`/`apply*` identifier taking a function is treated as an
    // updater, whether or not the callee is a React setter. That is the safe
    // side of the trade — the alternative is a rule that has to know which
    // names are setters — but it means a legitimate `setX(fn)` helper of one's
    // own can turn this red. The answer is to rename the helper, to hoist the
    // callback out of the call, or — for a built-in mutator in the nested
    // position — to name it in NOT_UPDATERS. Not to weaken the rule.
    expect(sourceFiles(root).flatMap(impureUpdaters)).toEqual([]);
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
      expect.stringContaining("setConciseRefWrite(updater) -> streamingRef.current ="),
      expect.stringContaining("setCompoundRefWrite(updater) -> streamingRef.current +="),
      expect.stringContaining("setThroughProperty(updater) -> catalog.setSort()"),
      expect.stringContaining("setWithFetch(updater) -> fetch()"),
      expect.stringContaining("setWithKvWrite(updater) -> kv.set()"),
      expect.stringContaining("setWithDeferredWrite(updater) -> setMessages()"),
    ]);
  });
});
