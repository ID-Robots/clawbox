/**
 * What a coding run has to LEAVE BEHIND before the box calls it finished.
 *
 * WHY THIS EXISTS. A headless run settles as `completed` on one fact: Claude
 * Code emitted a success result event. A harness that investigated for twenty
 * turns, concluded the task was too hard and wrote a polite paragraph about it
 * emits exactly that — so the card said "Finished", the finish notice fired,
 * and nothing on the device had looked at whether the thing the owner asked
 * for was there. A run is done when the deliverable exists; until then
 * "completed" is the harness's opinion of itself.
 *
 * PURE on purpose, and split from ./coding-deliverable-check for the reason
 * ./coding-pr-state is split from ./coding-pr: the run's page renders the
 * deliverable and its verdict, and a client component that imported the module
 * which stats files and spawns a command would pull `fs` and `child_process`
 * into the browser bundle, where they do not resolve and the build fails
 * outright.
 */

/**
 * The three things a run can be held to.
 *
 * - `pr`     — a pull request exists for the run's branch. Implied when the
 *              owner has auto-PR on, because that switch already says "the
 *              point of a run is a pull request".
 * - `paths`  — named files exist in the working folder and are NOT EMPTY. An
 *              empty file is the shape a run leaves when it created the file
 *              it was told to create and then ran out of turns, so size is
 *              part of the test rather than a refinement of it.
 * - `command`— a command the box runs itself, in the harness's own sandbox,
 *              which has to exit 0. The project's own verification, usually.
 *
 * A union rather than one record with three optional halves: a deliverable is
 * ONE question, and a record that could carry two would need a rule about what
 * "missing" means when they disagree.
 */
export type Deliverable =
  | { kind: "pr" }
  | { kind: "paths"; paths: string[] }
  | { kind: "command"; command: string };

/** Every kind a stored record may carry — beside the type, for the reason
 *  RUN_STATUSES lives beside CodingRunStatus. */
export const DELIVERABLE_KINDS = ["pr", "paths", "command"] as const;

export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

/** How many paths one deliverable may name. A run delivers a handful of files;
 *  a list of hundreds is a caller using this as a file manifest. */
export const MAX_DELIVERABLE_PATHS = 10;
/** How long one of those paths may be. */
export const MAX_DELIVERABLE_PATH_CHARS = 256;
/** How long the command may be. Longer than a test command ever is, and short
 *  enough that the whole thing fits on the card and in a nudge. */
export const MAX_DELIVERABLE_COMMAND_CHARS = 300;
/**
 * The longest "what is missing" sentence a record will carry.
 *
 * Bounded because one branch of it quotes the TAIL of a command's own output,
 * which is neither this box's vocabulary nor the harness's — it is whatever a
 * project's test runner printed, and the runs file is read back on every boot
 * and polled by two UIs.
 */
export const MAX_MISSING_CHARS = 300;

/** Attempts at the deliverable a run gets by default, the original included. */
export const DEFAULT_COMPLETION_ATTEMPTS = 3;
/**
 * One is a real setting: check the deliverable, and if it is not there say so
 * rather than nudging. That is the whole feature for an owner who wants the
 * honest verdict and nothing spent on a second try.
 */
export const MIN_COMPLETION_ATTEMPTS = 1;
/** The ceiling. Six harness turns at one task is already a long evening. */
export const MAX_COMPLETION_ATTEMPTS = 6;

/**
 * One attempt at the deliverable, as the record carries it.
 *
 * `reason` is what was MISSING when that attempt was judged, and null when it
 * passed — so the list reads as the history of the question rather than as a
 * list of restarts. The first entry is the run's own original turn: the owner
 * asked for a deliverable, the harness had one go at it, and that go is an
 * attempt like any other.
 */
export interface RunAttempt {
  startedAt: number;
  /** ms since the epoch, or null while this attempt is still being made. */
  endedAt: number | null;
  /** What was still missing when it ended; null when the deliverable was there. */
  reason: string | null;
}

/** The last verdict the box reached on a run's deliverable. */
export interface DeliverableVerdict {
  ok: boolean;
  /** What is missing, in words meant for the owner. Null when `ok`. */
  missing: string | null;
  /** When it was checked. */
  checkedAt: number;
}

/**
 * Why a deliverable was refused at creation. A stable code beside the English,
 * the shape every other refusal in this family has: a surface that cannot tell
 * "that path is not relative" from "only you can name a command" would word
 * both the same way, and a caller that cannot tell them apart retries the
 * wrong one.
 */
export const DELIVERABLE_REFUSAL_CODES = [
  "bad_kind",
  "no_paths",
  "too_many_paths",
  "bad_path",
  "no_command",
  "command_too_long",
  "command_denied",
  "command_owner_only",
] as const;

export type DeliverableRefusalCode = (typeof DELIVERABLE_REFUSAL_CODES)[number];

export type DeliverableInput =
  | { ok: true; deliverable: Deliverable }
  | { ok: false; code: DeliverableRefusalCode; error: string };

/**
 * Commands the box will not run on a run's behalf, whoever asked.
 *
 * The same rule `BASH_KILL_DENYLIST` puts on the harness's own shell, for the
 * same measured reason: on 2026-09-05 a run's `pkill -f next-server`, meant
 * for the dev server it had started, took ClawBox itself down and systemd's
 * restart marked that run lost fourteen minutes in. A deliverable command runs
 * in the harness's sandbox but NOT through Claude Code's permission layer, so
 * without this it would be the one way back to that outage — and the owner,
 * who may legitimately run anything from the Terminal app, has no reason to
 * want it here either: a deliverable is a test of the work, not an operation
 * on the box.
 *
 * Deliberately NOT an attempt to parse a shell. It is a refusal of the names
 * that took the box down, anywhere in the command, including behind a `;` or a
 * `&&` — which is why it does not anchor.
 */
const COMMAND_DENIED_RE = /\b(?:pkill|killall|fuser)\b|\bkill\s+(?:-\S+\s+)*-1\b/;

/** Whether the kill-denylist refuses this command. Exported for its test. */
export function isDeniedDeliverableCommand(command: string): boolean {
  return COMMAND_DENIED_RE.test(command);
}

/**
 * Whether a path may be a deliverable path: RELATIVE, normalised, and inside
 * the folder it will be resolved against.
 *
 * Rebuilt-not-tested is the rule elsewhere in this codebase for a path that
 * reaches a filesystem call (`safeAppId`, `safeProjectId`, `safeSkillName`),
 * and this is the same class of string. Here the alphabet cannot be closed —
 * a deliverable is a real source file and may be called anything a filesystem
 * accepts — so the containment is done by the CHECKER, which resolves the path
 * and refuses anything that leaves the working folder. This function is the
 * cheap door: it keeps the obvious nonsense out of the record in the first
 * place, and is pure so the route, the panel and the checker agree.
 */
export function isSafeDeliverablePath(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const path = raw.trim();
  if (!path || path.length > MAX_DELIVERABLE_PATH_CHARS) return false;
  // NO CONTROL CHARACTER, which covers the NUL and more besides.
  //
  // A NUL truncates the string at every syscall that takes it, so a path that
  // passes a check up to the NUL and names something else afterwards is the
  // classic way past one. A NEWLINE or carriage return is the other half and the
  // one a path rule is likely to miss: this string is interpolated into the
  // continuation prompt the box sends the harness on stdin (`completionNudge`),
  // where an embedded line break would let a filename forge a line of that
  // prompt — the harness reading instructions the box never wrote. Escape and
  // the rest of C0 are refused with them; a real source file is named in none of
  // them, so there is nothing legitimate on the other side of this door.
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  // Absolute, or a Windows-style drive or UNC path: a deliverable is always
  // relative to the run's own folder, and an absolute one would be a way to
  // ask the box whether a file it must not read exists.
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  // `..` in any segment, with either separator. Not a substring test: a file
  // legitimately called `..hidden` or `a..b` is not traversal.
  const segments = path.split(/[/\\]/);
  if (segments.some((s) => s === ".." || s === "")) return false;
  return true;
}

/**
 * Read a deliverable off an UNTRUSTED creation request, or say why not.
 *
 * Separate from `parseDeliverable` below, and the asymmetry is deliberate: a
 * caller naming a deliverable is owed a REASON, while a stored record that
 * does not parse is simply not a deliverable — nothing is waiting on an
 * explanation, and the safe reading of a hand-edited or newer-build record is
 * "this run has no deliverable" rather than one no surface here can word.
 *
 * @param raw  the request's `deliverable` field, whatever it turned out to be
 * @param owner whether the OWNER asked (a browser session), as opposed to the
 *        MCP bearer. Only the owner may name a `command` — see the refusal.
 */
export function readDeliverableInput(raw: unknown, owner: boolean): DeliverableInput | null {
  // Absent is not a refusal: a run without a deliverable is the old behaviour
  // and the overwhelming majority of runs.
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "bad_kind", error: `A deliverable is { kind: ${DELIVERABLE_KINDS.map((k) => `"${k}"`).join(" | ")} }.` };
  }
  const value = raw as Record<string, unknown>;

  if (value.kind === "pr") return { ok: true, deliverable: { kind: "pr" } };

  if (value.kind === "paths") {
    if (!Array.isArray(value.paths) || value.paths.length === 0) {
      return { ok: false, code: "no_paths", error: "A paths deliverable needs at least one relative file path." };
    }
    if (value.paths.length > MAX_DELIVERABLE_PATHS) {
      return { ok: false, code: "too_many_paths", error: `A deliverable may name at most ${MAX_DELIVERABLE_PATHS} files.` };
    }
    const paths: string[] = [];
    for (const entry of value.paths) {
      if (!isSafeDeliverablePath(entry)) {
        return {
          ok: false,
          code: "bad_path",
          error: "Each deliverable path must be a relative path inside the run's folder, with no \"..\" segment.",
        };
      }
      const path = entry.trim();
      // Deduplicated, so "index.html" named twice is not reported as two
      // missing files, and the cap counts real files.
      if (!paths.includes(path)) paths.push(path);
    }
    return { ok: true, deliverable: { kind: "paths", paths } };
  }

  if (value.kind === "command") {
    // OWNER ONLY, and the one refusal here that is about WHO rather than WHAT.
    //
    // A deliverable command is run by the box, in the harness's sandbox, and
    // NOT through Claude Code's permission layer — so an MCP caller able to
    // name one would hold command execution that the run's own Bash does not
    // grant it, and that the Hermes edition grants the agent nowhere at all.
    // The rule for this whole family is that nothing an MCP caller does may
    // widen past what the owner enabled, and this is the only kind where the
    // deliverable is an ACTION rather than an observation.
    if (!owner) {
      return {
        ok: false,
        code: "command_owner_only",
        error: "Only the owner can set a command deliverable. Name the files the run must leave behind instead.",
      };
    }
    if (typeof value.command !== "string" || !value.command.trim()) {
      return { ok: false, code: "no_command", error: "A command deliverable needs a command to run." };
    }
    const command = value.command.trim();
    if (command.length > MAX_DELIVERABLE_COMMAND_CHARS) {
      return { ok: false, code: "command_too_long", error: `The command is too long: at most ${MAX_DELIVERABLE_COMMAND_CHARS} characters.` };
    }
    if (isDeniedDeliverableCommand(command)) {
      return {
        ok: false,
        code: "command_denied",
        error: "That command kills processes by name, which is refused here: it is how a run once took this box's own web server down. End what you started by process id.",
      };
    }
    return { ok: true, deliverable: { kind: "command", command } };
  }

  return { ok: false, code: "bad_kind", error: `A deliverable's kind must be one of ${DELIVERABLE_KINDS.join(", ")}.` };
}

/**
 * A deliverable off a STORED record, or null.
 *
 * Strict, and the only record parser: a hand-edited runs file, or one written
 * by a newer build that added a kind, must degrade to "this run has no
 * deliverable" rather than to one no surface here can word — the rule
 * `parsePauseReason` and `parseReviewLoop` are held to. The owner gate is not
 * re-applied: a command deliverable ON DISK was put there through the gate,
 * and re-judging it at read time would make a run's own frozen settings depend
 * on who is reading the file.
 */
export function parseDeliverable(raw: unknown): Deliverable | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === "pr") return { kind: "pr" };
  if (value.kind === "paths") {
    if (!Array.isArray(value.paths) || value.paths.length === 0) return null;
    // REJECTED, not trimmed to the cap and not filtered down to the safe ones.
    // Repairing here would quietly WEAKEN the bar a run is held to: a record
    // carrying one unsafe path beside three safe ones would have passed as a
    // three-file deliverable, and a list longer than the cap as its first ten —
    // in both cases the run could be called finished without delivering what the
    // record says. `readDeliverableInput` refuses both at creation, so a record
    // shaped this way was hand-edited, and "this run has no deliverable" is the
    // safe reading of that.
    if (value.paths.length > MAX_DELIVERABLE_PATHS) return null;
    const paths: string[] = [];
    for (const entry of value.paths) {
      if (!isSafeDeliverablePath(entry)) return null;
      const trimmed = entry.trim();
      // Deduplication is the one thing done on the way in that is kept here: it
      // cannot weaken the bar (the same set of files either way), and the
      // creation reader has already applied it, so a stored list is unique
      // anyway.
      if (!paths.includes(trimmed)) paths.push(trimmed);
    }
    return paths.length ? { kind: "paths", paths } : null;
  }
  if (value.kind === "command") {
    if (typeof value.command !== "string" || !value.command.trim()) return null;
    const command = value.command.trim();
    // Over-long is REJECTED rather than truncated, and this one is not merely a
    // weaker bar: `checkCommand` hands this string to `/bin/bash -lc`, so a
    // silent `.slice()` would have the box RUN A DIFFERENT COMMAND from the one
    // the record names — `npm test && rm -rf x` cut mid-word is its own program.
    if (command.length > MAX_DELIVERABLE_COMMAND_CHARS) return null;
    // Re-checked on the way OUT as well as in. The record is a file the
    // clawbox account can write, and this is the one field on it that the box
    // hands to a shell.
    if (isDeniedDeliverableCommand(command)) return null;
    return { kind: "command", command };
  }
  return null;
}

/** The verdict off a stored record, or null. */
export function parseDeliverableVerdict(raw: unknown): DeliverableVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.checkedAt !== "number" || !Number.isFinite(value.checkedAt)) return null;
  const ok = value.ok === true;
  return {
    ok,
    // A verdict that says "not there" without saying what is not there was not
    // written by this code; an empty sentence is better than a missing field
    // a reader has to guess at, so it is normalised rather than rejected.
    missing: ok ? null : typeof value.missing === "string" ? value.missing.slice(0, MAX_MISSING_CHARS) : "",
    checkedAt: value.checkedAt,
  };
}

/** The attempt list off a stored record. Entries that are not attempts are
 *  dropped rather than repaired, and the list is bounded by the cap's own
 *  ceiling so a hand-edited file cannot become the record. */
export function parseAttempts(raw: unknown): RunAttempt[] {
  if (!Array.isArray(raw)) return [];
  const attempts: RunAttempt[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) continue;
    attempts.push({
      startedAt: value.startedAt,
      endedAt: typeof value.endedAt === "number" && Number.isFinite(value.endedAt) ? value.endedAt : null,
      reason: typeof value.reason === "string" ? value.reason.slice(0, MAX_MISSING_CHARS) : null,
    });
    if (attempts.length >= MAX_COMPLETION_ATTEMPTS) break;
  }
  return attempts;
}

/** How many attempts this box gives a run, from the raw config value. */
export function completionAttemptsFrom(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_COMPLETION_ATTEMPTS;
  const rounded = Math.round(raw);
  if (rounded < MIN_COMPLETION_ATTEMPTS || rounded > MAX_COMPLETION_ATTEMPTS) return DEFAULT_COMPLETION_ATTEMPTS;
  return rounded;
}

/**
 * What the deliverable IS, in one English phrase.
 *
 * English and not a catalogue key, because this phrase has two readers that
 * have no translator: the nudge that goes to the harness on the run's stdin,
 * and the MCP status text a delegated agent reads back. The app words the same
 * facts from `codingAgent.deliverable*` in the owner's language instead, from
 * the structured field rather than by parsing this.
 */
export function describeDeliverable(deliverable: Deliverable): string {
  switch (deliverable.kind) {
    case "pr":
      return "a pull request for this run's branch";
    case "paths":
      return deliverable.paths.length === 1
        ? `the file ${deliverable.paths[0]}`
        : `these files: ${deliverable.paths.join(", ")}`;
    case "command":
      return `\`${deliverable.command}\` exiting 0`;
  }
}

/**
 * What the box says to the harness when the deliverable is not there.
 *
 * Short, and it names the one thing that is missing. It travels on the resumed
 * run's stdin, so it is the box's own words throughout — the only text from
 * outside is `missing`, which for a command deliverable carries a tail of that
 * command's output, already bounded by MAX_MISSING_CHARS on the way onto the
 * record. Labelled as a fact about the folder rather than as an instruction
 * from a third party, the way the review loop labels what GitHub said.
 *
 * "Do not start over" is load-bearing: this is a resume into the SAME session,
 * so the transcript of the attempt that just ended is still there, and a
 * harness told only "this is missing" rewrote the work from scratch.
 */
export function completionNudge(
  deliverable: Deliverable,
  missing: string,
  /**
   * Which go this is, when the BOX is spending one of its own. Null when the
   * owner pressed Resume: the attempt cap is what the box spends unasked, so
   * counting their own deliberate act against it — "attempt 4 of 3" — would be
   * the box reporting a budget the owner is not subject to.
   */
  attempt: { n: number; of: number } | null,
): string {
  return [
    `This run is not finished yet: ${missing}`,
    "",
    `What it has to leave behind is ${describeDeliverable(deliverable)}.`,
    "Carry on in the same folder from where the transcript leaves off — do not start over, and do not re-do work that is already done.",
    "Deliver the missing part, verify it yourself, and then finish with one line saying what you delivered.",
    ...(attempt ? [`This is attempt ${attempt.n} of ${attempt.of}.`] : []),
  ].join("\n");
}

/**
 * The reason a run that never got there is recorded with.
 *
 * One sentence, built from the last thing that was missing. `gave_up` is not a
 * failure of the harness's own making — it worked, reported success, and what
 * it produced was not the deliverable — so the wording says what is absent
 * rather than what went wrong.
 */
export function gaveUpReason(missing: string, attempts: number): string {
  const tries = attempts === 1 ? "one attempt" : `${attempts} attempts`;
  return `${missing} After ${tries} the deliverable is still not there, so this is not finished. Resume it to carry on in the same session.`;
}
