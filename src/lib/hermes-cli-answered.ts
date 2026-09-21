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

/**
 * Did `hermes config set` say its own coercion missed and it stored the value
 * as TEXT?
 *
 * `hermes config set k '["a","b"]'` exits 0 either way; when the structured
 * parse does not yield a list it prints "…storing as string." to stderr and
 * saves the literal (hermes_cli/config.py:5514-5527 on the pinned 0.20.5).
 * Every key this repo writes as a JSON literal has to read that line, because
 * an exit code is not an outcome — `providers.clawai.models` degrades to a
 * one-id allowlist and `plugins.enabled` disables every user plugin on the box.
 *
 * One function rather than the regex written out at each site: the two callers
 * that had their own copy also grew their own idea of what the answer MEANT,
 * which is how a proved "stored as text" and an unanswerable question came to
 * be handled alike in one of them.
 */
export function hermesStoredValueAsText(result: Pick<HermesCliResult, "stderr">): boolean {
  return /storing as string/i.test(result.stderr ?? "");
}
