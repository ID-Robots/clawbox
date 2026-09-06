import path from "path";
import { existsSync } from "fs";

/**
 * The one thing that stops `openclaw doctor` before it migrates anything.
 *
 * With a legacy `exec-approvals.json` in the state directory the core's
 * security gate (`assertNoPendingLegacyExecApprovals`) throws on the file's
 * mere PRESENCE, so `doctor --fix` exits 1 having migrated NOTHING — measured
 * against 2026.8.1 on 2026-09-06, with the sentence on stderr and in full:
 *
 *     Legacy exec approvals exist at <state>/exec-approvals.json. Run
 *     `openclaw doctor --fix` with OPENCLAW_STATE_DIR set to <state> before
 *     using exec approvals.
 *
 * — advice for the command that has just run, with the state directory the
 * caller had already set. ClawBox never moves a file that holds approvals of
 * the owner's, so on that box the useful half of the sentence is the PATH and
 * the actionable half is the owner's own.
 *
 * WHY THIS IS A MODULE. `scripts/gateway-pre-start.sh`, `install.sh` and
 * `install-x64.sh` grep this sentence case-sensitively and `openclaw-config.ts`
 * matched it case-insensitively with a copy of its own; the comment beside that
 * copy said a fourth reader was where a shared constant earned itself, and
 * `updater.ts` is the fourth. A module of its own rather than another export on
 * `@/lib/openclaw-config`: fifty-nine suites replace that module with a
 * hand-written factory, and an export none of them lists is `undefined` at
 * runtime — a matcher that answers `undefined.test(…)` throws where a missing
 * function merely returns nothing. Nothing mocks this file.
 *
 * All the readers fail SAFE: a reworded upstream sentence reverts each of them
 * to its old, stricter behaviour rather than to a wrong classification.
 */
export const LEGACY_EXEC_APPROVALS_RE = /Legacy exec approvals exist at/i;

/**
 * Both names the core's gate refuses on, in the order it finds them.
 *
 * doctor renames the file to the `.doctor-importing` claim for the duration of
 * an import, so a killed import leaves one behind that blocks every later
 * doctor exactly as the original does.
 */
export const LEGACY_EXEC_APPROVALS_NAMES = [
  "exec-approvals.json",
  "exec-approvals.json.doctor-importing",
] as const;

/** Doctor's own sentence with the path it names captured. */
const LEGACY_EXEC_APPROVALS_PATH_RE = /Legacy exec approvals exist at\s+(\S+?)[.,;]?(?:\s|$)/i;

/**
 * WHICH file is blocking, in the order of what can be trusted.
 *
 * The core's own sentence first — it names the file the gate actually tripped
 * over, which is the only source that cannot be wrong about a box with a
 * non-standard state directory. Then the filesystem, because a doctor killed
 * before it printed anything still leaves the blocker where it is. The
 * canonical path last, so the owner is always given something to look at
 * rather than a sentence about a file with no name.
 */
export function legacyExecApprovalsBlocker(said: string, openclawHome: string): string {
  const named = LEGACY_EXEC_APPROVALS_PATH_RE.exec(said)?.[1];
  if (named) return named;
  const candidates = LEGACY_EXEC_APPROVALS_NAMES.map((name) => path.join(openclawHome, name));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
