/**
 * Node's `path`, for every path this server works out at RUNTIME.
 *
 * Code under src/ imports `path` from here, never from "path" or "node:path"
 * (src/tests/unit/runtime-path-imports.test.ts enforces this). The functions
 * are Node's own. What changes is what `next build` sees.
 *
 * Turbopack spots `path.join` and `path.resolve` by the module they came from
 * and evaluates their arguments. Every call it can only partly resolve becomes
 * a FILE REFERENCE, which is a glob over the project directory. The roots this
 * app joins onto are all unknown at build time: CLAWBOX_ROOT, DATA_DIR, a home
 * directory, a folder named in a request. So `path.join(CONFIG_ROOT, "data")`
 * became "any directory called data" and `path.join(dir, name)` became "the
 * whole project". While it built the module graph, the build walked `data/`,
 * which holds the owner's live state, the coding agent's evidence folders and
 * the code projects. It then listed what it found in the middleware and
 * instrumentation traces and copied that into `.next/standalone`:
 *
 *   - a Python venv a coding run left in its evidence folder
 *     (`bin/python -> python3 -> /usr/bin/python3`) made Turbopack panic with
 *     "Symlink … is invalid, it points out of the filesystem root", and the
 *     build failed (rig boards, 2026-09-23; TASK-1102);
 *   - a stream file a live run rotated between the trace and the copy made
 *     the standalone copy die on ENOENT, for a file the dashboard never reads
 *     from there.
 *
 * `outputFileTracingExcludes` cannot reach either one. The walk happens while
 * the module graph is built, before any exclude is read, and Next applies the
 * excludes to route traces only, never to the middleware or instrumentation
 * ones (see next.config.ts).
 *
 * Imported from here, the same calls are ordinary function calls as far as the
 * build is concerned, so it traces nothing through them. Measured on
 * Next 16.3.5: `fs.readdirSync(path.join(ROOT, "x", name))` traced every
 * matching file in the project with `path` from "path", and traced nothing with
 * `path` from this module. Turbopack's own opt-out, a `turbopackIgnore`
 * comment inside the call, does the same thing for that one call only.
 * `path.join(dir, "package.json")` also matches every package.json in the
 * owner's code projects, so the rule has to cover every call, not just the
 * few that Turbopack warns about.
 *
 * Runtime files come from the checkout (CONFIG_ROOT) and never from
 * `.next/standalone`, so nothing is lost by this. scripts/check-build-isolation.sh
 * builds the app over a planted `data/` in CI and fails if any trace reaches it.
 */
import nodePath from "path";

export default nodePath;
export const join = nodePath.join;

/**
 * A path built with a template or `+` instead of `join`, passed on unchanged.
 *
 * The build reads those as well: to it, `${file}.tmp` means every *.tmp in the
 * project, and `${CONFIG_PATH}.lock` means every *.lock. data/ holds exactly
 * those files for the moment an atomic write or a lock is in flight, so a
 * build that listed one could lose it before the copy (the ENOENT above).
 * Wrap the string where it is built, `untraced(`${file}.tmp`)`, and every fs
 * call that later receives it traces nothing.
 */
export function untraced(p: string): string {
  return p;
}
