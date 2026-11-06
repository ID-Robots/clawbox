import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The SSH factory reset in the recovery guide must keep exactly what the UI
 * reset keeps in ~/.hermes.
 *
 * From Hermes v0.21.7 the agent install is no longer one directory: its Python
 * environment lives in `installs/` and the interpreter its launcher execs in
 * `tools/`. The route learned that (HERMES_KEEP); the guide's `find … -exec
 * rm -rf` still kept only `hermes-agent` and `bin`, so an owner following it
 * deleted both and was left with a `hermes` command that cannot start — on a
 * box that is about to reboot into AP mode with no internet to reinstall it.
 */

const REPO = process.cwd();
const ROUTE = readFileSync(path.join(REPO, "src/app/setup-api/setup/reset/route.ts"), "utf-8");
const GUIDE = readFileSync(path.join(REPO, "docs-site/support/recovery.mdx"), "utf-8");

const routeKeep = (): string[] => {
  const m = /const HERMES_KEEP = new Set\(\[([^\]]*)\]\)/.exec(ROUTE);
  if (!m) throw new Error("HERMES_KEEP not found in the reset route");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
};

describe("the recovery guide's SSH reset keeps what the UI reset keeps", () => {
  it("spares exactly HERMES_KEEP when it wipes ~/.hermes", () => {
    const line = GUIDE.split("\n").find((l) => /find ~\/\.hermes .*-exec rm -rf/.test(l));
    expect(line, "the guide no longer wipes ~/.hermes with find").toBeDefined();
    const spared = [...line!.matchAll(/! -name (\S+)/g)].map((x) => x[1]).sort();
    expect(spared).toEqual(routeKeep());
  });
});
