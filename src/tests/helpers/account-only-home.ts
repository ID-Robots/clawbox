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
  /**
   * Shell to source AFTER the hand-over helpers are defined: each call of
   * `hand_over_home_path` or `hand_over_checkout` is then logged, in order,
   * with the commands `as_clawbox` runs (`sequence`).
   */
  recordHandOvers: string;
  /** Root's file commands that named a path in the home, one per line. */
  rootInHome: () => string[];
  /** Every command run through `as_clawbox`, one per line. */
  asClawbox: () => string[];
  /** The hand-overs (`hand-over <helper> <args>`) and `as_clawbox` commands, in the order they ran. */
  sequence: () => string[];
}

/** The prefix of a hand-over line in `sequence()`. */
export const HAND_OVER = "hand-over ";

/**
 * Where in `sequence` the hand-over `call` ran, and where the first command
 * through `as_clawbox` did: a site that writes as the account must hand over
 * first, so `handOver` is found and comes before `firstWrite`.
 */
export function handOverOrder(sequence: string[], call: string): { handOver: number; firstWrite: number } {
  return {
    handOver: sequence.indexOf(`${HAND_OVER}${call}`),
    firstWrite: sequence.findIndex((l) => !l.startsWith(HAND_OVER)),
  };
}

/**
 * A `chown` for root that changes nothing and records, for every operand of a
 * RECURSIVE call, where the change would land: the operand's directory resolved
 * through every link, then the operand's own name, which `chown -R` does not
 * follow. One path per line in `log`.
 */
export function recursiveChownRecorder(log: string): string {
  return [
    "chown() {",
    '  local a r="" owner=""',
    '  for a in "$@"; do case "$a" in -R) r=1 ;; esac; done',
    '  [ -n "$r" ] || return 0',
    '  for a in "$@"; do',
    '    case "$a" in -*) continue ;; esac',
    '    if [ -z "$owner" ]; then owner=1; continue; fi',
    `    printf '%s/%s\\n' "$(cd -P -- "$(dirname -- "$a")" 2>/dev/null && pwd -P)" "$(basename -- "$a")" >> ${JSON.stringify(log)}`,
    "  done",
    "}",
  ].join("\n");
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
  // Each helper that is defined is renamed and wrapped: the wrapper logs the
  // call to the same file as `as_clawbox`, then runs the helper unchanged.
  const recordHandOvers = [
    "__ao_record_hand_overs() {",
    "  local fn",
    "  for fn in hand_over_home_path hand_over_checkout; do",
    '    declare -F "$fn" >/dev/null || continue',
    '    eval "$(declare -f "$fn" | sed "1s/^$fn /__ao_real_$fn /")"',
    `    eval "$fn() { printf '%s\\\\n' \\"${HAND_OVER}$fn \\$*\\" >> \\"\\$__AO_CALLS\\"; __ao_real_$fn \\"\\$@\\"; }"`,
    "  done",
    "}",
    "__ao_record_hand_overs",
  ].join("\n");
  const lines = (file: string) => fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  return {
    shell,
    recordHandOvers,
    rootInHome: () => lines(log),
    asClawbox: () => lines(calls).filter((l) => !l.startsWith(HAND_OVER)),
    sequence: () => lines(calls).map((l) => l.trimEnd()),
  };
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
