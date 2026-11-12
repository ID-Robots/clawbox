import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * A sandbox home that only `as_clawbox` may write to, for the installer
 * functions that do file work in the service account's home.
 *
 * On a box root runs install.sh and the clawbox user owns its home; a write
 * root makes there follows any link that user planted. A test runs as neither,
 * so the difference is modelled with permission bits: every directory and file
 * in the home is made read-only, and the `as_clawbox` stub puts the modes back
 * only while the command it wraps runs, then records them and takes the write
 * bits away again. A write root's own shell makes in the home — a `>`, `>>`, a
 * `mkdir`, an `rm` or a `mv` — then fails with EACCES, which a recorder of
 * commands alone cannot see: `as_clawbox cat >> "$f"` has root's shell open
 * `$f` before `cat` ever starts.
 *
 * What permission bits cannot stop, because the test process owns every file,
 * is a `chmod` or `chown` root makes there. Those, and the other commands that
 * touch files, are recorded when they run outside the wrapper with a path in
 * the home: `rootInHome()` must stay empty.
 *
 * Root ignores the mode bits, so under uid 0 the lock models nothing and the
 * callers fall back to the recorder alone (`lock: false`).
 */
export const CAN_LOCK_HOME =
  process.platform === "linux" && typeof process.getuid === "function" && process.getuid() !== 0;

/** Commands that read or change files, recorded when root runs them on a home path. */
const RECORDED = [
  "awk", "cat", "chmod", "chown", "cp", "install", "ln", "mkdir", "mktemp", "mv", "rm",
  "rmdir", "tee", "touch",
];

export interface AccountOnlyHome {
  /** Shell to source before the code under test; defines `as_clawbox`. */
  shell: string;
  /** Root's file commands that named a path in the home, one per line. */
  rootInHome: () => string[];
  /** Every command run through `as_clawbox`, one per line. */
  asClawbox: () => string[];
}

/**
 * `home` is the sandbox home; `aux` a directory outside it for the mode table
 * and the log. With `lock` the home is read-only outside `as_clawbox`, from the
 * `__ao_lock` the caller runs before the code under test until the script exits.
 */
export function accountOnlyHome(home: string, aux: string, { lock = CAN_LOCK_HOME } = {}): AccountOnlyHome {
  const log = path.join(aux, "root-in-home.log");
  const calls = path.join(aux, "as-clawbox.log");
  fs.writeFileSync(log, "");
  fs.writeFileSync(calls, "");
  const shell = [
    `__AO_HOME=${JSON.stringify(home)}`,
    `__AO_MODES=${JSON.stringify(path.join(aux, "home-modes.tsv"))}`,
    `__AO_LOG=${JSON.stringify(log)}`,
    `__AO_CALLS=${JSON.stringify(calls)}`,
    ...(lock
      ? [
        "__ao_lock() {",
        "  find \"$__AO_HOME\" \\( -type d -o -type f \\) -printf '%m\\t%p\\n' > \"$__AO_MODES\"",
        "  find \"$__AO_HOME\" \\( -type d -o -type f \\) -exec chmod a-w -- {} +",
        "}",
        "__ao_unlock() {",
        "  local mode p",
        "  [ -f \"$__AO_MODES\" ] || return 0",
        "  while IFS=$'\\t' read -r mode p; do command chmod \"$mode\" -- \"$p\" 2>/dev/null || true; done < \"$__AO_MODES\"",
        "}",
        "trap __ao_unlock EXIT",
      ]
      : ["__ao_lock() { :; }", "__ao_unlock() { :; }"]),
    // The service account: the home's own modes, for the wrapped command only.
    "as_clawbox() {",
    '  local rc=0',
    '  printf \'%s\\n\' "$*" >> "$__AO_CALLS"',
    '  __ao_unlock',
    '  AS_SERVICE_USER=1 "$@" || rc=$?',
    '  __ao_lock',
    '  return "$rc"',
    "}",
    "__ao_root() {",
    "  local a",
    '  for a in "${@:2}"; do',
    '    case "$a" in *"$__AO_HOME"*) printf \'%s\\n\' "$*" >> "$__AO_LOG"; return 0 ;; esac',
    "  done",
    "}",
    ...RECORDED.map(
      (cmd) => `${cmd}() { [ -n "\${AS_SERVICE_USER:-}" ] || __ao_root ${cmd} "$@"; command ${cmd} "$@"; }`,
    ),
  ].join("\n");
  const lines = (file: string) => fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  return { shell, rootInHome: () => lines(log), asClawbox: () => lines(calls) };
}

/** Write bits back on a sandbox a failed run left locked, so it can be removed. */
export function unlockTree(dir: string): void {
  if (fs.existsSync(dir)) spawnSync("chmod", ["-R", "u+w", dir], { stdio: "ignore" });
}

/**
 * install.sh's function `name`, cut at its first column-0 `}`, or "" when the
 * file has none: the hand-over helper these runs source does not exist on a
 * tree from before it, and a run there must fail on the behaviour, not here.
 */
export function shellFunctionIfPresent(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) return "";
  const end = source.indexOf("\n}", start + 1);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${source.slice(start + 1, end)}\n}`;
}
