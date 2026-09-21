/**
 * What counts as a pinnable update branch.
 *
 * One definition, three consumers: the updater (src/lib/updater.ts), the
 * Settings route (setup-api/system/update-branch) and install.sh's
 * `is_safe_git_ref`, which applies the same character class before handing the
 * value to `git check-ref-format --branch`.
 *
 * Any disagreement between those validators is silent branch drift. A value one
 * side writes and another side refuses does not fail — it falls through to
 * `main`, and the device updates onto software it was never built for while its
 * pin still reads as a deliberate choice. That is why the character class and
 * the grammar rules live here rather than being restated per call site;
 * src/tests/unit/update-branch-validator.test.ts holds install.sh and this file
 * to the same answers.
 */

/**
 * Characters. The negative lookahead rejects a leading '-' (or '/'): a branch
 * token that starts with '-' is parsed by git as an option flag (e.g. "-D",
 * "--all") rather than a ref, which smuggles switches into the checkout/fetch
 * commands and bricks the updater. Real branch names never start with '-' or '/'.
 */
const SAFE_BRANCH_CHARS = /^(?![-/])[A-Za-z0-9._\-/]+$/;

/**
 * Grammar. `git check-ref-format --branch` rejects each of these, the character
 * class alone does not, and every one of them resolves somewhere unintended:
 *
 *   "HEAD"    `git reset --hard origin/HEAD` follows origin's *default* branch
 *             — i.e. main — so a device pinned to "HEAD" silently tracks main.
 *   "a..b"    a revision range, not a ref.
 *   "x/"      not a ref; git refuses the checkout and the update fails.
 *
 * Only an exact "HEAD" is reserved: "feature/HEAD" and "HEAD/x" are branches git
 * accepts, and rejecting them here would put this file back out of step with
 * install.sh in the other direction.
 */
const INVALID_BRANCH = [
  /^HEAD$/,
  /\.\./, // ".." anywhere — a range, and git forbids it in a ref
  /\/\//, // empty path component
  /\/$/, // trailing slash
  /(^|\/)\./, // a path component starting with "."
  /\.($|\/)/, // a path component ending with "."
  /\.lock($|\/)/, // git's reserved lock-file suffix
];

/** True when `branch` is safe to interpolate into `origin/<branch>` and to check out. */
export function isSafeBranch(branch: string): boolean {
  if (!SAFE_BRANCH_CHARS.test(branch)) return false;
  return !INVALID_BRANCH.some((re) => re.test(branch));
}
