import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/**
 * That `register()` arms the coding folder janitor ONLY on the device's own
 * account.
 *
 * The janitor is on by default and its scope is the whole project folder —
 * `~/Projects` unless the owner chose another. Under `bun run dev` on a
 * developer's machine that is the developer's own folder, and ten minutes
 * after the dev server starts the first pass would remove their idle
 * worktrees and move their second clones to a trash. So the boot hook keeps it
 * behind `onDeviceAccount`, exactly like the git identity cleanup, the browser
 * repair and the default project folder, and says so in one line when it does
 * not arm it.
 *
 * Read from the boot file, like the other instrumentation tests: `register()`
 * pulls its dependencies in through `require()` to keep Node APIs out of
 * Next's Edge bundle, and those requires only resolve inside the Next build.
 * What regresses silently is the WIRING, so the wiring is what this pins. The
 * janitor's own second lock (`start()` refuses off the account) is behaviour,
 * and coding-folder-janitor.test.ts covers it.
 */

const BOOT_FILE = path.join(process.cwd(), "src", "instrumentation.ts");
const source = fs.readFileSync(BOOT_FILE, "utf8");

/** The `{ … }` block that opens at `open` (the index of its `{`). */
function blockAt(open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced block");
}

describe("boot arms the coding folder janitor only on the device account", () => {
  const load = source.indexOf("require('./lib/coding-folder-janitor')");

  it("loads and starts the janitor in exactly one place", () => {
    expect(load).toBeGreaterThan(-1);
    expect(source.indexOf("require('./lib/coding-folder-janitor')", load + 1)).toBe(-1);
    expect(source.match(/folderJanitor\.start\(\)/g)).toHaveLength(1);
  });

  it("keeps both the load and the start inside an `if (onDeviceAccount)` block", () => {
    const guard = source.lastIndexOf("if (onDeviceAccount) {", load);
    expect(guard).toBeGreaterThan(source.indexOf("const onDeviceAccount ="));
    const block = blockAt(source.indexOf("{", guard));
    expect(block).toContain("require('./lib/coding-folder-janitor')");
    expect(block).toMatch(/folderJanitor\.start\(\)/);
    // The block is the guard's own: no other boot job's block in between.
    expect(guard + block.length).toBeGreaterThan(load);
  });

  it("says so, off the device account, rather than arming it", () => {
    const guard = source.lastIndexOf("if (onDeviceAccount) {", load);
    const block = blockAt(source.indexOf("{", guard));
    const rest = source.slice(source.indexOf("{", guard) + block.length);
    expect(rest).toMatch(/^\s*else\s*\{\s*console\.log\('\[instrumentation\] Not the device account: the coding folder janitor is not armed'\)/);
  });

  it("does not let a janitor that fails to load stop the box booting", () => {
    const guard = source.lastIndexOf("if (onDeviceAccount) {", load);
    const before = source.slice(Math.max(0, guard - 2000), guard);
    expect(before.lastIndexOf("try {")).toBeGreaterThan(-1);
    const after = source.slice(load, load + 900);
    expect(after).toMatch(/catch \(err\)[\s\S]*Could not arm the coding folder janitor/);
  });
});
