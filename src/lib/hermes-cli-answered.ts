import type { HermesCliResult } from "@/lib/hermes-cli";

/**
 * Did `hermes` itself run and speak, or did the question fail before it could?
 *
 * The memos around the CLI keep an ANSWER for a long time (the life of the
 * process, or until config.yaml is rewritten) and hold a FAILURE only for a
 * short backoff, so which of the two a result is decides whether a wrong
 * `false` hides the attach button for a minute or until the next restart.
 * `runHermesCli` already rejects for a missing binary, a timeout and its own
 * SIGKILL, and a child killed by a signal closes with `code: null` — none of
 * those are answers. Neither are 126 and 127. `hermes` on the box is a shim
 * over a venv Python, and while an update moves the checkout aside and rebuilds
 * it (`step_hermes_install` in install.sh, about 90 s, with no web-server
 * restart afterwards) the shim EXISTS and RUNS but exits 127 — 126 when the
 * interpreter is there and not executable — without ever reaching argparse.
 * Those are the shell's codes, not the CLI's: nothing about the flag or the
 * key was said, and a memo that stored them as the CLI's verdict remembered
 * "no `--image`" for the life of the process on a box whose checkout was back
 * a minute later.
 */
export function hermesCliAnswered(result: Pick<HermesCliResult, "code">): boolean {
  return typeof result.code === "number" && result.code !== 126 && result.code !== 127;
}
