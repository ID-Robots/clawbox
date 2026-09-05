// The paths the on-device agent may never delete, overwrite, truncate or move.
//
// WHY THIS EXISTS. On 2026-09-02 a Hermes turn was asked to "delete the largest
// of those files"; it reasoned for a hundred seconds and then ran `rm` on a
// 3.2 GB Gemma GGUF under `…/data/llamacpp/models/` with no confirmation of any
// kind, mid-turn, while another turn was still running (TASK-605). The owner's
// ruling (2026-09-04) is deliberately narrow: **a hard deny rule on the local
// model folder and the ClawBox tree, and no prompt anywhere else** — "narrower,
// but silent when it bites". So there is no confirmation gate here, no clarify,
// no approval prompt: two path families are simply refused, everything else runs
// exactly as it did before, and the agent is handed the harness's own refusal
// text so it can tell the owner what happened.
//
// HARNESS FIRST — WHAT EACH HARNESS OWNS, AND WHAT IT DOES NOT
//
//   * Hermes 0.20.5 ships the deny itself: `approvals.deny` in
//     `~/.hermes/config.yaml` is a list of fnmatch globs matched against the
//     command, and a match blocks it BEFORE the `--yolo` / `/yolo` /
//     `approvals.mode: off` bypass — the user-editable counterpart of the
//     code-shipped hardline floor (`tools/approval.py:623` `_match_user_deny_rule`,
//     `:655` `_user_deny_block_result`, applied at `:3751` in
//     `check_dangerous_command` and `:4384` in `check_all_command_guards`).
//     `hermesDenyGlobs()` below renders that list; `scripts/register-mcp.sh`
//     merges it into the config on every boot. Nothing new is invented.
//
//   * OpenClaw 2026.8.1 has NO path-scoped deny. Its exec policy is
//     allowlist-shaped end to end — `tools.exec.mode` is
//     `deny|allowlist|ask|auto|full` over ALL host exec, and an approvals
//     allowlist entry is a glob over the BINARY (`~/Projects/**/bin/rg`), never
//     over the file a command touches. Its own documentation says so: "To
//     hard-block host exec, set approvals security to `deny` or deny the `exec`
//     tool via tool policy" (`docs/tools/exec-approvals.md:613`). The seam that
//     CAN express this is the core's typed `before_tool_call` hook — "Block a
//     tool or request approval", `{ block: true, blockReason }`, matched on
//     canonical tool ids and fail-CLOSED on handler timeout
//     (`docs/plugins/hooks.md:154`, `:242`, `:297`, `:460-520`) — which is what
//     `scripts/openclaw-plugins/clawbox-path-guard` registers. That is the same
//     seam `clawbox-email-directives` already uses for `reply_payload_sending`.
//
// THREE COPIES, ONE TABLE. This module is the definition. The two enforcement
// surfaces cannot import it — one is a Python-evaluated glob list inside
// `~/.hermes/config.yaml`, the other is a `.mjs` module loaded by the OpenClaw
// gateway's own Node process — so `src/tests/unit/protected-paths.test.ts` runs
// one shared case table through both and fails when they drift, exactly as
// `email-directive-parity.test.ts` does for the `EMAIL:` grammar.
//
// WHAT A COMMAND-STRING DENY CANNOT DO, stated rather than implied. Hermes
// matches globs against the command text, so it cannot see the process's
// working directory and it cannot read intent out of an interpreter: `python3 -c
// "os.remove(...)"`, a script that computes its target, or a `cd` into the tree
// followed by a bare `rm x.gguf` are outside its reach. The reverse-order globs
// below catch the common `cd <protected> && rm <file>` spelling, and the
// OpenClaw hook — which is handed `workdir` as a structured parameter — has no
// such hole. This is a hard floor on the spellings that actually cost a customer
// a 3.2 GB download, not a sandbox.

/**
 * The path fragments that are off limits, as they appear INSIDE a command.
 *
 * Each is matched as a substring, which is why every one begins and ends with a
 * separator: `/clawbox/` is the ClawBox checkout in every spelling the agent can
 * write — `~/clawbox/…`, `$HOME/clawbox/…`, `/home/clawbox/clawbox/…` — plus
 * `/etc/clawbox/` (the root-owned edition lock) and any other directory named
 * `clawbox`, all of which are things this appliance should never let a turn
 * delete.
 *
 * `/llamacpp/models/` and `/embed/models/` are the two model stores ClawBox
 * writes (`install.sh` `step_llamacpp_model` → `$PROJECT_DIR/data/llamacpp/models`,
 * `step_embed_model` → `$PROJECT_DIR/data/embed/models`). Both live inside the
 * tree on a stock box and are therefore already covered by `/clawbox/` — they
 * are listed separately because the file the incident destroyed was in a SECOND
 * checkout (`~/check-acbuild/data/llamacpp/models/`), and the ruling names the
 * model folder wherever it is.
 *
 * DELIBERATELY NOT HERE: `~/.cache/huggingface/hub/models--*`, where the Kokoro
 * and faster-whisper weights land. That is a cache the installer re-fetches, and
 * denying `rm` on it would block the documented repair for a corrupt download.
 */
export const PROTECTED_PATH_FRAGMENTS: readonly string[] = [
  "/clawbox/",
  "/llamacpp/models/",
  "/embed/models/",
];

/**
 * Verbs that delete, overwrite, truncate or move — the four operations the
 * ruling names — as they appear before a path.
 *
 * `rmdir` is absent on purpose: it removes only EMPTY directories, so it cannot
 * cost anyone a model file, and `*rm *` does not match `rmdir` (no space). `dd`
 * is absent for the opposite reason: the glob `*dd *` also matches `git add `,
 * and a deny that fires on `git add` inside the tree is worse than the exotic
 * `dd of=…` it would catch.
 */
export const DESTRUCTIVE_VERBS: readonly string[] = [
  "rm",
  "unlink",
  "shred",
  "truncate",
  "mv",
  "tee",
];

/**
 * The verbs that also get a REVERSED glob, for `cd <protected> && rm <file>`
 * — the one spelling where the path precedes the verb and the file being
 * destroyed is named relatively.
 *
 * Only two, because the reversed form is the loose one: `*/clawbox/*rm *` also
 * matches `cat ~/clawbox/notes | grep "rm "`. Refusing that is a cost worth
 * paying for `rm` and `mv`; it is not worth paying for `tee` or `truncate`,
 * which nobody reaches for after a `cd`.
 */
export const RELOCATING_VERBS: readonly string[] = ["rm", "mv"];

/**
 * `approvals.deny` for `~/.hermes/config.yaml`: Hermes' own fnmatch globs,
 * lowercase because `_match_user_deny_rule` lowercases both sides.
 *
 * Every glob is `*`-wrapped because `fnmatch.fnmatchcase` matches the WHOLE
 * string. There is no absolute-path variant of the tree: Hermes normalises the
 * resolved `$HOME` into `~/` before matching
 * (`_normalize_command_for_detection`, `tools/approval.py:1158-1173`), so
 * `/home/clawbox/clawbox/…` reaches the matcher as `~/clawbox/…` and the single
 * `/clawbox/` fragment covers both. Verified on the Hermes box with
 * `hermes approvals test --json`, which runs the real evaluators without
 * executing anything.
 */
export function hermesDenyGlobs(): string[] {
  const globs: string[] = [];
  for (const fragment of PROTECTED_PATH_FRAGMENTS) {
    for (const verb of DESTRUCTIVE_VERBS) globs.push(`*${verb} *${fragment}*`);
    for (const verb of RELOCATING_VERBS) globs.push(`*${fragment}*${verb} *`);
    // `>` and `>>` with or without a space, and `2>` — every redirection whose
    // target is inside a protected path truncates or creates a file there.
    globs.push(`*>*${fragment}*`);
  }
  return globs;
}
