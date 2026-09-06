import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Slicing `scripts/gateway-pre-start.sh`, in one place.
 *
 * Four suites run blocks of the boot script VERBATIM rather than a copy, so a
 * drift in the shipped script fails a test instead of a box. Each one had its
 * own copy of the same two functions, and they had already drifted: one threw a
 * named error when the markers moved, another returned a silent empty string.
 */
export const GATEWAY_PRE_START = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");

/** The script text, read fresh — these suites assert against what is on disk. */
export function scriptSource(): string {
  return readFileSync(GATEWAY_PRE_START, "utf-8");
}

/**
 * The text from `from` up to (not including) `to`.
 *
 * Throws when either marker has moved, naming it: a slice that silently came
 * back empty would leave the suite passing over code it never ran.
 */
export function sliceScript(from: string, to: string): string {
  const src = scriptSource();
  const start = src.indexOf(from);
  if (start < 0) throw new Error(`gateway-pre-start.sh no longer contains ${from.trim()}`);
  const end = src.indexOf(to, start);
  if (end < 0) throw new Error(`gateway-pre-start.sh no longer contains ${to.trim()} after ${from.trim()}`);
  return src.slice(start, end);
}

/**
 * The plugin-repair helpers (TASK-606).
 *
 * They are defined ~1300 lines above the blocks that call them, so an extract
 * starting at one of those blocks runs a call to a function that is not there —
 * exit 127, `clawbox_plugin_boot_without: command not found`. Prepended rather
 * than stubbed, so the suites keep running the shipped code.
 *
 * They write `$CLAWBOX_ROOT/data/plugin-repair.json`, so a suite that uses them
 * must point CLAWBOX_ROOT at its own temp directory or the marker leaks between
 * cases through the run-wide one `vitest.config.ts` sets.
 */
export function repairHelpers(): string {
  return sliceScript(
    "# ── Booting WITHOUT a plugin that could not be made loadable ",
    "# A `.openclaw` INSIDE the state directory",
  );
}
